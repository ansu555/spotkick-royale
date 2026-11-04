import { getAddress, type Hex } from "viem";
import type { ChainClient } from "../config/clients.js";
import type { Logger } from "../config/logger.js";
import { applyBatch, readCursor } from "../db/apply.js";
import type { DB } from "../db/client.js";
import { entryMap, rainMap, type Snapshots } from "../db/queries.js";
import type { Envelope } from "../protocol.js";
import type { Bus } from "./bus.js";
import { decodeLog, gameIdOf, type ChainEvent, type RawLog } from "./decode.js";
import { LiveFeed, wireToLog, type SpecMode, type WireLog } from "./live.js";
import { affectsRooms, pickEnvelope, snapshotGameIds, translateEvents } from "./translate.js";

/** Chain access needed by the indexer (viem-backed in prod, faked in tests). */
export interface ChainReader {
  /** highest block considered final */
  finalizedHead(): Promise<bigint>;
  /** inclusive range, caller guarantees to - from + 1 <= maxRange */
  getLogs(from: bigint, to: bigint): Promise<{ logs: RawLog[] }>;
  blockInfo(n: bigint): Promise<{ timestamp: bigint; hash: Hex }>;
}

export class IndexerSyncError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "IndexerSyncError";
  }
}

export const MAX_LOG_RANGE = 1000n; // eth_getLogs limit on Monad
const PUBLISH_MAX_AGE_SECS = 60; // never replay history onto the live bus during backfill
const SPEC_DEDUPE_CAP = 5000;

export interface IndexerOptions {
  db: DB;
  reader: ChainReader;
  bus: Bus;
  snapshots: Snapshots;
  log: Logger;
  startBlock: bigint;
  pollMs: number;
  /** returns seconds; injectable for tests */
  nowSec?: () => number;
  live?: { url: string; addresses: Hex[]; createSocket?: ConstructorParameters<typeof LiveFeed>[0]["createSocket"] };
}

export interface IndexerStatus {
  cursor: bigint | null;
  finalizedHead: bigint | null;
  lagBlocks: bigint | null;
  lastSyncAtMs: number | null;
  lastError: string | null;
  wsConnected: boolean;
  speculativeMode: SpecMode;
  running: boolean;
}

const RANGE_ERR = /range|limit|exceed|too many|too large|10000|1000/i;

export class Indexer {
  /** Background loop running flag (true when idle/stopped). */
  private stopped = true;
  /**
   * Set by stop() so an in-flight syncOnce can bail between chunks. Deliberately distinct from
   * `stopped`: a freshly-constructed indexer has `stopped === true` yet syncOnce() must still run
   * when called directly (unit tests + one-shot backfill). Using `stopped` to gate the chunk loop
   * made those direct calls silent no-ops, which was the bug behind the 4 failing syncOnce tests.
   */
  private stopping = false;
  private wake: (() => void) | null = null;
  private loopDone: Promise<void> = Promise.resolve();
  private feed: LiveFeed | null = null;
  private specSeen = new Set<string>();
  private chunk: bigint = MAX_LOG_RANGE;
  private st: IndexerStatus = {
    cursor: null, finalizedHead: null, lagBlocks: null, lastSyncAtMs: null, lastError: null,
    wsConnected: false, speculativeMode: "off", running: false,
  };
  private readonly nowSec: () => number;

  constructor(private readonly o: IndexerOptions) {
    this.nowSec = o.nowSec ?? ((): number => Math.floor(Date.now() / 1000));
  }

  status(): IndexerStatus {
    return { ...this.st, wsConnected: this.feed?.connected ?? false, speculativeMode: this.feed?.mode ?? "off" };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.stopping = false;
    this.st.running = true;
    if (this.o.live) {
      this.feed = new LiveFeed({
        url: this.o.live.url,
        addresses: this.o.live.addresses,
        log: this.o.log.child("ws"),
        createSocket: this.o.live.createSocket,
        onWake: () => this.wake?.(),
        onLog: (l, mode) => this.onSpeculative(l, mode),
      });
      this.feed.start();
    }
    this.loopDone = this.loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.stopping = true;
    this.feed?.stop();
    this.wake?.();
    await this.loopDone;
    this.st.running = false;
  }

