import type { Redis } from "ioredis";
import type { PrivateKeyAccount } from "viem/accounts";
import { Phase, royaleAbi } from "../abi.js";
import type { ChainClient, TierProvider } from "../config/clients.js";
import type { Logger } from "../config/logger.js";
import { CONSTANTS } from "../config/constants.js";
import type { DB } from "../db/client.js";
import { activeGameIds, lockedAtOf } from "../db/queries.js";
import { DriverNotLeaderError } from "./errors.js";
import { LeaderLock } from "./lock.js";
import { TxSender } from "./sender.js";
import { actionKey, decide, retryDelayMs, seatsInvolved, type ChainGameState, type DriverFn } from "./schedule.js";

export const DRIVER_LOCK_KEY = "sk:driver:leader";
export const DRIVER_HEARTBEAT_KEY = "sk:driver:heartbeat";

export interface DriverHealth {
  enabled: boolean;
  leader: boolean;
  address: string | null;
  lastTickAtMs: number | null;
  lastActionAtMs: number | null;
  lastError: string | null;
  consecutiveTickErrors: number;
  inFlight: number;
  actionsConfirmed: number;
  actionsNoop: number;
  actionsFailed: number;
  balanceWei: string | null;
  lowBalance: boolean;
}

const initialHealth = (enabled: boolean): DriverHealth => ({
  enabled, leader: false, address: null, lastTickAtMs: null, lastActionAtMs: null, lastError: null,
  consecutiveTickErrors: 0, inFlight: 0, actionsConfirmed: 0, actionsNoop: 0, actionsFailed: 0, balanceWei: null, lowBalance: false,
});

let current: Driver | null = null;
/** Process-local driver status for /health (cluster-wide heartbeat lives in Redis under DRIVER_HEARTBEAT_KEY). */
export function driverHealth(): DriverHealth {
  return current ? { ...current.healthState } : initialHealth(false);
}

export interface DriverOptions {
  client: ChainClient;
  account: PrivateKeyAccount;
  royale: `0x${string}`;
  chainId: number;
  redis: Redis;
  db: DB;
  tiers: TierProvider;
  log: Logger;
  tickMs: number;
  marginSecs: number;
  maxFeeGwei: number;
  minBalanceWei: bigint;
}

interface Cooldown {
  failures: number;
  nextAtMs: number;
}

export class Driver {
  healthState: DriverHealth = initialHealth(true);
  private readonly lock: LeaderLock;
  private readonly sender: TxSender;
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly gamesBusy = new Set<string>();
  private readonly cooldowns = new Map<string, Cooldown>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private ticking = false;
  private tickCount = 0;

  constructor(private readonly o: DriverOptions) {
    this.lock = new LeaderLock(o.redis, DRIVER_LOCK_KEY, 5000);
    this.sender = new TxSender({
      client: o.client, account: o.account, royale: o.royale, chainId: o.chainId, maxFeeGwei: o.maxFeeGwei,
      log: o.log.child("tx"), isLeader: () => this.lock.isLeader,
    });
    this.healthState.address = o.account.address.toLowerCase();
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    current = this;
    const run = (): void => {
      if (this.stopped) return;
      void this.tick().finally(() => {
        if (!this.stopped) this.timer = setTimeout(run, this.o.tickMs);
      });
    };
    run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await Promise.race([Promise.allSettled([...this.inFlight.values()]), new Promise((r) => setTimeout(r, 10_000))]);
    await this.lock.release().catch((e: unknown) => this.o.log.warn("lock release failed", { err: e }));
    this.healthState.leader = false;
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    const { log } = this.o;
    try {
      const leader = await this.lock.tick();
      this.healthState.leader = leader;
      if (this.lock.lastError) this.healthState.lastError = `lock: ${this.lock.lastError}`;
      if (!leader) return;

      const block = await this.o.client.getBlock({ blockTag: "latest" });
      const nowSec = block.timestamp;
      await this.o.redis.set(DRIVER_HEARTBEAT_KEY, JSON.stringify({ at: Date.now(), block: block.number.toString() }), "PX", 15_000);

      const games = await this.readGames();
      for (const g of games) await this.consider(g, nowSec);

      if (this.tickCount++ % 60 === 0) await this.checkBalance();
      this.gc();
      this.healthState.lastTickAtMs = Date.now();
      this.healthState.consecutiveTickErrors = 0;
      if (!this.lock.lastError) this.healthState.lastError = null;
    } catch (e) {
      this.healthState.consecutiveTickErrors++;
      this.healthState.lastError = e instanceof Error ? e.message : String(e);
      log.error("driver tick failed", { err: e, consecutive: this.healthState.consecutiveTickErrors });
    } finally {
      this.ticking = false;
    }
  }

