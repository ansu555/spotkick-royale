// On-chain actions via viem (lazy-loaded). ABI is built from contracts/src/ISpotkickRoyale.sol.
// Gas is charged on the LIMIT on Monad, so every call carries an explicit, tight limit.
import { loadViem } from "./viem.js";
import { chainInfo } from "./config.js";

export const ROYALE_ABI = [
  "function enter(uint8 tier) payable returns (uint64 gameId, uint8 seat)",
  "function leaveLobby(uint64 gameId)",
  "function pick(uint64 gameId, int16 x, int16 y)",
  "function pickFor(uint64 gameId, address player, int16 x, int16 y)",
  "function cashOut(uint64 gameId)",
  "function cashOutFor(uint64 gameId, address player)",
  "function withdraw()",
  "function claimable(address player) view returns (uint128)",
  "function wagered(address player) view returns (uint128)",
  "function tierValue(uint8 tier) view returns (uint128)",
  "event SeatTaken(uint64 indexed gameId, uint8 seat, address indexed player)",
  "event CashedOut(uint64 indexed gameId, uint8 round, uint8 seat, address indexed player, uint128 amount)",
  // Custom errors. Names that the deployed contract does not declare are harmless (unknown selectors
  // fall back to the generic message below); keep this list in sync with contracts/src/SpotkickRoyale.sol.
  "error BadPick()", "error Paused()", "error WrongValue()", "error UnknownTier()", "error AlreadySeated()",
  "error GameFull()", "error NotInLobby()", "error NotSeated()", "error NotAlive()", "error BadPhase()",
  "error RepickCap()", "error NotAuthorized()", "error CashOutBlocked()", "error NothingToWithdraw()",
  "error DeadlineNotReached()", "error OnlyOneAlive()",
];
export const SESSION_ABI = [
  "function authorize(address key, uint64 expiry)",
  "function revoke(address key)",
  "function isAuthorized(address player, address key) view returns (bool)",
];
export const RAIN_ABI = [
  "function join(uint64 rainId)",
  "function claim(uint64 rainId)",
];

// Placeholder limits until benchmarked on Monad testnet (server/src/driver/gas.ts has the driver's).
// /config may override any of them via `gas: { enter: 250000, ... }`.
const GAS = {
  enter: 320_000, leaveLobby: 160_000, pick: 120_000, pickFor: 150_000, cashOut: 220_000, cashOutFor: 250_000,
  withdraw: 90_000, authorize: 110_000, revoke: 80_000, fund: 21_000, rainJoin: 150_000, rainClaim: 120_000,
};

const FRIENDLY = {
  BadPick: "That spot is outside the goal.",
  Paused: "New entries are paused right now.",
  WrongValue: "Wrong entry amount for this tier.",
  UnknownTier: "That entry tier is not available.",
  AlreadySeated: "You already have a seat in this royale.",
  GameFull: "This royale is full.",
  NotInLobby: "The lobby has already closed.",
  NotSeated: "You have no seat in this royale.",
  NotAlive: "You are already eliminated.",
  BadPhase: "Not allowed in the current phase.",
  RepickCap: "Re-pick limit reached for this round.",
  NotAuthorized: "Quick-pick session is not authorised. Re-enable it from the wallet menu.",
  CashOutBlocked: "Cash-out is closed while the shot is being decided.",
  NothingToWithdraw: "Nothing to withdraw.",
  DeadlineNotReached: "Too early for that.",
  OnlyOneAlive: "You are the last player; the pot is yours at full time.",
};

export class TxError extends Error {
  constructor(message, { cause, errorName, rejected = false } = {}) {
    super(message);
    this.name = "TxError";
    this.cause = cause;
    this.errorName = errorName;
    this.rejected = rejected;
  }
}

