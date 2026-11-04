#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Spotkick Royale — end-to-end test: plays a REAL royale against the LOCAL
// chain (anvil 31337) + the REAL server (REST/WS/driver/indexer).
// TEST TOOLING ONLY — nothing here ships to players.
//
// Usage:  ./up.sh && node play.mjs
//
// `node play.mjs` re-execs itself under tsx so it can import the shared TS
// reference (packages/shared/src/royale-math.ts) used for seed selection.
//
// Scenarios:
//   (a) leaveLobby full refund incl fee
//   (b) 4 players enter one tier, countdown at MIN_PLAYERS, game starts, picks,
//       WS frame order on game:<id>, GET /api/games/:id == chain getGame/getRound
//   (c) cashOut inside a Between window: payout == pot/alive, others unaffected
//   (d) at Finished: exact-wei conservation + contract balance == obligations
//   (e) every round GET /api/fair/:id has verified === true
//   (f) stalled game (server stopped, evm_increaseTime): refundStalled pot/alive
//   (g) SIWE auth (/api/auth/nonce + /verify) then chat over WS round-trip
//
// Seeds: the local deploy uses MockRandomness — this harness acts as the
// entropy keeper (rng.fulfill) and calls the permissionless resolveRound.
// ---------------------------------------------------------------------------
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

if (!process.env.SK_E2E_TSX) {
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: "inherit",
    cwd: HERE,
    env: { ...process.env, SK_E2E_TSX: "1" },
  });
  child.on("exit", (code, sig) => process.exit(code ?? (sig ? 1 : 0)));
} else {
  await main().catch((e) => {
    console.error("\nFATAL:", e);
    process.exit(2);
  });
}

