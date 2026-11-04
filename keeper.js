import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";

// The keeper has two drivers behind one interface:
//  - AnimatedKeeper: rigged GLB with Mixamo clips (see SAVE_CLIPS). For each shot it searches every
//    clip, side and frame for the glove path that best meets the ball, then times that frame to
//    the ball's arrival. Saves test the real bones; catch clips hold the ball.
//  - StaticKeeper: unrigged mesh moved as one rigid body (fallback).

const HEIGHT = 1.9;
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpC = new THREE.Vector3();

function enableShadows(root) {
  root.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
      o.frustumCulled = false; // skinned bounds don't follow the animation
    }
  });
}

// where the keeper thinks the ball is going.
// `forced` ('goal' | 'saved') is the multiplayer path: the on-chain verdict is already known, so the keeper
// is scripted to play it out. saved -> reads the target exactly; goal -> commits to a spot well clear of it.
// Deterministic by construction (no randomness decides a forced result).
let perfectRead = false;
function guessTarget(target, power, forced = null) {
  if (forced === "saved") return target.clone();
  if (forced === "goal") {
    // dive to the opposite side of the target; for central shots pick the wider side of the goal
    const side = Math.abs(target.x) < 0.8 ? (target.x <= 0 ? 1 : -1) : -Math.sign(target.x);
    const x = THREE.MathUtils.clamp(target.x + side * 2.2, -3.2, 3.2);
    return new THREE.Vector3(Math.abs(x - target.x) < 1.6 ? side * 3.0 : x, target.y > 1.2 ? 0.5 : 1.6, 0);
  }
  if (perfectRead) return target.clone();
  const read = Math.random() < 0.62 - 0.32 * Math.min(power, 1);
  if (read) return new THREE.Vector3(target.x + (Math.random() - 0.5) * 1.0, target.y + (Math.random() - 0.5) * 0.6, 0);
  if (Math.random() < 0.18) return new THREE.Vector3((Math.random() - 0.5) * 0.6, 0.9 + Math.random() * 1.2, 0);
  return new THREE.Vector3((Math.random() < 0.5 ? -1 : 1) * (0.8 + Math.random() * 2.6), 0.2 + Math.random() * 2, 0);
}

function distToSegment(p, a, b) {
  tmpC.subVectors(b, a);
  const t = THREE.MathUtils.clamp(tmpA.subVectors(p, a).dot(tmpC) / Math.max(tmpC.lengthSq(), 1e-6), 0, 1);
  return tmpA.copy(a).addScaledVector(tmpC, t).distanceTo(p);
}

// ---------------------------------------------------------------------------
// Animated (rigged) keeper
// ---------------------------------------------------------------------------
// Save clips and the part of each worth intercepting with (seconds into the clip).
// `start` skips the slow wind-up so reactions happen at match speed.
const SAVE_CLIPS = {
  dive_mid: { start: 0.5, from: 0.6, to: 1.25, catches: false }, // flying side dive, mid height
  dive_low: { start: 0.42, from: 0.5, to: 1.2, catches: false }, // collapsing ground save
  jump_high: { start: 0.2, from: 0.4, to: 0.95, catches: false }, // one-hand jump reach
  catch_high: { start: 0.25, from: 0.5, to: 1.0, catches: true }, // two-hand jumping catch
  catch_mid: { start: 0.1, from: 0.3, to: 0.75, catches: true }, // chest catch
};
const MAX_SHIFT_X = 0.9; // how far the rig may slide beyond the clip's own travel
const MAX_LIFT = 0.5;

