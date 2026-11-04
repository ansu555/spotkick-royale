import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(here, "../../drizzle");

export interface SqlExecutor {
  /** Runs one or more statements (simple query protocol). */
  exec(sql: string): Promise<void>;
  /** Returns the names already applied. */
  applied(): Promise<Set<string>>;
  record(name: string): Promise<void>;
}

const BOOTSTRAP = `CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());`;

/** Applies drizzle/*.sql in lexical order, each once. Each file runs inside a transaction. */
export async function runMigrations(ex: SqlExecutor, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  await ex.exec(BOOTSTRAP);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const done = await ex.applied();
  const ran: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const text = await readFile(path.join(dir, f), "utf8");
    await ex.exec(`BEGIN;\n${text}\nCOMMIT;`).catch(async (e: unknown) => {
      await ex.exec("ROLLBACK;").catch(() => undefined);
      throw new Error(`migration ${f} failed`, { cause: e });
    });
    await ex.record(f);
    ran.push(f);
  }
  return ran;
}

export function pgExecutor(client: pg.Client | pg.PoolClient): SqlExecutor {
  return {
    async exec(sql: string): Promise<void> {
      await client.query(sql);
    },
    async applied(): Promise<Set<string>> {
      const r = await client.query<{ name: string }>("SELECT name FROM _migrations");
      return new Set(r.rows.map((x) => x.name));
    },
    async record(name: string): Promise<void> {
      await client.query("INSERT INTO _migrations (name) VALUES ($1) ON CONFLICT DO NOTHING", [name]);
    },
  };
}

/** Migrates `databaseUrl` using a single connection guarded by an advisory lock (safe with N replicas). */
export async function migrateDatabase(databaseUrl: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock(7203001)");
    return await runMigrations(pgExecutor(client));
  } finally {
    await client.query("SELECT pg_advisory_unlock(7203001)").catch(() => undefined);
    await client.end();
  }
}

/** Chain-derived tables: everything here can be rebuilt by re-indexing from START_BLOCK. */
const CHAIN_TABLES = ["games", "seats", "picks", "rounds", "cashouts", "players", "wins", "rain", "raw_events", "indexer_cursor"];
const DEPLOYMENT_ROW = "deployment"; // indexer_cursor row; block_hash holds the fingerprint

/**
 * Clears all chain-derived tables when `fingerprint` (chain + contract addresses + start block) differs from the one
 * stored by the previous boot, so a contract redeploy (new address, game ids restarting at 1) never mixes with rows
 * indexed from the old contract. Returns true when a reset happened. Same advisory lock as migrations.
 */
export async function resetIfDeploymentChanged(databaseUrl: string, fingerprint: string, startBlock: bigint): Promise<boolean> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock(7203001)");
    const r = await client.query<{ block_hash: string | null }>("SELECT block_hash FROM indexer_cursor WHERE name = $1", [DEPLOYMENT_ROW]);
    if (r.rows[0]?.block_hash === fingerprint) return false;
    await client.query("BEGIN");
    try {
      await client.query(`TRUNCATE ${CHAIN_TABLES.join(", ")}`);
      await client.query(
        "INSERT INTO indexer_cursor (name, block_number, block_hash, updated_at) VALUES ($1, $2, $3, $4)",
        [DEPLOYMENT_ROW, startBlock.toString(), fingerprint, Math.floor(Date.now() / 1000)],
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    }
    return true;
  } finally {
    await client.query("SELECT pg_advisory_unlock(7203001)").catch(() => undefined);
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    process.stderr.write("DATABASE_URL is required\n");
    process.exit(1);
  }
  migrateDatabase(url)
    .then((ran) => {
      process.stdout.write(`migrations applied: ${ran.length ? ran.join(", ") : "none (up to date)"}\n`);
    })
    .catch((e: unknown) => {
      process.stderr.write(`${e instanceof Error ? `${e.message} :: ${String((e as Error & { cause?: unknown }).cause)}` : String(e)}\n`);
      process.exit(1);
    });
}