async function main() {
  const fs = await import("node:fs");
  const {
    createPublicClient, createWalletClient, http, keccak256, toBytes, zeroHash,
    encodeAbiParameters, parseAbiParameters, parseAbi, parseEventLogs,
  } = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");
  const { WebSocket } = await import("ws");
  const { resolveRound } = await import("../../packages/shared/src/royale-math.ts");

  // ------------------------------------------------------------------ config
  const envFile = resolve(HERE, "../../server/.env.e2e");
  const accountsFile = resolve(HERE, "anvil-accounts.json");
  const deployFile = resolve(HERE, "../../contracts/deployments/31337.json");
  for (const f of [envFile, accountsFile, deployFile]) {
    if (!fs.existsSync(f)) throw new Error(`missing ${f} — run ./up.sh first`);
  }
  const env = Object.fromEntries(
    fs.readFileSync(envFile, "utf8").split("\n")
      .filter((l) => l && !l.startsWith("#") && l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  const accounts = JSON.parse(fs.readFileSync(accountsFile, "utf8"));
  const deployment = JSON.parse(fs.readFileSync(deployFile, "utf8"));

  const RPC = env.RPC_HTTP_URL || "http://localhost:8545";
  const PORT = env.PORT || "8787";
  const BASE = `http://localhost:${PORT}`;
  const WS_URL = `ws://localhost:${PORT}/ws`;
  const CHAIN_ID = Number(env.CHAIN_ID || 31337);
  const ROYALE = deployment.royale;
  const RNG = deployment.randomness;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // -------------------------------------------------------------------- chain
  const chain = {
    id: CHAIN_ID, name: `e2e-${CHAIN_ID}`, nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
  };
  const pub = createPublicClient({ chain, transport: http(RPC), pollingInterval: 250 });
  const wallets = accounts.slice(1, 5).map((a) =>
    createWalletClient({ account: privateKeyToAccount(a.privateKey), chain, transport: http(RPC) }));
  const addr = (i) => wallets[i].account.address.toLowerCase();

  const royaleAbi = parseAbi([
    "function enter(uint8 tier) payable returns (uint64 gameId, uint8 seat)",
    "function leaveLobby(uint64 gameId)",
    "function pick(uint64 gameId, int16 x, int16 y)",
    "function cashOut(uint64 gameId)",
    "function startGame(uint64 gameId)",
    "function lockPicks(uint64 gameId)",
    "function resolveRound(uint64 gameId)",
    "function advance(uint64 gameId)",
    "function refundStalled(uint64 gameId)",
    "function getGame(uint64 gameId) view returns (uint64 id, uint8 tier, uint8 phase, uint8 round, uint8 seatsFilled, uint16 aliveMask, uint128 entry, uint128 pot, uint64 phaseEndsAt)",
    "function getSeats(uint64 gameId) view returns (address[10])",
    "function getRound(uint64 gameId, uint8 round) view returns (bytes32 seed, int16 targetX, int16 targetY, uint8 outcome, uint16 survivorMask, uint16 radiusMm, uint16 saveBps)",
    "function openGameForTier(uint8 tier) view returns (uint64)",
    "function tierValue(uint8 tier) view returns (uint128)",
    "function treasury() view returns (uint128)",
    "function claimable(address) view returns (uint128)",
    "event SeatTaken(uint64 indexed gameId, uint8 seat, address indexed player)",
    "event SeatLeft(uint64 indexed gameId, uint8 seat, address indexed player)",
    "event LobbyCountdownStarted(uint64 indexed gameId, uint64 startsAt)",
    "event GameStarted(uint64 indexed gameId, uint8 players, uint128 pot)",
    "event RoundLocked(uint64 indexed gameId, uint8 round, bytes32 picksHash, uint64 entropyRequestId)",
    "event SeedReceived(uint64 indexed gameId, uint8 round, bytes32 seed)",
    "event RoundResolved(uint64 indexed gameId, uint8 round, int16 targetX, int16 targetY, uint8 outcome, uint16 survivorMask, uint16 radiusMm, uint16 saveBps, uint64 nextPhaseAt)",
    "event CashedOut(uint64 indexed gameId, uint8 round, uint8 seat, address indexed player, uint128 amount)",
    "event GameFinished(uint64 indexed gameId, uint8 seat, address indexed winner, uint128 prize, uint8 rounds)",
    "event GameRefunded(uint64 indexed gameId, uint128 perSeat)",
    "event Claimable(address indexed player, uint128 amount)",
  ]);
  const rngAbi = parseAbi([
    "function lastId() view returns (uint64)",
    "function fulfill(uint64 id, bytes32 seed)",
    "function fee() view returns (uint256)",
    "function fulfilled(uint64) view returns (bool)",
  ]);

  async function sendRaw(wallet, address, abi, functionName, args = [], value = 0n) {
    const hash = await wallet.writeContract({ address, abi, functionName, args, value });
    const rc = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (rc.status !== "success") throw new Error(`${functionName} tx reverted on-chain (${hash})`);
    return rc;
  }
  const send = (w, fn, args = [], value = 0n) => sendRaw(w, ROYALE, royaleAbi, fn, args, value);
  // viem returns a positional array for multi-output functions; re-key by ABI output names.
  const read = async (fn, args = []) => {
    const r = await pub.readContract({ address: ROYALE, abi: royaleAbi, functionName: fn, args });
    const item = royaleAbi.find((x) => x.type === "function" && x.name === fn);
    if (Array.isArray(r) && item && item.outputs.length > 1) {
      return Object.fromEntries(item.outputs.map((o, i) => [o.name, r[i]]));
    }
    return r;
  };
  const readRng = (fn, args = []) => pub.readContract({ address: RNG, abi: rngAbi, functionName: fn, args });
  const gasOf = (rc) => rc.gasUsed * rc.effectiveGasPrice;
  const balance = (a) => pub.getBalance({ address: a });
  const chainNow = async () => (await pub.getBlock()).timestamp;
  const eventsOf = (rc) => parseEventLogs({ abi: royaleAbi, logs: rc.logs });

  const getGame = async (gid) => {
    const v = await read("getGame", [gid]);
    return { id: v.id, tier: Number(v.tier), phase: Number(v.phase), round: Number(v.round), seatsFilled: Number(v.seatsFilled), aliveMask: Number(v.aliveMask), entry: v.entry, pot: v.pot, phaseEndsAt: v.phaseEndsAt };
  };

  const PHASE = { None: 0, Lobby: 1, Picking: 2, Locked: 3, Resolved: 4, Between: 5, Finished: 6, Cancelled: 7 };
  const popcount = (m) => { let n = 0; for (let x = m & 0xffff; x; x &= x - 1) n++; return n; };
  const seatsOf = (m) => { const s = []; for (let i = 0; i < 10; i++) if ((m >> i) & 1) s.push(i); return s; };

  async function waitFor(pred, timeoutMs, what, pollMs = 300) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (await pred()) return true;
      await sleep(pollMs);
    }
    throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
  }

  /** Waits for one of `want` phases; if the chain deadline passed +3s and the
   *  server driver still has not acted, the harness calls the permissionless
   *  function itself and records a note (driver finding). */
  async function waitPhase(gid, want, fallbackFn, label, timeoutMs = 60_000) {
    const t0 = Date.now();
    let noted = false;
    while (Date.now() - t0 < timeoutMs) {
      const v = await getGame(gid);
      if (want.includes(v.phase)) return v;
      const eligible = v.phaseEndsAt > 0n && (await chainNow()) >= v.phaseEndsAt + 3n;
      if (eligible && Date.now() - t0 > 4000) {
        try {
          await send(wallets[0], fallbackFn, [gid]);
          if (!noted) { notes.push(`driver did not call ${label} for game ${gid} within ~3s of the deadline; harness called it`); noted = true; }
        } catch { /* revert: not due yet, or driver raced us — keep polling */ }
      }
      await sleep(400);
    }
    throw new Error(`timed out waiting for phase ${want.map((p) => Object.keys(PHASE).find((k) => PHASE[k] === p)).join("/")} (${label}, game ${gid})`);
  }

  // ----------------------------------------------------------------------- ws
  class WsClient {
    constructor(url) { this.url = url; this.frames = []; this.ws = null; }
    connect() {
      return new Promise((res, rej) => {
        this.ws = new WebSocket(this.url);
        const to = setTimeout(() => rej(new Error(`WS connect timeout: ${this.url}`)), 15_000);
        this.ws.on("open", () => { clearTimeout(to); res(); });
        this.ws.on("error", (e) => { clearTimeout(to); rej(e); });
        this.ws.on("message", (d) => {
          try { const f = JSON.parse(d.toString()); f._idx = this.frames.length; this.frames.push(f); } catch { /* ignore */ }
        });
      });
    }
    send(o) { this.ws.send(JSON.stringify(o)); }
    sub(channels) { this.send({ t: "sub", channels }); }
    close() { try { this.ws.close(); } catch { /* ignore */ } }
    async waitFor(pred, timeoutMs = 30_000, what = "frame") {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        const f = this.frames.find(pred);
        if (f) return f;
        await sleep(150);
      }
      throw new Error(`timeout waiting for WS ${what}`);
    }
  }

  // -------------------------------------------------------------------- http
  async function fetchJson(url, opts = undefined) {
    const r = await fetch(url, opts);
    const body = await r.text();
    if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}: ${body.slice(0, 200)}`);
    return JSON.parse(body);
  }
  async function pollJson(url, pred, timeoutMs, what = url) {
    const t0 = Date.now();
    let last = "";
    while (Date.now() - t0 < timeoutMs) {
      try {
        const j = await fetchJson(url);
        last = JSON.stringify(j).slice(0, 240);
        if (pred(j)) return j;
      } catch (e) { last = e.message; }
      await sleep(1000);
    }
    throw new Error(`timeout polling ${what}; last: ${last}`);
  }

  // ----------------------------------------------------------------- results
  const results = [];
  const notes = [];
  function record(name, pass, detail = "") {
    results.push({ name, pass, detail });
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
  async function scenario(name, fn) {
    console.log(`\n▶ ${name}`);
    try { record(name, true, (await fn()) || ""); }
    catch (e) { record(name, false, e instanceof Error ? e.message : String(e)); }
  }
  const expect = (c, m) => { if (!c) throw new Error(m); };
  const soft = (errs, fn) => { try { fn(); } catch (e) { errs.push(e.message); } };
  const softAsync = async (errs, fn) => { try { await fn(); } catch (e) { errs.push(e.message); } };

  // ------------------------------------------------------------- e2e fixtures
  const PICK_POS = [[-3000, 300], [3000, 300], [-3000, 2000], [3000, 2000]]; // per seat, every round
  const CASH_SEAT = 3; // wallets[3] cashes out in the first Between window it is alive in

  function chooseSeed(gid, round, aliveMask, picks, wantFinish) {
    const n = popcount(aliveMask);
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < 3000; i++) {
        const seed = keccak256(toBytes(`spotkick-e2e:${gid}:${round}:${pass}:${i}`));
        const sim = resolveRound(seed, picks.map((p) => ({ seat: p.seat, x: p.x, y: p.y, picked: true })), aliveMask);
        const sc = popcount(sim.survivorMask);
        if (wantFinish) {
          if (sc === 1) return seed;
        } else {
          const casherAlive = ((sim.survivorMask >> CASH_SEAT) & 1) === 1;
          if (pass === 0 ? sc === n - 1 && casherAlive : sc >= 2 && casherAlive) return seed;
        }
      }
    }
    throw new Error(`chooseSeed: no suitable seed found (round ${round}, aliveMask ${aliveMask}, wantFinish ${wantFinish})`);
  }

  // ---------------------------------------------------------------- preflight
  console.log(`[e2e] rpc=${RPC} server=${BASE} royale=${ROYALE} rng=${RNG}`);
  const health = await fetchJson(`${BASE}/api/health`).catch((e) => { throw new Error(`server not healthy at ${BASE}/api/health — run ./up.sh first (${e.message})`); });
  expect(health.ok === true, `server health not ok: ${JSON.stringify(health).slice(0, 300)}`);
  const mc3 = await pub.getCode({ address: "0xcA11bde05977b3631167028862bE2a173976CA11" });
  if (!mc3 || mc3 === "0x") notes.push("Multicall3 missing at canonical address on anvil — server driver multicalls will fail");

  const gid1 = await read("openGameForTier", [0]); // tier 0 lobby (opened at deploy)
  const gid2 = await read("openGameForTier", [1]); // tier 1 lobby (for scenario f)
  const entry0 = await read("tierValue", [0]);
  const entry1 = await read("tierValue", [1]);
  expect(gid1 > 0n && entry0 > 0n, "tier 0 has no open lobby / value");
  expect(gid2 > 0n && entry1 > 0n, "tier 1 has no open lobby / value");
  console.log(`[e2e] tier0 game=${gid1} entry=${entry0} wei; tier1 game=${gid2} entry=${entry1} wei`);

  const ws = new WsClient(WS_URL);
  await ws.connect();
  const hello = await ws.waitFor((f) => f.t === "hello", 10_000, "hello");
  expect(hello.chainId === CHAIN_ID, `WS hello chainId ${hello.chainId} != ${CHAIN_ID}`);
  expect(hello.contracts.royale.toLowerCase() === ROYALE.toLowerCase(), "WS hello royale address mismatch");
  ws.sub(["rooms", "chat", `game:${gid1}`, `game:${gid2}`]);
  await sleep(500);

  // ===================================================================== (a)
  await scenario("(a) leaveLobby refunds the entry in full (incl fee)", async () => {
    const w = wallets[0];
    const t0 = await read("treasury");
    const b0 = await balance(w.account.address);
    const rc1 = await send(w, "enter", [0], entry0);
    const seatEv = eventsOf(rc1).find((e) => e.eventName === "SeatTaken");
    expect(seatEv && seatEv.args.gameId === gid1, "SeatTaken missing / wrong gameId");
    const b1 = await balance(w.account.address);
    expect(b0 - b1 - gasOf(rc1) === entry0, `enter cost ${b0 - b1 - gasOf(rc1)} != entry ${entry0}`);
    const t1 = await read("treasury");
    expect(t1 - t0 === (entry0 * 400n) / 10_000n, `treasury fee on enter ${t1 - t0} != 400bps ${(entry0 * 400n) / 10_000n}`);
    const v1 = await getGame(gid1);
    expect(v1.phase === PHASE.Lobby && v1.seatsFilled === 1 && v1.phaseEndsAt === 0n, "lobby state after 1 entry wrong (no countdown below MIN_PLAYERS)");

    const rc2 = await send(w, "leaveLobby", [gid1]);
    const b2 = await balance(w.account.address);
    const refund = b2 - b1 + gasOf(rc2);
    expect(refund === entry0, `refund ${refund} wei != entry ${entry0} wei (must include the 400bps fee)`);
    const t2 = await read("treasury");
    expect(t2 === t0, `treasury not restored after leaveLobby (${t0} -> ${t1} -> ${t2})`);
    const v2 = await getGame(gid1);
    expect(v2.seatsFilled === 0 && v2.pot === 0n && v2.phase === PHASE.Lobby, "lobby not emptied after leaveLobby");
    expect(eventsOf(rc2).some((e) => e.eventName === "SeatLeft"), "SeatLeft event missing");
    return `refund == entry == ${refund} wei exactly (gas accounted); treasury fee reverted`;
  });

  // ============================================================== (b)(c)(d)(e)
  console.log("\n▶ main game: (b) flow + WS order + REST==chain, (c) cashOut, (d) accounting, (e) fair");
  const bErrs = [];
  const cErrs = [];
  const dErrs = [];
  const eErrs = [];
  const seeds = {};
  const roundInfo = {};
  let cashoutInfo = null;
  let finishedEvent = null;
  let roundsPlayed = 0;
  let treasuryStart = null;
  let countdownEndsAt = 0n;
  let flowFatal = null;

  try {
    // ---- 4 players enter; countdown must start exactly at MIN_PLAYERS (3)
    for (let i = 0; i < 4; i++) {
      const rc = await send(wallets[i], "enter", [0], entry0);
      const ev = eventsOf(rc).find((e) => e.eventName === "SeatTaken");
      const v = await getGame(gid1);
      if (i < 2) soft(bErrs, () => expect(v.phaseEndsAt === 0n, `countdown started with only ${i + 1} seated (< MIN_PLAYERS=3)`));
      if (i === 2) {
        const blk = await pub.getBlock({ blockNumber: rc.blockNumber });
        countdownEndsAt = v.phaseEndsAt;
        soft(bErrs, () => {
          expect(v.seatsFilled === 3, `seatsFilled ${v.seatsFilled} != 3 at MIN_PLAYERS`);
          expect(v.phaseEndsAt === blk.timestamp + 15n, `countdown endsAt ${v.phaseEndsAt} != blockTs+LOBBY_COUNTDOWN_SECS ${blk.timestamp + 15n}`);
        });
        console.log(`[e2e]   countdown started at MIN_PLAYERS=3, endsAt=${v.phaseEndsAt}`);
      }
      if (i === 3) soft(bErrs, () => expect(ev && v.seatsFilled === 4 && v.phaseEndsAt === countdownEndsAt, "4th entry disturbed seats/countdown"));
      expect(ev && ev.args.seat === i, `seat ${ev ? ev.args.seat : "?"} != ${i} for player ${i}`);
    }
    const potExpected = 4n * (entry0 - (entry0 * 400n) / 10_000n);

    // ---- WS: seat + countdown frames
    await softAsync(bErrs, async () => {
      for (let i = 0; i < 4; i++) {
        await ws.waitFor((f) => f.t === "seat" && String(f.gameId) === String(gid1) && f.player === addr(i) && !f.left, 60_000, `seat frame p${i}`);
      }
      const cd = await ws.waitFor((f) => f.t === "countdown" && String(f.gameId) === String(gid1), 60_000, "countdown frame");
      expect(BigInt(cd.startsAt) === countdownEndsAt, `WS countdown.startsAt ${cd.startsAt} != chain phaseEndsAt ${countdownEndsAt}`);
    });

    // ---- game starts (driver at deadline+margin; harness falls back + notes)
    const vStart = await waitPhase(gid1, [PHASE.Picking], "startGame", "startGame", 60_000);
    soft(bErrs, () => {
      expect(vStart.round === 1 && vStart.seatsFilled === 4, `start state round=${vStart.round} seats=${vStart.seatsFilled}`);
      expect(vStart.aliveMask === 0b1111, `aliveMask ${vStart.aliveMask} != 15`);
      expect(vStart.pot === potExpected, `pot ${vStart.pot} != 4*(entry-fee) ${potExpected}`);
    });
    treasuryStart = await read("treasury");
    console.log(`[e2e]   game ${gid1} started: 4 seats, pot=${vStart.pot}`);

    // ---- round loop: picks → (driver) lock → harness fulfil seed → resolve
    while (true) {
      const v = await getGame(gid1);
      if (v.phase === PHASE.Finished) break;

      if (v.phase === PHASE.Picking) {
        const round = v.round;
        const aliveSeats = seatsOf(v.aliveMask);
        const picks = aliveSeats.map((s) => ({ seat: s, x: PICK_POS[s][0], y: PICK_POS[s][1] }));
        roundInfo[round] = { aliveMask: v.aliveMask, picks };
        await Promise.all(picks.map((p) => send(wallets[p.seat], "pick", [gid1, p.x, p.y])));
        console.log(`[e2e]   round ${round}: ${picks.length} picks placed`);
        for (const p of picks) {
          await softAsync(bErrs, async () => {
            await ws.waitFor((f) => f.t === "pick" && String(f.gameId) === String(gid1) && f.round === round && f.seat === p.seat, 45_000, `pick frame seat ${p.seat} r${round}`);
          });
        }
        await waitPhase(gid1, [PHASE.Locked], "lockPicks", "lockPicks", 60_000);
        continue;
      }

      if (v.phase === PHASE.Locked) {
        const round = v.round;
        const reqId = await readRng("lastId");
        expect(await readRng("fulfilled", [reqId]) === false, `rng request ${reqId} already fulfilled?`);
        const wantFinish = cashoutInfo !== null || popcount(v.aliveMask) <= 2;
        const seed = chooseSeed(gid1, round, v.aliveMask, roundInfo[round].picks, wantFinish);
        await sendRaw(wallets[0], RNG, rngAbi, "fulfill", [reqId, seed]); // MockRandomness.fulfill → royale.onSeed
        await waitFor(async () => (await read("getRound", [gid1, round])).seed === seed, 10_000, "SeedReceived stored");
        seeds[round] = seed;

        // resolveRound is permissionless; the server driver never calls it (see FINDINGS.md)
        const rcR = await send(wallets[0], "resolveRound", [gid1]);
        roundsPlayed = round;
        const evs = eventsOf(rcR);
        const resEv = evs.find((e) => e.eventName === "RoundResolved");
        const finEv = evs.find((e) => e.eventName === "GameFinished");
        if (finEv) finishedEvent = finEv.args;

        // TS reference (packages/shared) must equal what the chain emitted — per round
        soft(eErrs, () => {
          const sim = resolveRound(seed, roundInfo[round].picks.map((p) => ({ ...p, picked: true })), roundInfo[round].aliveMask);
          expect(resEv, `round ${round}: no RoundResolved event`);
          const a = resEv.args;
          expect(Number(a.targetX) === sim.targetX && Number(a.targetY) === sim.targetY, `round ${round}: chain target (${a.targetX},${a.targetY}) != TS reference (${sim.targetX},${sim.targetY})`);
          expect(Number(a.survivorMask) === sim.survivorMask, `round ${round}: chain survivorMask ${a.survivorMask} != reference ${sim.survivorMask}`);
          expect(Number(a.saveBps) === sim.saveBps, `round ${round}: saveBps mismatch`);
          const outcomeName = Number(a.outcome) === 1 ? "goal" : "saved";
          expect(outcomeName === sim.outcome, `round ${round}: outcome ${outcomeName} != ${sim.outcome}`);
        });

        const after = await getGame(gid1);
        console.log(`[e2e]   round ${round} resolved: survivors=${popcount(after.aliveMask)} phase=${Object.keys(PHASE).find((k) => PHASE[k] === after.phase)}`);

        if (after.phase === PHASE.Between) {
          if (!cashoutInfo && ((after.aliveMask >> CASH_SEAT) & 1) === 1 && popcount(after.aliveMask) >= 2) {
            cashoutInfo = await doCashOut(gid1, after, cErrs);
          }
          await waitPhase(gid1, [PHASE.Picking, PHASE.Finished], "advance", "advance", 60_000);
        } else if (after.phase !== PHASE.Finished) {
          throw new Error(`unexpected phase ${after.phase} after resolveRound`);
        }
        continue;
      }

      throw new Error(`unexpected phase ${v.phase} in round loop`);
    }

    // ---- (c) cashOut assertions happened inside doCashOut (cErrs, cashoutInfo)
    if (!cashoutInfo && cErrs.length === 0) cErrs.push("cashOut never executed: no Between window with the casher alive and alive >= 2");

    // ---- (d) exact-wei conservation at Finished
    soft(dErrs, () => expect(finishedEvent !== null, "no GameFinished event captured"));
    if (finishedEvent) {
      const prize = finishedEvent.prize;
      const cashoutsSum = cashoutInfo ? cashoutInfo.amount : 0n;
      const entries = 4n * entry0;
      const feeTotal = (entries * 400n) / 10_000n; // 400 bps of every entry, accrued to treasury at enter
      soft(dErrs, () => expect(entries === prize + cashoutsSum + feeTotal,
        `Σentries ${entries} != Σpayouts (prize ${prize} + cashouts ${cashoutsSum}) + treasuryFee ${feeTotal}`));
      const t1 = await read("treasury");
      const rngFee = await readRng("fee");
      soft(dErrs, () => expect(treasuryStart - t1 === BigInt(roundsPlayed) * rngFee,
        `treasury delta ${treasuryStart - t1} != rounds(${roundsPlayed}) × entropyFee(${rngFee})`));
      const vEnd = await getGame(gid1);
      const bal = await balance(ROYALE);
      soft(dErrs, () => expect(vEnd.phase === PHASE.Finished && vEnd.pot === 0n, `end state phase=${vEnd.phase} pot=${vEnd.pot}`));
      const claims = await (async () => { let s = 0n; for (const w of wallets) s += await read("claimable", [w.account.address]); return s; })();
      soft(dErrs, () => expect(bal === t1 + vEnd.pot + claims,
        `royale balance ${bal} != treasury ${t1} + pot ${vEnd.pot} + claimable ${claims}`));
      soft(dErrs, () => { if (cashoutInfo) expect(prize === cashoutInfo.potAfter, `winner prize ${prize} != pot right after cashOut ${cashoutInfo.potAfter} (dust must go to the winner)`); });
      console.log(`[e2e]   finished: prize=${prize} cashout=${cashoutsSum} entries=${entries} fee=${feeTotal} rounds=${roundsPlayed}`);
    }

    // ---- (b) REST /api/games/:id == chain getGame/getRound (after indexer catches up)
    await softAsync(bErrs, async () => {
      const replay = await pollJson(`${BASE}/api/games/${gid1}`, (j) => j && j.game && j.game.phase === "finished" && Array.isArray(j.rounds) && j.rounds.length === roundsPlayed, 120_000, `GET /api/games/${gid1} (phase finished)`);
      const cv = await getGame(gid1);
      expect(replay.game.entryWei === cv.entry.toString(), `replay entryWei ${replay.game.entryWei} != chain ${cv.entry}`);
      expect(replay.game.potWei === cv.pot.toString(), `replay potWei ${replay.game.potWei} != chain ${cv.pot}`);
      const chainSeats = await read("getSeats", [gid1]);
      expect(replay.seats.length === 4, `replay seats ${replay.seats.length} != 4`);
      for (const s of replay.seats) expect(s.player.toLowerCase() === chainSeats[s.seat].toLowerCase(), `replay seat ${s.seat} player ${s.player} != chain ${chainSeats[s.seat]}`);
      for (let r = 1; r <= roundsPlayed; r++) {
        const crr = await read("getRound", [gid1, r]);
        const rep = replay.rounds.find((x) => x.round === r);
        expect(rep && rep.result, `replay missing round ${r} result`);
        expect(rep.result.targetX === Number(crr.targetX) && rep.result.targetY === Number(crr.targetY), `round ${r}: replay target != chain getRound`);
        const outcome = Number(crr.outcome) === 1 ? "goal" : "saved";
        expect(rep.result.outcome === outcome, `round ${r}: replay outcome ${rep.result.outcome} != chain ${outcome}`);
        expect(rep.result.survivorMask === Number(crr.survivorMask) && rep.result.radiusMm === Number(crr.radiusMm) && rep.result.saveBps === Number(crr.saveBps), `round ${r}: replay survivorMask/radiusMm/saveBps != chain`);
        const info = roundInfo[r];
        expect(rep.picks.length === info.picks.length, `round ${r}: replay picks ${rep.picks.length} != ${info.picks.length}`);
        for (const p of info.picks) {
          const rp = rep.picks.find((q) => q.seat === p.seat);
          expect(rp && rp.x === p.x && rp.y === p.y && rp.auto === false, `round ${r}: replay pick for seat ${p.seat} mismatch`);
        }
      }
      expect(replay.winner && replay.winner.player.toLowerCase() === finishedEvent.winner.toLowerCase() && replay.winner.prizeWei === finishedEvent.prize.toString() && replay.winner.rounds === Number(finishedEvent.rounds), `replay winner ${JSON.stringify(replay.winner)} != chain GameFinished`);
      if (cashoutInfo) {
        expect(Array.isArray(replay.cashouts) && replay.cashouts.length === 1 && replay.cashouts[0].amountWei === cashoutInfo.amount.toString(), `replay cashouts ${JSON.stringify(replay.cashouts)} != expected single ${cashoutInfo.amount}`);
      }
    });

    // ---- (b) WS frame order on game:<id>
    await softAsync(bErrs, async () => {
      await ws.waitFor((f) => f.t === "finished" && String(f.gameId) === String(gid1), 120_000, "finished frame");
      const g = String(gid1);
      const first = (pred) => ws.frames.findIndex(pred);
      const idx = {
        seat: first((f) => f.t === "seat" && String(f.gameId) === g && !f.left),
        countdown: first((f) => f.t === "countdown" && String(f.gameId) === g),
        pick: first((f) => f.t === "pick" && String(f.gameId) === g),
        locked: first((f) => f.t === "locked" && String(f.gameId) === g),
        seed: first((f) => f.t === "seed" && String(f.gameId) === g),
        resolved: first((f) => f.t === "resolved" && String(f.gameId) === g),
        cashout: cashoutInfo ? first((f) => f.t === "cashout" && String(f.gameId) === g) : -1,
        finished: first((f) => f.t === "finished" && String(f.gameId) === g),
      };
      const order = ["seat", "countdown", "pick", "locked", "seed", "resolved", ...(cashoutInfo ? ["cashout"] : []), "finished"];
      for (const k of order) expect(idx[k] >= 0, `WS frame "${k}" never received on game:${g}`);
      for (let i = 1; i < order.length; i++) {
        expect(idx[order[i - 1]] < idx[order[i]], `WS order violated: "${order[i - 1]}"(#${idx[order[i - 1]]}) must arrive before "${order[i]}"(#${idx[order[i]]})`);
      }
      console.log(`[e2e]   WS order ok: ${order.map((k) => `${k}#${idx[k]}`).join(" < ")}`);
    });

    // ---- (e) /api/fair/:id verified === true for every round
    await softAsync(eErrs, async () => {
      const fair = await pollJson(`${BASE}/api/fair/${gid1}`, (j) => j && Array.isArray(j.rounds) && j.rounds.length === roundsPlayed && j.rounds.every((r) => r.seed), 120_000, `GET /api/fair/${gid1}`);
      for (const r of fair.rounds) {
        expect(r.verified === true, `round ${r.round}: verified !== true (recomputed=${JSON.stringify(r.recomputed)} chain target=${JSON.stringify(r.target)} outcome=${r.outcome} saveBps=${r.saveBps} survivorMask=${r.survivorMask})`);
        expect(r.seed === seeds[r.round], `round ${r.round}: /fair seed ${r.seed} != delivered seed ${seeds[r.round]}`);
        const info = roundInfo[r.round];
        expect(r.picksHash, `round ${r.round}: picksHash missing`);
        const ur = keccak256(encodeAbiParameters(parseAbiParameters("uint64 gameId, uint8 round, bytes32 picksHash"), [gid1, r.round, r.picksHash]));
        expect(r.userRandomness === ur, `round ${r.round}: userRandomness ${r.userRandomness} != keccak(gameId,round,picksHash) ${ur}`);
        const xs = new Array(10).fill(0), ys = new Array(10).fill(0), picked = new Array(10).fill(false);
        for (const p of info.picks) { xs[p.seat] = p.x; ys[p.seat] = p.y; picked[p.seat] = true; }
        const ph = keccak256(encodeAbiParameters(parseAbiParameters("int16[10] xs, int16[10] ys, bool[10] picked, uint16 aliveMask"), [xs, ys, picked, info.aliveMask]));
        expect(ph === r.picksHash, `round ${r.round}: picksHash ${r.picksHash} != recomputed ${ph}`);
      }
      if (fair.verifierVersion === null) notes.push("GET /api/fair returns verifierVersion:null although server/src/fair/verifier.ts defines VERIFIER_VERSION (stale comment in server/src/api/routes.ts says royale-math is 'not wired in yet')");
    });
  } catch (e) {
    flowFatal = e instanceof Error ? e.message : String(e);
    console.error(`[e2e]   main game flow aborted: ${flowFatal}`);
  }

  record("(b) 4 enter tier, countdown at MIN_PLAYERS, start, picks, WS order, /api/games==chain",
    !flowFatal && bErrs.length === 0,
    flowFatal ? `flow aborted: ${flowFatal}` : bErrs.join(" | ") || `game ${gid1}, ${roundsPlayed} round(s) played to Finished`);
  record("(c) cashOut in a Between window pays pot/alive, others unaffected",
    !flowFatal && cashoutInfo !== null && cErrs.length === 0,
    flowFatal ? `blocked: flow aborted (${flowFatal})` : cErrs.join(" | ") || (cashoutInfo ? `seat ${cashoutInfo.seat} cashed out ${cashoutInfo.amount} wei in round ${cashoutInfo.round} (pot/alive), pot/aliveMask updated, others unchanged` : "cashOut never executed"));
  record("(d) Finished: Σ(payouts+cashouts)+treasuryFee == Σentries exact wei; balance == obligations",
    !flowFatal && finishedEvent !== null && dErrs.length === 0,
    flowFatal ? `blocked: flow aborted (${flowFatal})` : dErrs.join(" | ") || `entries=${4n * entry0} = prize ${finishedEvent ? finishedEvent.prize : "?"} + cashout ${cashoutInfo ? cashoutInfo.amount : 0n} + fee ${(4n * entry0 * 400n) / 10_000n}; balance==treasury+pot+claimable`);
  record("(e) /api/fair/:id verified === true for every round (TS reference == chain)",
    !flowFatal && roundsPlayed > 0 && eErrs.length === 0,
    flowFatal ? `blocked: flow aborted (${flowFatal})` : eErrs.join(" | ") || `${roundsPlayed} round(s) verified, seeds/userRandomness/picksHash all match`);

  // ===================================================================== (g)
  await scenario("(g) SIWE auth (nonce+verify) then chat over WS round-trip", async () => {
    const w = wallets[0];
    const nonceRes = await fetchJson(`${BASE}/api/auth/nonce?address=${w.account.address}`);
    expect(nonceRes.nonce && nonceRes.message, `bad nonce response: ${JSON.stringify(nonceRes)}`);
    const signature = await w.signMessage({ message: nonceRes.message });
    const ver = await fetchJson(`${BASE}/api/auth/verify`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: w.account.address, signature }),
    });
    expect(ver.token && ver.expiresAt > Date.now(), `bad verify response: ${JSON.stringify(ver).slice(0, 200)}`);

    const ws2 = new WsClient(`${WS_URL}?token=${encodeURIComponent(ver.token)}`);
    await ws2.connect();
    try {
      await ws2.waitFor((f) => f.t === "hello", 10_000, "hello (authed)");
      ws2.sub(["chat"]);
      await sleep(200);
      const text = "e2e gl hf";
      ws2.send({ t: "chat", text });
      const f = await ws2.waitFor((m) => m.t === "chat" && m.text === text, 15_000, "echoed chat frame");
      expect(f.user, "chat frame missing user");
      const err = ws2.frames.find((m) => m.t === "error");
      expect(!err, `WS error frame: ${JSON.stringify(err)}`);
      const hist = await fetchJson(`${BASE}/api/chat?limit=20`);
      expect(Array.isArray(hist) && hist.some((h) => h.id === f.id), "chat not present in GET /api/chat history");
      return `token issued, chat "${text}" echoed over WS (id ${f.id}) and present in /api/chat`;
    } finally { ws2.close(); }
  });

  // ===================================================================== (f)
  await scenario("(f) stalled game: driver stopped + time travel → refundStalled pays pot/alive", async () => {
    // fresh lobby on tier 1, 3 players, let the server driver start it
    const gidF = await read("openGameForTier", [1]);
    expect(gidF > 0n, "no open tier-1 lobby");
    for (let i = 0; i < 3; i++) await send(wallets[i], "enter", [1], entry1);
    const vc = await getGame(gidF);
    expect(vc.phaseEndsAt > 0n, "countdown did not start with 3 players");
    await waitPhase(gidF, [PHASE.Picking], "startGame", "startGame", 60_000);
    console.log(`[e2e]   game ${gidF} in Picking; stopping the server (driver)…`);

    // stop the server (driver). Use the pid file written by up.sh.
    const { execSync } = await import("node:child_process");
    const pidFile = resolve(HERE, "server.pid");
    if (fs.existsSync(pidFile)) {
      const pid = fs.readFileSync(pidFile, "utf8").trim();
      execSync(`pkill -P ${pid} 2>/dev/null; kill ${pid} 2>/dev/null; pkill -f "tsx src/main.ts" 2>/dev/null; true`);
    } else execSync(`pkill -f "tsx src/main.ts" 2>/dev/null; true`);
    await waitFor(async () => {
      try { await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) }); return false; }
      catch { return true; }
    }, 30_000, "server to stop answering /api/health", 500);
    ws.close();

    // jump past pickDeadline + STALL_TIMEOUT_SECS (600)
    const before = await getGame(gidF);
    await pub.request({ method: "evm_increaseTime", params: [700] });
    await pub.request({ method: "evm_mine" });
    const now = await chainNow();
    expect(now >= before.phaseEndsAt + 600n || (before.phase === PHASE.Locked && now >= before.phaseEndsAt), `time travel insufficient: now=${now} deadline=${before.phaseEndsAt}`);

    const aliveN = popcount(before.aliveMask);
    const perSeat = before.pot / BigInt(aliveN);
    const bals0 = await Promise.all([0, 1, 2].map((i) => balance(wallets[i].account.address)));
    const rc = await send(wallets[0], "refundStalled", [gidF]);
    const bals1 = await Promise.all([0, 1, 2].map((i) => balance(wallets[i].account.address)));
    expect(bals1[0] - bals0[0] + gasOf(rc) === perSeat, `caller refund ${bals1[0] - bals0[0] + gasOf(rc)} != pot/alive ${perSeat}`);
    expect(bals1[1] - bals0[1] === perSeat, `player1 refund ${bals1[1] - bals0[1]} != ${perSeat}`);
    expect(bals1[2] - bals0[2] === perSeat, `player2 refund ${bals1[2] - bals0[2]} != ${perSeat}`);
    const after = await getGame(gidF);
    expect(after.phase === PHASE.Cancelled, `phase ${after.phase} != Cancelled(7)`);
    expect(after.pot === 0n, `pot ${after.pot} != 0 after refund`);
    const ev = eventsOf(rc).find((e) => e.eventName === "GameRefunded");
    expect(ev && ev.args.perSeat === perSeat, `GameRefunded perSeat ${ev ? ev.args.perSeat : "missing"} != ${perSeat}`);
    return `game ${gidF} stalled in phase ${Object.keys(PHASE).find((k) => PHASE[k] === before.phase)}; +700s; 3× refund of pot/alive = ${perSeat} wei each; phase Cancelled, pot 0`;
  });

  // ------------------------------------------------------------------- report
  console.log("\n================ RESULTS ================");
  for (const r of results) {
    console.log(`${r.pass ? "PASS" : "FAIL"} | ${r.name}${r.detail ? `\n       reason: ${r.detail}` : ""}`);
  }
  if (notes.length) {
    console.log("\n---- notes (candidate FINDINGS.md entries) ----");
    for (const n of notes) console.log(` * ${n}`);
  }
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} scenarios passed`);
  fs.writeFileSync(resolve(HERE, "results.json"), JSON.stringify({ results, notes }, null, 2) + "\n");
  process.exit(results.every((r) => r.pass) ? 0 : 1);

  // ------------------------------------------------------------- helpers used above
  async function doCashOut(gid, view, errs) {
    const aliveN = popcount(view.aliveMask);
    const expected = view.pot / BigInt(aliveN);
    const seat = CASH_SEAT;
    console.log(`[e2e]   Between window r${view.round}: cashing out seat ${seat}, expected pot/alive = ${expected}`);
    const bals0 = await Promise.all(wallets.map((w) => balance(w.account.address)));
    let rc;
    try { rc = await send(wallets[seat], "cashOut", [gid]); }
    catch (e) { errs.push(`cashOut tx failed: ${e.message}`); return null; }
    const bals1 = await Promise.all(wallets.map((w) => balance(w.account.address)));
    const got = bals1[seat] - bals0[seat] + gasOf(rc);
    soft(errs, () => expect(got === expected, `cashOut paid ${got} wei != pot/alive ${expected} wei (pot ${view.pot} / alive ${aliveN})`));
    for (let i = 0; i < wallets.length; i++) {
      if (i !== seat) soft(errs, () => expect(bals1[i] === bals0[i], `player ${i} balance changed during cashOut (${bals0[i]} -> ${bals1[i]}) — must be unaffected`));
    }
    const after = await getGame(gid);
    soft(errs, () => expect(after.pot === view.pot - expected, `pot after cashOut ${after.pot} != ${view.pot - expected}`));
    soft(errs, () => expect(after.aliveMask === (view.aliveMask & ~(1 << seat)), `aliveMask after cashOut ${after.aliveMask} != ${view.aliveMask & ~(1 << seat)}`));
    soft(errs, () => {
      const ev = eventsOf(rc).find((e) => e.eventName === "CashedOut");
      expect(ev && ev.args.amount === expected && Number(ev.args.seat) === seat, `CashedOut event ${JSON.stringify(ev ? { amount: ev.args.amount.toString(), seat: ev.args.seat } : null)} != expected ${expected.toString()}/${seat}`);
    });
    await softAsync(errs, async () => {
      const f = await ws.waitFor((m) => m.t === "cashout" && String(m.gameId) === String(gid) && m.seat === seat, 90_000, "cashout frame");
      expect(BigInt(f.amount) === expected, `WS cashout amount ${f.amount} != ${expected}`);
    });
    return { round: view.round, seat, amount: expected, potAfter: after.pot, aliveAfter: popcount(after.aliveMask) };
  }
}
