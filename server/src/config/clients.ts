import { createPublicClient, fallback, http, type Chain, type PublicClient, type Transport } from "viem";
import { royaleAbi } from "../abi.js";
import type { Env } from "./env.js";
import { chainFor } from "./chain.js";

export type ChainClient = PublicClient<Transport, Chain>;

export interface Chains {
  chain: Chain;
  /** HTTP client with primary -> fallback failover. Used for reads, simulation and tx submission. */
  client: ChainClient;
}

export function createChainClient(env: Env): Chains {
  const chain = chainFor(env.CHAIN_ID, env.RPC_HTTP_URL, env.RPC_WS_URL);
  const urls = [env.RPC_HTTP_URL, ...(env.RPC_FALLBACK_URL ? [env.RPC_FALLBACK_URL] : [])];
  const transports = urls.map((u) => http(u, { timeout: 10_000, retryCount: 2, retryDelay: 250 }));
  const transport = transports.length > 1 ? fallback(transports, { rank: false, retryCount: 1 }) : transports[0]!;
  const client = createPublicClient({ chain, transport, pollingInterval: 250 });
  return { chain, client };
}

export interface TierInfo {
  tier: number;
  valueWei: bigint;
}

export interface TierProvider {
  tiers(): Promise<TierInfo[]>;
}

const MAX_TIER_PROBE = 8; // tier ids are uint8; the owner configures only a handful

/** Discovers configured tiers by probing tierValue(0..7) (value > 0 means configured). Cached for ttlMs. */
export function createTierProvider(client: ChainClient, royale: `0x${string}`, ttlMs = 60_000): TierProvider {
  let cache: { at: number; tiers: TierInfo[] } | null = null;
  let inflight: Promise<TierInfo[]> | null = null;

  async function load(): Promise<TierInfo[]> {
    // Plain reads (not multicall): works on any chain, incl. a bare local node without Multicall3.
    const results = await Promise.allSettled(
      Array.from({ length: MAX_TIER_PROBE }, (_, t) =>
        client.readContract({ address: royale, abi: royaleAbi, functionName: "tierValue", args: [t] }),
      ),
    );
    const tiers: TierInfo[] = [];
    results.forEach((r, t) => {
      if (r.status === "fulfilled" && r.value > 0n) tiers.push({ tier: t, valueWei: r.value });
    });
    return tiers;
  }

  return {
    async tiers(): Promise<TierInfo[]> {
      if (cache && Date.now() - cache.at < ttlMs) return cache.tiers;
      inflight ??= load()
        .then((tiers) => {
          cache = { at: Date.now(), tiers };
          return tiers;
        })
        .finally(() => {
          inflight = null;
        });
      try {
        return await inflight;
      } catch (e) {
        if (cache) return cache.tiers; // stale-on-error: tiers change rarely
        throw e;
      }
    },
  };
}
