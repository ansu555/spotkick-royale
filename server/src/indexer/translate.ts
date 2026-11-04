// Pure translation of chain events into bus Envelopes (see protocol.ts). No I/O here.
import { formatEther } from "viem";
import type { Envelope, ServerMsg } from "../protocol.js";
import { outcomeName, type ChainEvent } from "./decode.js";

export interface RainState {
  amountWei: bigint;
  joined: number;
  endsAt: number;
  settled: boolean;
}

export interface TranslateCtx {
  /** gross entry per game id (decimal string), loaded from the DB after the batch was applied */
  entryWei: ReadonlyMap<string, bigint>;
  /** post-apply rain state per rain id */
  rain: ReadonlyMap<string, RainState>;
}

export function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/** wei -> "3", "0.25", "12.3456" MON (max 4 decimals, trailing zeros trimmed). */
export function formatMon(wei: bigint): string {
  const [i, f = ""] = formatEther(wei).split(".");
  const frac = f.slice(0, 4).replace(/0+$/, "");
  return frac ? `${i}.${frac}` : (i ?? "0");
}

/** payout multiple relative to the gross entry, 2 decimals; null if the entry is unknown/zero. */
export function multiple(amount: bigint, entry: bigint | undefined): number | null {
  if (entry === undefined || entry === 0n) return null;
  return Number((amount * 100n) / entry) / 100;
}

const gid = (g: bigint): string => g.toString();
const toNum = (b: bigint): number => Number(b);
const gameCh = (g: bigint): string => `game:${gid(g)}`;

/** The one message published from the speculative stream. */
export function pickEnvelope(ev: Extract<ChainEvent, { eventName: "PickPlaced" }>, speculative: boolean): Envelope {
  const a = ev.args;
  return {
    channel: gameCh(a.gameId),
    msg: { t: "pick", gameId: gid(a.gameId), round: a.round, seat: a.seat, x: a.x, y: a.y, pickCount: a.pickCount, speculative },
  };
}

/**
 * Translates an ordered batch of finalized events. AutoPicked events are accumulated and attached to the
 * RoundResolved that follows them (same tx). Channels: game:<id> for game flow, "chat" for sys lines,
 * "ticker" for ticker lines, "rain" for rain.
 */
