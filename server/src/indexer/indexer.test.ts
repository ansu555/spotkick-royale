import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { applyBatch, readCursor } from "../db/apply.js";
import type { DB } from "../db/client.js";
import { createSnapshots } from "../db/queries.js";
import { cashouts, games, picks, players, rawEvents, rounds, wins } from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import { createLogger } from "../config/logger.js";
import type { Envelope } from "../protocol.js";
import type { Bus } from "./bus.js";
import type { ChainEvent, RawLog } from "./decode.js";
import { Indexer, MAX_LOG_RANGE, type ChainReader } from "./indexer.js";
import { P1, P2, P3, RAIN, ROYALE, ev, rawLog } from "./test-events.js";

const E3 = 3_000_000_000_000_000_000n;
const silent = createLogger("error", "test", () => undefined);

/** A whole game lifecycle as decoded events (block 100.., ts 1000..). */
function lifecycle(): ChainEvent[] {
  return [
    ev("GameOpened", { gameId: 1n, tier: 0, entry: E3 }, 100n, 0, 1000n, 1),
    ev("SeatTaken", { gameId: 1n, seat: 0, player: P1 }, 101n, 0, 1001n, 2),
    ev("SeatTaken", { gameId: 1n, seat: 1, player: P2 }, 102n, 0, 1002n, 3),
    ev("SeatTaken", { gameId: 1n, seat: 2, player: P3 }, 103n, 0, 1003n, 4),
    ev("LobbyCountdownStarted", { gameId: 1n, startsAt: 1018n }, 103n, 1, 1003n, 4),
    ev("GameStarted", { gameId: 1n, players: 3, pot: 11_520_000_000_000_000_000n }, 120n, 0, 1019n, 5),
    ev("RoundStarted", { gameId: 1n, round: 1, pickDeadline: 1026n, aliveMask: 0b111 }, 120n, 1, 1019n, 5),
    ev("PickPlaced", { gameId: 1n, round: 1, seat: 0, x: 100, y: 500, pickCount: 1 }, 121n, 0, 1020n, 6),
    ev("PickPlaced", { gameId: 1n, round: 1, seat: 0, x: 200, y: 600, pickCount: 2 }, 122n, 0, 1021n, 7),
    ev("RoundLocked", { gameId: 1n, round: 1, picksHash: "0x" + "ab".repeat(32), entropyRequestId: 5n }, 130n, 0, 1027n, 8),
    ev("SeedReceived", { gameId: 1n, round: 1, seed: "0x" + "cd".repeat(32) }, 131n, 0, 1028n, 9),
    ev("AutoPicked", { gameId: 1n, round: 1, seat: 1, x: 5, y: 150 }, 132n, 0, 1029n, 10),
    ev("RoundResolved", { gameId: 1n, round: 1, targetX: 10, targetY: 700, outcome: 1, survivorMask: 0b011, radiusMm: 1200, saveBps: 3000, nextPhaseAt: 1038n }, 132n, 1, 1029n, 10),
    ev("CashedOut", { gameId: 1n, round: 2, seat: 1, player: P2, amount: 5_760_000_000_000_000_000n }, 140n, 0, 1040n, 11),
    ev("GameFinished", { gameId: 1n, seat: 0, winner: P1, prize: 5_760_000_000_000_000_000n, rounds: 2 }, 150n, 0, 1050n, 12),
  ];
}

let db: DB;
beforeEach(async () => {
  ({ db } = await createTestDb());
});

