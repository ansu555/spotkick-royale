import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { encodeAbiParameters, keccak256, parseAbiParameters } from "viem";
import type { GameSnapshot, Outcome, PhaseName, RoomInfo } from "../protocol.js";
import type { TierProvider } from "../config/clients.js";
import { PHASE_NAMES } from "../indexer/decode.js";
import { recomputeRound } from "../fair/verifier.js";
import type { DB } from "./client.js";
import { cashouts, games, picks, players, rain, rounds, seats, wins } from "./schema.js";

export function asPhase(s: string): PhaseName {
  if ((PHASE_NAMES as readonly string[]).includes(s)) return s as PhaseName;
  throw new Error(`unknown phase in DB: ${s}`);
}
const asOutcome = (s: string): Outcome => {
  if (s === "goal" || s === "saved") return s;
  throw new Error(`unknown outcome in DB: ${s}`);
};

export const TERMINAL_PHASES = ["finished", "cancelled"] as const;

// ---------------------------------------------------------------------------------------------- snapshots

export interface Snapshots {
  rooms(): Promise<RoomInfo[]>;
  game(gameId: string): Promise<GameSnapshot | null>;
}

export function createSnapshots(db: DB, tiers: TierProvider): Snapshots {
  return {
    async rooms(): Promise<RoomInfo[]> {
      const list = await tiers.tiers();
      return Promise.all(
        list.map(async (t): Promise<RoomInfo> => {
          const rows = await db
            .select()
            .from(games)
            .where(eq(games.tier, t.tier))
            .orderBy(sql`(${games.phase} = 'lobby') DESC`, desc(games.id))
            .limit(1);
          const g = rows[0];
          if (!g) return { tier: t.tier, valueWei: t.valueWei.toString(), gameId: null, phase: "none", seatsFilled: 0, phaseEndsAt: 0 };
          return {
            tier: t.tier, valueWei: t.valueWei.toString(), gameId: g.id.toString(), phase: asPhase(g.phase),
            seatsFilled: g.seatsFilled, phaseEndsAt: g.phaseEndsAt,
          };
        }),
      );
    },

    async game(gameId: string): Promise<GameSnapshot | null> {
      if (!/^\d{1,20}$/.test(gameId)) return null;
      const id = BigInt(gameId);
      const g = (await db.select().from(games).where(eq(games.id, id)).limit(1))[0];
      if (!g) return null;
      const [seatRows, pickRows, roundRows] = await Promise.all([
        db.select().from(seats).where(eq(seats.gameId, id)),
        db.select().from(picks).where(and(eq(picks.gameId, id), eq(picks.round, g.round))).orderBy(asc(picks.seat), desc(picks.pickCount)),
        db.select().from(rounds).where(eq(rounds.gameId, id)).orderBy(asc(rounds.round)),
      ]);
      const seatList: (string | null)[] = Array.from({ length: 10 }, () => null);
      for (const s of seatRows) if (!s.left && s.seat >= 0 && s.seat < 10) seatList[s.seat] = s.player;
      const latest = new Map<number, (typeof pickRows)[number]>();
      for (const p of pickRows) if (!latest.has(p.seat)) latest.set(p.seat, p); // rows ordered pickCount desc per seat
      return {
        gameId: g.id.toString(), tier: g.tier, phase: asPhase(g.phase), round: g.round, entryWei: g.entryWei, potWei: g.potWei,
        aliveMask: g.aliveMask, phaseEndsAt: g.phaseEndsAt, seats: seatList,
        picks: [...latest.values()].map((p) => ({ seat: p.seat, x: p.x, y: p.y, ...(p.auto ? { auto: true } : {}) })),
        results: roundRows.flatMap((r) =>
          r.outcome && r.targetX !== null && r.targetY !== null && r.survivorMask !== null && r.radiusMm !== null && r.saveBps !== null
            ? [{ round: r.round, targetX: r.targetX, targetY: r.targetY, outcome: asOutcome(r.outcome), survivorMask: r.survivorMask, radiusMm: r.radiusMm, saveBps: r.saveBps }]
            : [],
        ),
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------- REST reads

export interface GameReplay {
  game: {
    id: string; tier: number; entryWei: string; phase: PhaseName; round: number; potWei: string; playersAtStart: number | null;
    openedAt: number; startedAt: number | null; finishedAt: number | null; refundPerSeatWei: string | null;
  };
  seats: { seat: number; player: string; left: boolean; cashedOutRound: number | null; cashoutWei: string | null }[];
  rounds: {
    round: number;
    picks: { seat: number; x: number; y: number; auto: boolean }[];
    result: { targetX: number; targetY: number; outcome: Outcome; survivorMask: number; radiusMm: number; saveBps: number; nextPhaseAt: number | null } | null;
  }[];
  cashouts: { round: number; seat: number; player: string; amountWei: string; ts: number; txHash: string }[];
  winner: { seat: number; player: string; prizeWei: string; rounds: number } | null;
}

export async function getGameReplay(db: DB, id: bigint): Promise<GameReplay | null> {
  const g = (await db.select().from(games).where(eq(games.id, id)).limit(1))[0];
  if (!g) return null;
  const [seatRows, pickRows, roundRows, cashRows] = await Promise.all([
    db.select().from(seats).where(eq(seats.gameId, id)).orderBy(asc(seats.seat)),
    db.select().from(picks).where(eq(picks.gameId, id)).orderBy(asc(picks.round), asc(picks.seat), desc(picks.pickCount)),
    db.select().from(rounds).where(eq(rounds.gameId, id)).orderBy(asc(rounds.round)),
    db.select().from(cashouts).where(eq(cashouts.gameId, id)).orderBy(asc(cashouts.ts), asc(cashouts.logIndex)),
  ]);
  const finalPicks = new Map<string, (typeof pickRows)[number]>();
  for (const p of pickRows) {
    const k = `${p.round}:${p.seat}`;
    if (!finalPicks.has(k)) finalPicks.set(k, p);
  }
  return {
    game: {
      id: g.id.toString(), tier: g.tier, entryWei: g.entryWei, phase: asPhase(g.phase), round: g.round, potWei: g.potWei,
      playersAtStart: g.playersAtStart, openedAt: g.openedAt, startedAt: g.startedAt, finishedAt: g.finishedAt,
      refundPerSeatWei: g.refundPerSeatWei,
    },
    seats: seatRows.map((s) => ({ seat: s.seat, player: s.player, left: s.left, cashedOutRound: s.cashedOutRound, cashoutWei: s.cashoutWei })),
    rounds: roundRows.map((r) => ({
      round: r.round,
      picks: [...finalPicks.values()].filter((p) => p.round === r.round).map((p) => ({ seat: p.seat, x: p.x, y: p.y, auto: p.auto })),
      result:
        r.outcome && r.targetX !== null && r.targetY !== null && r.survivorMask !== null && r.radiusMm !== null && r.saveBps !== null
          ? { targetX: r.targetX, targetY: r.targetY, outcome: asOutcome(r.outcome), survivorMask: r.survivorMask, radiusMm: r.radiusMm, saveBps: r.saveBps, nextPhaseAt: r.nextPhaseAt }
          : null,
    })),
    cashouts: cashRows.map((c) => ({ round: c.round, seat: c.seat, player: c.player, amountWei: c.amountWei, ts: c.ts, txHash: c.txHash })),
    winner: g.winner && g.prizeWei !== null && g.winnerSeat !== null && g.roundsPlayed !== null
      ? { seat: g.winnerSeat, player: g.winner, prizeWei: g.prizeWei, rounds: g.roundsPlayed }
      : null,
  };
}

export interface FairRound {
  round: number;
  picksHash: string | null;
  entropyRequestId: string | null;
  seed: string | null;
  userRandomness: string | null;
  /** on-chain values emitted by RoundResolved */
  target: { x: number; y: number } | null;
  outcome: Outcome | null;
  saveBps: number | null;
  survivorMask: number | null;
  txHashes: { started: string | null; locked: string | null; seed: string | null; resolved: string | null };
  /** server re-derivation from seed + picks + alive mask (null when the round never resolved) */
  recomputed: {
    target: { x: number; y: number };
    outcome: Outcome;
    saveBps: number;
    survivorMask: number;
    survivorSeats: number[];
  } | null;
  /** true iff the re-derived target/outcome/saveBps/survivors all match the on-chain values */
  verified: boolean;
}

/** keccak256(abi.encode(gameId, round, picksHash)) -- INTERFACES.md section 2 item 7. */
export function userRandomnessOf(gameId: bigint, round: number, picksHash: `0x${string}`): `0x${string}` {
  return keccak256(encodeAbiParameters(parseAbiParameters("uint64, uint8, bytes32"), [gameId, round, picksHash]));
}

export async function getFair(db: DB, id: bigint): Promise<FairRound[] | null> {
  const g = (await db.select({ id: games.id }).from(games).where(eq(games.id, id)).limit(1))[0];
  if (!g) return null;
  const [rs, pickRows] = await Promise.all([
    db.select().from(rounds).where(eq(rounds.gameId, id)).orderBy(asc(rounds.round)),
    db
      .select()
      .from(picks)
      .where(and(eq(picks.gameId, id), eq(picks.auto, false)))
      .orderBy(asc(picks.round), asc(picks.seat), desc(picks.pickCount)),
  ]);
  // final explicit pick per (round, seat): rows are ordered pickCount desc, so first wins.
  const byRound = new Map<number, { seat: number; x: number; y: number }[]>();
  for (const p of pickRows) {
    const list = byRound.get(p.round) ?? [];
    if (!list.some((q) => q.seat === p.seat)) list.push({ seat: p.seat, x: p.x, y: p.y });
    byRound.set(p.round, list);
  }
  return rs.map((r) => {
    const onTarget = r.targetX !== null && r.targetY !== null ? { x: r.targetX, y: r.targetY } : null;
    const onOutcome = r.outcome ? asOutcome(r.outcome) : null;
    const onBps = r.saveBps;
    const onMask = r.survivorMask;
    const recomputed = recomputeRound({
      seed: r.seed,
      aliveMask: r.aliveMask,
      picks: byRound.get(r.round) ?? [],
    });
    const verified =
      recomputed !== null &&
      onTarget !== null &&
      onOutcome !== null &&
      onBps !== null &&
      onMask !== null &&
      recomputed.target.x === onTarget.x &&
      recomputed.target.y === onTarget.y &&
      recomputed.outcome === onOutcome &&
      recomputed.saveBps === onBps &&
      recomputed.survivorMask === onMask;
    return {
      round: r.round,
      picksHash: r.picksHash,
      entropyRequestId: r.entropyRequestId,
      seed: r.seed,
      userRandomness: r.picksHash ? userRandomnessOf(id, r.round, r.picksHash as `0x${string}`) : null,
      target: onTarget,
      outcome: onOutcome,
      saveBps: onBps,
      survivorMask: onMask,
      txHashes: { started: r.startedTx, locked: r.lockedTx, seed: r.seedTx, resolved: r.resolvedTx },
      recomputed,
      verified,
    };
  });
}

export interface PlayerStats {
  address: string;
  wagered: string;
  won: string;
  games: number;
  cashouts: number;
  bestMultiple: number;
}

export async function getPlayer(db: DB, address: string): Promise<PlayerStats> {
  const a = address.toLowerCase();
  const p = (await db.select().from(players).where(eq(players.address, a)).limit(1))[0];
  return p
    ? { address: a, wagered: p.wageredWei, won: p.wonWei, games: p.games, cashouts: p.cashouts, bestMultiple: p.bestMultiple }
    : { address: a, wagered: "0", won: "0", games: 0, cashouts: 0, bestMultiple: 0 };
}

export interface LeaderRow {
  rank: number;
  address: string;
  wonWei: string;
  games: number;
}

/** window "all" reads the players aggregate; "7d" sums cashouts + wins inside the window. */
export async function getLeaderboard(db: DB, window: "7d" | "all", nowSec: number, limit = 50): Promise<LeaderRow[]> {
  if (window === "all") {
    const rows = await db.select().from(players).where(ne(players.wonWei, "0")).orderBy(desc(players.wonWei)).limit(limit);
    return rows.map((r, i) => ({ rank: i + 1, address: r.address, wonWei: r.wonWei, games: r.games }));
  }
  const since = nowSec - 7 * 86400;
  const res = (await db.execute(sql`
    SELECT address, SUM(amount)::text AS won, COUNT(*)::text AS games FROM (
      SELECT player AS address, amount_wei AS amount FROM ${cashouts} WHERE ts >= ${since}
      UNION ALL
      SELECT winner AS address, prize_wei AS amount FROM ${wins} WHERE ts >= ${since}
    ) t GROUP BY address ORDER BY SUM(amount) DESC LIMIT ${limit}`)) as unknown as { rows: { address: string; won: string; games: string }[] };
  return res.rows.map((r, i) => ({ rank: i + 1, address: r.address, wonWei: r.won, games: Number(r.games) }));
}

export interface WinRow {
  gameId: string;
  winner: string;
  prizeWei: string;
  entryWei: string;
  rounds: number;
  ts: number;
  txHash: string;
}

export async function getWins(db: DB, limit: number): Promise<WinRow[]> {
  const rows = await db.select().from(wins).orderBy(desc(wins.ts), desc(wins.gameId)).limit(limit);
  return rows.map((w) => ({ gameId: w.gameId.toString(), winner: w.winner, prizeWei: w.prizeWei, entryWei: w.entryWei, rounds: w.rounds, ts: w.ts, txHash: w.txHash }));
}

/** Non-terminal game ids the driver should watch (DB view; the driver also asks the chain for open tier games). */
export async function activeGameIds(db: DB): Promise<bigint[]> {
  const rows = await db.select({ id: games.id }).from(games).where(sql`${games.phase} NOT IN ('finished','cancelled')`);
  return rows.map((r) => r.id);
}

export async function lockedAtOf(db: DB, gameId: bigint, round: number): Promise<number | null> {
  const r = (await db.select({ at: rounds.lockedAt }).from(rounds).where(and(eq(rounds.gameId, gameId), eq(rounds.round, round))).limit(1))[0];
  return r?.at ?? null;
}

export async function entryMap(db: DB, ids: readonly bigint[]): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  if (ids.length === 0) return out;
  const rows = await db.select({ id: games.id, entry: games.entryWei }).from(games).where(inArray(games.id, [...ids]));
  for (const r of rows) out.set(r.id.toString(), BigInt(r.entry));
  return out;
}

export async function rainMap(db: DB, ids: readonly bigint[]): Promise<Map<string, { amountWei: bigint; joined: number; endsAt: number; settled: boolean }>> {
  const out = new Map<string, { amountWei: bigint; joined: number; endsAt: number; settled: boolean }>();
  if (ids.length === 0) return out;
  const rows = await db.select().from(rain).where(inArray(rain.rainId, [...ids]));
  for (const r of rows) out.set(r.rainId.toString(), { amountWei: BigInt(r.amountWei), joined: r.joined, endsAt: r.endsAt, settled: r.settled });
  return out;
}