class AnimatedKeeper {
  constructor(rig, base, gltf, rotY) {
    this.rig = rig;
    this.base = base;
    this.root = gltf.scene;
    this.mirror = new THREE.Group();
    this.mirror.add(this.root);
    rig.add(this.mirror);
    rig.position.copy(base);
    rig.rotation.set(0, 0, 0);
    this.root.rotation.y += rotY;
    enableShadows(this.root);

    this.clips = Object.fromEntries(gltf.animations.map((a) => [a.name, a]));
    this.mixer = new THREE.AnimationMixer(this.root);

    // normalise: size from the standing bind pose, floor + centre from the idle pose
    // (the raw bind-pose bounds are the right size but sit offset from the animated body)
    const skinnedBox = (bind) => {
      this.root.updateMatrixWorld(true);
      this.root.traverse((o) => {
        if (!o.isSkinnedMesh) return;
        if (bind) o.skeleton.pose();
        o.computeBoundingBox();
      });
      return new THREE.Box3().setFromObject(this.root);
    };
    let box = skinnedBox(true);
    this.root.scale.multiplyScalar(HEIGHT / (box.max.y - box.min.y));
    this.mixer.clipAction(this.clips.idle ?? gltf.animations[0]).play();
    this.mixer.update(0);
    box = skinnedBox(false);
    const c = box.getCenter(new THREE.Vector3());
    this.root.position.x -= c.x;
    this.root.position.z -= c.z;
    this.root.position.y -= box.min.y;
    this.mixer.stopAllAction();
    this.bones = this.findBones(this.root);
    this.colliders = this.buildColliders(this.bones);

    // sidestep is played in place; the rig carries its sideways travel
    this.shuffle = this.clips.sidestep ? this.extractRootX(this.clips.sidestep) : null;

    this.tracks = {};
    for (const key of Object.keys(SAVE_CLIPS)) if (this.clips[key]) this.tracks[key] = this.sample(key);

    this.actions = {};
    for (const [k, clip] of Object.entries(this.clips)) this.actions[k] = this.mixer.clipAction(clip);

    this.ready = false;
    this.reset();
  }

  findBones(root) {
    const bones = {};
    root.traverse((o) => {
      if (o.isBone) bones[o.name.replace(/^mixamorig[:_]?/i, "")] = o;
    });
    return bones;
  }

  buildColliders(b) {
    const caps = [];
    const cap = (a, c, r) => { if (b[a] && b[c]) caps.push([b[a], b[c], r]); };
    cap("Hips", "Spine2", 0.2);
    cap("Spine2", "Head", 0.15);
    for (const s of ["Left", "Right"]) {
      cap(`${s}Arm`, `${s}ForeArm`, 0.09);
      cap(`${s}ForeArm`, `${s}Hand`, 0.085);
      cap(`${s}UpLeg`, `${s}Leg`, 0.11);
      cap(`${s}Leg`, `${s}Foot`, 0.09);
    }
    const hands = ["Left", "Right"].filter((s) => b[`${s}Hand`] && b[`${s}ForeArm`])
      .map((s) => ({ hand: b[`${s}Hand`], fore: b[`${s}ForeArm`] }));
    return { caps, hands };
  }

  // glove centre: wrist pushed ~10 cm further along the forearm
  glove(h, out, bones = null) {
    const hand = bones ? bones[h.hand.name.replace(/^mixamorig[:_]?/i, "")] : h.hand;
    const fore = bones ? bones[h.fore.name.replace(/^mixamorig[:_]?/i, "")] : h.fore;
    hand.getWorldPosition(out);
    fore.getWorldPosition(tmpB);
    return out.add(tmpB.subVectors(out, tmpB).setLength(0.1));
  }

  // Run a clip on a hidden clone and record both gloves over its usable window
  sample(key) {
    const cfg = SAVE_CLIPS[key];
    const clone = cloneSkinned(this.root);
    const holder = new THREE.Group();
    holder.add(clone);
    const mixer = new THREE.AnimationMixer(clone);
    mixer.clipAction(this.clips[key]).setLoop(THREE.LoopOnce, 1).play().clampWhenFinished = true;
    const bones = this.findBones(clone);
    const out = [];
    for (let t = cfg.from; t <= Math.min(cfg.to, this.clips[key].duration); t += 1 / 30) {
      mixer.setTime(t);
      holder.updateMatrixWorld(true);
      // gloves first; chest and hips also count — balls at the body get blocked, not reached for
      const points = this.colliders.hands.map((h) => this.glove(h, new THREE.Vector3(), bones));
      for (const n of ["Spine2", "Hips"]) if (bones[n]) points.push(bones[n].getWorldPosition(new THREE.Vector3()));
      out.push({ t, points });
    }
    mixer.stopAllAction();
    return out;
  }

