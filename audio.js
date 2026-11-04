// Web Audio sound engine: preloaded buffers, one-shots, a ducked crowd bed, mute persisted.
// Browsers block audio until a user gesture, so the context is resumed on the first pointer/key.

const NAMES = [
  "crowd_loop", "crowd_goal", "crowd_win", "crowd_save", "scan", "lock_on", "lock_thud", "whistle", "kickoff",
  "kick", "save_glove", "whoosh", "net_hit", "post_clang", "blast_safe", "blast_kill", "eliminated", "advance",
  "bet_place", "coins", "cash_out", "tick", "click",
];

// per-sound mix levels (files are all peak-normalised to -1 dBFS)
const LEVEL = {
  crowd_loop: 0.32, crowd_goal: 0.7, crowd_win: 0.7, crowd_save: 0.75, scan: 0.28, lock_on: 0.55, lock_thud: 0.6,
  whistle: 0.45, kickoff: 0.45, kick: 0.9, save_glove: 0.9, whoosh: 0.35, net_hit: 0.8, post_clang: 0.6,
  blast_safe: 0.55, blast_kill: 0.6, eliminated: 0.5, advance: 0.55, bet_place: 0.6, coins: 0.6, cash_out: 0.6,
  tick: 0.35, click: 0.3,
};

const ctx = new (window.AudioContext || window.webkitAudioContext)();
const master = ctx.createGain();
const bedGain = ctx.createGain(); // crowd bed, ducked under the action
master.connect(ctx.destination);
bedGain.connect(master);

let muted = localStorage.getItem("spotkick:muted") === "1";
master.gain.value = muted ? 0 : 0.9;

const buffers = {};
const ready = Promise.all(
  NAMES.map(async (n) => {
    try {
      const res = await fetch(`assets/sfx/${n}.mp3`);
      buffers[n] = await ctx.decodeAudioData(await res.arrayBuffer());
    } catch {
      console.info(`[audio] missing ${n}`);
    }
  })
);

const unlock = () => {
  if (ctx.state !== "running") ctx.resume();
};
addEventListener("pointerdown", unlock, { capture: true });
addEventListener("keydown", unlock, { capture: true });

const playing = new Map(); // name -> last source, for stop()

export function play(name, { vol = 1, rate = 1, delay = 0 } = {}) {
  const buf = buffers[name];
  if (!buf || ctx.state !== "running") return null;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = rate;
  const g = ctx.createGain();
  g.gain.value = (LEVEL[name] ?? 0.6) * vol;
  src.connect(g).connect(master);
  src.start(ctx.currentTime + delay);
  playing.set(name, { src, g });
  src.onended = () => {
    if (playing.get(name)?.src === src) playing.delete(name);
  };
  return src;
}

export function stop(name, fade = 0.25) {
  const p = playing.get(name);
  if (!p) return;
  const t = ctx.currentTime;
  p.g.gain.setTargetAtTime(0, t, fade / 3);
  p.src.stop(t + fade);
  playing.delete(name);
}

// crowd bed: looped, starts on first unlock
let bed = null;
async function startBed() {
  await ready;
  if (bed || !buffers.crowd_loop) return;
  bed = ctx.createBufferSource();
  bed.buffer = buffers.crowd_loop;
  bed.loop = true;
  const g = ctx.createGain();
  g.gain.value = LEVEL.crowd_loop;
  bed.connect(g).connect(bedGain);
  bed.start();
}
ctx.onstatechange = () => {
  if (ctx.state === "running") startBed();
};

// 0 = full bed, 1 = heavily ducked (during the shot)
export function duck(amount, time = 0.4) {
  bedGain.gain.setTargetAtTime(1 - 0.75 * amount, ctx.currentTime, time / 3);
}

export function setMuted(m) {
  muted = m;
  localStorage.setItem("spotkick:muted", m ? "1" : "0");
  master.gain.setTargetAtTime(m ? 0 : 0.9, ctx.currentTime, 0.05);
}
export const isMuted = () => muted;
export const debug = () => ({ state: ctx.state, loaded: Object.keys(buffers).length, total: NAMES.length, playing: [...playing.keys()] });
