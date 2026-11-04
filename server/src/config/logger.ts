// Minimal structured JSON logger (one line per event). Bigints are rendered as decimal strings.
export type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

function serializeErr(e: unknown): unknown {
  if (e instanceof Error) {
    const cause = (e as { cause?: unknown }).cause;
    return { name: e.name, message: e.message, ...(cause !== undefined ? { cause: serializeErr(cause) } : {}) };
  }
  return e;
}

export function createLogger(level: Level, scope = "app", sink: (line: string) => void = (l) => process.stdout.write(l + "\n")): Logger {
  const min = ORDER[level];
  const emit = (lvl: Level, msg: string, fields?: Record<string, unknown>): void => {
    if (ORDER[lvl] < min) return;
    const out: Record<string, unknown> = { ts: new Date().toISOString(), level: lvl, scope, msg };
    if (fields) {
      for (const [k, v] of Object.entries(fields)) out[k] = k === "err" || k === "error" ? serializeErr(v) : v;
    }
    sink(JSON.stringify(out, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)));
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (s) => createLogger(level, `${scope}.${s}`, sink),
  };
}