export function createChain(net) {
  let pending = null; // memoised client bundle
  let bundleKey = "";

  async function clients() {
    const key = `${net.cfg?.chainId}:${net.wallet.state.address}`;
    if (pending && bundleKey === key) return pending;
    bundleKey = key;
    pending = (async () => {
      const V = await loadViem();
      const ci = chainInfo(net.cfg);
      const chain = V.defineChain({
        id: ci.id, name: ci.name,
        nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
        rpcUrls: { default: { http: ci.rpc ? [ci.rpc] : [] } },
        blockExplorers: ci.explorer ? { default: { name: "Explorer", url: ci.explorer } } : undefined,
      });
      const provider = net.wallet.state.provider;
      const transport = ci.rpc ? V.http(ci.rpc) : provider ? V.custom(provider) : null;
      if (!transport) throw new TxError("No RPC available. Connect a wallet first.");
      const pc = V.createPublicClient({ chain, transport });
      const wc = provider && net.wallet.state.address
        ? V.createWalletClient({ account: net.wallet.state.address, chain, transport: V.custom(provider) })
        : null;
      return {
        V, chain, pc, wc, transport, abi: {
          royale: V.parseAbi(ROYALE_ABI), session: V.parseAbi(SESSION_ABI), rain: V.parseAbi(RAIN_ABI),
        },
      };
    })();
    pending.catch(() => { pending = null; });
    return pending;
  }

  const gasFor = (name) => BigInt(net.cfg?.gas?.[name] ?? GAS[name]);
  const addr = {
    get royale() { return net.cfg.contracts.royale; },
    get rain() { return net.cfg.contracts.rain; },
    get sessions() { return net.cfg.contracts.sessions; },
  };

  /** Turn any viem/wallet error into a short, readable TxError. */
  async function explain(e) {
    if (e instanceof TxError) return e;
    const code = e?.code ?? e?.cause?.code ?? e?.cause?.cause?.code;
    if (code === 4001 || e?.name === "UserRejectedRequestError" || /user (rejected|denied)/i.test(e?.message ?? "")) {
      return new TxError("Cancelled in your wallet.", { cause: e, rejected: true });
    }
    let name;
    try {
      const V = await loadViem();
      const rev = e?.walk?.((x) => x instanceof V.ContractFunctionRevertedError);
      name = rev?.data?.errorName;
      if (!name && rev?.reason) return new TxError(`Reverted: ${rev.reason}`, { cause: e });
      if (!name && e?.walk?.((x) => x instanceof V.InsufficientFundsError)) {
        return new TxError("Not enough MON to cover the amount plus gas.", { cause: e });
      }
    } catch { /* viem unavailable: fall through */ }
    if (name) return new TxError(FRIENDLY[name] ?? `Rejected by contract: ${name}`, { cause: e, errorName: name });
    const msg = e?.shortMessage ?? e?.message ?? String(e);
    return new TxError(msg.length > 160 ? msg.slice(0, 157) + "…" : msg, { cause: e });
  }

  /**
   * Send a contract call. `signer` = { account, client } for a session key, else the connected wallet.
   * `simulate` runs eth_call first so reverts surface as readable errors without burning gas.
   */
  async function send(name, { to, abiKey, fn, args = [], value, simulate = false, signer = null, nonce }) {
    try {
      const c = await clients();
      if (!signer && !c.wc) throw new TxError("Connect a wallet first.");
      const account = signer ? signer.account : net.wallet.state.address;
      const base = { address: to, abi: c.abi[abiKey], functionName: fn, args, gas: gasFor(name), ...(value !== undefined ? { value } : {}) };
      if (simulate) await c.pc.simulateContract({ ...base, account: signer ? signer.account.address : account });
      const hash = await (signer ? signer.client : c.wc).writeContract({ ...base, account, chain: c.chain, ...(nonce !== undefined ? { nonce } : {}) });
      const receipt = c.pc.waitForTransactionReceipt({ hash, timeout: 45_000 }).then((r) => {
        if (r.status === "reverted") throw new TxError("Transaction reverted on-chain.");
        return r;
      });
      receipt.catch(() => {}); // callers that don't await still must not leave an unhandled rejection
      return { hash, receipt };
    } catch (e) {
      throw await explain(e);
    }
  }

  // ---------- player actions ----------
  const tierInfo = (tier) => net.cfg.tiers.find((t) => t.tier === tier);

  async function enter(tier) {
    const t = tierInfo(tier);
    if (!t) throw new TxError("That entry tier is not available.");
    const { hash, receipt } = await send("enter", { to: addr.royale, abiKey: "royale", fn: "enter", args: [tier], value: BigInt(t.valueWei), simulate: true });
    const r = await receipt.catch((e) => { throw e instanceof TxError ? e : new TxError("Could not confirm the entry transaction.", { cause: e }); });
    const c = await clients();
    const logs = c.V.parseEventLogs({ abi: c.abi.royale, logs: r.logs, eventName: "SeatTaken" });
    const mine = logs.find((l) => l.args.player.toLowerCase() === net.wallet.state.address);
    net.wallet.refreshBalance();
    return { hash, gameId: mine ? String(mine.args.gameId) : null, seat: mine ? Number(mine.args.seat) : null };
  }

  async function leaveLobby(gameId) {
    const { hash, receipt } = await send("leaveLobby", { to: addr.royale, abiKey: "royale", fn: "leaveLobby", args: [BigInt(gameId)], simulate: true });
    await receipt;
    net.wallet.refreshBalance();
    return hash;
  }

  // session-key nonce manager: sequential sends, nonce = max(local counter, pending count)
  let nextNonce = null;
  let nonceAcct = null;
  async function sessionNonce(signer) {
    const c = await clients();
    const a = signer.account.address;
    if (nonceAcct !== a) { nextNonce = null; nonceAcct = a; }
    const n = await c.pc.getTransactionCount({ address: a, blockTag: "pending" });
    nextNonce = Math.max(n, nextNonce ?? 0);
    return nextNonce++;
  }

  async function sendPick({ gameId, x, y }) {
    const signer = await net.session.signer();
    const g = BigInt(gameId);
    if (signer) {
      try {
        const nonce = await sessionNonce(signer);
        return await send("pickFor", { to: addr.royale, abiKey: "royale", fn: "pickFor", args: [g, net.wallet.state.address, x, y], signer, nonce });
      } catch (e) { nextNonce = null; throw e; }
    }
    return send("pick", { to: addr.royale, abiKey: "royale", fn: "pick", args: [g, x, y] });
  }

  // latest-wins queue: a flurry of clicks only ever sends the newest spot once the previous tx is out
  let pickBusy = false;
  let pickLatest = null;
  async function drainPicks() {
    if (pickBusy) return;
    pickBusy = true;
    while (pickLatest) {
      const job = pickLatest;
      pickLatest = null;
      try { job.resolve(await sendPick(job.args)); } catch (e) { job.reject(e); }
    }
    pickBusy = false;
  }
  /** x,y in millimetres. Resolves { hash, receipt } or null if a newer pick superseded this one. */
  function pick(gameId, x, y) {
    return new Promise((resolve, reject) => {
      pickLatest?.resolve(null);
      pickLatest = { args: { gameId, x, y }, resolve, reject };
      drainPicks();
    });
  }

  async function cashOut(gameId) {
    const g = BigInt(gameId);
    const signer = await net.session.signer();
    let res;
    if (signer) {
      try {
        const nonce = await sessionNonce(signer);
        res = await send("cashOutFor", { to: addr.royale, abiKey: "royale", fn: "cashOutFor", args: [g, net.wallet.state.address], signer, nonce, simulate: true });
      } catch (e) { nextNonce = null; throw e; }
    } else {
      res = await send("cashOut", { to: addr.royale, abiKey: "royale", fn: "cashOut", args: [g], simulate: true });
    }
    await res.receipt;
    net.wallet.refreshBalance();
    return res.hash;
  }

  async function claimable() {
    const c = await clients();
    return c.pc.readContract({ address: addr.royale, abi: c.abi.royale, functionName: "claimable", args: [net.wallet.state.address] });
  }
  async function withdraw() {
    const { hash, receipt } = await send("withdraw", { to: addr.royale, abiKey: "royale", fn: "withdraw", simulate: true });
    await receipt;
    net.wallet.refreshBalance();
    return hash;
  }
  async function rainJoin(rainId) {
    const { hash, receipt } = await send("rainJoin", { to: addr.rain, abiKey: "rain", fn: "join", args: [BigInt(rainId)], simulate: true });
    await receipt;
    return hash;
  }
  async function rainClaim(rainId) {
    const { hash, receipt } = await send("rainClaim", { to: addr.rain, abiKey: "rain", fn: "claim", args: [BigInt(rainId)], simulate: true });
    await receipt;
    net.wallet.refreshBalance();
    return hash;
  }

  return {
    clients, send, explain, gasFor, addr,
    enter, leaveLobby, pick, cashOut, withdraw, claimable, rainJoin, rainClaim,
    txUrl: (hash) => { const e = chainInfo(net.cfg).explorer; return e ? `${e}/tx/${hash}` : null; },
    reset: () => { pending = null; nextNonce = null; },
  };
}
