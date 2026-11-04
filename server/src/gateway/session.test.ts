import { describe, expect, it, vi } from "vitest";
import type { ChatService } from "../chat/index.js";
import type { GameSnapshot, RoomInfo } from "../protocol.js";
import { Hub } from "./hub.js";
import { Session, type SessionDeps } from "./session.js";
import { FakeSocket, silentLog } from "./testutil.js";

const room: RoomInfo = { tier: 0, valueWei: "3000000000000000000", gameId: "5", phase: "lobby", seatsFilled: 1, phaseEndsAt: 0 };
const game: GameSnapshot = {
  gameId: "5", tier: 0, phase: "lobby", round: 0, entryWei: "1", potWei: "1", aliveMask: 1, phaseEndsAt: 0,
  seats: Array.from({ length: 10 }, () => null), picks: [], results: [],
};

function setup(address: string | null = null, over: Partial<SessionDeps> = {}, expiresAt: number | null = null) {
  const hub = new Hub(silentLog);
  const socket = new FakeSocket("s1", address);
  hub.add(socket);
  const chat: ChatService = {
    send: vi.fn(async () => ({ ok: true as const, id: "1-0" })),
    history: vi.fn(async () => []),
  };
  const snapshots = {
    rooms: vi.fn(async () => [room]),
    game: vi.fn(async (id: string) => (id === "5" ? game : null)),
  };
  const session = new Session(socket, expiresAt, {
    hub, snapshots, chat, presenceCount: () => 42, log: silentLog, ...over,
  });
  return { hub, socket, chat, snapshots, session };
}
const send = (s: Session, m: unknown): Promise<void> => s.onMessage(JSON.stringify(m));

describe("Session subscribe snapshots", () => {
  it("sends the rooms snapshot on subscribing to rooms", async () => {
    const { socket, session, snapshots } = setup();
    await send(session, { t: "sub", channels: ["rooms"] });
    expect(snapshots.rooms).toHaveBeenCalledOnce();
    expect(socket.sent).toEqual([{ t: "rooms", rooms: [room] }]);
  });

  it("sends the game snapshot on game:<id>, and an error for unknown games", async () => {
    const { socket, session } = setup();
    await send(session, { t: "sub", channels: ["game:5", "game:6"] });
    expect(socket.sent[0]).toEqual({ t: "game", game });
    expect(socket.sent[1]).toMatchObject({ t: "error", code: "not_found" });
  });

  it("sends the live presence count on subscribing to presence, and only once for repeat subs", async () => {
    const { socket, session } = setup();
    await send(session, { t: "sub", channels: ["presence"] });
    await send(session, { t: "sub", channels: ["presence"] });
    expect(socket.sent).toEqual([{ t: "presence", count: 42 }]);
  });

  it("reports snapshot failures as an error frame instead of crashing", async () => {
    const { socket, session } = setup(null, {
      snapshots: { rooms: async () => { throw new Error("db down"); }, game: async () => null },
    });
    await send(session, { t: "sub", channels: ["rooms"] });
    expect(socket.sent).toEqual([expect.objectContaining({ t: "error", code: "snapshot_failed" })]);
  });

  it("errors on invalid channel and over-limit subscriptions", async () => {
    const { socket, session } = setup();
    await send(session, { t: "sub", channels: ["bogus"] });
    expect(socket.sent[0]).toMatchObject({ code: "bad_channel" });
    await send(session, { t: "sub", channels: Array.from({ length: 21 }, (_, i) => `game:${i}`) });
    expect(socket.sent).toContainEqual(expect.objectContaining({ code: "too_many_channels" }));
  });
});

describe("Session misc", () => {
  it("answers ping with pong and rejects malformed frames", async () => {
    const { socket, session } = setup();
    await send(session, { t: "ping" });
    expect(socket.types()).toEqual(["pong"]);
    await session.onMessage("not json");
    await send(session, { t: "nope" });
    expect(socket.sent.slice(1)).toEqual([
      expect.objectContaining({ code: "bad_message" }),
      expect.objectContaining({ code: "bad_message" }),
    ]);
  });

  it("closes sockets that exceed the message rate", async () => {
    const { socket, session } = setup(null, { msgBurst: 3, msgPerSec: 0.0001 });
    for (let i = 0; i < 5; i++) await send(session, { t: "ping" });
    expect(socket.closed?.code).toBe(1008);
  });

  it("closes oversized frames", async () => {
    const { socket, session } = setup();
    await session.onMessage("x".repeat(5000));
    expect(socket.closed?.code).toBe(1009);
  });
});

describe("Session chat gating", () => {
  it("rejects chat from anonymous sockets without calling the chat service", async () => {
    const { socket, session, chat } = setup(null);
    await send(session, { t: "chat", text: "hi" });
    expect(chat.send).not.toHaveBeenCalled();
    expect(socket.sent[0]).toMatchObject({ t: "error", code: "unauthorized" });
  });

  it("forwards chat from authenticated sockets and relays rejections", async () => {
    const { socket, session, chat } = setup("0xabc");
    await send(session, { t: "chat", text: "gm" });
    expect(chat.send).toHaveBeenCalledWith("0xabc", "gm");
    expect(socket.sent).toEqual([]);

    vi.mocked(chat.send).mockResolvedValueOnce({ ok: false, code: "rate_limited", message: "slow down", retryAfterMs: 1500 });
    await send(session, { t: "chat", text: "gm" });
    expect(socket.sent[0]).toEqual({ t: "error", code: "rate_limited", message: "slow down", retryAfterMs: 1500 });
  });

  it("rejects chat after the token expired", async () => {
    const { socket, session, chat } = setup("0xabc", { now: () => 2000 }, 1000);
    await send(session, { t: "chat", text: "gm" });
    expect(chat.send).not.toHaveBeenCalled();
    expect(socket.sent[0]).toMatchObject({ code: "token_expired" });
  });
});
