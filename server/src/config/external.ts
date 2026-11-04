import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const SAVE_TABLE_PATH = path.resolve(here, "../../../packages/shared/save-table.json");

/** Reads packages/shared/save-table.json if present: either number[48] or {saveBps:number[48]}. */
export async function loadSaveTable(file: string = SAVE_TABLE_PATH): Promise<number[] | null> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  const parsed: unknown = JSON.parse(raw);
  const arr = Array.isArray(parsed) ? parsed : (parsed as { saveBps?: unknown } | null)?.saveBps;
  if (!Array.isArray(arr) || arr.length !== 48 || !arr.every((n) => typeof n === "number" && Number.isFinite(n))) {
    throw new Error(`save-table.json must be number[48] (got ${JSON.stringify(arr)?.slice(0, 80)})`);
  }
  return arr as number[];
}

/** Pulls the first finite positive number out of a price payload at a few well-known paths. */
export function extractPrice(payload: unknown): number | null {
  const paths = ["price", "usd", "monad.usd", "data.price", "data.usd", "mon.usd"];
  for (const p of paths) {
    let cur: unknown = payload;
    for (const k of p.split(".")) {
      if (cur && typeof cur === "object" && k in (cur as Record<string, unknown>)) cur = (cur as Record<string, unknown>)[k];
      else {
        cur = undefined;
        break;
      }
    }
    const n = typeof cur === "string" ? Number(cur) : cur;
    if (typeof n === "number" && Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

export interface PriceFeed {
  get(): Promise<number | null>;
}

/** MON/USD from MON_USD_PRICE_URL, cached 60s; null (never a fake number) when unset or failing. */
export function createPriceFeed(url: string | undefined, onError: (e: unknown) => void, ttlMs = 60_000): PriceFeed {
  let cache: { at: number; v: number | null } | null = null;
  return {
    async get(): Promise<number | null> {
      if (!url) return null;
      if (cache && Date.now() - cache.at < ttlMs) return cache.v;
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) throw new Error(`price feed HTTP ${res.status}`);
        const v = extractPrice(await res.json());
        cache = { at: Date.now(), v };
        return v;
      } catch (e) {
        onError(e);
        cache = { at: Date.now() - ttlMs + 10_000, v: cache?.v ?? null }; // retry in 10s, serve last good meanwhile
        return cache.v;
      }
    },
  };
}
