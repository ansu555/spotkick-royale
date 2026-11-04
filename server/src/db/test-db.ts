// Test helper: in-process Postgres (PGlite) with the real migrations applied.
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { DB } from "./client.js";
import { runMigrations } from "./migrate.js";
import { schema } from "./schema.js";

export async function createTestDb(): Promise<{ db: DB; pg: PGlite }> {
  const pg = new PGlite();
  await runMigrations({
    async exec(sql) {
      await pg.exec(sql);
    },
    async applied() {
      const r = await pg.query<{ name: string }>("SELECT name FROM _migrations");
      return new Set(r.rows.map((x) => x.name));
    },
    async record(name) {
      await pg.query("INSERT INTO _migrations (name) VALUES ($1)", [name]);
    },
  });
  return { db: drizzle(pg, { schema }) as unknown as DB, pg };
}
