// Applies decoded chain events to Postgres. Idempotent per (txHash, logIndex) via raw_events, and the cursor
// advances in the same transaction, so a crash at any point resumes exactly where it stopped.
import { and, eq, sql } from "drizzle-orm";
import type { ChainEvent } from "../indexer/decode.js";
import { jsonArgs, outcomeName } from "../indexer/decode.js";
import { cashouts, games, indexerCursor, picks, players, rain, rawEvents, rounds, seats, wins } from "./schema.js";
import type { DB } from "./client.js";

export class MissingGameError extends Error {
  constructor(public gameId: bigint, public eventName: string) {
    super(`event ${eventName} references unknown game ${gameId} (is START_BLOCK before the contract deployment block?)`);
    this.name = "MissingGameError";
  }
}

type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

const bit = (seat: number): number => 1 << seat;
const ts = (ev: ChainEvent): number => Number(ev.blockTimestamp);
const lower = (a: string): string => a.toLowerCase();

async function entryOf(tx: Tx, gameId: bigint, eventName: string): Promise<bigint> {
  const rows = await tx.select({ entry: games.entryWei }).from(games).where(eq(games.id, gameId)).limit(1);
  const row = rows[0];
  if (!row) throw new MissingGameError(gameId, eventName);
  return BigInt(row.entry);
}

async function upsertRound(tx: Tx, gameId: bigint, round: number, patch: Partial<typeof rounds.$inferInsert>): Promise<void> {
  await tx
    .insert(rounds)
    .values({ gameId, round, ...patch })
    .onConflictDoUpdate({ target: [rounds.gameId, rounds.round], set: patch });
}

async function addPlayerStats(
  tx: Tx,
  address: string,
  d: { wagered?: bigint; won?: bigint; games?: number; cashouts?: number; multiple?: number },
): Promise<void> {
  const w = (d.wagered ?? 0n).toString();
  const won = (d.won ?? 0n).toString();
  const m = d.multiple ?? 0;
  await tx
    .insert(players)
    .values({
      address,
      wageredWei: sql`GREATEST(${w}::numeric, 0)`,
      wonWei: won,
      games: d.games ?? 0,
      cashouts: d.cashouts ?? 0,
      bestMultiple: m,
    })
    .onConflictDoUpdate({
      target: players.address,
      set: {
        wageredWei: sql`GREATEST(${players.wageredWei} + ${w}::numeric, 0)`,
        wonWei: sql`${players.wonWei} + ${won}::numeric`,
        games: sql`${players.games} + ${d.games ?? 0}`,
        cashouts: sql`${players.cashouts} + ${d.cashouts ?? 0}`,
        bestMultiple: sql`GREATEST(${players.bestMultiple}, ${m})`,
      },
    });
}

const mult = (amount: bigint, entry: bigint): number => (entry === 0n ? 0 : Number((amount * 100n) / entry) / 100);

