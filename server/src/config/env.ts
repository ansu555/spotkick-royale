import { z } from "zod";

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "expected 0x-prefixed 20-byte address")
  .transform((s) => s.toLowerCase() as `0x${string}`);

const bigintStr = z
  .string()
  .regex(/^\d+$/, "expected non-negative integer string")
  .transform((s) => BigInt(s));

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const EnvSchema = z.object({
  RPC_HTTP_URL: z.string().url(),
  RPC_WS_URL: z.string().url(),
  RPC_FALLBACK_URL: z.string().url().optional(),
  CHAIN_ID: z.coerce.number().int().positive(),
  ROYALE_ADDRESS: address,
  /** TESTNET ONLY: MockRandomness address; when set, the server fulfils seeds itself. Leave unset in production (Pyth Entropy). */
  MOCK_RANDOMNESS_ADDRESS: address.optional(),
  RAIN_ADDRESS: address,
  SESSIONS_ADDRESS: address,
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16),
  DRIVER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "expected 0x + 32-byte hex").transform((s) => s as `0x${string}`),
  START_BLOCK: bigintStr,
  MIN_CHAT_WAGER_WEI: bigintStr,
  MON_USD_PRICE_URL: z.string().url().optional(),

  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default("0.0.0.0"),
  CORS_ORIGINS: z.string().default("*"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  DRIVER_ENABLED: bool.default("true"),
  DRIVER_TICK_MS: z.coerce.number().int().min(100).max(10_000).default(500),
  DRIVER_MARGIN_SECS: z.coerce.number().int().min(1).max(30).default(1),
  DRIVER_MAX_FEE_GWEI: z.coerce.number().positive().default(1000),
  DRIVER_MIN_BALANCE_WEI: bigintStr.default("1000000000000000000"),

  INDEXER_ENABLED: bool.default("true"),
  INDEXER_CONFIRMATIONS: z.coerce.number().int().min(0).max(100).default(3),
  INDEXER_POLL_MS: z.coerce.number().int().min(250).max(60_000).default(1000),
});

export type Env = z.infer<typeof EnvSchema>;

export class ConfigError extends Error {
  constructor(public issues: string[]) {
    super(`Invalid environment:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

export function parseEnv(source: Record<string, string | undefined>): Env {
  const r = EnvSchema.safeParse(source);
  if (!r.success) {
    throw new ConfigError(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  }
  return r.data;
}
