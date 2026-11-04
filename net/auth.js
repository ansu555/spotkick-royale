// SIWE-style sign-in for chat (docs §3): GET /auth/nonce -> personal_sign -> POST /auth/verify.
// Money never depends on this; it only unlocks posting in chat.
import { api, toMs } from "./config.js";

const KEY = "sk:auth";
const utf8hex = (s) => "0x" + [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, "0")).join("");

export function createAuth(net) {
  let token = null;
  let expiresAt = 0;
  let address = null;

  function load(addr) {
    try {
      const raw = JSON.parse(sessionStorage.getItem(KEY) ?? "null");
      if (raw && raw.address === addr && raw.expiresAt > Date.now() + 30000) {
        ({ token, expiresAt, address } = raw);
        return token;
      }
    } catch { /* ignore */ }
    token = null; expiresAt = 0; address = null;
    return null;
  }

  async function signIn() {
    const w = net.wallet.state;
    if (!w.connected) throw new Error("Connect a wallet first");
    if (load(w.address)) { net.socket.setToken(token); return token; }
    const { message } = await api(`/auth/nonce?address=${w.address}`);
    const signature = await w.provider.request({ method: "personal_sign", params: [utf8hex(message), w.address] });
    const res = await api("/auth/verify", { method: "POST", body: { address: w.address, signature } });
    token = res.token;
    expiresAt = toMs(res.expiresAt) || Date.now() + 3600e3;
    address = w.address;
    try { sessionStorage.setItem(KEY, JSON.stringify({ token, expiresAt, address })); } catch { /* ignore */ }
    net.socket.setToken(token);
    return token;
  }

  function signOut() {
    token = null; expiresAt = 0; address = null;
    try { sessionStorage.removeItem(KEY); } catch { /* ignore */ }
    net.socket.setToken(null);
  }

  return {
    signIn, signOut,
    /** token valid for the connected wallet, else null */
    get token() { const a = net.wallet.state.address; return a && load(a); },
  };
}
