import { decodeEventLog, type DecodeEventLogReturnType, type Hex } from "viem";
import { eventsAbi } from "../abi.js";

type Decoded = DecodeEventLogReturnType<typeof eventsAbi, undefined, Hex[], Hex, true>;

export interface LogMeta {
  txHash: Hex;
  logIndex: number;
  blockNumber: bigint;
  blockHash: Hex;
  address: Hex;
  /** unix seconds of the containing block (filled by the indexer after decoding) */
  blockTimestamp: bigint;
}

export type ChainEvent = Decoded & LogMeta;
export type EventName = ChainEvent["eventName"];

export class UnknownOutcomeError extends Error {
  constructor(public code: number) {
    super(`unknown Outcome code ${code} (expected 1=Goal, 2=Saved)`);
    this.name = "UnknownOutcomeError";
  }
}

export function outcomeName(code: number): "goal" | "saved" {
  if (code === 1) return "goal";
  if (code === 2) return "saved";
  throw new UnknownOutcomeError(code);
}

export const PHASE_NAMES = ["none", "lobby", "picking", "locked", "resolved", "between", "finished", "cancelled"] as const;

export interface RawLog {
  address: Hex;
  topics: readonly Hex[];
  data: Hex;
  blockNumber: bigint | null;
  blockHash: Hex | null;
  transactionHash: Hex | null;
  logIndex: number | null;
}

/** Decodes a raw log with the royale+rain ABI. Returns null for logs that aren't ours (or removed/pending). */
export function decodeLog(log: RawLog, blockTimestamp: bigint): ChainEvent | null {
  if (log.transactionHash == null || log.logIndex == null || log.blockNumber == null || log.blockHash == null) return null;
  if (log.topics.length === 0) return null;
  let decoded: Decoded;
  try {
    decoded = decodeEventLog({
      abi: eventsAbi,
      data: log.data,
      topics: log.topics as [Hex, ...Hex[]],
      strict: true,
    });
  } catch {
    return null; // unknown topic0 for this ABI (e.g. an unrelated event from the same address): not an error
  }
  return {
    ...decoded,
    txHash: log.transactionHash,
    logIndex: log.logIndex,
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    address: log.address,
    blockTimestamp,
  } as ChainEvent;
}

/** JSON-safe args for raw_events.args (bigints as decimal strings). */
export function jsonArgs(ev: ChainEvent): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  const args = (ev as { args: Record<string, unknown> }).args;
  for (const [k, v] of Object.entries(args)) {
    out[k] = typeof v === "bigint" ? v.toString() : (v as string | number | boolean);
  }
  return out;
}

/** Game id (as decimal string) an event belongs to, if any. */
export function gameIdOf(ev: ChainEvent): bigint | null {
  const a = (ev as { args: Record<string, unknown> }).args;
  return typeof a.gameId === "bigint" ? a.gameId : null;
}