  private async loop(): Promise<void> {
    let failures = 0;
    while (!this.stopped) {
      try {
        await this.syncOnce();
        failures = 0;
        this.st.lastError = null;
      } catch (e) {
        failures++;
        this.st.lastError = e instanceof Error ? e.message : String(e);
        this.o.log.error("sync failed", { err: e, failures });
      }
      const delay = failures === 0 ? this.o.pollMs : Math.min(500 * 2 ** failures, 30_000);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, delay);
        this.wake = (): void => {
          clearTimeout(t);
          resolve();
        };
      });
      this.wake = null;
    }
  }

  /** Backfills [cursor+1, finalizedHead] in <=1000-block chunks. Idempotent and resumable. Returns blocks covered. */
  async syncOnce(): Promise<bigint> {
    const head = await this.o.reader.finalizedHead();
    const cur = await readCursor(this.o.db);
    let from = cur ? cur.blockNumber + 1n : this.o.startBlock;
    this.st.finalizedHead = head;
    this.st.cursor = cur ? cur.blockNumber : from - 1n;
    let covered = 0n;
    // Gate on `stopping` (not `stopped`): syncOnce must be callable directly without start().
    while (from <= head && !this.stopping) {
      const to = from + this.chunk - 1n < head ? from + this.chunk - 1n : head;
      let fetched: { logs: RawLog[] };
      try {
        fetched = await this.fetchLogs(from, to);
      } catch (e) {
        if (RANGE_ERR.test(e instanceof Error ? e.message : "") && this.chunk > 1n) {
          this.chunk = this.chunk / 2n || 1n;
          this.o.log.warn("log range rejected, shrinking chunk", { chunk: this.chunk });
          continue;
        }
        throw new IndexerSyncError(`getLogs ${from}-${to} failed`, e);
      }
      await this.processChunk(fetched.logs, to);
      covered += to - from + 1n;
      from = to + 1n;
      this.st.cursor = to;
      this.st.lagBlocks = head - to;
      this.st.lastSyncAtMs = Date.now();
    }
    if (from > head) {
      this.st.lagBlocks = 0n;
      this.st.lastSyncAtMs = Date.now();
    }
    return covered;
  }

  private async fetchLogs(from: bigint, to: bigint): Promise<{ logs: RawLog[] }> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.o.reader.getLogs(from, to);
      } catch (e) {
        lastErr = e;
        if (RANGE_ERR.test(e instanceof Error ? e.message : "")) throw e;
        await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
      }
    }
    throw lastErr;
  }

  private async processChunk(logs: RawLog[], to: bigint): Promise<void> {
    const ordered = [...logs].sort((a, b) =>
      a.blockNumber === b.blockNumber ? (a.logIndex ?? 0) - (b.logIndex ?? 0) : Number((a.blockNumber ?? 0n) - (b.blockNumber ?? 0n)),
    );
    const blocks = new Map<bigint, { timestamp: bigint; hash: Hex }>();
    const events: ChainEvent[] = [];
    for (const l of ordered) {
      if (l.blockNumber === null) continue;
      let b = blocks.get(l.blockNumber);
      if (!b) {
        b = await this.o.reader.blockInfo(l.blockNumber);
        blocks.set(l.blockNumber, b);
      }
      const ev = decodeLog(l, b.timestamp);
      if (ev) events.push(ev);
    }
    const cursorHash = blocks.get(to)?.hash ?? null;
    const { applied } = await applyBatch(this.o.db, events, { blockNumber: to, blockHash: cursorHash });
    if (applied.length === 0) return;
    this.o.log.debug("applied events", { count: applied.length, to });
    const fresh = applied.filter((e) => this.nowSec() - Number(e.blockTimestamp) <= PUBLISH_MAX_AGE_SECS);
    if (fresh.length > 0) await this.publishFinalized(fresh);
  }

  private async publishFinalized(events: ChainEvent[]): Promise<void> {
    try {
      const gameIds = [...new Set(events.map(gameIdOf).filter((g): g is bigint => g !== null))];
      const rainIds = [
        ...new Set(events.flatMap((e) => ("rainId" in e.args ? [(e.args as { rainId: bigint }).rainId] : []))),
      ];
      const [entryWei, rain] = await Promise.all([entryMap(this.o.db, gameIds), rainMap(this.o.db, rainIds)]);
      const envs: Envelope[] = translateEvents(events, { entryWei, rain });
      for (const id of snapshotGameIds(events)) {
        const game = await this.o.snapshots.game(id);
        if (game) envs.push({ channel: `game:${id}`, msg: { t: "game", game } });
      }
      if (affectsRooms(events)) envs.push({ channel: "rooms", msg: { t: "rooms", rooms: await this.o.snapshots.rooms() } });
      for (const env of envs) await this.o.bus.publish(env);
    } catch (e) {
      // State is already committed; clients re-sync from snapshots. Log loudly, do not crash the indexer.
      this.o.log.error("publish failed after commit", { err: e, events: events.length });
    }
  }

  /** Speculative path: PickPlaced only, display-only, de-duplicated across commitState updates. */
  private onSpeculative(wire: WireLog, _mode: Exclude<SpecMode, "off">): void {
    if (wire.removed) return;
    const raw = wireToLog(wire);
    let ev: ChainEvent | null;
    try {
      ev = decodeLog(raw, 0n);
    } catch (e) {
      this.o.log.warn("speculative decode failed", { err: e });
      return;
    }
    if (!ev || ev.eventName !== "PickPlaced") return;
    const key = `${ev.txHash}:${ev.logIndex}`;
    if (this.specSeen.has(key)) return;
    this.specSeen.add(key);
    if (this.specSeen.size > SPEC_DEDUPE_CAP) {
      const first = this.specSeen.values().next().value;
      if (first !== undefined) this.specSeen.delete(first);
    }
    this.o.bus.publish(pickEnvelope(ev, true)).catch((e: unknown) => this.o.log.error("speculative publish failed", { err: e }));
  }

  /** @internal exposed for tests */
  injectSpeculative(wire: WireLog): void {
    this.onSpeculative(wire, "monadLogs");
  }
}

/** viem-backed reader. Finalized head = `finalized` block tag, else latest - confirmations. */
export function createViemReader(client: ChainClient, addresses: Hex[], confirmations: number, log: Logger): ChainReader {
  let tagSupported = true;
  return {
    async finalizedHead(): Promise<bigint> {
      if (tagSupported) {
        try {
          return (await client.getBlock({ blockTag: "finalized" })).number;
        } catch (e) {
          tagSupported = false;
          log.warn("finalized block tag unsupported, using latest - confirmations", { err: e, confirmations });
        }
      }
      const latest = await client.getBlockNumber();
      return latest > BigInt(confirmations) ? latest - BigInt(confirmations) : 0n;
    },
    async getLogs(from, to): Promise<{ logs: RawLog[] }> {
      const logs = await client.getLogs({ address: addresses.map((a) => getAddress(a)), fromBlock: from, toBlock: to });
      return { logs };
    },
    async blockInfo(n): Promise<{ timestamp: bigint; hash: Hex }> {
      const b = await client.getBlock({ blockNumber: n });
      return { timestamp: b.timestamp, hash: b.hash };
    },
  };
}