describe("applyBatch", () => {
  it("builds game, round, pick, cashout, win and player state from events", async () => {
    await applyBatch(db, lifecycle(), { blockNumber: 150n, blockHash: "0xh" });
    const g = (await db.select().from(games).where(eq(games.id, 1n)))[0]!;
    expect(g).toMatchObject({ phase: "finished", winner: P1, prizeWei: "5760000000000000000", seatsFilled: 3, playersAtStart: 3, roundsPlayed: 2, potWei: "0" });
    const r = (await db.select().from(rounds))[0]!;
    expect(r).toMatchObject({ round: 1, outcome: "goal", targetX: 10, seed: "0x" + "cd".repeat(32), lockedAt: 1027, entropyRequestId: "5" });
    const ps = await db.select().from(picks);
    expect(ps.map((p) => [p.seat, p.pickCount, p.auto])).toEqual(expect.arrayContaining([[0, 1, false], [0, 2, false], [1, 0, true]]));
    expect(await db.select().from(cashouts)).toHaveLength(1);
    expect(await db.select().from(wins)).toHaveLength(1);
    const p1 = (await db.select().from(players).where(eq(players.address, P1)))[0]!;
    expect(p1).toMatchObject({ wageredWei: E3.toString(), wonWei: "5760000000000000000", games: 1, bestMultiple: 1.92 });
    expect(await readCursor(db)).toMatchObject({ blockNumber: 150n });
  });

  it("is idempotent: replaying the same events changes nothing", async () => {
    const first = await applyBatch(db, lifecycle(), { blockNumber: 150n, blockHash: null });
    expect(first.applied).toHaveLength(15);
    const snapshot = async () => ({
      g: await db.select().from(games), p: await db.select().from(players), pk: await db.select().from(picks),
      c: await db.select().from(cashouts), raw: (await db.select().from(rawEvents)).length,
    });
    const before = await snapshot();
    const again = await applyBatch(db, lifecycle(), { blockNumber: 150n, blockHash: null });
    expect(again.applied).toHaveLength(0);
    expect(await snapshot()).toEqual(before);
  });

  it("is resumable: a split/overlapping replay converges to the same state as one pass", async () => {
    const all = lifecycle();
    await applyBatch(db, all.slice(0, 7), { blockNumber: 120n, blockHash: null });
    await applyBatch(db, all.slice(4), { blockNumber: 150n, blockHash: null }); // overlap of events 4..6
    const { db: ref } = await createTestDb();
    await applyBatch(ref, all, { blockNumber: 150n, blockHash: null });
    expect(await db.select().from(players).orderBy(players.address)).toEqual(await ref.select().from(players).orderBy(players.address));
    expect(await db.select().from(games)).toEqual(await ref.select().from(games));
  });

  it("rolls back the whole batch (events + cursor) when an event fails", async () => {
    const bad = [ev("GameOpened", { gameId: 9n, tier: 0, entry: E3 }), ev("SeatTaken", { gameId: 404n, seat: 0, player: P1 }, 101n, 0, 1001n, 2)];
    await expect(applyBatch(db, bad, { blockNumber: 101n, blockHash: null })).rejects.toThrow(/unknown game 404/);
    expect(await db.select().from(games)).toHaveLength(0);
    expect(await db.select().from(rawEvents)).toHaveLength(0);
    expect(await readCursor(db)).toBeNull();
  });

  it("tracks rain", async () => {
    await applyBatch(db, [
      ev("RainOpened", { rainId: 1n, endsAt: 9000n, amount: 100n }),
      ev("RainFunded", { rainId: 1n, amount: 50n, total: 150n }, 101n, 0, 1001n, 2),
      ev("RainJoined", { rainId: 1n, player: P1, joined: 1 }, 102n, 0, 1002n, 3),
      ev("RainSettled", { rainId: 1n, total: 150n, joined: 1 }, 103n, 0, 1003n, 4),
    ], { blockNumber: 103n, blockHash: null });
    const { rain } = await import("../db/schema.js");
    expect((await db.select().from(rain))[0]).toMatchObject({ amountWei: "150", joined: 1, settled: true });
  });

  it("serves snapshots from state", async () => {
    await applyBatch(db, lifecycle().slice(0, 9), { blockNumber: 122n, blockHash: null });
    const snaps = createSnapshots(db, { tiers: async () => [{ tier: 0, valueWei: E3 }, { tier: 1, valueWei: 5n * E3 }] });
    const rooms = await snaps.rooms();
    expect(rooms[0]).toMatchObject({ tier: 0, gameId: "1", phase: "picking", seatsFilled: 3 });
    expect(rooms[1]).toMatchObject({ tier: 1, gameId: null, phase: "none" });
    const game = await snaps.game("1");
    expect(game?.picks).toEqual([{ seat: 0, x: 200, y: 600 }]); // latest of the two picks
    expect(game?.seats.slice(0, 4)).toEqual([P1, P2, P3, null]);
    expect(await snaps.game("999")).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------ Indexer

class FakeReader implements ChainReader {
  head = 0n;
  logs: RawLog[] = [];
  calls: [bigint, bigint][] = [];
  failNext = 0;
  async finalizedHead(): Promise<bigint> {
    return this.head;
  }
  async getLogs(from: bigint, to: bigint): Promise<{ logs: RawLog[] }> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("rpc hiccup");
    }
    this.calls.push([from, to]);
    return { logs: this.logs.filter((l) => l.blockNumber! >= from && l.blockNumber! <= to) };
  }
  async blockInfo(n: bigint): Promise<{ timestamp: bigint; hash: `0x${string}` }> {
    return { timestamp: 1_000_000n + n, hash: `0x${n.toString(16).padStart(64, "0")}` };
  }
}

class MemBus implements Bus {
  out: Envelope[] = [];
  async publish(e: Envelope): Promise<void> {
    this.out.push(e);
  }
}

function mkIndexer(reader: FakeReader, bus: Bus, startBlock = 1n, nowSec = 1_000_000 + 10_000) {
  const snapshots = createSnapshots(db, { tiers: async () => [{ tier: 0, valueWei: E3 }] });
  return new Indexer({ db, reader, bus, snapshots, log: silent, startBlock, pollMs: 50, nowSec: () => nowSec });
}

describe("Indexer.syncOnce", () => {
  it("backfills in <=1000-block chunks and resumes from the cursor", async () => {
    const reader = new FakeReader();
    reader.head = 2500n;
    const ix = mkIndexer(reader, new MemBus(), 1n);
    await ix.syncOnce();
    expect(reader.calls).toEqual([[1n, 1000n], [1001n, 2000n], [2001n, 2500n]]);
    for (const [f, t] of reader.calls) expect(t - f + 1n).toBeLessThanOrEqual(MAX_LOG_RANGE);
    expect((await readCursor(db))?.blockNumber).toBe(2500n);
    reader.calls = [];
    reader.head = 2600n;
    await ix.syncOnce();
    expect(reader.calls).toEqual([[2501n, 2600n]]);
    expect(ix.status().lagBlocks).toBe(0n);
  });

  it("decodes real encoded logs, writes state once, and does not re-apply on a re-run from an older cursor", async () => {
    const reader = new FakeReader();
    reader.head = 10n;
    reader.logs = [
      rawLog("GameOpened", { gameId: 1n, tier: 0, entry: E3 }, 3n, 0, 1),
      rawLog("SeatTaken", { gameId: 1n, seat: 0, player: P1 }, 4n, 0, 2),
      rawLog("PickPlaced", { gameId: 1n, round: 1, seat: 0, x: -50, y: 300, pickCount: 1 }, 5n, 0, 3),
      rawLog("RainOpened", { rainId: 1n, endsAt: 99n, amount: 7n }, 6n, 0, 4, RAIN),
      { ...rawLog("GameOpened", { gameId: 77n, tier: 1, entry: 1n }, 7n, 0, 5), topics: ["0x" + "11".repeat(32)] as unknown as RawLog["topics"] }, // foreign topic: ignored
    ];
    const ix = mkIndexer(reader, new MemBus(), 1n, 0); // nowSec=0 => nothing "fresh", no publish
    await ix.syncOnce();
    expect(await db.select().from(rawEvents)).toHaveLength(4);
    expect((await db.select().from(players))[0]).toMatchObject({ address: P1, wageredWei: E3.toString() });

    // rewind the cursor and sync again: raw_events dedupes everything
    const { indexerCursor } = await import("../db/schema.js");
    await db.update(indexerCursor).set({ blockNumber: 0 });
    await ix.syncOnce();
    expect(await db.select().from(rawEvents)).toHaveLength(4);
    expect((await db.select().from(players))[0]).toMatchObject({ wageredWei: E3.toString() });
    expect(await db.select().from(picks)).toHaveLength(1);
  });

  it("publishes fresh finalized events (incl. rooms + game snapshot) but never replays old history", async () => {
    const reader = new FakeReader();
    reader.head = 10n;
    reader.logs = [
      rawLog("GameOpened", { gameId: 1n, tier: 0, entry: E3 }, 3n, 0, 1),
      rawLog("SeatTaken", { gameId: 1n, seat: 0, player: P1 }, 4n, 0, 2),
      rawLog("PickPlaced", { gameId: 1n, round: 1, seat: 0, x: 1, y: 2, pickCount: 1 }, 5n, 0, 3),
    ];
    const old = new MemBus();
    await mkIndexer(reader, old, 1n, 1_000_000 + 4 + 3600).syncOnce(); // chain time is an hour ahead of the events
    expect(old.out).toHaveLength(0);

    ({ db } = await createTestDb());
    const bus = new MemBus();
    await mkIndexer(reader, bus, 1n, 1_000_000 + 10).syncOnce();
    const kinds = bus.out.map((e) => `${e.channel}:${e.msg.t}`);
    expect(kinds).toContain("game:1:seat");
    expect(kinds).toContain("chat:sys");
    expect(kinds).toContain("game:1:pick");
    expect(kinds).toContain("rooms:rooms");
    expect(bus.out.find((e) => e.msg.t === "pick")?.msg).toMatchObject({ speculative: false });
  });

  it("recovers from transient RPC errors with bounded retries, and surfaces persistent ones", async () => {
    const reader = new FakeReader();
    reader.head = 5n;
    const ix = mkIndexer(reader, new MemBus());
    reader.failNext = 2;
    await ix.syncOnce();
    expect((await readCursor(db))?.blockNumber).toBe(5n);
    reader.head = 9n;
    reader.failNext = 10;
    await expect(ix.syncOnce()).rejects.toThrow(/getLogs 6-9 failed/);
    expect((await readCursor(db))?.blockNumber).toBe(5n); // cursor untouched
  });

  it("speculative stream publishes pick messages only, once per log", async () => {
    const bus = new MemBus();
    const ix = mkIndexer(new FakeReader(), bus);
    const wire = (l: RawLog) => ({
      address: l.address, topics: [...l.topics], data: l.data, blockNumber: "0x5" as const,
      blockHash: l.blockHash, transactionHash: l.transactionHash, logIndex: "0x0" as const,
    });
    const pick = wire(rawLog("PickPlaced", { gameId: 1n, round: 1, seat: 2, x: 9, y: 8, pickCount: 1 }, 5n, 0, 3));
    ix.injectSpeculative(pick);
    ix.injectSpeculative(pick); // Proposed -> Voted -> Finalized re-delivery
    ix.injectSpeculative(wire(rawLog("SeatTaken", { gameId: 1n, seat: 2, player: P1 }, 5n, 1, 3)));
    ix.injectSpeculative({ ...pick, removed: true });
    await new Promise((r) => setTimeout(r, 10));
    expect(bus.out).toEqual([{ channel: "game:1", msg: { t: "pick", gameId: "1", round: 1, seat: 2, x: 9, y: 8, pickCount: 1, speculative: true } }]);
  });
});

void ROYALE;
