import * as THREE from "three";
import { fmtMon, usdLine } from "./casino.js";
import { constants, toMs, weiToMon } from "./net/config.js";

// Penalty Royale — a crowd picks spots on the goal, the shot locks onto one point, and a blast
// radius around the strike decides who advances:
//   GOAL  → players inside the radius (closest to the strike) survive
//   SAVED → players inside the radius are eliminated; the farthest survive
// The radius is fitted so every round keeps between 25% and 75% of the field.
//
// This file is a VIEW + CONTROLLER. The contract decides everything (seats, picks, target, verdict,
// survivors, money); the game server relays chain events over WebSocket. Local `t` only drives animation.

const W_M = 7.32, H_M = 2.44, PPM = 150;
const CW = Math.round(W_M * PPM), CH = Math.round(H_M * PPM);
// animation timings only (seconds). Game timing (pick window, lobby countdown, between) comes from chain deadlines.
const T = { focus: 3.2, minConverge: 1.4, hold: 1.2, blast: 2.1, card: 2.9, win: 8 };
const SEATS = 10;
const PHASES = ["none", "lobby", "picking", "locked", "resolved", "between", "finished", "cancelled"];
const ANIMATING = ["focus", "shot", "hold", "blast", "card"];
// hologram palette: chalk lines, referee yellow for you + the lock, semantic green/red for the verdict
const YOU_COLOR = "#f2d21b";
const CYAN = "#eeebe3";
const SAFE = "#39c072";
const KILL = "#e8382f";

const toPx = (x, y) => [(x + W_M / 2) * PPM, (H_M - y) * PPM];
const clamp = THREE.MathUtils.clamp;
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const normPhase = (p) => (typeof p === "number" ? PHASES[p] ?? "none" : String(p ?? "none").toLowerCase());
const bit = (mask, i) => (Number(mask) >> i) & 1;
const popcount = (m) => { let n = 0; for (let v = Number(m) & 0xffff; v; v &= v - 1) n++; return n; };
const fmtTier = (v) => (Number.isInteger(v) ? String(v) : fmtMon(v, 2));

function zoneName({ x, y }) {
  const row = y > 1.63 ? "TOP" : y > 0.81 ? "MID" : "LOW";
  const col = x < -1.22 ? "LEFT" : x > 1.22 ? "RIGHT" : "CENTRE";
  return row === "MID" && col === "CENTRE" ? "DEAD CENTRE" : `${row} ${col}`;
}

// ---------------------------------------------------------------------------
// Heat palette (deep blue → cyan → white-gold → magenta)
// ---------------------------------------------------------------------------
const LUT = (() => {
  const stops = [
    [0.0, [238, 235, 227, 0]],
    [0.18, [238, 235, 227, 26]],
    [0.45, [255, 226, 140, 70]],
    [0.75, [242, 190, 40, 115]],
    [1.0, [232, 90, 47, 150]],
  ];
  const lut = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const [t0, c0] = stops[k], [t1, c1] = stops[k + 1];
    const f = clamp((t - t0) / (t1 - t0), 0, 1);
    for (let j = 0; j < 4; j++) lut[i * 4 + j] = c0[j] + (c1[j] - c0[j]) * f;
  }
  return lut;
})();

