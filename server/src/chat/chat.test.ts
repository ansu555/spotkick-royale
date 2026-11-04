import { beforeEach, describe, expect, it, vi } from "vitest";
import { newRedis, silentLog } from "../gateway/testutil.js";
import { BUS_CHANNEL } from "../protocol.js";
import { CHAT_STREAM, MUTED_SET, createChat, muteAddress, type ChatService } from "./index.js";
import { escapeHtml, sanitizeChat, shortAddress } from "./sanitize.js";

const ADDR = "0x1234567890abcdef1234567890abcdef12345678";

describe("sanitizeChat", () => {
  it("trims, collapses whitespace and strips control / invisible chars", () => {
    expect(sanitizeChat("  hello\n\tworld \u0007​ ")).toEqual({ ok: true, text: "hello world" });
    expect(sanitizeChat("a‮b")).toEqual({ ok: true, text: "ab" });
  });
  it("rejects empty, non-string and >140 code points", () => {
    expect(sanitizeChat("")).toMatchObject({ ok: false, reason: "empty" });
    expect(sanitizeChat(" \u0000 \n")).toMatchObject({ ok: false, reason: "empty" });
    expect(sanitizeChat(42)).toMatchObject({ ok: false, reason: "not_string" });
    expect(sanitizeChat("x".repeat(141))).toMatchObject({ ok: false, reason: "too_long" });
    expect(sanitizeChat("x".repeat(140)).ok).toBe(true);
    expect(sanitizeChat("\u{1F3C6}".repeat(140)).ok).toBe(true); // counts code points, not UTF-16 units
  });
  it("escapes html and shortens addresses", () => {
    expect(escapeHtml(`<img src=x onerror="a&b">'`)).toBe("&lt;img src=x onerror=&quot;a&amp;b&quot;&gt;&#39;");
    expect(shortAddress(ADDR)).toBe("0x1234…5678");
  });
});

describe("chat service", () => {
  const redis = newRedis();
  let t: number;
  let readWager: ReturnType<typeof vi.fn<(a: string) => Promise<bigint>>>;
  let chat: ChatService;
  const MIN = 10n;

  beforeEach(async () => {
    await redis.flushall();
    t = 1_000_000;
    readWager = vi.fn(async () => 100n);
    chat = createChat({ redis, readWager, minChatWagerWei: MIN, log: silentLog, now: () => t });
  });

  it("validates text before touching rate limit or chain", async () => {
    const r = await chat.send(ADDR, "   ");
    expect(r).toMatchObject({ ok: false, code: "invalid_text" });
    expect(readWager).not.toHaveBeenCalled();
    expect(await chat.send(ADDR, "y".repeat(141))).toMatchObject({ ok: false, code: "invalid_text" });
  });

  it("stores history, publishes a chat envelope on the bus, shows short-address names", async () => {
    const sub = redis.duplicate();
    const got: string[] = [];
    sub.on("message", (_c: string, m: string) => got.push(m));
    await sub.subscribe(BUS_CHANNEL);

    const r = await chat.send(ADDR, " gm <b>all</b> ");
    expect(r.ok).toBe(true);
    await new Promise((res) => setTimeout(res, 20));

    expect(got).toHaveLength(1);
    const env = JSON.parse(got[0] as string);
    expect(env.channel).toBe("chat");
    expect(env.msg).toMatchObject({ t: "chat", user: "0x1234…5678", text: "gm &lt;b&gt;all&lt;/b&gt;", ts: t });

    const hist = await chat.history(50);
    expect(hist).toEqual([{ id: env.msg.id, ts: t, user: "0x1234…5678", text: "gm &lt;b&gt;all&lt;/b&gt;" }]);
    await sub.quit();
  });

  it("history is oldest-first, honours limit, and hides muted users", async () => {
    const other = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    await chat.send(ADDR, "one");
    t += 10_000;
    await chat.send(other, "two");
    t += 10_000;
    await chat.send(ADDR, "three");
    expect((await chat.history(50)).map((m) => m.text)).toEqual(["one", "two", "three"]);
    expect((await chat.history(2)).map((m) => m.text)).toEqual(["two", "three"]);
    await muteAddress(redis, other.toUpperCase().replace("0X", "0x"));
    expect((await chat.history(50)).map((m) => m.text)).toEqual(["one", "three"]);
  });

  it("caps the history stream (MAXLEN ~500)", async () => {
    const c = createChat({ redis, readWager, minChatWagerWei: 0n, log: silentLog, now: () => t, rate: { limit: 100000, windowMs: 60_000 } });
    for (let i = 0; i < 700; i++) {
      t += 5;
      await c.send(ADDR, `m${i}`);
    }
    const len = await redis.xlen(CHAT_STREAM);
    expect(len).toBeLessThanOrEqual(700);
    expect(len).toBeGreaterThanOrEqual(500);
  });

  it("enforces the per-address rate limit (3 per 6s) and recovers", async () => {
    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push(await chat.send(ADDR, `m${i}`));
      t += 100;
    }
    expect(results.map((r) => r.ok)).toEqual([true, true, true, false]);
    expect(results[3]).toMatchObject({ code: "rate_limited" });
    expect((await chat.send("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "hi")).ok).toBe(true);
    t += 6000;
    expect((await chat.send(ADDR, "later")).ok).toBe(true);
  });

  it("blocks muted addresses", async () => {
    await redis.sadd(MUTED_SET, ADDR);
    expect(await chat.send(ADDR, "hi")).toMatchObject({ ok: false, code: "muted" });
  });

  it("requires minChatWagerWei and caches the wager lookup for 60s", async () => {
    readWager.mockResolvedValue(5n);
    expect(await chat.send(ADDR, "a")).toMatchObject({ ok: false, code: "insufficient_wager", requiredWei: "10" });
    readWager.mockResolvedValue(50n);
    t += 30_000;
    expect(await chat.send(ADDR, "b")).toMatchObject({ ok: false, code: "insufficient_wager" }); // still cached
    expect(readWager).toHaveBeenCalledTimes(1);
    t += 31_000;
    expect((await chat.send(ADDR, "c")).ok).toBe(true); // cache expired, re-read
    expect(readWager).toHaveBeenCalledTimes(2);
  });

  it("fails closed (and does not cache) when the wager read errors", async () => {
    readWager.mockRejectedValueOnce(new Error("rpc down"));
    expect(await chat.send(ADDR, "a")).toMatchObject({ ok: false, code: "wager_unavailable" });
    expect((await chat.send(ADDR, "b")).ok).toBe(true);
  });
});
