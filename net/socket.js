// WebSocket client (docs/INTERFACES.md §4): auto-reconnect, channel subscriptions, server clock offset,
// typed dispatch. Frames are JSON `{ t: type, ... }`.
import { wsUrl } from "./config.js";

export function createSocket() {
  const handlers = new Map(); // type -> Set<fn>
  const statusHandlers = new Set();
  const wants = new Map();    // owner -> string[] of channels
  let ws = null;
  let token = null;
  let attempts = 0;
  let timer = null;
  let pingTimer = null;
  let closedByUs = false;
  let everOpened = false;
  let offset = 0; // serverTime - Date.now()
  const self = {
    status: "idle", // idle | connecting | open | closed
    get everOpened() { return everOpened; },
    get attempts() { return attempts; },
  };

  const setStatus = (s) => {
    self.status = s;
    statusHandlers.forEach((f) => f(s));
  };
  const channels = () => [...new Set([...wants.values()].flat().filter(Boolean))];
  const sendRaw = (obj) => {
    if (ws?.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(obj)); return true; }
    return false;
  };

  function dispatch(msg) {
    const set = handlers.get(msg.t);
    set?.forEach((f) => { try { f(msg); } catch (e) { console.error(`[ws] handler for ${msg.t} threw`, e); } });
    handlers.get("*")?.forEach((f) => { try { f(msg); } catch (e) { console.error("[ws] handler threw", e); } });
  }

  function open() {
    clearTimeout(timer);
    closedByUs = false;
    setStatus("connecting");
    let url = wsUrl();
    if (token) url += (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token);
    try { ws = new WebSocket(url); } catch (e) { return scheduleReconnect(); }
    ws.onopen = () => {
      attempts = 0;
      everOpened = true;
      setStatus("open");
      const ch = channels();
      if (ch.length) sendRaw({ t: "sub", channels: ch });
      clearInterval(pingTimer);
      pingTimer = setInterval(() => sendRaw({ t: "ping" }), 20000);
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (!msg || typeof msg.t !== "string") return;
      if (msg.t === "hello" && Number.isFinite(Number(msg.serverTime))) offset = Number(msg.serverTime) - Date.now();
      dispatch(msg);
    };
    ws.onclose = (ev) => {
      clearInterval(pingTimer);
      ws = null;
      if (ev?.code === 4401) {
        // bad/expired ?token=: drop it, tell listeners to forget the sign-in, reconnect anonymously
        token = null;
        dispatch({ t: "_authExpired" });
      }
      if (closedByUs) return setStatus("closed");
      setStatus("closed");
      scheduleReconnect();
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  function scheduleReconnect() {
    attempts++;
    const delay = Math.min(10000, 400 * 2 ** Math.min(attempts, 5));
    clearTimeout(timer);
    timer = setTimeout(open, delay);
  }

  Object.assign(self, {
    connect: () => { if (!ws) open(); },
    close: () => { closedByUs = true; clearTimeout(timer); ws?.close(); },
    reconnect: () => { clearTimeout(timer); if (ws) { closedByUs = false; ws.onclose = null; ws.close(); ws = null; } attempts = 0; open(); },
    /** Typed dispatch: on("pick", fn). "*" receives everything. Returns an unsubscribe. */
    on(type, fn) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(fn);
      return () => handlers.get(type).delete(fn);
    },
    onStatus(fn) { statusHandlers.add(fn); return () => statusHandlers.delete(fn); },
    /** Each owner declares the channels it needs; the union is (re)sent on every change and reconnect. */
    want(owner, list) {
      const before = new Set(channels());
      wants.set(owner, list);
      if (ws?.readyState !== WebSocket.OPEN) return;
      const after = new Set(channels());
      const dropped = [...before].filter((c) => !after.has(c));
      if (dropped.length) sendRaw({ t: "unsub", channels: dropped });
      sendRaw({ t: "sub", channels: [...after] });
    },
    send: sendRaw,
    setToken(t) {
      if (t === token) return;
      token = t;
      if (ws) self.reconnect();
    },
    /** Server clock in unix ms (offset from the `hello` frame). */
    now: () => Date.now() + offset,
    get offset() { return offset; },
  });
  return self;
}
