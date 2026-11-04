import cors from "@fastify/cors";
import { sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Redis } from "ioredis";
import { isAddress } from "viem";
import { z } from "zod";
import type { ChainClient, TierProvider } from "../config/clients.js";
import { CONSTANTS } from "../config/constants.js";
import type { Env } from "../config/env.js";
import { loadSaveTable, type PriceFeed } from "../config/external.js";
import type { DB } from "../db/client.js";
import { getFair, getGameReplay, getLeaderboard, getPlayer, getWins, type Snapshots } from "../db/queries.js";
import { VERIFIER_VERSION } from "../fair/verifier.js";
import { DRIVER_HEARTBEAT_KEY, driverHealth, type DriverHealth } from "../driver/index.js";
import type { IndexerStatus } from "../indexer/index.js";

export interface ApiDeps {
  env: Pick<Env, "CHAIN_ID" | "ROYALE_ADDRESS" | "RAIN_ADDRESS" | "SESSIONS_ADDRESS" | "CORS_ORIGINS" | "DRIVER_ENABLED" | "INDEXER_ENABLED">;
  db: DB;
  redis: Redis;
  client: ChainClient;
  tiers: TierProvider;
  snapshots: Snapshots;
  price: PriceFeed;
  indexerStatus(): IndexerStatus;
  driver?: () => DriverHealth;
  nowSec?: () => number;
}

const IdParam = z.object({ id: z.string().regex(/^\d{1,19}$/, "game id must be a decimal integer") });
const LimitQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });
const BoardQuery = z.object({ window: z.enum(["7d", "all"]).default("all"), limit: z.coerce.number().int().min(1).max(100).default(50) });

function bad(reply: FastifyReply, issues: z.ZodIssue[]): FastifyReply {
  return reply.code(400).send({ error: "bad_request", issues: issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, rej) => (t = setTimeout(() => rej(new Error(`${what} timed out after ${ms}ms`)), ms)))]);
  } finally {
    if (t) clearTimeout(t);
  }
}

export interface Probe {
  ok: boolean;
  error?: string;
  [k: string]: unknown;
}
async function probe(what: string, fn: () => Promise<Record<string, unknown> | void>): Promise<Probe> {
  try {
    return { ok: true, ...((await withTimeout(fn(), 2500, what)) ?? {}) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function registerApi(app: FastifyInstance, d: ApiDeps): Promise<void> {
  const origins = d.env.CORS_ORIGINS.trim();
  await app.register(cors, {
    origin: origins === "*" ? true : origins.split(",").map((s) => s.trim()).filter(Boolean),
    methods: ["GET", "POST", "OPTIONS"],
  });
  const nowSec = d.nowSec ?? ((): number => Math.floor(Date.now() / 1000));
  const driver = d.driver ?? driverHealth;

  await app.register(
    async (api) => {
      api.get("/config", async () => {
        const [tiers, saveTable, monUsd] = await Promise.all([d.tiers.tiers(), loadSaveTable(), d.price.get()]);
        return {
          chainId: d.env.CHAIN_ID,
          contracts: { royale: d.env.ROYALE_ADDRESS, rain: d.env.RAIN_ADDRESS, sessions: d.env.SESSIONS_ADDRESS },
          tiers: tiers.map((t) => ({ tier: t.tier, valueWei: t.valueWei.toString() })),
          constants: CONSTANTS,
          saveTable,
          monUsd,
        };
      });

      api.get("/rooms", async () => d.snapshots.rooms());

      api.get("/games/:id", async (req, reply) => {
        const p = IdParam.safeParse(req.params);
        if (!p.success) return bad(reply, p.error.issues);
        const g = await getGameReplay(d.db, BigInt(p.data.id));
        return g ?? reply.code(404).send({ error: "not_found" });
      });

      api.get("/fair/:id", async (req, reply) => {
        const p = IdParam.safeParse(req.params);
        if (!p.success) return bad(reply, p.error.issues);
        const rounds = await getFair(d.db, BigInt(p.data.id));
        if (!rounds) return reply.code(404).send({ error: "not_found" });
        // Each round carries the on-chain values, the server's re-derivation (seed -> target/outcome/
        // survivors via packages/shared royale-math), and a `verified` flag comparing the two.
        return { gameId: p.data.id, verifierVersion: VERIFIER_VERSION, rounds };
      });

      api.get("/players/:addr", async (req, reply) => {
        const p = z.object({ addr: z.string() }).parse(req.params);
        if (!isAddress(p.addr, { strict: false })) return bad(reply, [{ code: "custom", path: ["addr"], message: "not an address" }]);
        return getPlayer(d.db, p.addr);
      });

      api.get("/leaderboard", async (req, reply) => {
        const q = BoardQuery.safeParse(req.query);
        if (!q.success) return bad(reply, q.error.issues);
        return getLeaderboard(d.db, q.data.window, nowSec(), q.data.limit);
      });

      api.get("/wins", async (req, reply) => {
        const q = LimitQuery.safeParse(req.query);
        if (!q.success) return bad(reply, q.error.issues);
        return getWins(d.db, q.data.limit);
      });

      api.get("/health", async (_req, reply) => {
        const [db, redis, rpc] = await Promise.all([
          probe("db", async () => void (await d.db.execute(sql`select 1`))),
          probe("redis", async () => void (await d.redis.ping())),
          probe("rpc", async () => ({ block: (await d.client.getBlockNumber()).toString() })),
        ]);
        const ix = d.indexerStatus();
        const indexer = {
          enabled: d.env.INDEXER_ENABLED,
          running: ix.running,
          cursor: ix.cursor?.toString() ?? null,
          finalizedHead: ix.finalizedHead?.toString() ?? null,
          lagBlocks: ix.lagBlocks === null ? null : Number(ix.lagBlocks),
          lastSyncAgoMs: ix.lastSyncAtMs === null ? null : Date.now() - ix.lastSyncAtMs,
          wsConnected: ix.wsConnected,
          speculativeMode: ix.speculativeMode,
          lastError: ix.lastError,
        };
        const local = driver();
        let hb: { at: number; block: string } | null = null;
        let hbError: string | null = null;
        try {
          const raw = await withTimeout(d.redis.get(DRIVER_HEARTBEAT_KEY), 2000, "driver heartbeat");
          hb = raw ? (JSON.parse(raw) as { at: number; block: string }) : null;
        } catch (e) {
          hbError = e instanceof Error ? e.message : String(e);
        }
        const driverOut = {
          enabled: d.env.DRIVER_ENABLED,
          heartbeatAgoMs: hb ? Date.now() - hb.at : null,
          heartbeatError: hbError,
          local,
        };
        const indexerStale = d.env.INDEXER_ENABLED && (!ix.running || (indexer.lagBlocks ?? Infinity) > 100);
        const driverStale = d.env.DRIVER_ENABLED && (driverOut.heartbeatAgoMs === null || driverOut.heartbeatAgoMs > 10_000);
        const core = db.ok && redis.ok && rpc.ok;
        return reply.code(core ? 200 : 503).send({
          ok: core && !indexerStale && !driverStale,
          core,
          db, redis, rpc, indexer, driver: driverOut,
          degraded: { indexer: indexerStale, driver: driverStale },
        });
      });
    },
    { prefix: "/api" },
  );
}
