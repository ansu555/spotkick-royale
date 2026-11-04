import Fastify from "fastify";
import { Redis } from "ioredis";
import { existsSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { registerApi } from "./api/index.js";
import { createChainClient, createTierProvider, createLogger, parseEnv, ConfigError } from "./config/index.js";
import { createPriceFeed } from "./config/external.js";
import { createDb, createSnapshots, migrateDatabase, resetIfDeploymentChanged } from "./db/index.js";
import { Driver } from "./driver/index.js";
import { MockKeeper } from "./driver/mock-keeper.js";
import { Indexer, createRedisBus, createViemReader } from "./indexer/index.js";
import { startRealtime } from "./gateway/index.js";

async function main(): Promise<void> {
  if (existsSync(".env")) process.loadEnvFile(".env");
  let env;
  try {
    env = parseEnv(process.env);
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }
  const log = createLogger(env.LOG_LEVEL, "server");
  log.info("starting", { chainId: env.CHAIN_ID, royale: env.ROYALE_ADDRESS });

  // db
  const ran = await migrateDatabase(env.DATABASE_URL);
  if (ran.length) log.info("migrations applied", { files: ran });
  const deployment = [env.CHAIN_ID, env.ROYALE_ADDRESS.toLowerCase(), env.RAIN_ADDRESS.toLowerCase(), env.START_BLOCK].join(":");
  if (await resetIfDeploymentChanged(env.DATABASE_URL, deployment, env.START_BLOCK)) {
    log.warn("contract deployment changed; chain-derived tables cleared, re-indexing from START_BLOCK", { deployment });
  }
  const dbh = createDb(env.DATABASE_URL);

  // redis: one command connection (publish, leader lock, heartbeat); the gateway opens its own subscriber
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: false });
  redis.on("error", (e: Error) => log.error("redis error", { err: e }));

  // chain
  const { client } = createChainClient(env);
  const tiers = createTierProvider(client, env.ROYALE_ADDRESS);
  const snapshots = createSnapshots(dbh.db, tiers);
  const bus = createRedisBus(redis);
  const price = createPriceFeed(env.MON_USD_PRICE_URL, (e) => log.warn("price feed failed", { err: e }));

  // indexer
  const addresses = [env.ROYALE_ADDRESS, env.RAIN_ADDRESS];
  const indexer = new Indexer({
    db: dbh.db,
    reader: createViemReader(client, addresses, env.INDEXER_CONFIRMATIONS, log.child("reader")),
    bus,
    snapshots,
    log: log.child("indexer"),
    startBlock: env.START_BLOCK,
    pollMs: env.INDEXER_POLL_MS,
    live: { url: env.RPC_WS_URL, addresses },
  });
  if (env.INDEXER_ENABLED) indexer.start();

  // driver
  const driver = new Driver({
    client,
    account: privateKeyToAccount(env.DRIVER_PRIVATE_KEY),
    royale: env.ROYALE_ADDRESS,
    chainId: env.CHAIN_ID,
    redis,
    db: dbh.db,
    tiers,
    log: log.child("driver"),
    tickMs: env.DRIVER_TICK_MS,
    marginSecs: env.DRIVER_MARGIN_SECS,
    maxFeeGwei: env.DRIVER_MAX_FEE_GWEI,
    minBalanceWei: env.DRIVER_MIN_BALANCE_WEI,
  });
  if (env.DRIVER_ENABLED) driver.start();
  const mockKeeper = env.MOCK_RANDOMNESS_ADDRESS && env.DRIVER_ENABLED
    ? new MockKeeper({
        client, account: privateKeyToAccount(env.DRIVER_PRIVATE_KEY), rpcUrl: env.RPC_HTTP_URL,
        rng: env.MOCK_RANDOMNESS_ADDRESS, isLeader: () => driver.healthState.leader, log: log.child("mock-keeper"),
      })
    : null;
  mockKeeper?.start();

  // http api + realtime
  const app = Fastify({ logger: false, trustProxy: true });
  await registerApi(app, {
    env, db: dbh.db, redis, client, tiers, snapshots, price,
    indexerStatus: () => indexer.status(),
    driver: () => driver.healthState,
  });
  const realtime = await startRealtime({
    app,
    redisUrl: env.REDIS_URL,
    jwtSecret: env.JWT_SECRET,
    chainId: env.CHAIN_ID,
    rpcUrl: env.RPC_HTTP_URL,
    contracts: { royale: env.ROYALE_ADDRESS, rain: env.RAIN_ADDRESS, sessions: env.SESSIONS_ADDRESS },
    minChatWagerWei: env.MIN_CHAT_WAGER_WEI,
    snapshots: { rooms: () => snapshots.rooms(), game: (id) => snapshots.game(id) },
  });
  await app.listen({ host: env.HOST, port: env.PORT });
  log.info("listening", { host: env.HOST, port: env.PORT });

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    log.info("shutting down", { signal });
    const step = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
      try {
        await fn();
      } catch (e) {
        log.error(`shutdown step failed: ${name}`, { err: e });
      }
    };
    await step("http", () => app.close());
    await step("realtime", () => realtime.close());
    mockKeeper?.stop();
    await step("driver", () => driver.stop());
    await step("indexer", () => indexer.stop());
    await step("redis", () => redis.quit());
    await step("db", () => dbh.close());
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e: unknown) => {
  process.stderr.write(`fatal: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
