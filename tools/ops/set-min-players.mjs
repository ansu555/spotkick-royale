// Owner-only: set SpotkickRoyale.minPlayers on Monad testnet (10143). Usage: DEPLOYER_KEY=0x… node tools/ops/set-min-players.mjs [n]
// The key is read from the environment and never printed.
import { createRequire } from "node:module";
const require = createRequire(new URL("../../server/package.json", import.meta.url));
const { createPublicClient, createWalletClient, http, parseAbi, defineChain } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");

import { readFileSync } from "node:fs";
const ROYALE = JSON.parse(readFileSync(new URL("../../contracts/deployments/10143.json", import.meta.url), "utf8")).royale;
const RPC = process.env.MONAD_TESTNET_RPC ?? "https://testnet-rpc.monad.xyz";
const n = Number(process.argv[2] ?? 1);
const key = process.env.DEPLOYER_KEY;
if (!/^0x[0-9a-fA-F]{64}$/.test(key ?? "")) throw new Error("DEPLOYER_KEY must be 0x + 64 hex chars");
if (!Number.isInteger(n) || n < 1 || n > 10) throw new Error("n must be an integer 1..10 (contract bounds)");

const chain = defineChain({ id: 10143, name: "Monad Testnet", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const abi = parseAbi(["function minPlayers() view returns (uint8)", "function owner() view returns (address)", "function setMinPlayers(uint8 n)"]);
const pub = createPublicClient({ chain, transport: http(RPC) });
const account = privateKeyToAccount(key);
const wallet = createWalletClient({ account, chain, transport: http(RPC) });

if ((await pub.getChainId()) !== 10143) throw new Error("RPC is not chain 10143");
const owner = await pub.readContract({ address: ROYALE, abi, functionName: "owner" });
console.log("signer", account.address, "| contract owner", owner);
if (owner.toLowerCase() !== account.address.toLowerCase()) throw new Error("signer is not the contract owner; the call would revert");
console.log("minPlayers before:", await pub.readContract({ address: ROYALE, abi, functionName: "minPlayers" }));
const hash = await wallet.writeContract({ address: ROYALE, abi, functionName: "setMinPlayers", args: [n], gas: 100_000n });
console.log("tx", hash);
const rcpt = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
console.log("status", rcpt.status);
console.log("minPlayers after:", await pub.readContract({ address: ROYALE, abi, functionName: "minPlayers" }));
