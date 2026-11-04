import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { Redis } from "ioredis";
import { WebSocket, WebSocketServer } from "ws";
import { createAuth, registerAuthRoutes, resolveAllowedDomains, verifyToken, type TokenClaims } from "../auth/index.js";
import { createChat, makeWagerReader, registerChatRoutes } from "../chat/index.js";
import { Presence } from "../presence/index.js";
import { BUS_CHANNEL, type Envelope, type RealtimeOptions, type StartRealtime } from "../protocol.js";
import { Hub, type HubSocket } from "./hub.js";
import { Session } from "./session.js";
import { DEFAULT_MAX_BUFFERED_BYTES, MAX_FRAME_BYTES, WS_CLOSE, type Logger } from "./types.js";

export { verifyToken } from "../auth/index.js";

export interface RealtimeDeps {
  createRedis: (url: string) => Redis;
  readWager?: (address: string) => Promise<bigint>;
  allowedDomains?: string[];
  heartbeatMs?: number;
  presenceIntervalMs?: number;
  maxBufferedBytes?: number;
}

const MIN_SECRET_LEN = 32;

export class BadEnvelopeError extends Error {
  constructor(detail: string) {
    super(`bad bus envelope: ${detail}`);
    this.name = "BadEnvelopeError";
  }
}

export function parseEnvelope(raw: string): Envelope {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new BadEnvelopeError("not JSON");
  }
  if (typeof v !== "object" || v === null) throw new BadEnvelopeError("not an object");
  const o = v as { channel?: unknown; msg?: unknown };
  const msg = o.msg as { t?: unknown } | null | undefined;
  if (typeof o.channel !== "string" || typeof msg !== "object" || msg === null || typeof msg.t !== "string") {
    throw new BadEnvelopeError("missing channel or msg.t");
  }
  return v as Envelope;
}

class WsAdapter implements HubSocket {
  readonly id = randomUUID();
  alive = true;
  constructor(
    private readonly ws: WebSocket,
    readonly address: string | null,
  ) {}
  send(data: string): void {
    this.ws.send(data);
  }
  bufferedAmount(): number {
    return this.ws.bufferedAmount;
  }
  close(code: number, reason: string): void {
    this.ws.close(code, reason);
  }
}

export async function startRealtimeWith(o: RealtimeOptions, deps: RealtimeDeps): Promise<{ close(): Promise<void> }> {
  if (o.jwtSecret.length < MIN_SECRET_LEN) throw new Error(`realtime: jwtSecret must be >= ${MIN_SECRET_LEN} chars`);
  const log: Logger = o.app.log;
  const nodeId = randomUUID();

  const redis = deps.createRedis(o.redisUrl);
  const sub = deps.createRedis(o.redisUrl);
  for (const [name, c] of [["cmd", redis], ["sub", sub]] as const) {
    c.on("error", (err: Error) => log.error({ err, conn: name }, "redis error"));
  }

  const hub = new Hub(log, deps.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES);
  const readWager = deps.readWager ?? makeWagerReader(o.rpcUrl, o.chainId, o.contracts.royale);
  const chat = createChat({ redis, readWager, minChatWagerWei: o.minChatWagerWei, log });
  const auth = createAuth({
    redis,
    jwtSecret: o.jwtSecret,
    chainId: o.chainId,
    allowedDomains: deps.allowedDomains ?? resolveAllowedDomains(),
  });
  registerAuthRoutes(o.app, auth, redis);
  registerChatRoutes(o.app, chat);

  const presence = new Presence({
    redis,
    nodeId,
    log,
    localCount: () => hub.size,
    onChange: (count) => hub.broadcast("presence", { t: "presence", count }),
    ...(deps.presenceIntervalMs !== undefined ? { intervalMs: deps.presenceIntervalMs } : {}),
  });

  // Redis bus -> local sockets
  sub.on("message", (channel: string, raw: string) => {
    if (channel !== BUS_CHANNEL) return;
    try {
      hub.fanout(parseEnvelope(raw));
    } catch (err) {
      log.warn({ err }, "dropped bus message");
    }
  });
  await sub.subscribe(BUS_CHANNEL);

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const alive = new WeakMap<WebSocket, boolean>();

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://placeholder");
    } catch {
      return;
    }
    if (url.pathname !== "/ws") {
      // Not ours. If nobody else handles upgrades, don't leave the socket hanging.
      if (o.app.server.listenerCount("upgrade") <= 1) {
        socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        socket.destroy();
      }
      return;
    }
    const token = url.searchParams.get("token");
    wss.handleUpgrade(req, socket, head, (ws) => {
      void onConnection(ws, token);
    });
  };

  const onConnection = async (ws: WebSocket, token: string | null): Promise<void> => {
    let claims: TokenClaims | null = null;
    if (token) {
      try {
        claims = await verifyToken(token, o.jwtSecret);
      } catch (err) {
        log.error({ err }, "token verification crashed");
      }
      if (!claims) {
        ws.close(WS_CLOSE.BAD_TOKEN, "invalid token");
        return;
      }
    }
    if (ws.readyState !== WebSocket.OPEN) return;

    const adapter = new WsAdapter(ws, claims?.address ?? null);
    hub.add(adapter);
    alive.set(ws, true);
    const session = new Session(adapter, claims?.expiresAt ?? null, {
      hub,
      snapshots: o.snapshots,
      chat,
      presenceCount: () => presence.current,
      log,
    });

    ws.on("pong", () => alive.set(ws, true));
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        ws.close(WS_CLOSE.POLICY, "text frames only");
        return;
      }
      session.onMessage(data.toString("utf8")).catch((err: unknown) => {
        log.error({ err }, "session handler crashed");
      });
    });
    ws.on("close", () => hub.remove(adapter.id));
    ws.on("error", (err) => {
      log.warn({ err }, "ws error");
      hub.remove(adapter.id);
    });

    hub.sendTo(adapter.id, {
      t: "hello",
      chainId: o.chainId,
      serverTime: Date.now(),
      contracts: { royale: o.contracts.royale, rain: o.contracts.rain, sessions: o.contracts.sessions },
    });
  };

  o.app.server.on("upgrade", onUpgrade);

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, deps.heartbeatMs ?? 30_000);
  heartbeat.unref();

  presence.start();

  return {
    async close(): Promise<void> {
      clearInterval(heartbeat);
      o.app.server.off("upgrade", onUpgrade);
      await presence.stop();
      hub.closeAll(WS_CLOSE.GOING_AWAY, "server shutting down");
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await sub.quit();
      await redis.quit();
    },
  };
}

export const startRealtime: StartRealtime = (o) =>
  startRealtimeWith(o, { createRedis: (url) => new Redis(url, { maxRetriesPerRequest: null }) });
