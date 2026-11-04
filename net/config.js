// Runtime configuration for the multiplayer client: where the API lives and what the server says
// about the chain. Nothing here is hard-coded game data; contract addresses, tiers and the save
// table all come from GET /config.

const params = new URLSearchParams(location.search);

/** Hosted API (Railway). Used on any non-local host; local dev keeps the same-origin `/api`. */
const HOSTED_API = "https://server-production-df0a.up.railway.app/api";
const isLocalHost = /^(localhost|127\.0\.0\.1|\[::1\]|.*\.localhost)$/.test(location.hostname);

/** API base: `?api=` override, else same-origin `/api` locally, else the hosted API. */
export function apiBase() {
  return (params.get("api") ?? (isLocalHost ? "/api" : HOSTED_API)).replace(/\/+$/, "");
}

/** WebSocket URL: `?ws=` override, else derived from the API base (`.../api` -> `.../ws`). */
export function wsUrl() {
  if (params.has("ws")) return params.get("ws");
  const u = new URL(apiBase(), location.href);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = u.pathname.replace(/\/api\/?$/, "") + "/ws";
  u.search = "";
  return u.toString();
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** JSON fetch against the API base. Throws ApiError (never returns fake data). */
export async function api(path, { method = "GET", body, token, signal } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(apiBase() + path, { method, headers, signal, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) {
    throw new ApiError(`Network error: ${e.message}`, 0);
  }
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) throw new ApiError(json?.error ?? json?.message ?? `HTTP ${res.status}`, res.status);
  return json;
}

export async function loadConfig() {
  const cfg = await api("/config");
  if (!cfg?.contracts?.royale || !cfg?.chainId) throw new ApiError("Server config is incomplete", 0);
  return cfg;
}

// Public RPC / explorer fallbacks, used only when /config does not provide `rpcUrl` / `explorer`.
// Chain ids per plan §10 (mainnet 143, testnet 10143): verify against docs.monad.xyz before launch.
export const CHAIN_DEFAULTS = {
  143: { name: "Monad", rpc: "https://rpc.monad.xyz", explorer: "https://monadscan.com" },
  10143: { name: "Monad Testnet", rpc: "https://testnet-rpc.monad.xyz", explorer: "https://testnet.monadexplorer.com" },
  31337: { name: "Local Anvil", rpc: "http://127.0.0.1:8545", explorer: null }, // local dev chain (tools/e2e)
};

export function chainInfo(cfg) {
  const d = CHAIN_DEFAULTS[cfg.chainId] ?? {};
  return {
    id: cfg.chainId,
    name: cfg.chainName ?? d.name ?? `Monad (${cfg.chainId})`,
    rpc: cfg.rpcUrl ?? cfg.rpcUrls?.[0] ?? d.rpc ?? null,
    explorer: cfg.explorer ?? d.explorer ?? null,
  };
}

/** Normalise a timestamp to unix ms. Server sends seconds for chain deadlines, ms for serverTime. */
export const toMs = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e11 ? n * 1000 : n;
};

/** wei (bigint | decimal string | number) -> MON as a JS number, for DISPLAY only. */
export const weiToMon = (w) => {
  if (w === null || w === undefined || w === "") return 0;
  try { return Number(BigInt(w)) / 1e18; } catch { return Number(w) / 1e18 || 0; }
};

/** constants helper: reads cfg.constants[NAME] (or camelCase), falling back to the INTERFACES.md default. */
export function constants(cfg) {
  const c = cfg?.constants ?? {};
  const camel = (s) => s.toLowerCase().replace(/_([a-z])/g, (_, ch) => ch.toUpperCase());
  const get = (k, d) => {
    const v = c[k] ?? c[camel(k)];
    return v === undefined || v === null ? d : Number(v);
  };
  return {
    MAX_SEATS: get("MAX_SEATS", 10),
    MIN_PLAYERS: get("MIN_PLAYERS", 1),
    LOBBY_COUNTDOWN_SECS: get("LOBBY_COUNTDOWN_SECS", 15),
    PICK_SECS: get("PICK_SECS", 7),
    BETWEEN_SECS: get("BETWEEN_SECS", 9),
    REPICK_CAP: get("REPICK_CAP", 5),
    FEE_BPS: get("FEE_BPS", 400),
    PICK_X_MAX: get("PICK_X_MAX", 3500),
    PICK_Y_MIN: get("PICK_Y_MIN", 140),
    PICK_Y_MAX: get("PICK_Y_MAX", 2300),
    BLAST_R_MM: get("BLAST_R_MM", 1500),
  };
}