  // Strip the hips' sideways travel from a clip; return that travel as a curve for the rig
  extractRootX(clip) {
    const clone = cloneSkinned(this.root);
    const holder = new THREE.Group();
    holder.add(clone);
    const mixer = new THREE.AnimationMixer(clone);
    mixer.clipAction(clip).setLoop(THREE.LoopOnce, 1).play().clampWhenFinished = true;
    const hips = this.findBones(clone).Hips;
    const curve = [];
    for (let t = 0; t <= clip.duration + 1e-4; t += 1 / 60) {
      mixer.setTime(Math.min(t, clip.duration));
      holder.updateMatrixWorld(true);
      curve.push(hips.getWorldPosition(tmpA).x);
    }
    mixer.stopAllAction();
    const x0 = curve[0];
    for (let i = 0; i < curve.length; i++) curve[i] -= x0;

    const track = clip.tracks.find((tr) => /hips\.position$/i.test(tr.name));
    if (track) {
      const v = track.values;
      const n = v.length / 3;
      const d = [0, 1, 2].map((c) => Math.abs(v[(n - 1) * 3 + c] - v[c]));
      const axis = d.indexOf(Math.max(...d));
      for (let i = 0; i < n; i++) v[i * 3 + axis] = v[axis];
    }
    return { curve, duration: clip.duration, travel: curve[curve.length - 1] };
  }

  play(key, { fade = 0.12, timeScale = 1, at = 0, loop = false } = {}) {
    const next = this.actions[key];
    if (!next) return;
    next.reset();
    next.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    next.clampWhenFinished = !loop;
    next.timeScale = timeScale;
    next.time = at;
    if (this.current && this.current !== next) next.crossFadeFrom(this.current, fade, false);
    next.play();
    this.current = next;
    this.currentKey = key;
  }

  setReady(on) {
    this.ready = on;
  }

  // Pick the clip, side, frame and speed whose glove path best meets the guessed ball
  decide(target, power, timeToGoal, forced = null) {
    const guess = guessTarget(target, power, forced);
    const delay = forced ? 0.08 : 0.06 + Math.random() * 0.06;
    // a scripted save may stretch further than a natural one so it can always meet the on-chain target
    const maxShiftX = forced === "saved" ? 2.4 : MAX_SHIFT_X;
    const maxLift = forced === "saved" ? 0.9 : MAX_LIFT;
    const avail = Math.max(0.2, timeToGoal - delay);
    const rx = this.rig.position.x;
    let best = null;
    const perClip = {};
    for (const [key, samples] of Object.entries(this.tracks)) {
      const cfg = SAVE_CLIPS[key];
      for (const flip of [1, -1]) {
        for (const s of samples) {
          const ts = (s.t - cfg.start) / avail;
          if (ts < 0.7 || ts > 1.9) continue;
          for (const g of s.points) {
            const ox = guess.x - (rx + g.x * flip);
            const oy = guess.y - g.y;
            const spill = Math.max(0, Math.abs(ox) - maxShiftX) + Math.max(0, oy - maxLift) + Math.max(0, -0.1 - oy);
            // prefer: little sliding, no impossible lift, natural speed, catches for balls at the body
            const cost = Math.abs(ox) * 0.8 + Math.max(0, oy) * 0.6 + Math.max(0, -oy) * 0.9 + spill * 4
              + Math.abs(Math.log(ts)) * 0.7 - (cfg.catches ? (Math.abs(guess.x - rx) < 0.6 ? 0.45 : 0.1) : 0);
            if (!best || cost < best.cost) best = { cost, key, flip, t: s.t, ts, ox, oy };
            if (perfectRead && (!perClip[key] || cost < perClip[key].cost)) perClip[key] = { cost: +cost.toFixed(2), t: +s.t.toFixed(2), ox: +ox.toFixed(2), oy: +oy.toFixed(2), g: [+g.x.toFixed(2), +g.y.toFixed(2)] };
          }
        }
      }
    }
    if (!best) return;
    if (perfectRead) console.info("[keeper] candidates", JSON.stringify(perClip), "samples", JSON.stringify(Object.fromEntries(Object.entries(this.tracks).map(([k, v]) => [k, v.length]))));
    if (perfectRead) console.info("[keeper] decide", JSON.stringify({ guess: guess.toArray().map((v) => +v.toFixed(2)), key: best.key, flip: best.flip, t: +best.t.toFixed(2), ts: +best.ts.toFixed(2), ox: +best.ox.toFixed(2), oy: +best.oy.toFixed(2), avail: +avail.toFixed(2) }));
    this.pending = {
      ...best,
      delay,
      from: this.rig.position.clone(),
      offset: new THREE.Vector3(
        THREE.MathUtils.clamp(best.ox, -maxShiftX, maxShiftX),
        THREE.MathUtils.clamp(best.oy, -0.1, maxLift),
        0
      ),
    };
    this.state = "wait";
  }