// ---------------------------------------------------------------------------
export function createRoyale(api) {
  document.body.classList.add("royale");
  const net = api.net;
  const debug = new URLSearchParams(location.search).has("debug");

  // ---------------- hologram plane over the goal mouth ----------------
  const holo = document.createElement("canvas");
  holo.width = CW; holo.height = CH;
  const g = holo.getContext("2d");
  const tex = new THREE.CanvasTexture(holo);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(W_M, H_M),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false })
  );
  plane.position.set(0, H_M / 2, 0.06);
  plane.renderOrder = 10;
  api.scene.add(plane);

  // low-res heat field, colourised through the LUT and scaled up
  const HW = 183, HH = 61;
  const heat = document.createElement("canvas"); heat.width = HW; heat.height = HH;
  const hg = heat.getContext("2d");
  const heatCol = document.createElement("canvas"); heatCol.width = HW; heatCol.height = HH;
  const hcg = heatCol.getContext("2d");
  let heatDirty = true;

  // ---------------- DOM ----------------
  const cz = api.casino;
  const sfx = api.sfx;
  let lastBeep = -1; // whole seconds already beeped in the current countdown
  let locked = false;
  const root = document.createElement("div");
  root.id = "ry";
  root.innerHTML = `
    <div class="sb" id="ry-sb">
      <div class="sb-round" id="ry-round">—</div>
      <div class="sb-body">
        <div class="sb-line"><span class="sb-name" id="ry-gid">Royale</span><span class="sb-left"><b id="ry-alive">0</b><span id="ry-of">/${SEATS}</span> left</span></div>
        <div class="sb-pips" id="ry-rounds"></div>
      </div>
    </div>
    <div class="pool">
      <span class="k">Prize pool</span>
      <span class="led pool-v">◎<b id="ry-pot">0.00</b></span>
      <span class="pool-usd" id="ry-pot-usd"></span>
    </div>
    <aside class="feed">
      <header><span id="ry-feed-k">Lobby</span><em id="ry-count">0/${SEATS}</em></header>
      <ul id="ry-feed"></ul>
    </aside>
    <section class="seat" id="ry-seatcard">
      <div class="seat-top"><span class="k">Your seat</span><span class="seat-status" id="ry-you">Not entered</span></div>
      <div class="led seat-v" id="ry-seat">—</div>
      <div class="seat-mult" id="ry-mult"></div>
      <button class="btn btn-y seat-cash" id="ry-cash" hidden>Cash out</button>
      <dl class="seat-rules">
        <dt class="g">Goal</dt><dd>closest to the strike survive</dd>
        <dt class="r">Saved</dt><dd>farthest from the save survive</dd>
      </dl>
    </section>
    <div class="lt" id="ry-phase">
      <span class="lt-k" id="ry-phase-k">Lobby</span>
      <span class="lt-v" id="ry-phase-v">Connecting</span>
      <span class="lt-t led" id="ry-timer">—</span>
      <span class="lt-bar"><i id="ry-ring"></i></span>
    </div>
    <div class="ry-conn" id="ry-conn" hidden>Connection lost. Reconnecting to the game server…</div>
    <div class="lobby ry-down" id="ry-down">
      <div class="lb-main">
        <div class="lb-eyebrow"><span id="dn-title">Connecting</span></div>
        <p class="lb-fine" id="dn-msg">Reaching the game server…</p>
        <button class="btn btn-y lb-join" id="dn-retry" hidden>Retry</button>
        <p class="lb-fine mono" id="dn-api"></p>
      </div>
    </div>
    <div class="lobby" id="ry-lobby">
      <div class="lb-main">
        <div class="lb-eyebrow"><span id="lb-id">Royale</span><span class="lb-state"><i></i>Seats filling</span></div>
        <div class="k">Prize pool</div>
        <div class="led lb-pot">◎<b id="lb-pot">0.00</b></div>
        <div class="lb-usd" id="lb-usd"></div>
        <div class="k lb-k">Entry</div>
        <div class="seg" id="lb-tiers" role="radiogroup" aria-label="Entry"></div>
        <button class="btn btn-y lb-join" id="lb-join" disabled>Enter</button>
        <button class="btn btn-line lb-leave" id="lb-leave" hidden>Leave and refund</button>
        <p class="lb-fine" id="lb-fine">Last player standing takes the pool. Cash out after any round you survive. 4% house edge.</p>
      </div>
      <div class="lb-side">
        <div class="lb-seats" id="lb-seats">${"<i></i>".repeat(SEATS)}</div>
        <div class="lb-meta"><span><b id="lb-filled">0</b>/${SEATS} seated</span><span id="lb-clock">Waiting for players</span></div>
        <ol class="lb-how">
          <li>Click the goal to pick your spot.</li>
          <li>The contract locks the shot onto one point.</li>
          <li>Goal: the closest survive. Save: the farthest survive.</li>
        </ol>
      </div>
    </div>
    <div class="ry-outcome" id="ry-outcome"><b></b><small></small></div>
    <div class="res" id="ry-card">
      <div class="res-eyebrow">Round <span id="ry-card-round">1</span> result</div>
      <div class="res-head"><span class="res-pct"><b id="ry-pct">0</b>%</span><span class="res-k">survived</span></div>
      <div class="res-split"><span class="g"><b id="ry-adv">0</b> advance</span><span class="r"><b id="ry-out">0</b> out</span></div>
      <div class="res-chip" id="ry-chip"></div>
      <div class="offer" id="ry-offer">
        <div class="k">Your seat is worth</div>
        <div class="offer-v"><span class="led">◎<b id="ry-offer-v">0.000</b></span><em id="ry-offer-m">1.00×</em></div>
        <div class="offer-btns">
          <button class="btn btn-y" id="ry-offer-cash">Cash out</button>
          <button class="btn btn-line" id="ry-offer-ride">Ride <span class="mono" id="ry-offer-t">4</span></button>
        </div>
      </div>
    </div>
    <div class="win" id="ry-win">
      <div class="res-eyebrow">Last one standing</div>
      <div class="win-name" id="ry-win-name"></div>
      <div class="win-prize"><span class="led">◎<b id="ry-win-prize">0.000</b></span><em id="ry-win-mult"></em></div>
      <div class="win-sub" id="ry-win-sub"></div>
      <button class="btn btn-y wide" id="ry-again">Go to next royale</button>
    </div>`;
  api.hud.appendChild(root);
  const $ = (id) => root.querySelector("#" + id);
  for (const id of ["ry-again", "ry-cash", "ry-offer-cash", "ry-offer-ride", "ry-lobby", "ry-down", "dn-retry", "lb-leave"]) $(id).style.pointerEvents = "auto";
  $("ry-again").onclick = () => openLobby();
  $("ry-cash").onclick = () => cashOut();
  $("ry-offer-cash").onclick = () => cashOut();
  $("ry-offer-ride").onclick = () => { if (phase === "card") t = Math.max(t, T.card - 0.3); };
  $("lb-join").onclick = () => join();
  $("lb-leave").onclick = () => leave();
  $("dn-retry").onclick = () => net.retry();
  $("dn-api").textContent = `API: ${net.apiBase}`;

  // ---------------- state ----------------
  let K = constants(null);        // game constants (from /config)
  let tiers = [];                 // [{ tier, value (MON), valueWei }]
  let selTier = null;             // tier number selected in the lobby
  let rooms = [];                 // latest /rooms snapshot
  let viewId = null;              // game id we are watching / playing
  let G = null;                   // latest server snapshot of that game
  let players = [];               // one entry per taken seat
  let phase = "lobby";            // lobby | pick | focus | shot | hold | blast | card | between | win
  let t = 0;                      // animation clock for the current phase
  let round = 0;
  let history = [];               // "goal" | "saved" per finished round
  let target = null;              // metres, set from the chain's `resolved`
  let focus = { x: 0, y: 1.2 };
  let result = null;              // the `resolved` message for the round being played out
  let resolvedQ = [];             // resolved messages that arrived before we were ready for them
  let conv0 = 0, convLen = T.focus;
  let outcome = null;
  let blast = null;
  let holoAlpha = 0;
  let holoWant = 1;
  let startCount = 0;
  let potMon = 0, entryMon = 0;
  let cardLen = T.card;
  let pendingPick = false;        // next round's picking snapshot arrived while we were still animating
  let needsReset = false;         // ball is in the net: reset it (behind a fade) before the next round
  let fin = null;                 // `finished` message
  let busy = false;               // enter / leave tx in flight
  let cashing = false;
  let picksSent = 0;
  let clickSeq = 0;
  let seenKickoff = false;
  let lastPicks = [];

  const me = () => players.find((p) => p.you);
  const alive = () => players.filter((p) => p.alive);
  const seatValue = () => potMon / Math.max(1, alive().length);
  const mult = () => (entryMon > 0 ? seatValue() / entryMon : 0);
  const myAddr = () => net.wallet.state.address;
  const now = () => net.socket.now();
  const bySeat = (s) => players.find((p) => p.seat === s);
  const mine = (m) => viewId !== null && String(m.gameId) === viewId;
  const animating = () => ANIMATING.includes(phase);
  const tierObj = () => tiers.find((x) => x.tier === selTier);
  const roomFor = (tier) => rooms.find((r) => Number(r.tier) === tier);

  // ---------------- view / subscriptions ----------------
  function setView(id) {
    id = id && String(id) !== "0" ? String(id) : null;
    if (id === viewId) return;
    viewId = id;
    G = null;
    players = [];
    lastPicks = [];
    fin = null;
    resolvedQ = [];
    if (id) cz.setFair({ gameId: id });
    net.socket.want("royale", ["rooms", id ? `game:${id}` : null]);
    renderLobby();
  }

  // ---------------- lobby ----------------
  function openLobby() {
    phase = "lobby";
    t = 0;
    players = [];
    history = [];
    round = 0;
    target = null; result = null; blast = null; outcome = null;
    fin = null; pendingPick = false; cashing = false; resolvedQ = []; seenKickoff = false;
    potMon = 0;
    G = null;
    viewId = null;
    startCount = 0;
    $("ry-win").classList.remove("show");
    $("ry-card").classList.remove("show");
    $("ry-outcome").className = "ry-outcome";
    $("ry-feed").innerHTML = "";
    $("ry-feed-k").textContent = "Lobby";
    api.setReticle(false);
    const r = roomFor(selTier);
    setView(r?.gameId ?? null);
    net.socket.want("royale", ["rooms", viewId ? `game:${viewId}` : null]);
    setPhase("Lobby", "Seats filling");
    renderLobby();
    updateStats();
    renderRounds();
    renderNet();
  }

  function lobbyCount() {
    if (G) return players.length;
    return Number(roomFor(selTier)?.seatsFilled ?? 0);
  }

  function renderTiers() {
    const box = $("lb-tiers");
    if (!net.cfg) return;
    tiers = (net.cfg.tiers ?? []).map((x) => ({ tier: Number(x.tier), valueWei: String(x.valueWei), value: weiToMon(x.valueWei) })).sort((a, b) => a.tier - b.tier);
    box.style.gridTemplateColumns = `repeat(${Math.max(1, tiers.length)}, 1fr)`;
    box.innerHTML = tiers.map((x) => `<button data-t="${x.tier}" role="radio">${fmtTier(x.value)}</button>`).join("");
    if (selTier === null || !tiers.some((x) => x.tier === selTier)) {
      let saved = null;
      try { saved = Number(localStorage.getItem("sk:tier")); } catch { /* ignore */ }
      selTier = tiers.some((x) => x.tier === saved) ? saved : tiers[0]?.tier ?? null;
    }
    box.querySelectorAll("button").forEach((b) => (b.onclick = () => {
      if (me() || busy) return;
      sfx.play("click");
      selTier = Number(b.dataset.t);
      try { localStorage.setItem("sk:tier", String(selTier)); } catch { /* ignore */ }
      const r = roomFor(selTier);
      setView(r?.gameId ?? null);
      renderLobby();
    }));
  }

  function renderLobby() {
    const t0 = tierObj();
    const n = lobbyCount();
    const entry = G ? entryMon || t0?.value || 0 : t0?.value ?? 0;
    const pot = n * entry * (1 - K.FEE_BPS / 10000);
    const lobbyView = phase === "lobby";
    if (lobbyView) {
      potMon = pot;
      entryMon = entry;
    }
    $("lb-id").textContent = viewId ? `Royale ${viewId}` : "Royale";
    $("ry-gid").textContent = viewId ? `Royale ${viewId}` : "Royale";
    $("lb-pot").textContent = fmtMon(pot);
    $("lb-usd").textContent = usdLine(pot);
    $("lb-filled").textContent = n;
    const cells = $("lb-seats").children;
    for (let i = 0; i < cells.length; i++) {
      const p = bySeat(i);
      cells[i].className = p ? (p.you ? "you" : "on") : !G && i < n ? "on" : "";
    }
    const mm = me();
    const seated = !!mm && phase === "lobby";
    root.querySelectorAll("#lb-tiers button").forEach((b) => {
      const on = Number(b.dataset.t) === selTier;
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", on);
      b.disabled = !!mm || busy;
    });
    const btn = $("lb-join");
    const w = net.wallet.state;
    let label, dis = false;
    if (!net.cfg) { label = "Connecting…"; dis = true; }
    else if (seated) { label = `You're in · seat ${mm.seat + 1}`; dis = true; }
    else if (busy) { label = "Confirm in wallet…"; dis = true; }
    else if (n >= SEATS) { label = "Room full"; dis = true; }
    else if (!w.connected) label = "Connect wallet to enter";
    else if (net.wallet.wrongChain) label = "Switch to Monad";
    else label = `Enter for ◎${fmtMon(entry, entry % 1 ? 2 : 0)}`;
    btn.textContent = label;
    btn.disabled = dis && !seated;
    btn.classList.toggle("in", seated);
    $("lb-leave").hidden = !seated;
    $("lb-leave").disabled = busy;
    $("lb-fine").textContent = `Last player standing takes the pool. Cash out after any round you survive. ${(K.FEE_BPS / 100).toFixed(0)}% house edge.${K.MIN_PLAYERS ? ` Kick-off ${K.LOBBY_COUNTDOWN_SECS}s after ${K.MIN_PLAYERS} players are seated; leave any time before for a full refund.` : ""}`;
    if (lobbyView) { $("ry-count").textContent = `${n}/${SEATS}`; updateStats(); }
  }

  async function join() {
    if (busy || phase !== "lobby" || me() || selTier === null) return;
    if (!(await cz.requireWallet())) return;
    const t0 = tierObj();
    if (!t0) return;
    if (net.wallet.state.balance < BigInt(t0.valueWei)) {
      cz.toast(`Not enough MON. Entry is ◎${fmtMon(t0.value, 2)} plus gas.`, "bad");
      cz.openFund();
      return;
    }
    busy = true;
    renderLobby();
    try {
      const r = await net.chain.enter(t0.tier);
      sfx.play("bet_place");
      cz.toast(`Seat taken · <span class="mono">−◎${fmtMon(t0.value, 2)}</span>`);
      if (r.gameId) setView(r.gameId);
      if (net.session.state.status !== "ready" && !net.session.state.declined) setTimeout(() => cz.enableQuickPicks(), 400);
    } catch (e) {
      cz.toastErr(e);
    } finally {
      busy = false;
      renderLobby();
    }
  }

  async function leave() {
    if (busy || !viewId || !me() || phase !== "lobby") return;
    busy = true;
    renderLobby();
    try {
      await net.chain.leaveLobby(viewId);
      cz.toast("Left the lobby · entry refunded in full", "ok");
    } catch (e) {
      cz.toastErr(e);
    } finally {
      busy = false;
      renderLobby();
    }
  }

  function feedJoin(p, left = false) {
    const ul = $("ry-feed");
    const li = document.createElement("li");
    if (p.you) li.className = "you";
    li.innerHTML = `<b></b><span>${left ? "left" : "joined"}</span>`;
    li.querySelector("b").textContent = p.you ? "You" : p.name;
    ul.prepend(li);
    while (ul.children.length > 11) ul.lastChild.remove();
    $("ry-count").textContent = `${players.length}/${SEATS}`;
  }

  function updateLobbyClock() {
    const n = lobbyCount();
    const clock = $("lb-clock");
    if (G?.phase === "lobby" && G.endsAt > 0) {
      const left = Math.max(0, (G.endsAt - now()) / 1000);
      clock.innerHTML = left <= 0 ? "Starting…" : `Kick-off in <b>0:${String(Math.ceil(left)).padStart(2, "0")}</b>`;
      timer(left, K.LOBBY_COUNTDOWN_SECS);
    } else {
      const need = Math.max(0, K.MIN_PLAYERS - n);
      clock.textContent = need > 0 ? `Waiting for ${need} more player${need > 1 ? "s" : ""}` : "Starting…";
      timer(null);
    }
  }

  // ---------------- server snapshots ----------------
  function syncSeats(seats) {
    const prev = new Map(players.map((p) => [p.seat, p]));
    const next = [];
    (seats ?? []).forEach((a, seat) => {
      if (!a) return;
      const addr = String(a).toLowerCase();
      let p = prev.get(seat);
      if (!p || p.addr !== addr) p = { seat, addr, name: cz.short(addr), alive: true, pos: null, mm: null, flash: 0, verdict: null };
      p.you = !!myAddr() && addr === myAddr();
      next.push(p);
    });
    const before = new Set(players.map((p) => p.seat + p.addr));
    const after = new Set(next.map((p) => p.seat + p.addr));
    players = next;
    return { joined: next.filter((p) => !before.has(p.seat + p.addr)), left: [...before].filter((k) => !after.has(k)) };
  }

  function applyAlive(mask) {
    for (const p of players) p.alive = !!bit(mask, p.seat) && !p.cashed;
  }

  function applyPicks(picks) {
    for (const p of players) { p.pos = null; p.mm = null; p.pending = false; p.spec = false; }
    for (const k of picks ?? []) {
      const p = bySeat(Number(k.seat));
      if (!p) continue;
      p.mm = { x: Number(k.x), y: Number(k.y) };
      p.pos = { x: p.mm.x / 1000, y: p.mm.y / 1000 };
      p.confirmed = p.pos;
      p.auto = !!k.auto;
    }
    heatDirty = true;
  }

  function enterRunning() {
    $("ry-lobby").classList.remove("show");
    startCount = Math.max(players.length, startCount);
    $("ry-feed-k").textContent = "Picks";
    if (!seenKickoff) {
      seenKickoff = true;
      sfx.play("kickoff");
      if (!me()) cz.toast("You're watching this royale. Enter the next one from the lobby.");
    }
  }

  function applySnapshot(raw) {
    const s = raw.game ?? raw;
    const id = String(s.gameId ?? s.id);
    if (id !== viewId) return;
    G = {
      id,
      tier: Number(s.tier),
      phase: normPhase(s.phase),
      round: Number(s.round ?? 0),
      entry: BigInt(s.entryWei ?? s.entry ?? 0),
      pot: BigInt(s.potWei ?? s.pot ?? 0),
      aliveMask: Number(s.aliveMask ?? 0),
      endsAt: toMs(s.phaseEndsAt),
      seats: s.seats ?? [],
      picks: s.picks ?? [],
      results: s.results ?? [],
    };
    if (Number.isFinite(G.tier) && tiers.some((x) => x.tier === G.tier)) selTier = G.tier;
    entryMon = weiToMon(G.entry) || entryMon;
    if (G.phase !== "lobby") potMon = weiToMon(G.pot);
    const d = syncSeats(G.seats);
    if (G.phase === "lobby") d.joined.forEach((p) => feedJoin(p));
    if (G.results.length && history.length < G.results.length && !animating()) history = G.results.map((r) => normOutcome(r.outcome));

    switch (G.phase) {
      case "lobby":
        if (phase !== "lobby") { phase = "lobby"; $("ry-lobby").classList.add("show"); }
        renderLobby();
        break;
      case "picking":
        onPickingSnapshot();
        break;
      case "locked":
        if (!animating()) { round = G.round; enterRunning(); applyAlive(G.aliveMask); applyPicks(G.picks); beginFocus(); }
        break;
      case "resolved":
      case "between":
        if (phase === "lobby" || phase === "win") { round = G.round; enterRunning(); applyAlive(G.aliveMask); applyPicks([]); phase = "between"; renderRounds(); setPhase(`Round ${round}`, "Next round starting"); updateStats(); }
        else if (phase === "focus" && !target) {
          const last = G.results.find((r) => Number(r.round) === round);
          if (last) armTarget({ ...last, autoPicks: [], nextPhaseAt: G.endsAt });
        }
        break;
      case "finished":
      case "cancelled":
        if (phase === "lobby") setView(null); // this game is over; wait for `rooms` to name the next open one
        break;
      default:
        break;
    }
    updateStats();
  }

  const normOutcome = (o) => (o === 1 || o === "goal" || o === "Goal" ? "goal" : "saved");

  function onPickingSnapshot() {
    if (phase === "pick" && round === G.round) {
      applyPicks(G.picks);
      updateStats();
      return;
    }
    if (ANIMATING.includes(phase) && !(phase === "focus" && !target)) { pendingPick = true; return; }
    beginRound(phase === "between" || phase === "win");
  }

  // ---------------- rounds ----------------
  function beginRound(withFade) {
    const go = () => {
      if (needsReset) { api.resetShot(); needsReset = false; }
      startRound();
    };
    if (withFade && needsReset) {
      phase = "between";
      api.transition(go);
    } else go();
  }

  function startRound() {
    phase = "pick";
    t = 0;
    round = G.round;
    outcome = null;
    blast = null;
    target = null;
    result = null;
    holoWant = 1;
    picksSent = 0;
    pendingPick = false;
    enterRunning();
    for (const p of players) { p.flash = 0; p.verdict = null; p.d = undefined; }
    applyAlive(G.aliveMask);
    applyPicks(G.picks);
    $("ry-feed").innerHTML = "";
    $("ry-card").classList.remove("show");
    $("ry-outcome").className = "ry-outcome";
    setPhase(`Round ${round}`, me()?.alive ? "Click the goal to pick your spot" : "Watching · picks open");
    updatePickCount();
    updateStats();
    renderRounds();
  }

  function updatePickCount() {
    $("ry-count").textContent = `${alive().filter((p) => p.pos).length}/${alive().length}`;
  }

  function place(p, spot, auto = false) {
    const first = !p.pos;
    p.pos = spot;
    p.flash = 1;
    heatDirty = true;
    feed(p, spot, first ? (auto ? "AUTO" : "") : "MOVED");
  }

  function feed(p, spot, tag) {
    const ul = $("ry-feed");
    const li = document.createElement("li");
    if (p.you) li.className = "you";
    li.innerHTML = `<b></b><span>${zoneName(spot).toLowerCase()}</span>${tag ? `<em>${tag.toLowerCase()}</em>` : ""}`;
    li.querySelector("b").textContent = p.you ? "You" : p.name;
    ul.prepend(li);
    while (ul.children.length > 11) ul.lastChild.remove();
    updatePickCount();
  }

  function setPhase(k, label) {
    $("ry-phase-k").textContent = k;
    $("ry-phase-v").textContent = label;
  }

  function canCash() {
    const m = me();
    if (!m?.alive || m.cashed || alive().length <= 1) return false;
    return phase === "card" || phase === "between" || (phase === "pick" && round > 1);
  }

  function updateStats() {
    const inGame = phase !== "lobby";
    const a = inGame ? alive().length : lobbyCount();
    $("ry-pot").textContent = fmtMon(potMon);
    $("ry-pot-usd").textContent = usdLine(potMon);
    $("ry-alive").textContent = a;
    $("ry-of").textContent = `/${inGame ? startCount || SEATS : SEATS}`;
    const m = me();
    const seated = !!m;
    $("ry-seatcard").classList.toggle("empty", !seated);
    const v = !seated ? null : m.cashed ? m.cashedValue : !inGame || m.alive ? (inGame ? seatValue() : potMon / Math.max(1, a)) : 0;
    $("ry-seat").innerHTML = v === null ? "—" : `<b>${fmtMon(v, 3)}</b>`;
    $("ry-mult").textContent = seated && inGame && m.alive ? `${mult().toFixed(2)}× entry` : m?.cashed ? `cashed at ${m.cashed.toFixed(2)}×` : "";
    const status = !inGame ? (seated ? "Seated" : "Not entered") : !m ? "Watching" : m.cashed ? "Cashed out" : m.alive ? "Alive" : "Eliminated";
    const y = $("ry-you");
    y.textContent = status;
    y.className = `seat-status ${status === "Alive" || status === "Seated" || status === "Cashed out" ? "g" : status === "Eliminated" ? "r" : ""}`;
    const can = canCash();
    $("ry-cash").hidden = !can;
    $("ry-cash").disabled = cashing;
    if (can) $("ry-cash").textContent = cashing ? "Confirm in wallet…" : `Cash out ◎${fmtMon(seatValue(), 3)}`;
    $("ry-offer-cash").disabled = cashing;
  }

  function renderRounds() {
    const el = $("ry-rounds");
    $("ry-round").textContent = phase === "lobby" ? "—" : phase === "win" ? "FT" : `R${round}`;
    el.innerHTML = "";
    if (phase === "lobby") return;
    const remaining = Math.max(1, Math.ceil(Math.log2(Math.max(2, alive().length))));
    const total = history.length + (phase === "win" ? 0 : remaining);
    for (let i = 0; i < total; i++) {
      const pip = document.createElement("i");
      const done = i < history.length;
      pip.className = done ? (history[i] === "goal" ? "goal" : "saved") : i === history.length && phase !== "win" ? "now" : "";
      pip.title = done ? `Round ${i + 1}: ${history[i]}` : i === total - 1 ? "Final" : `Round ${i + 1}`;
      el.appendChild(pip);
    }
  }

  // ---------------- chain events -> view ----------------
  function onSeat(m) {
    if (!mine(m) || G?.phase !== "lobby") return;
    const seats = [...(G.seats ?? [])];
    while (seats.length < SEATS) seats.push(null);
    const seat = Number(m.seat);
    const was = bySeat(seat);
    seats[seat] = m.left ? null : m.player;
    G.seats = seats;
    const d = syncSeats(seats);
    if (m.left && was) feedJoin(was, true);
    d.joined.forEach((p) => { feedJoin(p); sfx.play("tick", { vol: 0.25, rate: 1.7 }); });
    renderLobby();
  }

  function onCountdown(m) {
    if (!mine(m)) return;
    if (G) G.endsAt = toMs(m.startsAt);
    renderLobby();
  }

  function onPick(m) {
    if (!mine(m) || Number(m.round) !== round || (phase !== "pick" && phase !== "boot")) return;
    const p = bySeat(Number(m.seat));
    if (!p) return;
    const spot = { x: Number(m.x) / 1000, y: Number(m.y) / 1000 };
    p.pickCount = Number(m.pickCount ?? 1);
    p.confirmed = spot;
    p.spec = !!m.speculative;
    if (p.you && p.pending && p.mm && (p.mm.x !== Number(m.x) || p.mm.y !== Number(m.y))) return; // an older pick; a newer click is still in flight
    const same = p.pos && p.pos.x === spot.x && p.pos.y === spot.y;
    p.pending = false;
    p.mm = { x: Number(m.x), y: Number(m.y) };
    if (same) { heatDirty = true; return; } // our own optimistic dot, now confirmed
    place(p, spot);
  }

  function onLocked(m) {
    if (!mine(m)) return;
    if (phase === "pick" && Number(m.round) === round) beginFocus();
  }

  function onSeed(m) {
    if (!mine(m) || phase !== "focus" || target) return;
    setPhase(`Round ${round}`, "Seed received · computing result");
  }

  function onResolved(m) {
    if (!mine(m)) return;
    const r = Number(m.round);
    resolvedQ = resolvedQ.filter((x) => Number(x.round) !== r);
    resolvedQ.push(m);
    if (G) { G.endsAt = toMs(m.nextPhaseAt); G.phase = "between"; G.round = r; G.aliveMask = Number(m.survivorMask); }
    if (phase === "focus" && !target && r === round) armTarget(m);
    else if (phase === "pick" && r === round) beginFocus();
    else if (!animating() && phase !== "pick") { round = r; if (phase === "lobby") { enterRunning(); applyAlive(G?.aliveMask ?? 0x3ff); } beginFocus(); }
    // otherwise an earlier round is still animating: beginFocus() will pick this up from resolvedQ
  }

  function applyCashout(seat, amountMon) {
    const p = bySeat(seat);
    if (!p || p.cashed) return;
    const x = entryMon > 0 ? amountMon / entryMon : 0;
    p.alive = false;
    p.cashed = x;
    p.cashedValue = amountMon;
    potMon = Math.max(0, potMon - amountMon);
    if (p.pos) { p.pos = null; heatDirty = true; }
    if (p.you) {
      sfx.play("cash_out");
      cz.toast(`Cashed out at ${x.toFixed(2)}× <span class="mono up">+◎${fmtMon(amountMon, 3)}</span>`, "ok");
      $("ry-offer").classList.remove("show");
      $("ry-chip").textContent = `Cashed out at ${x.toFixed(2)}×`;
      $("ry-chip").className = "res-chip g";
      api.setReticle(false);
      net.wallet.refreshBalance();
    }
    updateStats();
    updatePickCount();
  }
  function onCashout(m) {
    if (!mine(m)) return;
    applyCashout(Number(m.seat), weiToMon(m.amount));
  }

  function onFinished(m) {
    if (!mine(m)) return;
    fin = m;
    if (phase === "win") fillWinner();
    else if (!animating() && phase !== "lobby") showWinner();
  }

  function onRefunded(m) {
    if (!mine(m)) return;
    cz.toast(`Royale ${viewId} was refunded · ◎${fmtMon(weiToMon(m.perSeat), 3)} back to every seat`, "ok");
    net.wallet.refreshBalance();
    openLobby();
  }

  function onRooms(m) {
    rooms = m.rooms ?? (Array.isArray(m) ? m : []);
    const r = roomFor(selTier);
    // follow the tier's open game unless we are seated or spectating a running one
    if (phase === "lobby" && !me() && !busy && r && String(r.gameId) !== viewId && (r.gameId || viewId)) setView(r.gameId ?? null);
    renderLobby();
  }

  // ---------------- animation sequence ----------------
  function beginFocus() {
    phase = "focus";
    t = 0;
    target = null;
    result = null;
    locked = false;
    enterRunning();
    focus = { ...hottest() };
    api.game.state = "focus";
    api.game.power = 0;
    api.setReticle(false);
    api.keeper.setReady(true);
    sfx.play("whistle");
    sfx.play("scan", { delay: 0.3 });
    sfx.duck(0.6, 0.6);
    setPhase(`Round ${round}`, "Scanning the picks");
    updateStats();
    const q = resolvedQ.find((x) => Number(x.round) === round);
    if (q) armTarget(q);
  }

  // The chain's verdict is in: converge the scanner on the on-chain target. If the event arrived
  // before the scan has run its course, the remaining scan time is kept (min T.minConverge).
  function armTarget(m) {
    result = m;
    round = Number(m.round);
    target = { x: Number(m.targetX) / 1000, y: Number(m.targetY) / 1000 };
    for (const ap of m.autoPicks ?? []) {
      const p = bySeat(Number(ap.seat));
      if (!p) continue;
      p.mm = { x: Number(ap.x), y: Number(ap.y) };
      place(p, { x: p.mm.x / 1000, y: p.mm.y / 1000 }, true);
    }
    conv0 = t;
    convLen = Math.max(T.minConverge, T.focus - t);
    setPhase(`Round ${round}`, "Locking onto the target");
  }

  // densest point of the heat field, as a starting point for the scanner
  function hottest() {
    const d = hg.getImageData(0, 0, HW, HH).data;
    let best = 0, bi = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > best) { best = d[i]; bi = (i - 3) / 4; }
    return { x: ((bi % HW) / HW) * W_M - W_M / 2, y: H_M - (Math.floor(bi / HW) / HH) * H_M };
  }

  function fire() {
    phase = "shot";
    t = 0;
    holoWant = 0.16;
    needsReset = true;
    setPhase(`Round ${round}`, "Shot locked");
    // scripted: the ball and keeper play out the on-chain verdict, they never decide it
    api.shootAt(new THREE.Vector3(target.x, target.y, 0), 0.85, normOutcome(result.outcome));
  }

  function onOutcome() {
    if (phase !== "shot") return;
    outcome = normOutcome(result.outcome);
    phase = "hold";
    t = 0;
    const el = $("ry-outcome");
    el.querySelector("b").textContent = outcome === "goal" ? "Goal" : "Saved";
    el.querySelector("small").textContent = outcome === "goal" ? "Closest to the strike survive" : "Farthest from the save survive";
    el.className = `ry-outcome show ${outcome}`;
    applyVerdict();
  }

  // verdicts come from the chain's survivorMask; distances are only for drawing the blast
  function applyVerdict() {
    const mask = Number(result.survivorMask);
    const a = alive();
    for (const p of a) {
      p.d = p.pos ? Math.hypot(p.pos.x - target.x, p.pos.y - target.y) : Infinity;
      p.verdict = bit(mask, p.seat) ? "safe" : "out";
    }
    blast = { R: Number(result.radiusMm) / 1000, n: a.length, survivors: a.filter((p) => p.verdict === "safe").length };
    if (debug) debugAssert(a, mask);
  }

  // debug only (?debug): re-derive the blast with the client's old maths on integer mm and compare
  function debugAssert(a, mask) {
    if (a.some((p) => !p.mm)) return console.warn("[royale] debug assert skipped: missing pick positions");
    const tx = Number(result.targetX), ty = Number(result.targetY);
    const rows = a.map((p) => ({ seat: p.seat, d2: (p.mm.x - tx) ** 2 + (p.mm.y - ty) ** 2 })).sort((x, y) => x.d2 - y.d2 || x.seat - y.seat);
    const n = rows.length;
    const inside = rows.filter((r) => r.d2 <= K.BLAST_R_MM ** 2).length;
    const lo = Math.max(1, Math.ceil(n / 4)), hi = Math.max(1, Math.min(n - 1, Math.floor((3 * n) / 4)));
    const k = clamp(inside, lo, hi);
    const goal = normOutcome(result.outcome) === "goal";
    let want = 0;
    rows.forEach((r, i) => { if ((i < k) === goal) want |= 1 << r.seat; });
    if (want !== mask) console.error("[royale] LOCAL/CHAIN MISMATCH survivorMask", want.toString(2), mask.toString(2), result);
    else console.info("[royale] local blast calc matches chain", { k, n });
  }

  function startBlast() {
    phase = "blast";
    t = 0;
    holoWant = 0.85;
    api.game.camCalm = true;
    sfx.play(outcome === "goal" ? "blast_safe" : "blast_kill");
    setPhase(`Round ${round}`, outcome === "goal" ? "Safe zone" : "Kill zone");
  }

  function showCard() {
    phase = "card";
    t = 0;
    const { n, survivors } = blast;
    const before = seatValue();
    for (const p of players) if (p.verdict === "out") p.alive = false;
    if (G) G.aliveMask = Number(result.survivorMask);
    history.push(outcome);
    countUp($("ry-pct"), Math.round((survivors / Math.max(1, n)) * 100));
    $("ry-card-round").textContent = round;
    $("ry-adv").textContent = survivors;
    $("ry-out").textContent = n - survivors;
    const m = me();
    const v = m?.verdict;
    const chip = $("ry-chip");
    chip.textContent = v === "safe" ? "You advance" : v === "out" ? "You're out" : m?.cashed ? "You cashed out" : "Watching";
    chip.className = `res-chip ${v === "safe" ? "g" : v === "out" ? "r" : ""}`;
    if (v === "out") { cz.toast(`Eliminated in round ${round}`, "bad"); sfx.play("eliminated"); }
    else if (v === "safe") sfx.play("advance");
    // survivors get the offer: take the seat value now, or ride
    const offer = m?.alive && alive().length > 1;
    cardLen = offer ? T.card + 1.6 : T.card;
    $("ry-offer").classList.toggle("show", !!offer);
    if (offer) {
      countUpMon($("ry-offer-v"), before, seatValue());
      $("ry-offer-m").textContent = `${mult().toFixed(2)}×`;
      $("ry-offer-cash").textContent = `Cash out ◎${fmtMon(seatValue(), 3)}`;
    }
    $("ry-card").className = `res show ${outcome}`;
    setPhase(`Round ${round}`, alive().length <= 1 ? "Final result" : "Next round");
    $("ry-outcome").className = `ry-outcome ${outcome}`;
    resolvedQ = resolvedQ.filter((x) => Number(x.round) !== round);
    updateStats();
    renderRounds();
  }

  async function cashOut() {
    if (cashing || !canCash() || !viewId) return;
    cashing = true;
    updateStats();
    try {
      await net.chain.cashOut(viewId);
      const m = me();
      if (m?.alive) applyCashout(m.seat, seatValue()); // the `cashout` event normally lands first; this is idempotent
    } catch (e) {
      cz.toastErr(e);
    } finally {
      cashing = false;
      updateStats();
    }
  }

  function countUp(el, to) {
    const t0 = performance.now();
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / 700);
      el.textContent = Math.round(to * easeOut(k));
      if (k < 1) requestAnimationFrame(step);
    };
    step();
  }
  function countUpMon(el, from, to) {
    const t0 = performance.now();
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / 900);
      el.textContent = fmtMon(from + (to - from) * easeOut(k), 3);
      if (k < 1) requestAnimationFrame(step);
    };
    step();
  }

  function nextRound() {
    $("ry-card").classList.remove("show");
    if (alive().length <= 1 || fin) return showWinner();
    if (pendingPick) { pendingPick = false; beginRound(true); return; }
    phase = "between";
    setPhase(`Round ${round}`, "Next round starting");
    updateStats();
  }

  function showWinner() {
    phase = "win";
    t = 0;
    $("ry-card").classList.remove("show");
    fillWinner();
    setPhase("Full time", "Next royale");
    renderRounds();
    updateStats();
    sfx.play("crowd_win", { vol: winnerIsMe() ? 1 : 0.6 });
    if (winnerIsMe()) {
      sfx.play("coins", { delay: 0.3 });
      const prize = fin ? weiToMon(fin.prize) : potMon;
      cz.bigWin(prize, entryMon > 0 ? prize / entryMon : 0);
      net.wallet.refreshBalance();
    }
  }
  const winnerAddr = () => (fin?.winner ? String(fin.winner).toLowerCase() : alive()[0]?.addr ?? null);
  const winnerIsMe = () => !!winnerAddr() && winnerAddr() === myAddr();
  function fillWinner() {
    const addr = winnerAddr();
    const you = winnerIsMe();
    const prize = fin ? weiToMon(fin.prize) : potMon;
    const x = entryMon > 0 ? prize / entryMon : 0;
    $("ry-win-name").textContent = you ? "You" : addr ? cz.short(addr) : "—";
    $("ry-win-prize").textContent = fmtMon(prize, 3);
    $("ry-win-mult").textContent = fin ? `${x.toFixed(2)}×` : "";
    $("ry-win-sub").textContent = you ? `Outlasted ${Math.max(0, startCount - 1)} players over ${fin?.rounds ?? round} rounds` : `Won royale ${viewId} · ${fin?.rounds ?? round} rounds · ${startCount} players`;
    $("ry-win").className = `win show ${you ? "you" : ""}`;
  }

  // ---------------- input ----------------
  function pointerDown(aim) {
    const m = me();
    if (phase !== "pick" || !m?.alive || !viewId) return false;
    if (G && (G.endsAt - now()) / 1000 < 0.15) return true; // window closed; the lock is on its way
    if (Math.max(picksSent, m.pickCount ?? 0) >= K.REPICK_CAP) {
      cz.toast(`Re-pick limit reached (${K.REPICK_CAP} per round)`, "bad");
      return true;
    }
    const x = clamp(aim.x, -K.PICK_X_MAX / 1000, K.PICK_X_MAX / 1000);
    const y = clamp(aim.y, K.PICK_Y_MIN / 1000, K.PICK_Y_MAX / 1000);
    const mmx = Math.round(x * 1000), mmy = Math.round(y * 1000);
    picksSent++;
    const seq = ++clickSeq;
    m.lastSent = seq;
    m.pending = true;               // optimistic dot, confirmed when the chain's `pick` event arrives
    m.mm = { x: mmx, y: mmy };
    place(m, { x: mmx / 1000, y: mmy / 1000 });
    sfx.play("click", { vol: 1.4 });
    const rollback = (e) => {
      if (m.lastSent !== seq) return; // a newer pick owns the dot now
      m.pending = false;
      m.pos = m.confirmed ?? null;
      heatDirty = true;
      updatePickCount();
      cz.toastErr(e);
    };
    net.chain.pick(viewId, mmx, mmy).then((res) => res?.receipt.catch(rollback)).catch(rollback);
    return true;
  }

  // ---------------- network state ----------------
  function renderNet() {
    const st = net.status;
    const down = $("ry-down");
    const show = st === "connecting" || st === "down";
    down.classList.toggle("show", show);
    $("dn-title").textContent = st === "down" ? "Can't reach game server" : "Connecting";
    $("dn-msg").textContent = st === "down"
      ? `${net.error ?? "No response"}. Spotkick needs its game server to seat players and relay the chain. There is no offline mode here. Try again in a moment, or play the solo practice game with ?mode=solo.`
      : "Reaching the game server…";
    $("dn-retry").hidden = st !== "down";
    $("ry-conn").hidden = st !== "reconnecting";
    $("ry-lobby").classList.toggle("show", phase === "lobby" && !show && !!net.cfg);
    if (st === "down") { setPhase("Offline", "Game server unreachable"); timer(null); }
    else if (phase === "lobby") setPhase("Lobby", st === "connecting" ? "Connecting" : "Seats filling");
  }

  net.on(() => {
    if (net.cfg && !tiers.length) {
      K = constants(net.cfg);
      renderTiers();
    }
    renderNet();
    renderLobby();
  });
  net.wallet.on(() => {
    for (const p of players) p.you = !!myAddr() && p.addr === myAddr();
    renderLobby();
    updateStats();
  });
  net.socket.onStatus((s) => { if (s === "open") net.socket.want("royale", ["rooms", viewId ? `game:${viewId}` : null]); });

  net.socket.on("rooms", onRooms);
  net.socket.on("game", applySnapshot);
  net.socket.on("seat", onSeat);
  net.socket.on("countdown", onCountdown);
  net.socket.on("pick", onPick);
  net.socket.on("locked", onLocked);
  net.socket.on("seed", onSeed);
  net.socket.on("resolved", onResolved);
  net.socket.on("cashout", onCashout);
  net.socket.on("finished", onFinished);
  net.socket.on("refunded", onRefunded);

  // ---------------- per-frame ----------------
  function update(rawDt, time) {
    t += rawDt;
    for (const p of players) p.flash = Math.max(0, (p.flash ?? 0) - rawDt * 1.4);

    if (phase === "lobby") {
      if (net.cfg) updateLobbyClock();
    } else if (phase === "pick") {
      const left = G ? (G.endsAt - now()) / 1000 : 0;
      timer(left, K.PICK_SECS);
      if (left <= 0) setPhase(`Round ${round}`, "Locking picks…");
      api.setReticle(!!me()?.alive && left > 0.15);
    } else if (phase === "focus") {
      // wander across the heat; once the chain's target is known, converge on it
      const wx = Math.sin(time * 2.3) * 2.2 + Math.sin(time * 5.1) * 0.6;
      const wy = 1.2 + Math.sin(time * 3.1) * 0.7 + Math.cos(time * 6.7) * 0.2;
      const pull = target ? easeInOut(clamp((t - conv0) / convLen, 0, 1)) : 0;
      const k = target ? 0.5 + 0.5 * pull : Math.min(0.5, (t / T.focus) * 0.5);
      focus.x = THREE.MathUtils.lerp(clamp(wx, -3.4, 3.4), target ? target.x : clamp(wx, -3.4, 3.4), pull);
      focus.y = THREE.MathUtils.lerp(clamp(wy, 0.2, 2.25), target ? target.y : clamp(wy, 0.2, 2.25), pull);
      api.game.power = k;
      if (target) timer(conv0 + convLen - t, convLen);
      else {
        timer(null);
        if (t > T.focus) setPhase(`Round ${round}`, "Waiting for the on-chain seed");
      }
      if (target && k > 0.8 && !locked) {
        locked = true;
        setPhase(`Round ${round}`, "Target locked");
        sfx.stop("scan", 0.15);
        sfx.play("lock_on");
        sfx.play("lock_thud", { vol: 0.8 });
      }
      if (target && pull >= 1) fire();
    } else if (phase === "hold") {
      timer(0, 1);
      if (t >= T.hold) startBlast();
    } else if (phase === "blast") {
      timer(T.blast - t, T.blast);
      if (t >= T.blast) showCard();
    } else if (phase === "card") {
      timer(cardLen - t, cardLen);
      $("ry-offer-t").textContent = Math.max(0, Math.ceil(cardLen - t));
      // the chain's next pick window is already running: don't sit on the card
      if (t >= (pendingPick ? Math.min(cardLen, 1.5) : cardLen)) nextRound();
    } else if (phase === "between") {
      const left = G?.endsAt ? (G.endsAt - now()) / 1000 : 0;
      timer(G?.endsAt ? left : null, K.BETWEEN_SECS);
    } else if (phase === "win") {
      timer(T.win - t, T.win);
      if (t >= T.win) openLobby();
    }

    holoAlpha = THREE.MathUtils.damp(holoAlpha, holoWant, 6, rawDt);
    draw(time);
  }

  function timer(left, total) {
    if (left === null || left === undefined) {
      $("ry-timer").textContent = "—";
      $("ry-ring").style.transform = "scaleX(0)";
      return;
    }
    // beep on each of the last three seconds of the lobby and pick countdowns
    if ((phase === "lobby" || phase === "pick") && left > 0 && left <= 3) {
      const s = Math.ceil(left);
      if (s !== lastBeep) { lastBeep = s; sfx.play("tick", { rate: s === 1 ? 1.25 : 1 }); }
    } else if (left > 3) lastBeep = -1;
    $("ry-timer").textContent = Math.max(0, left).toFixed(1);
    $("ry-ring").style.transform = `scaleX(${clamp(left / total, 0, 1)})`;
  }

  // ---------------- hologram drawing ----------------
  function rebuildHeat() {
    hg.clearRect(0, 0, HW, HH);
    hg.globalCompositeOperation = "lighter";
    const r = 0.55 * (HW / W_M);
    for (const p of alive()) {
      if (!p.pos) continue;
      const x = ((p.pos.x + W_M / 2) / W_M) * HW, y = ((H_M - p.pos.y) / H_M) * HH;
      const grd = hg.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, "rgba(0,0,0,0.2)");
      grd.addColorStop(1, "rgba(0,0,0,0)");
      hg.fillStyle = grd;
      hg.fillRect(x - r, y - r, r * 2, r * 2);
    }
    hg.globalCompositeOperation = "source-over";
    const src = hg.getImageData(0, 0, HW, HH);
    const out = hcg.createImageData(HW, HH);
    for (let i = 0; i < src.data.length; i += 4) {
      const v = src.data[i + 3];
      out.data.set(LUT.subarray(v * 4, v * 4 + 4), i);
    }
    hcg.putImageData(out, 0, 0);
    heatDirty = false;
  }

  function draw(time) {
    if (heatDirty) rebuildHeat();
    g.clearRect(0, 0, CW, CH);
    g.globalAlpha = holoAlpha;

    // grid + frame
    g.strokeStyle = "rgba(238,235,227,0.07)";
    g.lineWidth = 1;
    g.beginPath();
    for (let i = 1; i < 12; i++) { const x = (i / 12) * CW; g.moveTo(x, 0); g.lineTo(x, CH); }
    for (let i = 1; i < 4; i++) { const y = (i / 4) * CH; g.moveTo(0, y); g.lineTo(CW, y); }
    g.stroke();
    g.strokeStyle = "rgba(238,235,227,0.35)";
    g.lineWidth = 3;
    const B = 34;
    for (const [x, y, sx, sy] of [[2, 2, 1, 1], [CW - 2, 2, -1, 1], [2, CH - 2, 1, -1], [CW - 2, CH - 2, -1, -1]]) {
      g.beginPath(); g.moveTo(x, y + sy * B); g.lineTo(x, y); g.lineTo(x + sx * B, y); g.stroke();
    }
    // scan band
    const sy = ((time * 0.35) % 1) * (CH + 120) - 60;
    const band = g.createLinearGradient(0, sy - 60, 0, sy + 60);
    band.addColorStop(0, "rgba(238,235,227,0)");
    band.addColorStop(0.5, "rgba(238,235,227,0.04)");
    band.addColorStop(1, "rgba(238,235,227,0)");
    g.fillStyle = band;
    g.fillRect(0, sy - 60, CW, 120);

    // heat
    g.imageSmoothingEnabled = true;
    g.globalAlpha = holoAlpha * (phase === "blast" || phase === "card" ? 0.35 : 1);
    g.drawImage(heatCol, 0, 0, CW, CH);
    g.globalAlpha = holoAlpha;

    // blast
    if ((phase === "blast" || phase === "card") && blast) drawBlast();

    // players
    g.font = "600 17px 'Geist Mono', monospace";
    g.textAlign = "center";
    for (const p of players) {
      if (!p.pos || (!p.alive && phase !== "blast" && phase !== "card")) continue;
      const [x, y] = toPx(p.pos.x, p.pos.y);
      let col = p.you ? YOU_COLOR : CYAN;
      let r = p.you ? 8 : 4.5;
      let a = 1;
      if (blast && (phase === "blast" || phase === "card")) {
        const reached = blastRadiusPx() >= p.d * PPM;
        const settled = phase === "card" || t > T.blast * 0.75;
        if (p.verdict === "safe" && (reached || settled)) col = SAFE;
        if (p.verdict === "out" && (outcome === "saved" ? reached : settled)) {
          col = KILL;
          a = phase === "card" ? Math.max(0.25, 1 - t / 1.2) : 1;
        }
      }
      if (p.spec) a *= 0.6; // speculative (not yet finalised) pick: drawn, but dimmer
      g.globalAlpha = holoAlpha * a;
      g.fillStyle = col;
      g.shadowColor = col;
      g.shadowBlur = 4;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      if (col === KILL) {
        g.strokeStyle = col; g.lineWidth = 2;
        g.beginPath(); g.moveTo(x - 7, y - 7); g.lineTo(x + 7, y + 7); g.moveTo(x + 7, y - 7); g.lineTo(x - 7, y + 7); g.stroke();
      }
      g.shadowBlur = 0;
      if (p.flash > 0) {
        g.globalAlpha = holoAlpha * p.flash;
        g.strokeStyle = col; g.lineWidth = 2;
        g.beginPath(); g.arc(x, y, r + (1 - p.flash) * 26, 0, Math.PI * 2); g.stroke();
        g.fillStyle = "#eeebe3";
        g.fillText(p.you ? "YOU" : "@" + p.name, clamp(x, 70, CW - 70), Math.max(20, y - 16));
      }
      if (p.pending || p.spec) {
        g.globalAlpha = holoAlpha * 0.8;
        g.strokeStyle = col; g.lineWidth = 1.5;
        g.setLineDash([4, 4]);
        g.beginPath(); g.arc(x, y, r + 5, time * 2, time * 2 + Math.PI * 1.6); g.stroke();
        g.setLineDash([]);
      }
      if (p.you) {
        g.globalAlpha = holoAlpha;
        g.strokeStyle = YOU_COLOR; g.lineWidth = 2.5;
        g.beginPath(); g.arc(x, y, 15 + Math.sin(time * 5) * 3, 0, Math.PI * 2); g.stroke();
        g.fillStyle = YOU_COLOR;
        g.font = "800 20px 'Geist Mono', monospace";
        g.fillText("YOU", x, y + 36);
        g.font = "600 17px 'Geist Mono', monospace";
      }
    }
    g.globalAlpha = holoAlpha;

    // targeting scanner
    if (phase === "focus" || phase === "shot" || phase === "hold") drawScanner(time);

    g.globalAlpha = 1;
    tex.needsUpdate = true;
  }

  function blastRadiusPx() {
    const k = phase === "card" ? 1 : easeOut(clamp(t / (T.blast * 0.7), 0, 1));
    return blast.R * PPM * k;
  }

  function drawBlast() {
    const [cx, cy] = toPx(target.x, target.y);
    const R = blastRadiusPx();
    const safe = outcome === "goal";
    const core = safe ? "57,192,114" : "232,56,47";
    const fill = g.createRadialGradient(cx, cy, 0, cx, cy, Math.max(R, 1));
    fill.addColorStop(0, `rgba(${core},0.05)`);
    fill.addColorStop(0.85, `rgba(${core},0.16)`);
    fill.addColorStop(1, `rgba(${core},0.30)`);
    g.fillStyle = fill;
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
    g.strokeStyle = `rgba(${core},0.95)`;
    g.lineWidth = 4;
    g.shadowColor = `rgb(${core})`;
    g.shadowBlur = 8;
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.stroke();
    g.shadowBlur = 0;
    // shock ripples
    for (let i = 1; i <= 3; i++) {
      const rr = R * (1 + i * 0.08) + ((t * 120 * i) % 40);
      g.strokeStyle = `rgba(${core},${0.25 / i})`;
      g.lineWidth = 2;
      g.beginPath(); g.arc(cx, cy, rr, 0, Math.PI * 2); g.stroke();
    }
    g.fillStyle = `rgb(${core})`;
    g.font = "800 22px 'Geist Mono', monospace";
    g.textAlign = "center";
    const ly = cy - R - 14 > 24 ? cy - R - 14 : cy + R + 30;
    g.fillText(safe ? "SAFE ZONE" : "KILL ZONE", cx, Math.min(CH - 8, ly));
  }

  function drawScanner(time) {
    const [x, y] = toPx(focus.x, focus.y);
    const k = phase === "focus" ? (target ? 0.5 + 0.5 * easeInOut(clamp((t - conv0) / convLen, 0, 1)) : Math.min(0.5, (t / T.focus) * 0.5)) : 1;
    const locked = k > 0.8;
    const col = locked ? YOU_COLOR : CYAN;
    g.strokeStyle = col;
    g.fillStyle = col;
    g.shadowColor = col;
    g.shadowBlur = 5;
    // cross hairs across the panel
    g.globalAlpha = holoAlpha * 0.35;
    g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(0, y); g.lineTo(CW, y); g.moveTo(x, 0); g.lineTo(x, CH); g.stroke();
    g.globalAlpha = holoAlpha;
    // closing ring with rotating ticks
    const r = THREE.MathUtils.lerp(150, 34, easeInOut(k));
    g.lineWidth = 3;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke();
    const rot = time * (locked ? 0.8 : 3);
    for (let i = 0; i < 4; i++) {
      const a = rot + (i * Math.PI) / 2;
      g.beginPath();
      g.moveTo(x + Math.cos(a) * (r + 6), y + Math.sin(a) * (r + 6));
      g.lineTo(x + Math.cos(a) * (r + 22), y + Math.sin(a) * (r + 22));
      g.stroke();
    }
    g.beginPath(); g.arc(x, y, 5, 0, Math.PI * 2); g.fill();
    g.shadowBlur = 0;
    g.font = "700 18px 'Geist Mono', monospace";
    g.textAlign = "left";
    const lx = x + r + 28 > CW - 200 ? x - r - 210 : x + r + 28;
    g.fillText(locked ? "LOCKED" : "SCANNING", lx, y - 8);
    g.globalAlpha = holoAlpha * 0.7;
    g.fillText(`X ${focus.x >= 0 ? "+" : ""}${focus.x.toFixed(2)}  Y ${focus.y.toFixed(2)}`, lx, y + 16);
    g.globalAlpha = holoAlpha;
  }

  // boot: show the connecting state, then bring the network up (config -> tiers -> WebSocket)
  renderNet();
  renderLobby();
  updateStats();
  net.init();

  return {
    update,
    onOutcome,
    pointerDown,
    get phase() { return phase; },
    get players() { return players; },
    get game() { return G; },
  };
}
