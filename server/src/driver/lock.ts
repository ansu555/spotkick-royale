import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";

const RENEW = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

/** Redis leader lock: SET NX PX to acquire, token-checked Lua to renew/release. */
export class LeaderLock {
  readonly token = randomUUID();
  private held = false;
  private lastRenewOk = 0;
  /** last Redis failure while acquiring/renewing (surfaced via driverHealth) */
  lastError: string | null = null;

  constructor(
    private readonly redis: Redis,
    private readonly key: string,
    private readonly ttlMs: number,
  ) {}

  /** True while we believe we hold the lock (expires locally if renewals stop succeeding). */
  get isLeader(): boolean {
    return this.held && Date.now() - this.lastRenewOk < this.ttlMs;
  }

  /** Acquire or renew. Never throws on Redis errors: losing the lock is the safe outcome. Returns leadership. */
  async tick(): Promise<boolean> {
    try {
      if (this.held) {
        const r = await this.redis.eval(RENEW, 1, this.key, this.token, String(this.ttlMs));
        if (Number(r) === 1) {
          this.lastError = null;
          this.lastRenewOk = Date.now();
          return true;
        }
        this.held = false;
      }
      const ok = await this.redis.set(this.key, this.token, "PX", this.ttlMs, "NX");
      if (ok === "OK") {
        this.held = true;
        this.lastRenewOk = Date.now();
      }
      return this.held;
    } catch (e) {
      // Redis unreachable: we cannot prove leadership, so we must not act. The local expiry in isLeader covers the gap.
      this.lastError = e instanceof Error ? e.message : String(e);
      this.held = false;
      return false;
    }
  }

  async release(): Promise<void> {
    if (!this.held) return;
    this.held = false;
    await this.redis.eval(RELEASE, 1, this.key, this.token);
  }
}