/** Applies one event's effect on derived state. Caller guarantees at-most-once via raw_events. */
export async function applyEvent(tx: Tx, ev: ChainEvent): Promise<void> {
  switch (ev.eventName) {
    case "GameOpened": {
      const a = ev.args;
      await tx
        .insert(games)
        .values({
          id: a.gameId, tier: a.tier, entryWei: a.entry.toString(), phase: "lobby",
          openedBlock: Number(ev.blockNumber), openedAt: ts(ev),
        })
        .onConflictDoNothing();
      return;
    }
    case "SeatTaken": {
      const a = ev.args;
      const entry = await entryOf(tx, a.gameId, ev.eventName);
      const player = lower(a.player);
      await tx
        .insert(seats)
        .values({ gameId: a.gameId, seat: a.seat, player, left: false, takenAt: ts(ev) })
        .onConflictDoUpdate({
          target: [seats.gameId, seats.seat],
          set: { player, left: false, takenAt: ts(ev), cashedOutRound: null, cashoutWei: null },
        });
      await tx
        .update(games)
        .set({ seatsFilled: sql`${games.seatsFilled} + 1`, aliveMask: sql`${games.aliveMask} | ${bit(a.seat)}` })
        .where(eq(games.id, a.gameId));
      await addPlayerStats(tx, player, { wagered: entry });
      return;
    }
    case "SeatLeft": {
      const a = ev.args;
      const entry = await entryOf(tx, a.gameId, ev.eventName);
      await tx.update(seats).set({ left: true }).where(and(eq(seats.gameId, a.gameId), eq(seats.seat, a.seat)));
      await tx
        .update(games)
        .set({ seatsFilled: sql`GREATEST(${games.seatsFilled} - 1, 0)`, aliveMask: sql`${games.aliveMask} & ${~bit(a.seat)}` })
        .where(eq(games.id, a.gameId));
      await addPlayerStats(tx, lower(a.player), { wagered: -entry });
      return;
    }
    case "LobbyCountdownStarted":
      await tx
        .update(games)
        .set({ countdownStartsAt: Number(ev.args.startsAt), phaseEndsAt: Number(ev.args.startsAt) })
        .where(eq(games.id, ev.args.gameId));
      return;
    case "GameStarted": {
      const a = ev.args;
      await tx
        .update(games)
        .set({
          potWei: a.pot.toString(), playersAtStart: a.players, startedAt: ts(ev),
          phase: sql`CASE WHEN ${games.phase} = 'lobby' THEN 'picking' ELSE ${games.phase} END`,
        })
        .where(eq(games.id, a.gameId));
      const seated = await tx
        .select({ player: seats.player })
        .from(seats)
        .where(and(eq(seats.gameId, a.gameId), eq(seats.left, false)));
      for (const s of seated) await addPlayerStats(tx, s.player, { games: 1 });
      return;
    }
    case "GameCancelled":
      await tx
        .update(games)
        .set({ phase: "cancelled", phaseEndsAt: 0, finishedAt: ts(ev) })
        .where(eq(games.id, ev.args.gameId));
      return;
    case "RoundStarted": {
      const a = ev.args;
      await tx
        .update(games)
        .set({ phase: "picking", round: a.round, phaseEndsAt: Number(a.pickDeadline), aliveMask: a.aliveMask })
        .where(eq(games.id, a.gameId));
      await upsertRound(tx, a.gameId, a.round, { pickDeadline: Number(a.pickDeadline), aliveMask: a.aliveMask, startedTx: ev.txHash });
      return;
    }
    case "PickPlaced": {
      const a = ev.args;
      await tx
        .insert(picks)
        .values({
          gameId: a.gameId, round: a.round, seat: a.seat, pickCount: a.pickCount, x: a.x, y: a.y,
          auto: false, txHash: ev.txHash, blockNumber: Number(ev.blockNumber),
        })
        .onConflictDoNothing();
      return;
    }
    case "AutoPicked": {
      const a = ev.args;
      await tx
        .insert(picks)
        .values({
          gameId: a.gameId, round: a.round, seat: a.seat, pickCount: 0, x: a.x, y: a.y,
          auto: true, txHash: ev.txHash, blockNumber: Number(ev.blockNumber),
        })
        .onConflictDoNothing();
      return;
    }
    case "RoundLocked": {
      const a = ev.args;
      await tx.update(games).set({ phase: "locked", phaseEndsAt: 0 }).where(eq(games.id, a.gameId));
      await upsertRound(tx, a.gameId, a.round, {
        picksHash: a.picksHash, entropyRequestId: a.entropyRequestId.toString(), lockedAt: ts(ev), lockedTx: ev.txHash,
      });
      return;
    }
    case "SeedReceived": {
      const a = ev.args;
      await tx.update(games).set({ phase: "resolved", phaseEndsAt: 0 }).where(eq(games.id, a.gameId));
      await upsertRound(tx, a.gameId, a.round, { seed: a.seed, seedTx: ev.txHash });
      return;
    }
    case "RoundResolved": {
      const a = ev.args;
      const outcome = outcomeName(a.outcome);
      await tx
        .update(games)
        .set({ phase: "between", phaseEndsAt: Number(a.nextPhaseAt), aliveMask: a.survivorMask })
        .where(eq(games.id, a.gameId));
      await upsertRound(tx, a.gameId, a.round, {
        targetX: a.targetX, targetY: a.targetY, outcome, survivorMask: a.survivorMask, radiusMm: a.radiusMm,
        saveBps: a.saveBps, nextPhaseAt: Number(a.nextPhaseAt), resolvedTx: ev.txHash,
      });
      return;
    }
    case "CashedOut": {
      const a = ev.args;
      const entry = await entryOf(tx, a.gameId, ev.eventName);
      const player = lower(a.player);
      await tx
        .insert(cashouts)
        .values({
          txHash: ev.txHash, logIndex: ev.logIndex, gameId: a.gameId, round: a.round, seat: a.seat,
          player, amountWei: a.amount.toString(), ts: ts(ev),
        })
        .onConflictDoNothing();
      await tx
        .update(seats)
        .set({ cashedOutRound: a.round, cashoutWei: a.amount.toString() })
        .where(and(eq(seats.gameId, a.gameId), eq(seats.seat, a.seat)));
      await tx
        .update(games)
        .set({
          potWei: sql`GREATEST(${games.potWei} - ${a.amount.toString()}::numeric, 0)`,
          aliveMask: sql`${games.aliveMask} & ${~bit(a.seat)}`,
        })
        .where(eq(games.id, a.gameId));
      await addPlayerStats(tx, player, { won: a.amount, cashouts: 1, multiple: mult(a.amount, entry) });
      return;
    }
    case "GameFinished": {
      const a = ev.args;
      const entry = await entryOf(tx, a.gameId, ev.eventName);
      const winner = lower(a.winner);
      await tx
        .update(games)
        .set({
          phase: "finished", phaseEndsAt: 0, winner, winnerSeat: a.seat, prizeWei: a.prize.toString(),
          roundsPlayed: a.rounds, finishedAt: ts(ev), potWei: "0",
        })
        .where(eq(games.id, a.gameId));
      await tx
        .insert(wins)
        .values({
          gameId: a.gameId, winner, seat: a.seat, prizeWei: a.prize.toString(), entryWei: entry.toString(),
          rounds: a.rounds, ts: ts(ev), txHash: ev.txHash,
        })
        .onConflictDoNothing();
      await addPlayerStats(tx, winner, { won: a.prize, multiple: mult(a.prize, entry) });
      return;
    }
    case "GameRefunded":
      await tx
        .update(games)
        .set({ phase: "cancelled", phaseEndsAt: 0, refundPerSeatWei: ev.args.perSeat.toString(), finishedAt: ts(ev) })
        .where(eq(games.id, ev.args.gameId));
      return;
    case "RainOpened":
      await tx
        .insert(rain)
        .values({
          rainId: ev.args.rainId, endsAt: Number(ev.args.endsAt), amountWei: ev.args.amount.toString(), openedAt: ts(ev),
        })
        .onConflictDoNothing();
      return;
    case "RainFunded":
      await tx.update(rain).set({ amountWei: ev.args.total.toString() }).where(eq(rain.rainId, ev.args.rainId));
      return;
    case "RainJoined":
      await tx.update(rain).set({ joined: ev.args.joined }).where(eq(rain.rainId, ev.args.rainId));
      return;
    case "RainSettled":
      await tx
        .update(rain)
        .set({ settled: true, amountWei: ev.args.total.toString(), joined: ev.args.joined })
        .where(eq(rain.rainId, ev.args.rainId));
      return;
    case "RainClaimed":
      await tx
        .update(rain)
        .set({ claimedWei: sql`${rain.claimedWei} + ${ev.args.amount.toString()}::numeric` })
        .where(eq(rain.rainId, ev.args.rainId));
      return;
    case "Claimable":
    case "Withdrawn":
      return; // pull-payment accounting lives on-chain
  }
}