  /** Chain is the source of truth: union of DB-known live games and each tier's open lobby game. */
  private async readGames(): Promise<ChainGameState[]> {
    const { client, royale, db, tiers } = this.o;
    const ids = new Set<bigint>(await activeGameIds(db));
    const tierList = await tiers.tiers();
    if (tierList.length > 0) {
      const open = await Promise.allSettled(
        tierList.map((t) => client.readContract({ address: royale, abi: royaleAbi, functionName: "openGameForTier", args: [t.tier] })),
      );
      for (const r of open) if (r.status === "fulfilled" && r.value > 0n) ids.add(r.value);
    }
    if (ids.size === 0) return [];
    const list = [...ids];
    const views = await Promise.allSettled(
      list.map((id) => client.readContract({ address: royale, abi: royaleAbi, functionName: "getGame", args: [id] })),
    );
    const out: ChainGameState[] = [];
    views.forEach((v, i) => {
      if (v.status !== "fulfilled") {
        this.o.log.warn("getGame failed", { gameId: list[i], err: v.reason });
        return;
      }
      const g = v.value;
      out.push({ gameId: g.id, phase: g.phase, round: g.round, seatsFilled: g.seatsFilled, aliveMask: g.aliveMask, phaseEndsAt: g.phaseEndsAt });
    });
    // Locked games: has the entropy seed arrived yet? (all-zero seed = still pending)
    await Promise.all(
      out
        .filter((g) => g.phase === Phase.Locked)
        .map(async (g) => {
          try {
            const r = await client.readContract({ address: royale, abi: royaleAbi, functionName: "getRound", args: [g.gameId, g.round] });
            g.seedReady = BigInt(r.seed) !== 0n;
          } catch (e) {
            g.seedReady = false;
            this.o.log.warn("getRound failed", { gameId: g.gameId, err: e });
          }
        }),
    );
    return out;
  }

  private async consider(g: ChainGameState, nowSec: bigint): Promise<void> {
    const gameKey = g.gameId.toString();
    if (this.gamesBusy.has(gameKey)) return;
    const lockedAtSec =
      g.phase === Phase.Locked ? await lockedAtOf(this.o.db, g.gameId, g.round).then((v) => (v === null ? null : BigInt(v))) : null;
    const d = decide(g, {
      nowSec, lockedAtSec, marginSec: BigInt(this.o.marginSecs),
      stallTimeoutSec: BigInt(CONSTANTS.STALL_TIMEOUT_SECS), entropyTimeoutSec: BigInt(CONSTANTS.ENTROPY_TIMEOUT_SECS),
    });
    if (d.kind === "wait") return;

    const key = actionKey(g, d.fn);
    const cd = this.cooldowns.get(key);
    if (cd && Date.now() < cd.nextAtMs) return;

    this.gamesBusy.add(gameKey);
    const job = this.run(g, d.fn, d.reason, key).finally(() => {
      this.gamesBusy.delete(gameKey);
      this.inFlight.delete(key);
      this.healthState.inFlight = this.inFlight.size;
    });
    this.inFlight.set(key, job);
    this.healthState.inFlight = this.inFlight.size;
  }

  private async run(g: ChainGameState, fn: DriverFn, reason: string, key: string): Promise<void> {
    const { log } = this.o;
    const prev = this.cooldowns.get(key);
    const stateAdvanced = async (): Promise<boolean> => {
      const v = await this.o.client.readContract({ address: this.o.royale, abi: royaleAbi, functionName: "getGame", args: [g.gameId] });
      return v.phase !== g.phase || v.round !== g.round;
    };
    try {
      log.info("driver action", { fn, gameId: g.gameId, phase: g.phase, round: g.round, reason });
      const out = await this.sender.execute({ fn, gameId: g.gameId, seats: seatsInvolved(g), stateAdvanced });
      this.healthState.lastActionAtMs = Date.now();
      if (out.status === "confirmed") {
        this.healthState.actionsConfirmed++;
        this.cooldowns.delete(key);
        log.info("driver action confirmed", { fn, gameId: g.gameId, hash: out.hash, gasUsed: out.gasUsed, attempts: out.attempts });
      } else {
        // wrong-phase / already-done / not-yet: success for our purposes. Don't hammer the RPC with simulations.
        this.healthState.actionsNoop++;
        this.cooldowns.set(key, { failures: 0, nextAtMs: Date.now() + (fn === "refundStalled" ? 30_000 : 1500) });
        log.info("driver action no-op", { fn, gameId: g.gameId, reason: out.reason });
      }
    } catch (e) {
      if (e instanceof DriverNotLeaderError) {
        log.warn("lost leadership mid-action", { fn, gameId: g.gameId });
        return;
      }
      const failures = (prev?.failures ?? 0) + 1;
      this.cooldowns.set(key, { failures, nextAtMs: Date.now() + retryDelayMs(failures) });
      this.healthState.actionsFailed++;
      this.healthState.lastError = `${fn}(${g.gameId}): ${e instanceof Error ? e.message : String(e)}`;
      log.error("driver action failed", { fn, gameId: g.gameId, failures, err: e });
    }
  }

  private async checkBalance(): Promise<void> {
    const bal = await this.o.client.getBalance({ address: this.o.account.address });
    this.healthState.balanceWei = bal.toString();
    this.healthState.lowBalance = bal < this.o.minBalanceWei;
    if (this.healthState.lowBalance) this.o.log.error("driver balance low", { balanceWei: bal, minWei: this.o.minBalanceWei });
  }

  private gc(): void {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [k, c] of this.cooldowns) if (c.nextAtMs < cutoff) this.cooldowns.delete(k);
  }
}

export { DriverNotLeaderError };
