import { z } from "zod";
import type { ChatService } from "../chat/index.js";
import type { RealtimeOptions } from "../protocol.js";
import { Hub, type HubSocket } from "./hub.js";
import { TokenBucket } from "./ratelimit.js";
import { MAX_FRAME_BYTES, WS_CLOSE, type ErrorFrame, type Logger } from "./types.js";

// `unsub` is an extension beyond protocol.ts ClientMsg so clients can leave game:<id> channels.
const clientMsg = z.discriminatedUnion("t", [
  z.object({ t: z.literal("sub"), channels: z.array(z.string().max(80)).max(50) }),
  z.object({ t: z.literal("unsub"), channels: z.array(z.string().max(80)).max(50) }),
  z.object({ t: z.literal("chat"), text: z.string().max(2000) }),
  z.object({ t: z.literal("ping") }),
]);

export interface SessionDeps {
  hub: Hub;
  snapshots: RealtimeOptions["snapshots"];
  chat: ChatService;
  presenceCount: () => number;
  log: Logger;
  now?: () => number;
  /** token bucket: msgs burst / refill per sec */
  msgBurst?: number;
  msgPerSec?: number;
}

/** One client connection's message handling; independent of the `ws` library for testability. */
export class Session {
  private readonly bucket: TokenBucket;
  private readonly now: () => number;

  constructor(
    readonly socket: HubSocket,
    /** unix ms when the auth token expires; null for anonymous sockets */
    private readonly tokenExpiresAt: number | null,
    private readonly d: SessionDeps,
  ) {
    this.now = d.now ?? Date.now;
    this.bucket = new TokenBucket(d.msgBurst ?? 20, d.msgPerSec ?? 10, this.now);
  }

  async onMessage(raw: string): Promise<void> {
    if (raw.length > MAX_FRAME_BYTES) {
      this.socket.close(WS_CLOSE.TOO_BIG, "frame too large");
      return;
    }
    if (!this.bucket.tryTake()) {
      this.socket.close(WS_CLOSE.POLICY, "rate limit");
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      this.err("bad_message", "invalid JSON");
      return;
    }
    const parsed = clientMsg.safeParse(json);
    if (!parsed.success) {
      this.err("bad_message", "unrecognised message");
      return;
    }
    const msg = parsed.data;
    switch (msg.t) {
      case "ping":
        this.d.hub.sendTo(this.socket.id, { t: "pong", ts: this.now() });
        return;
      case "unsub":
        this.d.hub.unsubscribe(this.socket.id, msg.channels);
        return;
      case "sub":
        await this.subscribe(msg.channels);
        return;
      case "chat":
        await this.chat(msg.text);
        return;
    }
  }

  private async subscribe(channels: string[]): Promise<void> {
    const { added, rejected } = this.d.hub.subscribe(this.socket.id, channels);
    for (const r of rejected) {
      this.err(r.reason === "too_many" ? "too_many_channels" : "bad_channel", `cannot subscribe to ${r.channel}`);
    }
    // Subscribed first, snapshot second: a concurrent update can only duplicate, never be missed.
    for (const ch of added) {
      try {
        if (ch === "rooms") {
          this.d.hub.sendTo(this.socket.id, { t: "rooms", rooms: await this.d.snapshots.rooms() });
        } else if (ch.startsWith("game:")) {
          const game = await this.d.snapshots.game(ch.slice(5));
          if (game) this.d.hub.sendTo(this.socket.id, { t: "game", game });
          else this.err("not_found", `no such game ${ch}`);
        } else if (ch === "presence") {
          this.d.hub.sendTo(this.socket.id, { t: "presence", count: this.d.presenceCount() });
        }
      } catch (err) {
        this.d.log.error({ err, channel: ch }, "snapshot failed");
        this.err("snapshot_failed", `could not load ${ch}`);
      }
    }
  }

  private async chat(text: string): Promise<void> {
    const address = this.socket.address;
    if (!address) {
      this.err("unauthorized", "connect with ?token= to chat");
      return;
    }
    if (this.tokenExpiresAt !== null && this.now() >= this.tokenExpiresAt) {
      this.err("token_expired", "session expired, sign in again");
      return;
    }
    try {
      const res = await this.d.chat.send(address, text);
      if (!res.ok) {
        this.err(res.code, res.message, res.retryAfterMs);
      }
    } catch (err) {
      this.d.log.error({ err, address }, "chat send failed");
      this.err("internal", "chat unavailable");
    }
  }

  private err(code: string, message: string, retryAfterMs?: number): void {
    const frame: ErrorFrame = { t: "error", code, message, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
    this.d.hub.sendTo(this.socket.id, frame);
  }
}
