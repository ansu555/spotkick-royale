// Casino shell — match strip, wallet, terrace chat with MON rain, LED wins board, toasts, modals.
// Everything here is real: the wallet is an EVM wallet on Monad, the balance is read from chain, and
// chat / rain / online count / wins arrive over the game server's WebSocket and REST API.
import { api, weiToMon, toMs, chainInfo } from "./net/config.js";

let monUsd = null; // from /config; null => USD is hidden
export const setMonUsd = (v) => { monUsd = Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null; };
export const fmtMon = (n, d = 2) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
/** "$1,234" or "" when no price feed is available (callers hide empty USD lines). */
export const fmtUsd = (mon) => (monUsd == null ? "" : "$" + (mon * monUsd).toLocaleString("en-US", { maximumFractionDigits: 0 }));
export const usdLine = (mon) => (monUsd == null ? "" : "≈ " + fmtUsd(mon));
export const curMark = "◎"; // old look: ring glyph before LED amounts
export const monIcon = `<svg class="sol" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.4"/><circle cx="12" cy="12" r="3.6" fill="currentColor"/></svg>`; // old look: coin icon in balance / rain

const ICON = {
  shield: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 5 5.5v5.7c0 4.4 2.9 8.3 7 9.8 4.1-1.5 7-5.4 7-9.8V5.5L12 3z"/><path d="m9 12 2.2 2.2L15.5 10"/></svg>`,
  send: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h15M13 6l6 6-6 6"/></svg>`,
  rain: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 15a4 4 0 0 1-.6-8 5.5 5.5 0 0 1 10.6 1.4A3.3 3.3 0 0 1 17 15"/><path d="M9 18l-1 2M13 18l-1 2M17 18l-1 2"/></svg>`,
  close: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>`,
  sound: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path class="on" d="M15.5 9.5a3.5 3.5 0 0 1 0 5M18 7a7 7 0 0 1 0 10"/><path class="off" d="m16 10 4 4M20 10l-4 4"/></svg>`,
  copy: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg>`,
};

const short = (a) => (a && /^0x[0-9a-fA-F]{40}$/.test(a) ? `${a.slice(0, 6)}…${a.slice(-4)}` : String(a ?? ""));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// chat text arrives already HTML-escaped from the server: decode it and render as text (never as markup)
const unescapeText = (s) => String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, "&");
// server `sys` lines are HTML, but only <b> is allowed through
const cleanSys = (html) => esc(html).replace(/&lt;(\/?)b&gt;/g, "<$1b>");

export function createCasino(sfx, net) {
  document.body.classList.add("casino");
  const wallet = net.wallet.state;
  const listeners = [];

  // ---------------- match strip (top bar) ----------------
  const top = document.createElement("header");
  top.id = "top";
  top.innerHTML = `
    <a class="brand" href="#" aria-label="Spotkick">
      <span class="brand-spot"></span><span class="brand-word">SPOTKICK</span>
    </a>
    <nav class="games" aria-label="Games">
      <a class="active" aria-current="page"><i class="live-dot"></i>Royale</a>
      <a aria-disabled="true">Crash<small>Soon</small></a>
      <a aria-disabled="true">Coinflip<small>Soon</small></a>
      <a aria-disabled="true">Mines<small>Soon</small></a>
    </nav>
    <div class="top-right">
      <span class="online"><b id="c-online">—</b> watching</span>
      <button class="icon-btn" id="c-sound" title="Sound">${ICON.sound}</button>
      <button class="icon-btn" id="c-fair" title="How results are picked">${ICON.shield}</button>
      <button class="balance" id="c-balance" hidden>${monIcon}<b id="c-bal">0.000</b></button>
      <button class="btn btn-y" id="c-deposit" hidden>Fund</button>
      <button class="btn btn-line" id="c-wallet"><span id="c-wallet-label">Connect wallet</span></button>
    </div>`;
  document.body.prepend(top);

  // ---------------- terrace chat ----------------
  const chat = document.createElement("aside");
  chat.id = "chat";
  chat.innerHTML = `
    <header><b>Chat</b><span class="online"><b id="c-online-2">—</b> watching</span></header>
    <div class="rain" id="c-rain" hidden>
      <div class="rain-l">
        <span class="rain-k">${ICON.rain}MON rain</span>
        <span class="rain-amt">${monIcon}<b id="c-rain-amt">0.00</b></span>
        <span class="rain-meta"><span id="c-rain-n">0 joined</span> · <span id="c-rain-lbl">splits in</span> <span id="c-rain-t">0:00</span></span>
      </div>
      <button class="btn btn-line sm" id="c-rain-join">Join</button>
    </div>
    <ul id="c-msgs" aria-live="polite"></ul>
    <form id="c-form" autocomplete="off">
      <input id="c-input" maxlength="140" placeholder="Connect a wallet to chat" disabled aria-label="Message" />
      <button type="submit" aria-label="Send">${ICON.send}</button>
    </form>`;
  document.body.appendChild(chat);

  // ---------------- LED wins board ----------------
  const ticker = document.createElement("footer");
  ticker.id = "ticker";
  ticker.innerHTML = `<span class="t-k">Recent wins</span><div class="t-track"><div class="t-row" id="c-trow"></div><span class="t-empty" id="c-tempty">No wins yet</span></div>`;
  document.body.appendChild(ticker);

  const toasts = document.createElement("div");
  toasts.id = "toasts";
  toasts.setAttribute("aria-live", "polite");
  document.body.appendChild(toasts);
  const modal = document.createElement("div");
  modal.id = "modal";
  document.body.appendChild(modal);

  const $ = (id) => document.getElementById(id);

  // ---------------- toasts / modal ----------------
  function toast(html, kind = "") {
    const t = document.createElement("div");
    t.className = `toast ${kind}`;
    t.innerHTML = html;
    toasts.appendChild(t);
    setTimeout(() => t.classList.add("out"), kind === "bad" ? 5200 : 3400);
    setTimeout(() => t.remove(), kind === "bad" ? 5500 : 3700);
  }
  const toastErr = (e) => toast(esc(e?.message ?? String(e)), "bad");

  function openModal(html, cls = "") {
    modal.innerHTML = `<div class="m-back"></div><div class="m-card ${cls}" role="dialog" aria-modal="true"><button class="m-x" aria-label="Close">${ICON.close}</button>${html}</div>`;
    modal.classList.add("show");
    modal.querySelector(".m-back").onclick = closeModal;
    modal.querySelector(".m-x").onclick = closeModal;
    return modal.querySelector(".m-card");
  }
  function closeModal() { modal.classList.remove("show"); }
  addEventListener("keydown", (e) => { if (e.key === "Escape" && modal.classList.contains("show")) modal.querySelector(".m-x")?.click(); });

  const copy = async (text, msg = "Copied") => {
    try { await navigator.clipboard.writeText(text); toast(msg); } catch { toast("Copy failed. Select the text manually.", "bad"); }
  };

  // ---------------- wallet ----------------
  let lastBal = null;
  function bump(dir) {
    const el = $("c-balance");
    el.classList.remove("up", "down");
    void el.offsetWidth;
    el.classList.add(dir);
  }
  function renderWallet() {
    const wrong = net.wallet.wrongChain;
    $("c-wallet-label").textContent = !wallet.connected ? "Connect wallet" : wrong ? "Wrong network" : short(wallet.address);
    $("c-wallet").classList.toggle("on", wallet.connected);
    $("c-balance").hidden = !wallet.connected;
    $("c-deposit").hidden = !wallet.connected;
    const bal = weiToMon(wallet.balance);
    $("c-bal").textContent = fmtMon(bal, 3);
    if (lastBal !== null && wallet.connected && bal !== lastBal) bump(bal > lastBal ? "up" : "down");
    lastBal = wallet.connected ? bal : null;
    renderChatInput();
  }
  net.wallet.on(() => { renderWallet(); listeners.forEach((f) => f(wallet)); });

  let pendingConnect = null;
  async function doConnect(detail) {
    try {
      await net.wallet.connect(detail);
      toast(`Connected ${esc(detail.info.name)} · <span class="mono">${short(wallet.address)}</span>`, "ok");
      return true;
    } catch (e) {
      if (e?.code === 4001) toast("Connection cancelled.", "bad");
      else toast(esc(e?.message ?? e) + (wallet.connected ? " Switch network from the wallet menu." : ""), "bad");
      return wallet.connected && !net.wallet.wrongChain;
    }
  }

  function connectModal() {
    return new Promise(async (resolve) => {
      pendingConnect = resolve;
      const done = (ok) => { closeModal(); pendingConnect?.(ok); pendingConnect = null; };
      const card = openModal(`<h3>Connect a wallet</h3><p class="m-sub">Looking for wallets…</p><div class="w-list"></div>`, "m-wallet");
      modal.querySelector(".m-back").onclick = () => done(false);
      modal.querySelector(".m-x").onclick = () => done(false);
      const list = await net.wallet.discoverAsync(250);
      if (!list.length) {
        card.querySelector(".m-sub").innerHTML = "No EVM wallet found in this browser. Install one (for example <a href=\"https://metamask.io/download/\" target=\"_blank\" rel=\"noopener\">MetaMask</a> or <a href=\"https://rabby.io\" target=\"_blank\" rel=\"noopener\">Rabby</a>), add Monad, then reload this page.";
        return;
      }
      card.querySelector(".m-sub").textContent = net.cfg ? `Connect to play on ${chainInfo(net.cfg).name}. Your MON stays in your wallet until you enter a royale.` : "Connect to play.";
      const wl = card.querySelector(".w-list");
      for (const d of list) {
        const b = document.createElement("button");
        b.className = "w-opt";
        b.innerHTML = `${d.info.icon ? `<img class="w-img" alt="" src="${esc(d.info.icon)}" />` : `<span class="w-ico" style="--c:#d8d4c8">${esc(d.info.name[0] ?? "?")}</span>`}${esc(d.info.name)}<em>Detected</em>`;
        b.onclick = async () => {
          b.classList.add("busy");
          b.querySelector("em").textContent = "Approve in wallet";
          const ok = await doConnect(d);
          if (ok) done(true);
          else { b.classList.remove("busy"); b.querySelector("em").textContent = "Detected"; }
        };
        wl.appendChild(b);
      }
    });
  }

  async function requireWallet() {
    if (!net.cfg) { toast("Game server not reachable yet.", "bad"); return false; }
    if (!wallet.connected) {
      if (!(await connectModal())) return false;
    }
    if (net.wallet.wrongChain) {
      try { await net.wallet.ensureChain(); } catch (e) { toastErr(e); return false; }
      renderWallet();
    }
    return wallet.connected && !net.wallet.wrongChain;
  }

  function sessionLine() {
    const s = net.session.state;
    if (s.status === "ready") return `Quick picks on · key <span class="mono">${short(s.keyAddress)}</span> · ◎${fmtMon(weiToMon(s.balance), 3)} gas`;
    if (s.status === "low") return "Quick-pick key is low on gas. Top it up to keep one-click picks.";
    return "Quick picks off: each pick asks your wallet to sign.";
  }

  async function enableQuickPicks() {
    if (!(await requireWallet())) return false;
    toast(`Approve the session, then send ◎${fmtMon(weiToMon(net.session.fundWei), 2)} to the pick key for gas.`);
    try {
      await net.session.enable();
      toast("Quick picks enabled", "ok");
      return true;
    } catch (e) {
      net.session.decline();
      toastErr(e);
      return false;
    }
  }

  async function walletMenu() {
    if (net.wallet.wrongChain) { if (!(await requireWallet())) return; }
    const card = openModal(`
      <h3>${esc(wallet.name ?? "Wallet")}</h3>
      <p class="m-sub mono" style="word-break:break-all">${esc(wallet.address)}</p>
      <div class="wm-bal"><span class="k">Balance</span><span class="led">${monIcon}${fmtMon(weiToMon(wallet.balance), 3)}</span><small>${fmtUsd(weiToMon(wallet.balance))}</small></div>
      <p class="m-sub" id="wm-sess">${sessionLine()}</p>
      <div class="m-actions"><button class="btn btn-y" id="wm-dep">Fund wallet</button><button class="btn btn-line" id="wm-dis">Disconnect</button></div>
      <div class="m-actions"><button class="btn btn-line" id="wm-qp">${net.session.state.status === "ready" ? "Revoke quick picks" : "Enable quick picks"}</button><button class="btn btn-line" id="wm-wd" hidden>Withdraw</button></div>`, "m-wallet");
    card.querySelector("#wm-dep").onclick = fundModal;
    card.querySelector("#wm-dis").onclick = () => { net.wallet.disconnect(); net.auth.signOut(); closeModal(); };
    card.querySelector("#wm-qp").onclick = async () => {
      if (net.session.state.status === "ready") {
        try { await net.session.revoke(); toast("Quick picks revoked"); } catch (e) { toastErr(e); }
      } else await enableQuickPicks();
      closeModal();
    };
    net.chain.claimable().then((w) => {
      if (w > 0n && modal.classList.contains("show")) {
        const b = card.querySelector("#wm-wd");
        b.hidden = false;
        b.textContent = `Withdraw ◎${fmtMon(weiToMon(w), 3)}`;
        b.onclick = async () => {
          b.disabled = true;
          try { await net.chain.withdraw(); toast("Withdrawn", "ok"); closeModal(); } catch (e) { toastErr(e); b.disabled = false; }
        };
      }
    }).catch(() => {});
  }

  function fundModal() {
    if (!wallet.connected) return connectModal();
    const ci = net.cfg ? chainInfo(net.cfg) : null;
    const card = openModal(`
      <h3>Fund your wallet</h3>
      <p class="m-sub">Entries are paid in MON from your own wallet${ci ? ` on ${esc(ci.name)}` : ""}. Send MON to this address (nothing is deposited into the game until you enter a royale).</p>
      <div class="dep-addr"><span class="mono" style="word-break:break-all">${esc(wallet.address)}</span><button class="icon-btn sm" id="dep-copy" title="Copy address">${ICON.copy}</button></div>
      ${net.cfg?.faucet ? `<p class="m-sub"><a href="${esc(net.cfg.faucet)}" target="_blank" rel="noopener">Network faucet</a></p>` : ""}
      <button class="btn btn-y wide" id="dep-ok">Done</button>`, "m-dep");
    card.querySelector("#dep-copy").onclick = () => copy(wallet.address, "Address copied");
    card.querySelector("#dep-ok").onclick = () => { net.wallet.refreshBalance(); closeModal(); };
  }

  // ---------------- fairness (real proof from /fair/:gameId) ----------------
  let fairInfo = {};
  async function fairModal() {
    const gid = fairInfo.gameId;
    const card = openModal(`
      <h3>How results are picked</h3>
      <p class="m-sub">Every round is decided by the contract. Nobody, including the house, chooses the target or the verdict.</p>
      <div id="fair-body"><p class="m-sub">${gid ? "Loading proof…" : "Open a royale to see its proof."}</p></div>
      <dl class="fair-dl">
        <dt>Target</dt><dd>From the round seed: 60% of the time anchored on a random alive player's spot, otherwise anywhere on the goal, plus noise. Clamped to x ±3.30 m, y 0.25–2.15 m.</dd>
        <dt>Verdict</dt><dd>The target cell's save chance (table in the contract) against the seed decides GOAL or SAVED. The on-screen keeper just plays that result.</dd>
        <dt>House edge</dt><dd>${(Number(net.cfg?.constants?.FEE_BPS ?? net.cfg?.constants?.feeBps ?? 400) / 100).toFixed(0)}% of each entry, taken at entry.</dd>
      </dl>`, "m-fair");
    if (!gid) return;
    const body = card.querySelector("#fair-body");
    try {
      const d = await api(`/fair/${encodeURIComponent(gid)}`);
      const rounds = Array.isArray(d) ? d : d.rounds ?? [];
      const mm = (v) => (v === undefined || v === null ? "—" : (Number(v) / 1000).toFixed(2) + " m");
      const tx = (t) => {
        const list = Array.isArray(t) ? t : t && typeof t === "object" ? Object.values(t) : [];
        return list.filter(Boolean).map((h) => { const u = net.chain.txUrl(h); return u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(short(h).replace(/^(.{6}).*(.{4})$/, "$1…$2"))}</a>` : `<span class="mono">${esc(h)}</span>`; }).join(" · ") || "—";
      };
      body.innerHTML = `<p class="m-sub">Royale <span class="mono">${esc(gid)}</span>${d.verifierVersion ? ` · verifier v${esc(d.verifierVersion)}` : ""}</p>` + (rounds.length ? rounds.map((r) => `
        <dl class="fair-dl fair-round">
          <dt>Round</dt><dd>${esc(r.round)} · <b>${esc(String(r.outcome ?? "").toUpperCase())}</b></dd>
          <dt>Entropy request</dt><dd class="mono">${esc(r.entropyRequestId ?? "—")}</dd>
          <dt>Seed</dt><dd class="mono">${esc(r.seed ?? "pending")}</dd>
          <dt>Picks hash</dt><dd class="mono">${esc(r.picksHash ?? "—")}</dd>
          <dt>Target</dt><dd>${r.target ? `x ${mm(r.target.x ?? r.target[0])}, y ${mm(r.target.y ?? r.target[1])}` : "—"}${r.saveBps !== undefined ? ` · save chance ${(Number(r.saveBps) / 100).toFixed(1)}%` : ""}</dd>
          <dt>Transactions</dt><dd>${tx(r.txHashes)}</dd>
        </dl>`).join("") : `<p class="m-sub">No rounds resolved yet for this royale.</p>`);
    } catch (e) {
      body.innerHTML = `<p class="m-sub">Could not load the proof: ${esc(e.message)}</p>`;
    }
  }

  const renderSound = () => {
    $("c-sound").classList.toggle("muted", sfx.isMuted());
    $("c-sound").setAttribute("aria-pressed", String(!sfx.isMuted()));
  };
  $("c-sound").onclick = () => { sfx.setMuted(!sfx.isMuted()); renderSound(); };
  renderSound();

  $("c-wallet").onclick = () => (wallet.connected ? walletMenu() : requireWallet());
  $("c-deposit").onclick = fundModal;
  $("c-balance").onclick = fundModal;
  $("c-fair").onclick = fairModal;

  // ---------------- chat (WebSocket + SIWE) ----------------
  function chatMsg(user, text, { you = false, system = false, tag = "", level } = {}) {
    const ul = $("c-msgs");
    const li = document.createElement("li");
    if (system) {
      li.className = `sys ${tag ? "t-" + tag.toLowerCase().replace(/\s/g, "") : ""}`;
      li.innerHTML = `${tag ? `<span class="tag">${esc(tag)}</span>` : ""}<span>${text}</span>`;
    } else {
      li.className = you ? "you" : "";
      li.innerHTML = `<div class="who"><b></b>${level ? `<span class="lv"></span>` : ""}</div><p></p>`;
      li.querySelector("b").textContent = short(unescapeText(user));
      if (level) li.querySelector(".lv").textContent = level;
      li.querySelector("p").textContent = unescapeText(text);
    }
    ul.appendChild(li);
    while (ul.children.length > 60) ul.firstChild.remove();
    ul.scrollTop = ul.scrollHeight;
  }
  const isMine = (u) => !!wallet.address && String(u).toLowerCase() === wallet.address;
  const SYS_TAG = { entry: "Entry", cashout: "Cash out", winner: "Winner", kickoff: "Kick-off" };

  function renderChatInput() {
    const inp = $("c-input");
    if (!wallet.connected) { inp.disabled = true; inp.placeholder = "Connect a wallet to chat"; return; }
    inp.disabled = net.status === "down";
    inp.placeholder = net.auth.token ? "Message" : "Sign in to chat";
  }
  $("c-form").onsubmit = async (e) => {
    e.preventDefault();
    const v = $("c-input").value.trim();
    if (!v || !wallet.connected) return;
    try {
      if (!net.auth.token) {
        await net.auth.signIn();
        renderChatInput();
      }
      if (!net.socket.send({ t: "chat", text: v })) return toast("Not connected to chat. Retrying…", "bad");
      $("c-input").value = ""; // the server echoes the message back through the chat channel
    } catch (err) {
      toastErr(err);
    }
  };

  net.socket.want("casino", ["chat", "rain", "presence", "ticker"]);
  net.socket.on("chat", (m) => chatMsg(m.user, m.text, { you: isMine(m.user), level: m.level }));
  net.socket.on("sys", (m) => chatMsg("", cleanSys(m.html), { system: true, tag: SYS_TAG[m.kind] ?? "" }));
  net.socket.on("error", (m) => toast(esc(m.message ?? m.error ?? "Server error"), "bad"));
  net.socket.on("presence", (m) => {
    const n = Number(m.count);
    if (Number.isFinite(n)) $("c-online").textContent = $("c-online-2").textContent = n.toLocaleString();
  });

  // initial history / wins once the config (and so the API) is known
  let loadedHistory = false;
  async function loadHistory() {
    if (loadedHistory) return;
    loadedHistory = true;
    try {
      const h = await api("/chat?limit=50");
      for (const m of Array.isArray(h) ? h : h.messages ?? []) chatMsg(m.user, m.text, { you: isMine(m.user), level: m.level });
    } catch { /* chat history is optional */ }
    try {
      const w = await api("/wins?limit=24");
      for (const r of (Array.isArray(w) ? w : w.wins ?? []).reverse()) win(r.user, weiToMon(r.amount), Number(r.mult));
    } catch { /* wins board stays empty */ }
  }

  // ---------------- MON rain (Rain.sol mirrored over WS) ----------------
  let rain = null;
  const joinedKey = "sk:rain-joined";
  const joinedRains = new Set((() => { try { return JSON.parse(localStorage.getItem(joinedKey) ?? "[]"); } catch { return []; } })());
  const saveJoined = () => { try { localStorage.setItem(joinedKey, JSON.stringify([...joinedRains].slice(-20))); } catch { /* ignore */ } };
  function renderRain() {
    const box = $("c-rain");
    if (!rain || (rain.settled && !joinedRains.has(String(rain.rainId)))) { box.hidden = true; return; }
    box.hidden = false;
    $("c-rain-amt").textContent = fmtMon(weiToMon(rain.amount));
    $("c-rain-n").textContent = `${rain.joined} joined`;
    const btn = $("c-rain-join");
    const mine = joinedRains.has(String(rain.rainId));
    if (rain.settled) {
      $("c-rain-lbl").textContent = "settled";
      $("c-rain-t").textContent = "";
      btn.textContent = "Claim";
      btn.disabled = !mine;
    } else {
      const left = Math.max(0, Math.round((toMs(rain.endsAt) - net.socket.now()) / 1000));
      $("c-rain-lbl").textContent = "splits in";
      $("c-rain-t").textContent = `${(left / 60) | 0}:${String(left % 60).padStart(2, "0")}`;
      btn.textContent = mine ? "Joined" : "Join";
      btn.disabled = mine;
    }
  }
  net.socket.on("rain", (m) => {
    const wasSettled = rain?.settled;
    rain = m;
    if (m.settled && !wasSettled && joinedRains.has(String(m.rainId))) chatMsg("", `Rain settled: <b>◎${fmtMon(weiToMon(m.amount))}</b> split between ${m.joined} players. Claim yours.`, { system: true, tag: "Rain" });
    renderRain();
  });
  setInterval(() => { if (rain && !rain.settled) renderRain(); }, 1000);
  $("c-rain-join").onclick = async () => {
    if (!rain || !(await requireWallet())) return;
    const btn = $("c-rain-join");
    btn.disabled = true;
    try {
      if (rain.settled) {
        await net.chain.rainClaim(rain.rainId);
        joinedRains.delete(String(rain.rainId));
        sfx.play("coins", { vol: 0.7 });
        toast("Rain claimed", "ok");
      } else {
        await net.chain.rainJoin(rain.rainId);
        joinedRains.add(String(rain.rainId));
        toast("Joined the rain", "ok");
      }
      saveJoined();
    } catch (e) { toastErr(e); }
    renderRain();
  };

  // ---------------- LED wins board (real indexed wins only) ----------------
  function win(user, amount, mult) {
    const row = $("c-trow");
    const chip = document.createElement("span");
    chip.className = `t-chip ${mult >= 10 ? "big" : ""}`;
    chip.innerHTML = `<b>${esc(short(user))}</b><em>${fmtMon(amount)}</em><i>${Number.isFinite(mult) ? mult.toFixed(2) : "—"}×</i>`;
    row.prepend(chip);
    while (row.children.length > 24) row.lastChild.remove();
    $("c-tempty").hidden = true;
  }
  net.socket.on("ticker", (m) => win(m.user, weiToMon(m.amount), Number(m.mult)));

  function bigWin(amount, mult, title = "You won the royale") {
    const card = openModal(`
      <div class="bw-k">${esc(title)}</div>
      <div class="bw-amt led">◎${fmtMon(amount, 3)}</div>
      <div class="bw-sub"><span>${mult.toFixed(2)}× your entry</span><span>${fmtUsd(amount)}</span></div>
      <button class="btn btn-y wide" id="bw-ok">Collect</button>`, "m-bigwin");
    card.querySelector("#bw-ok").onclick = closeModal;
  }

  // Doto's "." renders as "+" at display sizes; render punctuation in the mono face.
  const LED_SEL = ".led, #c-bal, .rain-amt b, .t-chip em, .t-chip i, .sb-left b, .res-split b, .offer-v em, .win-prize em, .lb-meta b, .seg button";
  const PUNCT = /([.◎×:])/;
  let ledQueued = false;
  function ledify() {
    ledQueued = false;
    for (const el of document.querySelectorAll(LED_SEL)) {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const hits = [];
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.parentElement.classList.contains("lp") && PUNCT.test(n.data)) hits.push(n);
      }
      for (const n of hits) {
        const frag = document.createDocumentFragment();
        for (const part of n.data.split(PUNCT)) {
          if (!part) continue;
          if (PUNCT.test(part)) {
            const sp = document.createElement("span");
            sp.className = "lp";
            sp.textContent = part;
            frag.appendChild(sp);
          } else frag.appendChild(document.createTextNode(part));
        }
        n.replaceWith(frag);
      }
    }
  }
  new MutationObserver(() => {
    if (!ledQueued) { ledQueued = true; requestAnimationFrame(ledify); }
  }).observe(document.body, { subtree: true, childList: true, characterData: true });

  // config arrives asynchronously: price feed, history
  net.on(() => {
    if (net.cfg) {
      setMonUsd(net.cfg.monUsd);
      loadHistory();
    }
    renderChatInput();
  });

  renderWallet();

  return {
    wallet,
    requireWallet,
    enableQuickPicks,
    toast,
    toastErr,
    win,
    bigWin,
    copy,
    openFund: fundModal,
    setFair: (info) => (fairInfo = { ...fairInfo, ...info }),
    onWallet: (f) => listeners.push(f),
    short,
    esc,
  };
}
