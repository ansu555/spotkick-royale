// Network facade: one object that wires wallet, chain, session, socket and auth together.
import { loadConfig, apiBase } from "./config.js";
import { createWallet } from "./wallet.js";
import { createSocket } from "./socket.js";
import { createChain } from "./chain.js";
import { createSession } from "./session.js";
import { createAuth } from "./auth.js";

export function createNet() {
  const net = {
    cfg: null,
    status: "connecting", // connecting | ready | reconnecting | down
    error: null,
    apiBase: apiBase(),
  };
  const handlers = new Set();
  const emit = () => handlers.forEach((f) => f(net));
  net.on = (f) => { handlers.add(f); return () => handlers.delete(f); };
  const setStatus = (s, err = null) => {
    if (net.status === s && net.error === err) return;
    net.status = s; net.error = err; emit();
  };

  net.socket = createSocket();
  net.wallet = createWallet(net);
  net.chain = createChain(net);
  net.session = createSession(net);
  net.auth = createAuth(net);

  // socket health drives the status: never connected after 2 tries => down; dropped after being up => reconnecting
  net.socket.onStatus((s) => {
    if (!net.cfg) return;
    if (s === "open") setStatus("ready");
    else if (s === "closed") {
      if (!net.socket.everOpened && net.socket.attempts >= 2) setStatus("down", "WebSocket unreachable");
      else if (net.socket.everOpened) setStatus("reconnecting");
    }
  });

  let initStarted = false;
  net.init = async () => {
    if (initStarted && net.status !== "down") return;
    initStarted = true;
    setStatus("connecting");
    try {
      net.cfg = await loadConfig();
    } catch (e) {
      setStatus("down", e.message);
      return;
    }
    net.chain.reset();
    emit();
    net.socket.connect();
    net.wallet.restore().then((ok) => { if (ok) net.session.load(); });
  };
  net.retry = async () => {
    if (net.cfg) { net.socket.reconnect(); setStatus("connecting"); } else { initStarted = false; await net.init(); }
  };

  // server rejected our token (close code 4401): forget it; the next chat send re-runs SIWE
  net.socket.on("_authExpired", () => { net.auth.signOut(); emit(); });

  // keep the session key in step with the connected account
  let lastAddr = null;
  net.wallet.on((w) => {
    if (w.address !== lastAddr) {
      lastAddr = w.address;
      if (net.cfg) net.session.load();
    }
  });

  return net;
}