export function translateEvents(events: readonly ChainEvent[], ctx: TranslateCtx): Envelope[] {
  const out: Envelope[] = [];
  const autoPicks = new Map<string, { seat: number; x: number; y: number }[]>(); // key gameId:round
  const push = (channel: string, msg: ServerMsg): void => void out.push({ channel, msg });
  const sys = (ev: ChainEvent, kind: "entry" | "cashout" | "winner" | "kickoff", html: string): void =>
    push("chat", { t: "sys", ts: Number(ev.blockTimestamp) * 1000, kind, html });

  for (const ev of events) {
    switch (ev.eventName) {
      case "SeatTaken": {
        const a = ev.args;
        push(gameCh(a.gameId), { t: "seat", gameId: gid(a.gameId), seat: a.seat, player: a.player.toLowerCase() });
        const entry = ctx.entryWei.get(gid(a.gameId));
        sys(ev, "entry", `<b>${shortAddr(a.player)}</b> took a seat${entry !== undefined ? ` at the <b>${formatMon(entry)} MON</b> table` : ""}`);
        break;
      }
      case "SeatLeft": {
        const a = ev.args;
        push(gameCh(a.gameId), { t: "seat", gameId: gid(a.gameId), seat: a.seat, player: a.player.toLowerCase(), left: true });
        break;
      }
      case "LobbyCountdownStarted":
        push(gameCh(ev.args.gameId), { t: "countdown", gameId: gid(ev.args.gameId), startsAt: toNum(ev.args.startsAt) });
        break;
      case "GameStarted": {
        const a = ev.args;
        sys(ev, "kickoff", `Kickoff! <b>${a.players}</b> players, pot <b>${formatMon(a.pot)} MON</b>`);
        break;
      }
      case "PickPlaced":
        out.push(pickEnvelope(ev, false));
        break;
      case "RoundLocked":
        push(gameCh(ev.args.gameId), { t: "locked", gameId: gid(ev.args.gameId), round: ev.args.round, picksHash: ev.args.picksHash });
        break;
      case "SeedReceived":
        push(gameCh(ev.args.gameId), { t: "seed", gameId: gid(ev.args.gameId), round: ev.args.round });
        break;
      case "AutoPicked": {
        const a = ev.args;
        const key = `${gid(a.gameId)}:${a.round}`;
        const list = autoPicks.get(key) ?? [];
        list.push({ seat: a.seat, x: a.x, y: a.y });
        autoPicks.set(key, list);
        break;
      }
      case "RoundResolved": {
        const a = ev.args;
        const key = `${gid(a.gameId)}:${a.round}`;
        push(gameCh(a.gameId), {
          t: "resolved",
          gameId: gid(a.gameId),
          round: a.round,
          targetX: a.targetX,
          targetY: a.targetY,
          outcome: outcomeName(a.outcome),
          survivorMask: a.survivorMask,
          radiusMm: a.radiusMm,
          saveBps: a.saveBps,
          nextPhaseAt: toNum(a.nextPhaseAt),
          autoPicks: (autoPicks.get(key) ?? []).sort((p, q) => p.seat - q.seat),
        });
        autoPicks.delete(key);
        break;
      }
      case "CashedOut": {
        const a = ev.args;
        const player = a.player.toLowerCase();
        push(gameCh(a.gameId), { t: "cashout", gameId: gid(a.gameId), round: a.round, seat: a.seat, player, amount: a.amount.toString() });
        const mult = multiple(a.amount, ctx.entryWei.get(gid(a.gameId)));
        if (mult !== null) push("ticker", { t: "ticker", user: shortAddr(player), amount: a.amount.toString(), mult, gameId: gid(a.gameId) });
        sys(ev, "cashout", `<b>${shortAddr(player)}</b> cashed out <b>${formatMon(a.amount)} MON</b>`);
        break;
      }
      case "GameFinished": {
        const a = ev.args;
        const winner = a.winner.toLowerCase();
        push(gameCh(a.gameId), { t: "finished", gameId: gid(a.gameId), seat: a.seat, winner, prize: a.prize.toString(), rounds: a.rounds });
        const mult = multiple(a.prize, ctx.entryWei.get(gid(a.gameId)));
        if (mult !== null) push("ticker", { t: "ticker", user: shortAddr(winner), amount: a.prize.toString(), mult, gameId: gid(a.gameId) });
        sys(ev, "winner", `<b>${shortAddr(winner)}</b> won <b>${formatMon(a.prize)} MON</b> in ${a.rounds} rounds`);
        break;
      }
      case "GameRefunded":
        push(gameCh(ev.args.gameId), { t: "refunded", gameId: gid(ev.args.gameId), perSeat: ev.args.perSeat.toString() });
        break;
      case "RainOpened":
      case "RainFunded":
      case "RainJoined":
      case "RainSettled": {
        const id = ev.args.rainId.toString();
        const r = ctx.rain.get(id);
        if (r) {
          push("rain", {
            t: "rain", rainId: id, amount: r.amountWei.toString(), joined: r.joined, endsAt: r.endsAt,
            ...(r.settled ? { settled: true } : {}),
          });
        }
        break;
      }
      // GameOpened / GameCancelled / RoundStarted: no dedicated ServerMsg (rooms + game snapshots cover them).
      // Claimable / Withdrawn / RainClaimed: accounting only.
      default:
        break;
    }
  }
  return out;
}

/** Events that change what a room card shows. */
const ROOM_EVENTS = new Set<string>([
  "GameOpened", "SeatTaken", "SeatLeft", "LobbyCountdownStarted", "GameStarted", "GameCancelled",
  "RoundStarted", "GameFinished", "GameRefunded",
]);
/** Events after which a fresh `game` snapshot is pushed (phase changes). */
const SNAPSHOT_EVENTS = new Set<string>([
  "GameStarted", "RoundStarted", "RoundLocked", "SeedReceived", "RoundResolved", "GameFinished", "GameCancelled", "GameRefunded",
  "LobbyCountdownStarted",
]);

export function affectsRooms(events: readonly ChainEvent[]): boolean {
  return events.some((e) => ROOM_EVENTS.has(e.eventName));
}

export function snapshotGameIds(events: readonly ChainEvent[]): string[] {
  const ids = new Set<string>();
  for (const e of events) {
    if (SNAPSHOT_EVENTS.has(e.eventName)) {
      const g = (e.args as { gameId?: bigint }).gameId;
      if (g !== undefined) ids.add(g.toString());
    }
  }
  return [...ids];
}