  get catching() {
    return this.state === "dive" && SAVE_CLIPS[this.pending.key].catches;
  }

  // midpoint of both gloves — where a caught ball sits
  hands(out) {
    const [a, b] = this.colliders.hands;
    this.glove(a, out);
    if (b) out.lerp(this.glove(b, tmpC), 0.5);
    return out;
  }

  startShuffle() {
    const sh = this.shuffle;
    // step toward a random spot on the line, never more than ~0.7 m off centre
    // a half-step of 0.4–0.65 m, heading back toward the middle once off centre
    const off = this.rig.position.x - this.base.x;
    const dir = Math.abs(off) > 0.3 ? -Math.sign(off) : Math.random() < 0.5 ? -1 : 1;
    const dist = 0.4 + Math.random() * 0.25;
    this.shuffleFlip = dir * Math.sign(sh.travel || 1);
    this.shuffleScale = Math.min(1, dist / Math.abs(sh.travel));
    this.shuffleFrom = this.rig.position.x;
    this.mirror.scale.x = this.shuffleFlip;
    this.play("sidestep", { fade: 0.15, timeScale: 0.9 });
    this.state = "shuffle";
  }

  update(dt, time) {
    if (this.state === "idle") {
      this.idleFor += dt;
      if (this.shuffle && !this.ready && this.idleFor > this.nextShuffle) this.startShuffle();
    } else if (this.state === "shuffle") {
      const sh = this.shuffle;
      const t = this.current.time;
      const i = Math.min(sh.curve.length - 1, Math.round(t * 60));
      this.rig.position.x = this.shuffleFrom + sh.curve[i] * this.shuffleFlip * this.shuffleScale;
      if (t >= sh.duration - 0.02) {
        this.mirror.scale.x = 1;
        this.play("idle", { fade: 0.2, loop: true });
        this.state = "idle";
        this.idleFor = 0;
        this.nextShuffle = 1.6 + Math.random() * 2.5;
      }
    } else if (this.state === "wait") {
      this.pending.delay -= dt;
      if (this.pending.delay <= 0) {
        const p = this.pending;
        p.from.copy(this.rig.position);
        this.mirror.scale.x = p.flip;
        this.play(p.key, { fade: 0.1, timeScale: p.ts, at: SAVE_CLIPS[p.key].start });
        this.state = "dive";
      }
    } else if (this.state === "dive") {
      const p = this.pending;
      const start = SAVE_CLIPS[p.key].start;
      const k = easeOut(THREE.MathUtils.clamp((this.current.time - start) / (p.t - start), 0, 1));
      this.rig.position.x = p.from.x + p.offset.x * k;
      // lift rises into the save and is given back after it
      const after = THREE.MathUtils.clamp((this.current.time - p.t) / 0.4, 0, 1);
      this.rig.position.y = p.from.y + p.offset.y * Math.sin(k * Math.PI * 0.5) * (1 - after * after);
    }
    this.mixer.update(dt);
  }

  hits(pos, r) {
    this.root.updateMatrixWorld(true);
    for (const [a, b, rad] of this.colliders.caps) {
      if (distToSegment(pos, a.getWorldPosition(tmpB), b.getWorldPosition(new THREE.Vector3())) < rad + r) return true;
    }
    for (const h of this.colliders.hands) {
      if (this.glove(h, new THREE.Vector3()).distanceTo(pos) < 0.13 + r) return true;
    }
    return false;
  }

  center(out) {
    return this.bones.Hips ? this.bones.Hips.getWorldPosition(out) : out.copy(this.rig.position);
  }

  reset() {
    this.mirror.scale.x = 1;
    this.rig.position.copy(this.base);
    this.state = "idle";
    this.pending = null;
    this.ready = false;
    this.idleFor = 0;
    this.nextShuffle = 1 + Math.random() * 2;
    for (const a of Object.values(this.actions)) a.stop();
    this.current = null;
    if (this.actions.idle) {
      this.play("idle", { loop: true });
      this.actions.idle.time = Math.random() * this.clips.idle.duration;
    }
    this.mixer.update(0);
  }

  dispose() {
    this.mixer.stopAllAction();
    this.rig.remove(this.mirror);
  }
}

