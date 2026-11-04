// Test helpers: build typed ChainEvents and encoded raw logs.
import { encodeAbiParameters, encodeEventTopics, type AbiEvent, type Hex } from "viem";
import { eventsAbi } from "../abi.js";
import type { ChainEvent, RawLog } from "./decode.js";

export const ROYALE = "0x00000000000000000000000000000000000000a1" as const;
export const RAIN = "0x00000000000000000000000000000000000000a2" as const;
export const P1 = "0x00000000000000000000000000000000000000b1" as const;
export const P2 = "0x00000000000000000000000000000000000000b2" as const;
export const P3 = "0x00000000000000000000000000000000000000b3" as const;

const hex = (n: number | bigint, bytes = 32): Hex => `0x${BigInt(n).toString(16).padStart(bytes * 2, "0")}`;

export function metaFor(block: bigint, logIndex: number, ts: bigint, tx = 1) {
  return {
    txHash: hex(tx),
    logIndex,
    blockNumber: block,
    blockHash: hex(block + 1000n),
    address: ROYALE as Hex,
    blockTimestamp: ts,
  };
}

/** Builds a ChainEvent (decoded form). `args` is loosely typed on purpose; tests assert behaviour. */
export function ev(eventName: ChainEvent["eventName"], args: Record<string, unknown>, block = 100n, logIndex = 0, ts = 1_000n, tx = 1): ChainEvent {
  return { eventName, args, ...metaFor(block, logIndex, ts, tx) } as unknown as ChainEvent;
}

/** Encodes an event as a raw log (what eth_getLogs returns). */
export function rawLog(eventName: string, args: Record<string, unknown>, block: bigint, logIndex: number, tx = 1, address: Hex = ROYALE): RawLog {
  const item = eventsAbi.find((i): i is Extract<(typeof eventsAbi)[number], { type: "event" }> => i.type === "event" && i.name === eventName);
  if (!item) throw new Error(`no such event ${eventName}`);
  const topics = encodeEventTopics({ abi: [item as AbiEvent], eventName, args } as never) as Hex[];
  const nonIndexed = item.inputs.filter((i) => !("indexed" in i && i.indexed));
  const data = nonIndexed.length === 0 ? "0x" : encodeAbiParameters(nonIndexed, nonIndexed.map((i) => args[i.name as string]) as never);
  return { address, topics, data, blockNumber: block, blockHash: hex(block + 1000n), transactionHash: hex(tx), logIndex };
}
