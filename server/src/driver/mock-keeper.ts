import { createWalletClient, http, parseAbi, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import type { ChainClient } from "../config/clients.js";
import type { Logger } from "../config/logger.js";

const mockRngAbi = parseAbi([
  "function lastId() view returns (uint64)",
  "function fulfilled(uint64) view returns (bool)",
  "function fulfillDefault(uint64 id)",
]);

export interface MockKeeperOptions {
  client: ChainClient;
  account: PrivateKeyAccount;
  rpcUrl: string;
  rng: Hex;
  isLeader(): boolean;
  log: Logger;
  pollMs?: number;
}

/**
 * TESTNET ONLY. Fulfils MockRandomness requests (deterministic seed from the public userRandomness).
 * Enabled only when MOCK_RANDOMNESS_ADDRESS is set; production uses Pyth Entropy, which calls back by itself.
 * Idempotent: only acts on the newest unfulfilled request, and a failed/duplicate send just reverts.
 */
export class MockKeeper {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private busy = false;
  private lastErrLogged = 0;

  constructor(private readonly o: MockKeeperOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.o.log.warn("MOCK randomness keeper enabled — testnet only, seeds are predictable", { rng: this.o.rng });
    const run = (): void => {
      if (this.stopped) return;
      void this.tick().finally(() => {
        if (!this.stopped) this.timer = setTimeout(run, this.o.pollMs ?? 700);
      });
    };
    run();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.busy || !this.o.isLeader()) return;
    this.busy = true;
    try {
      const { client, rng, account } = this.o;
      const id = await client.readContract({ address: rng, abi: mockRngAbi, functionName: "lastId" });
      if (id === 0n) return;
      if (await client.readContract({ address: rng, abi: mockRngAbi, functionName: "fulfilled", args: [id] })) return;
      const wallet = createWalletClient({ account, chain: client.chain, transport: http(this.o.rpcUrl) });
      const hash = await wallet.writeContract({ address: rng, abi: mockRngAbi, functionName: "fulfillDefault", args: [id], gas: 600_000n });
      await client.waitForTransactionReceipt({ hash, timeout: 20_000 });
      this.o.log.info("mock seed fulfilled", { requestId: id, hash });
    } catch (e) {
      if (Date.now() - this.lastErrLogged > 10_000) {
        this.lastErrLogged = Date.now();
        this.o.log.error("mock keeper failed", { err: e });
      }
    } finally {
      this.busy = false;
    }
  }
}
