import { drizzle } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import pg from "pg";
import { schema } from "./schema.js";

/** Driver-agnostic handle (node-postgres in prod, PGlite in tests). */
export type DB = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface DbHandle {
  db: DB;
  pool: pg.Pool;
  close(): Promise<void>;
}

export function createDb(databaseUrl: string): DbHandle {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  return { db: drizzle(pool, { schema }), pool, close: () => pool.end() };
}