// ---------------------------------------------------------------------------
// Static (unrigged) keeper — whole-body transforms
// ---------------------------------------------------------------------------
class StaticKeeper {
  constructor(rig, base, model, rotY) {
    this.rig = rig;
    this.base = base;
    enableShadows(model);
    this.wrap = new THREE.Group();
    this.wrap.add(model);
    model.rotation.y += rotY;
    // HEIGHT tall, centred on the rig origin (rig origin = body centre so dives pivot naturally)
    let box = new THREE.Box3().setFromObject(this.wrap);
    model.scale.multiplyScalar(HEIGHT / (box.max.y - box.min.y));
    box = new THREE.Box3().setFromObject(this.wrap);
    model.position.sub(box.getCenter(new THREE.Vector3()));
    this.box = new THREE.Box3().setFromObject(this.wrap);
    this.halfH = (this.box.max.y - this.box.min.y) / 2;
    rig.add(this.wrap);
    this.phase = "idle";
    this.crouch = 0;
    this.reset();
  }

  planDive(target) {
    const dx = target.x - this.base.x;
    const dy = Math.max(target.y, 0.15);
    const theta = THREE.MathUtils.clamp(Math.atan2(Math.abs(dx), dy), 0, 1.45);
    const len = Math.hypot(dx, dy);
    const reach = THREE.MathUtils.clamp(len - 0.55, this.halfH * 0.9, 2.35);
    const ux = dx / (len || 1), uy = dy / (len || 1);
    return {
      x: this.base.x + ux * reach,
      y: Math.max(uy * reach, 0.32),
      rz: -Math.sign(dx || 1) * theta * (Math.abs(dx) < 0.5 ? 0.2 : 1),
    };
  }

  setReady(on) { if (this.phase === "idle" || this.phase === "set") this.phase = on ? "set" : "idle"; }

  decide(target, power, timeToGoal, forced = null) {
    const r = this.rig;
    this.from = { x: r.position.x, y: r.position.y, rz: r.rotation.z };
    this.to = this.planDive(guessTarget(target, power, forced));
    this.delay = forced ? 0.12 : 0.1 + Math.random() * 0.08;
    this.t = 0;
    this.phase = "wait";
  }

  update(dt, time) {
    const r = this.rig, rest = this.halfH;
    if (this.phase === "idle" || this.phase === "set") {
      this.crouch = THREE.MathUtils.damp(this.crouch, this.phase === "set" ? 1 : 0, 6, dt);
      const sway = Math.sin(time * 1.3) * 0.18 * (1 - this.crouch * 0.6);
      const bob = Math.abs(Math.sin(time * 2.6)) * 0.025 * (1 - this.crouch);
      r.position.set(this.base.x + sway, rest + bob - this.crouch * 0.08, this.base.z);
      r.rotation.set(0, Math.sin(time * 0.7) * 0.05, Math.sin(time * 1.3) * 0.02);
      r.scale.set(1, 1 - this.crouch * 0.035, 1);
    } else if (this.phase === "wait") {
      this.delay -= dt;
      if (this.delay <= 0) this.phase = "dive";
    } else if (this.phase === "dive") {
      this.t = Math.min(1, this.t + dt / 0.46);
      const k = easeOut(this.t), f = this.from, to = this.to;
      r.position.x = THREE.MathUtils.lerp(f.x, to.x, k);
      r.position.y = THREE.MathUtils.lerp(f.y, to.y, k) + Math.sin(Math.PI * this.t) * 0.22;
      r.rotation.z = THREE.MathUtils.lerp(f.rz, to.rz, k);
      r.rotation.y = THREE.MathUtils.lerp(r.rotation.y, 0, k);
      r.scale.y = THREE.MathUtils.lerp(r.scale.y, 1, k);
      if (this.t >= 1) {
        this.phase = "land";
        this.t = 0;
        this.from = { x: r.position.x, y: r.position.y, rz: r.rotation.z };
      }
    } else if (this.phase === "land") {
      this.t = Math.min(1, this.t + dt / 0.38);
      const k = this.t * this.t;
      const lying = Math.abs(this.from.rz) > 0.6;
      r.position.y = THREE.MathUtils.lerp(this.from.y, lying ? 0.24 : rest, k);
      r.rotation.z = THREE.MathUtils.lerp(this.from.rz, lying ? Math.sign(this.from.rz) * Math.PI / 2 : 0, k);
    }
  }

