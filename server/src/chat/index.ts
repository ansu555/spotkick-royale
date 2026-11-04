import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { createPublicClient, defineChain, http, parseAbi } from "viem";
import { z } from "zod";
import { SlidingWindowLimiter } from "../gateway/ratelimit.js";
import type { Logger } from "../gateway/types.js";
import { BUS_CHANNEL, type Envelope } from "../protocol.js";
import { escapeHtml, sanitizeChat, shortAddress } from "./sanitize.js";

export { MAX_CHAT_CHARS, sanitizeChat, escapeHtml, shortAddress } from "./sanitize.js";

export const CHAT_STREAM = "sk:chat";
export const MUTED_SET = "sk:muted";
export const CHAT_STREAM_MAXLEN = 500;
export const WAGER_CACHE_MS = 60_000;

export type ChatErrorCode =
  | "invalid_text"
  | "muted"
  | "rate_limited"
  | "insufficient_wager"
  | "wager_unavailable";

export type ChatResult =
  | { ok: true; id: string }
  | { ok: false; code: ChatErrorCode; message: string; retryAfterMs?: number; requiredWei?: string };

export interface ChatHistoryItem {
  id: string;
  ts: number;
  user: string;
  text: string;
}

export interface ChatService {
  send(address: string, text: unknown): Promise<ChatResult>;
  history(limit: number): Promise<ChatHistoryItem[]>;
}

export interface ChatOptions {
  redis: Redis;
  /** lifetime wagered wei for an address (royale.wagered) */
  readWager: (address: string) => Promise<bigint>;
  minChatWagerWei: bigint;
  log: Logger;
  now?: () => number;
  /** burst / window for the per-address limiter; default 3 msgs per 6s (~1 msg/2s, burst 3) */
  rate?: { limit: number; windowMs: number };
}

export function createChat(o: ChatOptions): ChatService {
  const now = o.now ?? Date.now;
  const limiter = new SlidingWindowLimiter(
    o.redis,
    { prefix: "sk:rl:chat:", limit: o.rate?.limit ?? 3, windowMs: o.rate?.windowMs ?? 6000 },
    now,
  );
  const wagerCache = new Map<string, { value: bigint; expires: number }>();
  const inflight = new Map<string, Promise<bigint>>();

  const wagerOf = async (address: string): Promise<bigint> => {
    const hit = wagerCache.get(address);
    if (hit && hit.expires > now()) return hit.value;
    let p = inflight.get(address);
    if (!p) {
      p = o
        .readWager(address)
        .then((value) => {
          wagerCache.set(address, { value, expires: now() + WAGER_CACHE_MS });
          return value;
        })
        .finally(() => inflight.delete(address));
      inflight.set(address, p);
    }
    return p;
  };

  return {
    async send(address, rawText) {
      const clean = sanitizeChat(rawText);
      if (!clean.ok) {
        const message = clean.reason === "too_long" ? "message must be 1-140 characters" : "message must be 1-140 characters of text";
        return { ok: false, code: "invalid_text", message };
      }
      if ((await o.redis.sismember(MUTED_SET, address)) === 1) {
        return { ok: false, code: "muted", message: "you are muted" };
      }
      const hit = await limiter.hit(address);
      if (!hit.allowed) {
        return { ok: false, code: "rate_limited", message: "slow down", retryAfterMs: hit.retryAfterMs };
      }
      if (o.minChatWagerWei > 0n) {
        let wagered: bigint;
        try {
          wagered = await wagerOf(address);
        } catch (err) {
          o.log.error({ err, address }, "wager lookup failed; rejecting chat (fail closed)");
          return { ok: false, code: "wager_unavailable", message: "could not verify eligibility, try again" };
        }
        if (wagered < o.minChatWagerWei) {
          return {
            ok: false,
            code: "insufficient_wager",
            message: "wager to unlock chat",
            requiredWei: o.minChatWagerWei.toString(),
          };
        }
      }

      const ts = now();
      const user = shortAddress(address);
      const text = escapeHtml(clean.text);
      const id = await o.redis.xadd(
        CHAT_STREAM, "MAXLEN", "~", CHAT_STREAM_MAXLEN, "*",
        "ts", String(ts), "addr", address, "user", user, "text", text,
      );
      if (!id) throw new Error("chat: XADD returned null");
      const env: Envelope = { channel: "chat", msg: { t: "chat", id, ts, user, text } };
      await o.redis.publish(BUS_CHANNEL, JSON.stringify(env));
      return { ok: true, id };
    },

    async history(limit) {
      const n = Math.min(Math.max(1, Math.trunc(limit)), 200);
      const [rows, muted] = await Promise.all([
        o.redis.xrevrange(CHAT_STREAM, "+", "-", "COUNT", n),
        o.redis.smembers(MUTED_SET),
      ]);
      const mutedSet = new Set(muted);
      const items: ChatHistoryItem[] = [];
      for (const [id, fields] of rows) {
        const f = toRecord(fields);
        if (mutedSet.has(f.addr ?? "")) continue;
        items.push({ id, ts: Number(f.ts ?? 0), user: f.user ?? "", text: f.text ?? "" });
      }
      return items.reverse(); // oldest first
    },
  };
}

function toRecord(fields: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) out[fields[i] as string] = fields[i + 1] as string;
  return out;
}

/** Admin helpers (operate from a repl / script; no HTTP surface on purpose). */
export async function muteAddress(redis: Redis, address: string): Promise<void> {
  await redis.sadd(MUTED_SET, address.toLowerCase());
}
export async function unmuteAddress(redis: Redis, address: string): Promise<void> {
  await redis.srem(MUTED_SET, address.toLowerCase());
}

const WAGER_ABI = parseAbi(["function wagered(address player) view returns (uint128)"]);

/** Real chain read: royale.wagered(address). */
export function makeWagerReader(rpcUrl: string, chainId: number, royale: `0x${string}`): (address: string) => Promise<bigint> {
  const chain = defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const client = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 5000, retryCount: 1 }) });
  return (address) =>
    client.readContract({ address: royale, abi: WAGER_ABI, functionName: "wagered", args: [address as `0x${string}`] });
}

const historyQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

export function registerChatRoutes(app: FastifyInstance, chat: ChatService): void {
  app.get("/api/chat", async (req, reply) => {
    const q = historyQuery.safeParse(req.query);
    if (!q.success) {
      reply.code(400);
      return { error: "bad_request", message: "limit must be 1-200" };
    }
    return chat.history(q.data.limit);
  });
}
