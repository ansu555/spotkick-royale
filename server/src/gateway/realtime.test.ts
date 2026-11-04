import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import WebSocket from "ws";
import { BUS_CHANNEL, type GameSnapshot, type RealtimeOptions, type RoomInfo } from "../protocol.js";
import { startRealtimeWith } from "./index.js";
import { newRedis } from "./testutil.js";

const SECRET = "test-secret-test-secret-test-secret-123";
const account = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const rooms: RoomInfo[] = [{ tier: 0, valueWei: "1", gameId: "9", phase: "lobby", seatsFilled: 0, phaseEndsAt: 0 }];
const game = { gameId: "9" } as GameSnapshot;

type Frame = { t: string; [k: string]: unknown };

class Client {
  frames: Frame[] = [];
  closed: Promise<number>;
  constructor(readonly ws: WebSocket) {
    ws.on("message", (d) => this.frames.push(JSON.parse(d.toString()) as Frame));
    this.closed = new Promise((res) => ws.on("close", (code) => res(code)));
  }
  send(m: unknown): void {
    this.ws.send(JSON.stringify(m));
  }
  async waitFor(pred: (f: Frame) => boolean, ms = 2000): Promise<Frame> {
    const start = Date.now();
    for (;;) {
      const f = this.frames.find(pred);
      if (f) return f;
      if (Date.now() - start > ms) throw new Error(`timeout; frames=${JSON.stringify(this.frames)}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

describe("realtime end-to-end (ws + fastify + redis mock)", () => {
  let app: FastifyInstance;
  let close: () => Promise<void>;
  let port: number;
  const redis = newRedis();
  const clients: Client[] = [];
  let wager = 100n;

  const connect = async (query = ""): Promise<Client> =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`);
      const c = new Client(ws);
      clients.push(c);
      ws.once("open", () => resolve(c));
      ws.once("error", reject);
    });

  beforeEach(async () => {
    await redis.flushall();
    app = Fastify();
    const opts: RealtimeOptions = {
      app, redisUrl: "redis://mock", jwtSecret: SECRET, chainId: 10143, rpcUrl: "http://unused",
      contracts: { royale: `0x${"aa".repeat(20)}`, rain: `0x${"bb".repeat(20)}`, sessions: `0x${"cc".repeat(20)}` },
      minChatWagerWei: 10n,
      snapshots: { rooms: async () => rooms, game: async (id) => (id === "9" ? game : null) },
    };
    wager = 100n;
    const rt = await startRealtimeWith(opts, {
      createRedis: () => newRedis(),
      readWager: async () => wager,
      allowedDomains: ["localhost"],
      presenceIntervalMs: 50,
    });
    close = rt.close;
    await app.listen({ port: 0, host: "127.0.0.1" });
    port = (app.server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.ws.terminate();
    await close();
    await app.close();
  });

  it("sends hello, snapshots on subscribe, and fans Redis bus envelopes out by channel", async () => {
    const a = await connect();
    const b = await connect();
    const hello = await a.waitFor((f) => f.t === "hello");
    expect(hello).toMatchObject({ chainId: 10143, contracts: { royale: `0x${"aa".repeat(20)}` } });

    a.send({ t: "sub", channels: ["rooms", "game:9"] });
    await a.waitFor((f) => f.t === "rooms");
    await a.waitFor((f) => f.t === "game");
    b.send({ t: "sub", channels: ["game:10"] });
    await b.waitFor((f) => f.t === "error");

    await redis.publish(BUS_CHANNEL, JSON.stringify({ channel: "game:9", msg: { t: "seed", gameId: "9", round: 1 } }));
    await redis.publish(BUS_CHANNEL, "{garbage"); // must not crash the node
    await a.waitFor((f) => f.t === "seed");
    await new Promise((r) => setTimeout(r, 50));
    expect(b.frames.some((f) => f.t === "seed")).toBe(false);
  });

  it("reports a real presence count that follows connects and disconnects", async () => {
    const a = await connect();
    a.send({ t: "sub", channels: ["presence"] });
    await a.waitFor((f) => f.t === "presence" && f.count === 1);
    const b = await connect();
    await a.waitFor((f) => f.t === "presence" && f.count === 2);
    b.ws.close();
    await a.waitFor((f) => f.t === "presence" && f.count === 1 && a.frames.filter((x) => x.t === "presence").length >= 3);
  });

  it("serves nonce/verify, then an authenticated socket can chat; anonymous cannot", async () => {
    const nonce = await app.inject({ method: "GET", url: `/api/auth/nonce?address=${account.address}` });
    const { message } = nonce.json<{ message: string }>();
    const signature = await account.signMessage({ message });
    const ver = await app.inject({ method: "POST", url: "/api/auth/verify", payload: { address: account.address, signature } });
    const { token } = ver.json<{ token: string }>();

    const anon = await connect();
    anon.send({ t: "chat", text: "hi" });
    await anon.waitFor((f) => f.t === "error" && f.code === "unauthorized");

    const authed = await connect(`?token=${token}`);
    const listener = await connect();
    listener.send({ t: "sub", channels: ["chat"] });
    await listener.waitFor((f) => f.t === "hello");
    authed.send({ t: "sub", channels: ["chat"] });
    authed.send({ t: "chat", text: "  gm\nfrens " });
    const msg = await listener.waitFor((f) => f.t === "chat");
    expect(msg).toMatchObject({ text: "gm frens", user: `${account.address.toLowerCase().slice(0, 6)}…${account.address.slice(-4).toLowerCase()}` });
    await authed.waitFor((f) => f.t === "chat");

    const hist = await app.inject({ method: "GET", url: "/api/chat?limit=10" });
    expect(hist.json<{ text: string }[]>().map((m) => m.text)).toEqual(["gm frens"]);

    wager = 1n;
    // cached for 60s, so use a fresh address path: same address stays eligible; assert cache behaviour instead
    authed.send({ t: "chat", text: "still ok" });
    await listener.waitFor((f) => f.t === "chat" && f.text === "still ok");
  });

  it("closes sockets presenting an invalid token with code 4401", async () => {
    const c = await connect("?token=not-a-jwt");
    expect(await c.closed).toBe(4401);
  });

  it("ignores upgrades to other paths", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/other`);
    const outcome = await Promise.race([
      new Promise<string>((r) => ws.once("error", () => r("error"))),
      new Promise<string>((r) => setTimeout(() => r("hung"), 300)),
    ]);
    ws.terminate();
    expect(outcome).toBe("error"); // 404 + closed, not left hanging
  });
});
