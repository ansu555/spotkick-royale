import { BaseError, ContractFunctionRevertedError } from "viem";

export class TxNotLandedError extends Error {
  constructor(public fn: string, public gameId: bigint, public hashes: string[]) {
    super(`${fn}(${gameId}) not confirmed after ${hashes.length} signed attempt(s)`);
    this.name = "TxNotLandedError";
  }
}

export class OnChainRevertError extends Error {
  constructor(public fn: string, public gameId: bigint, public hash: string) {
    super(`${fn}(${gameId}) reverted on-chain in ${hash}`);
    this.name = "OnChainRevertError";
  }
}

export class SimulationRevertError extends Error {
  constructor(public fn: string, public gameId: bigint, public detail: RevertInfo, cause: unknown) {
    super(`${fn}(${gameId}) simulation reverted: ${detail.name ?? detail.reason ?? detail.signature ?? "unknown"}`, { cause });
    this.name = "SimulationRevertError";
  }
}

export class DriverNotLeaderError extends Error {
  constructor() {
    super("driver lock lost before send");
    this.name = "DriverNotLeaderError";
  }
}

export interface RevertInfo {
  name: string | null; // decoded custom error name
  reason: string | null; // Error(string) reason
  signature: string | null; // raw 4-byte selector when undecodable
  reverted: boolean; // false => not a contract revert (transport / internal error)
}

/** Custom-error / reason names that mean "someone already did this, or it is not time yet". */
const BENIGN = /wrong.?phase|bad.?phase|invalid.?phase|not.?in.?phase|too.?early|not.?ready|not.?stalled|already|not.?lobby|wrong.?state/i;

export function inspectRevert(err: unknown): RevertInfo {
  if (err instanceof BaseError) {
    const rev = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (rev instanceof ContractFunctionRevertedError) {
      return {
        name: rev.data?.errorName ?? null,
        reason: rev.reason ?? null,
        signature: rev.signature ?? null,
        reverted: true,
      };
    }
  }
  return { name: null, reason: err instanceof Error ? err.message.slice(0, 200) : String(err), signature: null, reverted: false };
}

export function isBenignRevert(info: RevertInfo): boolean {
  if (!info.reverted) return false;
  return BENIGN.test(info.name ?? "") || BENIGN.test(info.reason ?? "");
}

const NONCE_LOW = /nonce too low|already known|known transaction|replacement transaction underpriced|nonce.*(low|used)/i;
export function isNonceTooLow(err: unknown): boolean {
  return NONCE_LOW.test(err instanceof Error ? err.message : String(err));
}
export function isAlreadyKnown(err: unknown): boolean {
  return /already known|known transaction|already imported/i.test(err instanceof Error ? err.message : String(err));
}
