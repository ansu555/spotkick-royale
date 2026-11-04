// Session key: an ephemeral key (sessionStorage) that the player authorises ONCE on SessionRegistry,
// after which picks/cash-outs go out as pickFor/cashOutFor signed by that key (no wallet popups).
// The key can only call pickFor/cashOutFor for this player; it holds a small MON balance for gas.
import { loadViem } from "./viem.js";

const FUND_WEI = 200_000_000_000_000_000n; // 0.2 MON of gas money; override with cfg.session.fundWei
const LOW_WEI = 30_000_000_000_000_000n;   // below 0.03 MON the key is treated as empty -> wallet popups
const TTL_SECS = 2 * 3600;
const store = (a) => `sk:sess:${a}`;

export function createSession(net) {
  const state = { status: "none", keyAddress: null, expiry: 0, balance: 0n, declined: false };
  let rec = null; // { pk, expiry }
  let account = null;
  const handlers = new Set();
  const emit = () => handlers.forEach((f) => f(state));

  const fundWei = () => BigInt(net.cfg?.session?.fundWei ?? FUND_WEI);
  const lowWei = () => BigInt(net.cfg?.session?.lowWei ?? LOW_WEI);

  async function load() {
    const a = net.wallet.state.address;
    rec = null; account = null;
    Object.assign(state, { status: "none", keyAddress: null, expiry: 0, balance: 0n });
    if (!a) return emit();
    try { rec = JSON.parse(sessionStorage.getItem(store(a)) ?? "null"); } catch { rec = null; }
    if (rec?.pk && rec.expiry > Date.now() / 1000 + 60) {
      const V = await loadViem();
      account = V.privateKeyToAccount(rec.pk);
      state.keyAddress = account.address;
      state.expiry = rec.expiry;
      await refresh();
    } else rec = null;
    emit();
  }

  /** Re-check on-chain authorisation + the key's gas balance. */
  async function refresh() {
    if (!account || !net.cfg) return state;
    try {
      const c = await net.chain.clients();
      const [ok, bal] = await Promise.all([
        c.pc.readContract({ address: net.chain.addr.sessions, abi: c.abi.session, functionName: "isAuthorized", args: [net.wallet.state.address, account.address] }),
        c.pc.getBalance({ address: account.address }),
      ]);
      state.balance = bal;
      state.status = !ok ? "none" : bal < lowWei() ? "low" : "ready";
    } catch { /* RPC hiccup: keep previous status */ }
    emit();
    return state;
  }

  /** One-time setup: authorize(key, expiry) from the wallet, then top the key up with gas money. */
  async function enable() {
    if (!net.wallet.state.connected) throw new Error("Connect a wallet first");
    const V = await loadViem();
    const a = net.wallet.state.address;
    if (!rec || rec.expiry < Date.now() / 1000 + 600) {
      rec = { pk: V.generatePrivateKey(), expiry: Math.floor(Date.now() / 1000) + TTL_SECS };
      try { sessionStorage.setItem(store(a), JSON.stringify(rec)); } catch { /* ignore */ }
    }
    account = V.privateKeyToAccount(rec.pk);
    state.keyAddress = account.address;
    state.expiry = rec.expiry;
    const c = await net.chain.clients();
    const isAuth = await c.pc.readContract({ address: net.chain.addr.sessions, abi: c.abi.session, functionName: "isAuthorized", args: [a, account.address] }).catch(() => false);
    if (!isAuth) {
      const r = await net.chain.send("authorize", { to: net.chain.addr.sessions, abiKey: "session", fn: "authorize", args: [account.address, BigInt(rec.expiry)], simulate: true });
      await r.receipt;
    }
    const bal = await c.pc.getBalance({ address: account.address });
    if (bal < lowWei() * 2n) {
      const hash = await c.wc.sendTransaction({ account: a, chain: c.chain, to: account.address, value: fundWei(), gas: net.chain.gasFor("fund") }).catch(async (e) => { throw await net.chain.explain(e); });
      await c.pc.waitForTransactionReceipt({ hash, timeout: 45_000 });
    }
    state.declined = false;
    net.wallet.refreshBalance();
    await refresh();
    return state;
  }

  async function revoke() {
    if (!account) return;
    const r = await net.chain.send("revoke", { to: net.chain.addr.sessions, abiKey: "session", fn: "revoke", args: [account.address] });
    await r.receipt;
    try { sessionStorage.removeItem(store(net.wallet.state.address)); } catch { /* ignore */ }
    rec = null; account = null;
    Object.assign(state, { status: "none", keyAddress: null, expiry: 0, balance: 0n });
    emit();
  }

  /** { account, client } when the session can sign right now, else null (callers fall back to the wallet). */
  async function signer() {
    if (!account || state.status === "none" || state.expiry < Date.now() / 1000 + 30) return null;
    if (state.status === "low") await refresh();
    if (state.status !== "ready") return null;
    const c = await net.chain.clients();
    const client = c.V.createWalletClient({ account, chain: c.chain, transport: c.transport });
    return { account, client };
  }

  return {
    state, load, refresh, enable, revoke, signer,
    decline() { state.declined = true; emit(); },
    on: (f) => { handlers.add(f); return () => handlers.delete(f); },
    get fundWei() { return fundWei(); },
  };
}
