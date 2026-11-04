import { defineChain, type Chain } from "viem";

const multicall3 = { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } as const;

export const monadMainnet: Chain = defineChain({
  id: 143,
  name: "Monad",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.monad.xyz"], webSocket: ["wss://rpc.monad.xyz"] } },
  blockExplorers: { default: { name: "MonadVision", url: "https://monadvision.com" } },
  contracts: { multicall3 },
});

export const monadTestnet: Chain = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["https://testnet-rpc.monad.xyz"], webSocket: ["wss://testnet-rpc.monad.xyz"] } },
  blockExplorers: { default: { name: "MonadVision", url: "https://testnet.monadvision.com" } },
  contracts: { multicall3 },
  testnet: true,
});

/** Known Monad chains get their canonical definition; any other id (local fork) gets a generic MON chain. */
export function chainFor(chainId: number, rpcHttp: string, rpcWs: string): Chain {
  if (chainId === monadMainnet.id) return monadMainnet;
  if (chainId === monadTestnet.id) return monadTestnet;
  return defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [rpcHttp], webSocket: [rpcWs] } },
    contracts: { multicall3 },
  });
}
