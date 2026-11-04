// EIP-6963 wallet discovery + connection to the Monad chain. No viem needed here: raw EIP-1193.
import { chainInfo } from "./config.js";

const LAST_KEY = "sk:wallet";
const hex = (n) => "0x" + BigInt(n).toString(16);

export function createWallet(net) {
  const found = new Map(); // uuid -> { info, provider }
  const state = {
    connected: false,
    address: null,       // lowercase 0x...
    chainId: null,       // number
    balance: 0n,         // wei
    name: null,          // real wallet name from EIP-6963
    provider: null,
  };
  const handlers = new Set();
  const emit = () => handlers.forEach((f) => f(state));
  let pollTimer = null;
  let bound = null; // provider we attached listeners to

  // ---------- discovery ----------
  addEventListener("eip6963:announceProvider", (e) => {
    const d = e.detail;
    if (d?.info?.uuid && d.provider) found.set(d.info.uuid, { info: d.info, provider: d.provider });
  });
  const discover = () => dispatchEvent(new Event("eip6963:requestProvider"));
  discover();

  /** Discovered wallets. Falls back to a bare window.ethereum (real name from its flags) if nothing announced. */
  function list() {
    const out = [...found.values()];
    if (!out.length && window.ethereum) {
      const eth = window.ethereum;
      const name = eth.isRabby ? "Rabby" : eth.isPhantom ? "Phantom" : eth.isCoinbaseWallet ? "Coinbase Wallet"
        : eth.isMetaMask ? "MetaMask" : "Browser wallet";
      out.push({ info: { uuid: "window.ethereum", name, icon: "", rdns: "" }, provider: eth });
    }
    return out;
  }
  async function discoverAsync(ms = 200) {
    discover();
    await new Promise((r) => setTimeout(r, ms));
    return list();
  }

  // ---------- chain ----------
  const expectedChain = () => net.cfg?.chainId ?? null;
  const onWrongChain = () => state.connected && expectedChain() && state.chainId !== expectedChain();

  /** "chain not added" comes back in different shapes: 4902, -32603 with a nested code, or only a message. */
  const isUnknownChain = (e) =>
    e?.code === 4902 || e?.code === -32603 || e?.data?.originalError?.code === 4902 || e?.data?.code === 4902 ||
    /unrecognized chain|unknown chain|not been added|not added|4902/i.test(String(e?.message ?? ""));

  async function ensureChain(provider = state.provider) {
    const want = expectedChain();
    if (!want || !provider) return;
    const cur = Number(await provider.request({ method: "eth_chainId" }));
    state.chainId = cur;
    if (cur === want) return;
    try {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex(want) }] });
    } catch (e) {
      if (isUnknownChain(e)) {
        const ci = chainInfo(net.cfg);
        if (!ci.rpc) throw new Error("This network is not in your wallet and the server did not provide an RPC URL.");
        await provider.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: hex(want),
            chainName: ci.name,
            nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
            rpcUrls: [ci.rpc],
            blockExplorerUrls: ci.explorer ? [ci.explorer] : [],
          }],
        });
        // some wallets add the network without switching to it
        if (Number(await provider.request({ method: "eth_chainId" })) !== want) {
          await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex(want) }] });
        }
      } else throw e;
    }
    state.chainId = Number(await provider.request({ method: "eth_chainId" }));
  }

  // ---------- connect ----------
  function bind(provider) {
    if (bound === provider) return;
    bound = provider;
    provider.on?.("accountsChanged", (accts) => {
      if (!accts?.length) return disconnect(false);
      state.address = accts[0].toLowerCase();
      refreshBalance();
      emit();
    });
    provider.on?.("chainChanged", (id) => {
      state.chainId = Number(id);
      refreshBalance();
      emit();
    });
    provider.on?.("disconnect", () => disconnect(false));
  }

  async function connect(detail) {
    const { provider, info } = detail;
    const accts = await provider.request({ method: "eth_requestAccounts" });
    if (!accts?.length) throw new Error("Wallet returned no accounts");
    state.provider = provider;
    state.name = info.name;
    state.address = accts[0].toLowerCase();
    state.connected = true;
    bind(provider);
    try { await ensureChain(provider); } catch (e) {
      // stay connected but flagged as wrong network; callers show the reason
      state.chainId = Number(await provider.request({ method: "eth_chainId" }).catch(() => 0));
      emit();
      throw e;
    }
    try { localStorage.setItem(LAST_KEY, info.rdns || info.uuid); } catch { /* storage unavailable */ }
    await refreshBalance();
    startPoll();
    emit();
    return state;
  }

  /** Silent re-connect (no popup) if the user connected before and the wallet still authorises this site. */
  async function restore() {
    let last = null;
    try { last = localStorage.getItem(LAST_KEY); } catch { /* ignore */ }
    if (!last) return false;
    const all = await discoverAsync(300);
    const d = all.find((w) => (w.info.rdns || w.info.uuid) === last);
    if (!d) return false;
    try {
      const accts = await d.provider.request({ method: "eth_accounts" });
      if (!accts?.length) return false;
      state.provider = d.provider;
      state.name = d.info.name;
      state.address = accts[0].toLowerCase();
      state.connected = true;
      state.chainId = Number(await d.provider.request({ method: "eth_chainId" }));
      bind(d.provider);
      await ensureChain(d.provider).catch(() => { /* user can retry from the wallet menu; stay connected, flagged wrong-network */ });
      await refreshBalance();
      startPoll();
      emit();
      return true;
    } catch { return false; }
  }

  async function refreshBalance() {
    if (!state.connected || !state.provider) return state.balance;
    try {
      const b = await state.provider.request({ method: "eth_getBalance", params: [state.address, "latest"] });
      state.balance = BigInt(b);
      emit();
    } catch { /* keep last known balance */ }
    return state.balance;
  }
  function startPoll() {
    clearInterval(pollTimer);
    pollTimer = setInterval(refreshBalance, 6000);
  }

  function disconnect(revoke = true) {
    clearInterval(pollTimer);
    if (revoke) state.provider?.request?.({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] }).catch(() => {});
    try { localStorage.removeItem(LAST_KEY); } catch { /* ignore */ }
    Object.assign(state, { connected: false, address: null, chainId: null, balance: 0n, name: null, provider: null });
    emit();
  }

  return {
    state,
    list, discoverAsync, connect, restore, disconnect, ensureChain, refreshBalance,
    get wrongChain() { return onWrongChain(); },
    on: (f) => { handlers.add(f); return () => handlers.delete(f); },
  };
}