export interface BatchResult {
  /** events newly applied by this call (already-seen events are skipped) */
  applied: ChainEvent[];
}

export const CURSOR_FINALIZED = "finalized";

/**
 * Applies `events` (ordered) and advances the finalized cursor to `cursorBlock`, atomically.
 * Re-running the same batch applies nothing the second time.
 */
export async function applyBatch(
  db: DB,
  events: readonly ChainEvent[],
  cursor: { blockNumber: bigint; blockHash: string | null },
): Promise<BatchResult> {
  return db.transaction(async (tx) => {
    const applied: ChainEvent[] = [];
    for (const ev of events) {
      const inserted = await tx
        .insert(rawEvents)
        .values({
          txHash: ev.txHash, logIndex: ev.logIndex, blockNumber: Number(ev.blockNumber), blockHash: ev.blockHash,
          blockTimestamp: Number(ev.blockTimestamp), address: lower(ev.address), eventName: ev.eventName, args: jsonArgs(ev),
        })
        .onConflictDoNothing()
        .returning({ txHash: rawEvents.txHash });
      if (inserted.length === 0) continue;
      await applyEvent(tx, ev);
      applied.push(ev);
    }
    const now = Math.floor(Date.now() / 1000);
    await tx
      .insert(indexerCursor)
      .values({ name: CURSOR_FINALIZED, blockNumber: Number(cursor.blockNumber), blockHash: cursor.blockHash, updatedAt: now })
      .onConflictDoUpdate({
        target: indexerCursor.name,
        set: { blockNumber: Number(cursor.blockNumber), blockHash: cursor.blockHash, updatedAt: now },
        setWhere: sql`${indexerCursor.blockNumber} < ${Number(cursor.blockNumber)}`,
      });
    return { applied };
  });
}

export async function readCursor(db: DB): Promise<{ blockNumber: bigint; updatedAt: number } | null> {
  const rows = await db.select().from(indexerCursor).where(eq(indexerCursor.name, CURSOR_FINALIZED)).limit(1);
  const r = rows[0];
  return r ? { blockNumber: BigInt(r.blockNumber), updatedAt: r.updatedAt } : null;
}
