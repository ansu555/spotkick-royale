import { encodeFunctionData, keccak256, type Hex, type TransactionReceipt } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { royaleAbi } from "../abi.js";
import type { ChainClient } from "../config/clients.js";
import type { Logger } from "../config/logger.js";
import { DriverNotLeaderError, OnChainRevertError, SimulationRevertError, TxNotLandedError, inspectRevert, isAlreadyKnown, isBenignRevert } from "./errors.js";
import { gasLimitFor } from "./gas.js";
import { NonceManager } from "./nonce.js";
import type { DriverFn } from "./schedule.js";

export interface SendRequest {
  fn: DriverFn;
  gameId: bigint;
  seats: number;
  /** re-reads chain state: true if the game moved past the state this action was decided on (=> someone else did it) */
  stateAdvanced(): Promise<boolean>;
}

export type SendOutcome =
  | { status: "confirmed"; hash: Hex; gasUsed: bigint; attempts: number }
  | { status: "noop"; reason: string };

export interface SenderOptions {
  client: ChainClient;
  account: PrivateKeyAccount;
  royale: Hex;
  chainId: number;
  maxFeeGwei: number;
  log: Logger;
  isLeader(): boolean;
  /** how long to wait for a receipt per signed attempt */
  attemptWaitMs?: number;
  maxAttempts?: number;
}

const GWEI = 1_000_000_000n;
const FEE_FLOOR = 1n * GWEI; // clamp floor (wei per gas)
const FEE_BUMP_NUM = 125n; // +25% per replacement (nodes require >=10%)
const FEE_BUMP_DEN = 100n;

export function clampFee(estimate: bigint | undefined | null, ceilingGwei: number): bigint {
  const ceiling = BigInt(Math.floor(ceilingGwei * 1e9));
  const e = estimate && estimate > 0n ? estimate : FEE_FLOOR;
  return e < FEE_FLOOR ? FEE_FLOOR : e > ceiling ? ceiling : e;
}

export class TxSender {
  private readonly nonce: NonceManager;
  readonly attemptWaitMs: number;
  readonly maxAttempts: number;

  constructor(private readonly o: SenderOptions) {
    this.nonce = new NonceManager(() => o.client.getTransactionCount({ address: o.account.address, blockTag: "pending" }));
    this.attemptWaitMs = o.attemptWaitMs ?? 6000;
    this.maxAttempts = o.maxAttempts ?? 3;
  }

  private async fees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    let maxFee: bigint | undefined;
    let tip: bigint | undefined;
    try {
      const f = await this.o.client.estimateFeesPerGas();
      maxFee = f.maxFeePerGas;
      tip = f.maxPriorityFeePerGas;
    } catch (e) {
      this.o.log.warn("fee estimate failed, falling back to gasPrice", { err: e });
      maxFee = await this.o.client.getGasPrice(); // if this throws too, the caller's bounded retry handles it
    }
    const maxFeePerGas = clampFee(maxFee, this.o.maxFeeGwei);
    const maxPriorityFeePerGas = tip && tip > 0n ? (tip > maxFeePerGas ? maxFeePerGas : tip) : 0n;
    return { maxFeePerGas, maxPriorityFeePerGas };
  }

  async execute(req: SendRequest): Promise<SendOutcome> {
    const { fn, gameId } = req;
    const { client, account, royale, log } = this.o;
    if (!this.o.isLeader()) throw new DriverNotLeaderError();
    const gas = gasLimitFor(fn, req.seats);

    // 1. simulate with the exact gas limit we will send
    try {
      await client.simulateContract({ address: royale, abi: royaleAbi, functionName: fn, args: [gameId], account, gas });
    } catch (e) {
      const info = inspectRevert(e);
      if (info.reverted) {
        if (await req.stateAdvanced()) return { status: "noop", reason: `state advanced (${info.name ?? info.reason ?? info.signature})` };
        if (isBenignRevert(info)) return { status: "noop", reason: `benign revert ${info.name ?? info.reason}` };
        throw new SimulationRevertError(fn, gameId, info, e);
      }
      throw e; // transport / node error: caller backs off and retries
    }

    // 2. sign once at a fixed nonce, broadcast, rebroadcast same bytes, then bump the fee at the SAME nonce
    const data = encodeFunctionData({ abi: royaleAbi, functionName: fn, args: [gameId] });
    let { maxFeePerGas, maxPriorityFeePerGas } = await this.fees();

    return this.nonce.withNonce(async (nonce): Promise<SendOutcome> => {
      const hashes: Hex[] = [];
      for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
        if (!this.o.isLeader()) throw new DriverNotLeaderError();
        const serialized = await account.signTransaction({
          type: "eip1559", chainId: this.o.chainId, nonce, to: royale, data, gas, value: 0n, maxFeePerGas, maxPriorityFeePerGas,
        });
        const hash = await this.broadcast(serialized);
        hashes.push(hash);
        log.info("tx sent", { fn, gameId, nonce, hash, gas, attempt, maxFeePerGas });

        const receipt = await this.waitAny(hashes, serialized, this.attemptWaitMs);
        if (receipt) {
          if (receipt.status === "success") return { status: "confirmed", hash: receipt.transactionHash, gasUsed: receipt.gasUsed, attempts: attempt };
          if (await req.stateAdvanced()) return { status: "noop", reason: `reverted on-chain, state advanced (${receipt.transactionHash})` };
          throw new OnChainRevertError(fn, gameId, receipt.transactionHash);
        }
        // not landed: replace at same nonce with a higher fee (cannot double-execute: one nonce, one winner)
        maxFeePerGas = clampFee((maxFeePerGas * FEE_BUMP_NUM) / FEE_BUMP_DEN, this.o.maxFeeGwei);
        maxPriorityFeePerGas = (maxPriorityFeePerGas * FEE_BUMP_NUM) / FEE_BUMP_DEN;
        if (maxPriorityFeePerGas > maxFeePerGas) maxPriorityFeePerGas = maxFeePerGas;
      }
      throw new TxNotLandedError(fn, gameId, hashes);
    });
  }

  private async broadcast(serialized: Hex): Promise<Hex> {
    try {
      return await this.o.client.sendRawTransaction({ serializedTransaction: serialized });
    } catch (e) {
      if (isAlreadyKnown(e)) {
        // identical bytes already in the pool: fine, derive the hash locally
        return keccak256(serialized);
      }
      throw e;
    }
  }

  /** Polls receipts for every hash signed so far; rebroadcasts the same bytes once mid-wait. */
  private async waitAny(hashes: readonly Hex[], serialized: Hex, waitMs: number): Promise<TransactionReceipt | null> {
    const deadline = Date.now() + waitMs;
    let rebroadcast = false;
    while (Date.now() < deadline) {
      for (const h of hashes) {
        try {
          return await this.o.client.getTransactionReceipt({ hash: h });
        } catch (e) {
          if (!(e instanceof Error && e.name === "TransactionReceiptNotFoundError")) {
            this.o.log.debug("receipt poll error", { err: e });
          }
        }
      }
      if (!rebroadcast && Date.now() > deadline - waitMs / 2) {
        rebroadcast = true;
        await this.broadcast(serialized).catch((e: unknown) => this.o.log.warn("rebroadcast failed", { err: e }));
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return null;
  }
}