  hits(pos, r) {
    this.rig.updateMatrixWorld();
    const local = this.rig.worldToLocal(tmpA.copy(pos));
    return this.box.clone().expandByScalar(r + 0.04).containsPoint(local);
  }

  center(out) { return out.copy(this.rig.position); }

  reset() {
    this.phase = "idle";
    this.crouch = 0;
    this.rig.rotation.set(0, 0, 0);
    this.rig.scale.set(1, 1, 1);
    this.rig.position.set(this.base.x, this.halfH, this.base.z);
  }

  dispose() {
    this.rig.remove(this.wrap);
    this.rig.rotation.set(0, 0, 0);
    this.rig.scale.set(1, 1, 1);
  }
}

// ---------------------------------------------------------------------------
// Placeholder figure (used until a model loads)
// ---------------------------------------------------------------------------
function buildFallback() {
  const g = new THREE.Group();
  const shirt = new THREE.MeshStandardMaterial({ color: 0x1f6fe0, roughness: 0.7 });
  const black = new THREE.MeshStandardMaterial({ color: 0x111214, roughness: 0.8 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xc89a7a, roughness: 0.6 });
  const neon = new THREE.MeshStandardMaterial({ color: 0xd4f22a, roughness: 0.5, emissive: 0x2a3300 });
  const glove = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.6 });
  const add = (geo, mat, x, y, z, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.z = rz;
    g.add(m);
  };
  const cap = (r, l) => new THREE.CapsuleGeometry(r, l, 6, 14);
  for (const s of [-1, 1]) {
    add(cap(0.075, 0.36), black, s * 0.13, 0.32, 0, s * -0.05);
    add(cap(0.085, 0.32), skin, s * 0.12, 0.72, 0, s * -0.04);
    add(new THREE.BoxGeometry(0.11, 0.07, 0.26), neon, s * 0.14, 0.035, 0.05);
  }
  add(new THREE.BoxGeometry(0.42, 0.26, 0.24), black, 0, 0.93, 0);
  add(cap(0.19, 0.38), shirt, 0, 1.28, 0);
  add(cap(0.06, 0.05), skin, 0, 1.6, 0);
  add(new THREE.SphereGeometry(0.115, 24, 18), skin, 0, 1.75, 0.01);
  add(new THREE.SphereGeometry(0.118, 24, 18, 0, Math.PI * 2, 0, Math.PI / 2.2), black, 0, 1.77, -0.005);
  for (const s of [-1, 1]) {
    add(cap(0.06, 0.26), shirt, s * 0.3, 1.32, 0.02, s * 0.55);
    add(cap(0.055, 0.24), shirt, s * 0.44, 1.07, 0.08, s * 0.25);
    add(new THREE.BoxGeometry(0.12, 0.17, 0.08), glove, s * 0.5, 0.88, 0.12, s * 0.2);
  }
  return g;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export function createKeeper(scene, { urls, rotY = 0, base, perfect = false }) {
  perfectRead = perfect;
  const rig = new THREE.Group();
  scene.add(rig);
  let impl = new StaticKeeper(rig, base, buildFallback(), 0);

  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const tryLoad = (i) => {
    if (i >= urls.length) return console.info("[keeper] no model found — using placeholder");
    loader.load(
      urls[i],
      (gltf) => {
        impl.dispose();
        const rigged = gltf.animations.length > 0;
        impl = rigged ? new AnimatedKeeper(rig, base, gltf, rotY) : new StaticKeeper(rig, base, gltf.scene, rotY);
        console.info(`[keeper] ${urls[i]} (${rigged ? "animated: " + gltf.animations.map((a) => a.name).join(", ") : "static"})`);
      },
      undefined,
      () => tryLoad(i + 1)
    );
  };
  tryLoad(0);

  return {
    rig,
    get animated() { return impl instanceof AnimatedKeeper; },
    get impl() { return impl; },
    setReady: (on) => impl.setReady(on),
    decide: (target, power, timeToGoal, forced = null) => impl.decide(target, power, timeToGoal, forced),
    update: (dt, time) => impl.update(dt, time),
    hits: (pos, r) => impl.hits(pos, r),
    center: (out) => impl.center(out),
    get catching() { return !!impl.catching; },
    hands: (out) => (impl.hands ? impl.hands(out) : impl.center(out)),
    reset: () => impl.reset(),
  };
}
