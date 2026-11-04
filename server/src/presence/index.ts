import type { Redis } from "ioredis";
import type { Logger } from "../gateway/types.js";

const NODES_SET = "sk:presence:nodes";
const nodeKey = (id: string): string => `sk:presence:node:${id}`;

export interface PresenceOptions {
  redis: Redis;
  nodeId: string;
  /** number of sockets open on THIS node */
  localCount: () => number;
  /** called at most once per tick, only when the cluster-wide total changed */
  onChange: (total: number) => void;
  log: Logger;
  intervalMs?: number; // default 1000 => <= 1 broadcast / second
  ttlSec?: number; // default 15: a crashed node's count disappears after this
}

/**
 * Cluster-wide open-socket count. Each node writes its own count under a TTL'd key every tick and
 * sums all live node keys. A node that dies stops refreshing, so its sockets drop out within `ttlSec`.
 * Every node computes the same total and notifies only its OWN local subscribers (no duplicate bus traffic).
 */
export class Presence {
  private timer: NodeJS.Timeout | null = null;
  private last: number | null = null;
  private running = false;
  private readonly intervalMs: number;
  private readonly ttlSec: number;

  constructor(private readonly o: PresenceOptions) {
    this.intervalMs = o.intervalMs ?? 1000;
    this.ttlSec = o.ttlSec ?? 15;
  }

  get current(): number {
    return this.last ?? this.o.localCount();
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      await this.o.redis.multi().del(nodeKey(this.o.nodeId)).srem(NODES_SET, this.o.nodeId).exec();
    } catch (err) {
      this.o.log.warn({ err }, "presence cleanup failed");
    }
  }

  /** One heartbeat + aggregation. Exposed for tests. */
  async tick(): Promise<number | null> {
    if (this.running) return null; // never overlap ticks
    this.running = true;
    try {
      const { redis, nodeId } = this.o;
      await redis
        .multi()
        .set(nodeKey(nodeId), String(this.o.localCount()), "EX", this.ttlSec)
        .sadd(NODES_SET, nodeId)
        .exec();
      const ids = await redis.smembers(NODES_SET);
      const values = ids.length > 0 ? await redis.mget(ids.map(nodeKey)) : [];
      let total = 0;
      const stale: string[] = [];
      ids.forEach((id, i) => {
        const v = values[i];
        if (v === null || v === undefined) stale.push(id);
        else total += Number.parseInt(v, 10) || 0;
      });
      if (stale.length > 0) await redis.srem(NODES_SET, ...stale);
      if (total !== this.last) {
        this.last = total;
        this.o.onChange(total);
      }
      return total;
    } catch (err) {
      this.o.log.error({ err }, "presence tick failed");
      return null;
    } finally {
      this.running = false;
    }
  }
}
