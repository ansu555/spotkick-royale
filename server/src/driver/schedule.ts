// Pure scheduling decisions. No I/O, no clocks: callers pass chain time (block timestamp, seconds).
import { Phase } from "../abi.js";

export type DriverFn = "startGame" | "lockPicks" | "resolveRound" | "advance" | "refundStalled";

export interface ChainGameState {
  gameId: bigint;
  phase: number; // Phase enum value from getGame
  round: number;
  seatsFilled: number;
  aliveMask: number;
  phaseEndsAt: bigint; // seconds, 0 if none
  /** Locked phase only: the entropy seed for this round has arrived (getRound().seed != 0). Set by the driver. */
  seedReady?: boolean;
}

export interface ScheduleParams {
  /** latest block timestamp (seconds) */
  nowSec: bigint;
  /** block timestamp of RoundLocked for the current round, if known */
  lockedAtSec: bigint | null;
  /** extra seconds past a deadline before acting (>= 1: block.timestamp has 1s granularity) */
  marginSec: bigint;
  stallTimeoutSec: bigint;
  entropyTimeoutSec: bigint;
}

export type Decision =
  | { kind: "act"; fn: DriverFn; reason: string }
  | { kind: "wait"; untilSec: bigint | null; reason: string };

export function popcount(mask: number): number {
  let n = 0;
  for (let m = mask & 0xffff; m; m &= m - 1) n++;
  return n;
}

/** How many seats a call touches (drives the gas limit). */
export function seatsInvolved(g: ChainGameState): number {
  const alive = popcount(g.aliveMask);
  return alive > 0 ? alive : Math.max(1, g.seatsFilled);
}

export function decide(g: ChainGameState, p: ScheduleParams): Decision {
  const margin = p.marginSec < 1n ? 1n : p.marginSec;
  const due = (deadline: bigint): boolean => p.nowSec >= deadline + margin;
  const wait = (untilSec: bigint | null, reason: string): Decision => ({ kind: "wait", untilSec, reason });

  switch (g.phase) {
    case Phase.Lobby: {
      if (g.phaseEndsAt === 0n) return wait(null, "lobby: countdown not started");
      if (due(g.phaseEndsAt + p.stallTimeoutSec)) return { kind: "act", fn: "refundStalled", reason: "lobby stalled past countdown" };
      if (due(g.phaseEndsAt)) return { kind: "act", fn: "startGame", reason: "lobby countdown elapsed" };
      return wait(g.phaseEndsAt + margin, "lobby: counting down");
    }
    case Phase.Picking: {
      if (g.phaseEndsAt === 0n) return wait(null, "picking: no deadline reported");
      if (due(g.phaseEndsAt + p.stallTimeoutSec)) return { kind: "act", fn: "refundStalled", reason: "picking stalled past deadline" };
      if (due(g.phaseEndsAt)) return { kind: "act", fn: "lockPicks", reason: "pick deadline passed" };
      return wait(g.phaseEndsAt + margin, "picking: window open");
    }
    case Phase.Locked: {
      // The contract stays Locked after the seed arrives; resolveRound is what moves it on.
      if (g.seedReady) return { kind: "act", fn: "resolveRound", reason: "seed received" };
      if (p.lockedAtSec === null) return wait(null, "locked: lock time unknown");
      const stalledAt = p.lockedAtSec + p.entropyTimeoutSec;
      if (due(stalledAt)) return { kind: "act", fn: "refundStalled", reason: "entropy seed not delivered in time" };
      return wait(stalledAt + margin, "locked: waiting for entropy seed");
    }
    case Phase.Resolved:
      return { kind: "act", fn: "resolveRound", reason: "seed received" };
    case Phase.Between: {
      if (g.phaseEndsAt === 0n) return wait(null, "between: no deadline reported");
      if (due(g.phaseEndsAt + p.stallTimeoutSec)) return { kind: "act", fn: "refundStalled", reason: "between stalled past deadline" };
      if (due(g.phaseEndsAt)) return { kind: "act", fn: "advance", reason: "cash-out window over" };
      return wait(g.phaseEndsAt + margin, "between: cash-out window");
    }
    default:
      return wait(null, `terminal or unknown phase ${g.phase}`);
  }
}

/** Exponential retry spacing after consecutive failures of the same action (ms), capped. */
export function retryDelayMs(failures: number, baseMs = 500, capMs = 15_000): number {
  if (failures <= 0) return 0;
  return Math.min(capMs, baseMs * 2 ** (failures - 1));
}

export function actionKey(g: ChainGameState, fn: DriverFn): string {
  return `${g.gameId}:${g.phase}:${g.round}:${fn}`;
}
