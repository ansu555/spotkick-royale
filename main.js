import * as THREE from "three";
import { createKeeper } from "./keeper.js";
import { createRoyale } from "./royale.js";
import { createCasino } from "./casino.js";
import { createNet } from "./net/index.js";
import * as sfx from "./audio.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const params = new URLSearchParams(location.search);
const KEEPER_URLS = params.has("keeper") ? [params.get("keeper")] : ["assets/goalkeeper_rigged.glb", "assets/goalkeeper.glb"];
const KEEPER_ROT = THREE.MathUtils.degToRad(Number(params.get("rot") ?? 0));
const ROYALE = (params.get("mode") ?? "royale") !== "solo";
const QUALITY = params.get("q") ?? (matchMedia("(pointer: coarse)").matches ? "low" : "high");

const GOAL_HALF_W = 3.66;
const GOAL_H = 2.44;
const POST_R = 0.06;
const NET_DEPTH = 2.0;
const BALL_R = 0.11;
const SPOT = new THREE.Vector3(0, BALL_R, 11);
const KEEPER_Z = -0.25;
const GRAVITY = new THREE.Vector3(0, -9.81, 0);
const ROUNDS = 10;

const CAM_BASE = new THREE.Vector3(0, 1.15, 15.2);
const CAM_LOOK = new THREE.Vector3(0, 0.5, 0);
const BASE_FOV = 28;

// ---------------------------------------------------------------------------
// Renderer / scene
// ---------------------------------------------------------------------------
const canvas = document.getElementById("scene");
// the 3D view fills #stage (the casino shell may take space around it)
const stage = document.getElementById("stage");
// fall back to the window if #stage has no size yet (e.g. a stale cached stylesheet)
const VW = () => stage.clientWidth || innerWidth;
const VH = () => stage.clientHeight || innerHeight;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(devicePixelRatio, QUALITY === "high" ? 2 : 1.5));
renderer.setSize(VW(), VH());
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
scene.fog = new THREE.FogExp2(0x000000, 0.028);

const camera = new THREE.PerspectiveCamera(BASE_FOV, VW() / VH(), 0.05, 120);
camera.position.copy(CAM_BASE);
camera.lookAt(CAM_LOOK);

// ---------------------------------------------------------------------------
// Lighting — dark studio, soft overhead banks, rim from behind the goal
// ---------------------------------------------------------------------------
scene.add(new THREE.HemisphereLight(0x9fb8c8, 0x0a1a0a, 0.08));

function spot(color, intensity, pos, target, angle, penumbra, shadow = false) {
  const l = new THREE.SpotLight(color, intensity, 0, angle, penumbra, 2);
  l.position.copy(pos);
  l.target.position.copy(target);
  scene.add(l, l.target);
  if (shadow) {
    l.castShadow = true;
    l.shadow.mapSize.set(QUALITY === "high" ? 2048 : 1024, QUALITY === "high" ? 2048 : 1024);
    l.shadow.bias = -0.0002;
    l.shadow.normalBias = 0.02;
    l.shadow.radius = 6;
    l.shadow.camera.near = 2;
    l.shadow.camera.far = 30;
  }
  return l;
}

// key: big soft bank over the goal mouth
const keyLight = spot(0xfff4e6, 520, new THREE.Vector3(0, 10, 4.5), new THREE.Vector3(0, 0, -0.4), 0.62, 0.9, true);
// fill over the penalty area / ball
spot(0xeef4ff, 160, new THREE.Vector3(0, 8, 10.5), new THREE.Vector3(0, 0, 9), 0.75, 1.0);
// soft frontal fill from behind the taker so the ball face reads
spot(0xfff6ea, 30, new THREE.Vector3(0.6, 2.2, 16.5), SPOT, 0.35, 1.0);
// wide wash so the pitch fades instead of cutting off
spot(0xdfe9ff, 140, new THREE.Vector3(0, 14, 6), new THREE.Vector3(0, 0, 4), 0.9, 1.0);
// rim lights from behind the goal for edge separation on keeper + posts
spot(0xbcd6ff, 120, new THREE.Vector3(-5, 5.5, -5), new THREE.Vector3(0, 1, 0), 0.5, 0.8);
spot(0xbcd6ff, 120, new THREE.Vector3(5, 5.5, -5), new THREE.Vector3(0, 1, 0), 0.5, 0.8);

// ---------------------------------------------------------------------------
// Procedural textures
// ---------------------------------------------------------------------------
function rand(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function makePitchTexture() {
  // 40 m x 40 m, mowing stripes parallel to the goal line
  const S = 2048;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d");
  const r = rand(7);
  const stripe = S / 16;
  for (let i = 0; i < 16; i++) {
    g.fillStyle = i % 2 ? "#2f702c" : "#285f26";
    g.fillRect(0, i * stripe, S, stripe);
  }
  // blade noise
  for (let i = 0; i < 260000; i++) {
    const x = r() * S, y = r() * S;
    const l = 20 + r() * 16;
    g.fillStyle = `hsla(${100 + r() * 18}, ${40 + r() * 20}%, ${l}%, ${0.2 + r() * 0.3})`;
    g.fillRect(x, y, 1 + r() * 1.5, 2 + r() * 3);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

function makeNetTexture() {
  const S = 128;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d");
  g.clearRect(0, 0, S, S);
  g.strokeStyle = "#fff";
  g.lineWidth = 7;
  g.beginPath();
  // diamond mesh
  g.moveTo(0, S / 2); g.lineTo(S / 2, 0); g.lineTo(S, S / 2); g.lineTo(S / 2, S); g.closePath();
  g.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

function makeBallTexture() {
  // truncated-icosahedron panels traced per-pixel on an equirect map
  const W = 1024, H = 512;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d");
  const img = g.createImageData(W, H);
  const phi = (1 + Math.sqrt(5)) / 2;
  const pent = [], hex = [];
  for (const [a, b] of [[1, phi], [-1, phi], [1, -phi], [-1, -phi]]) {
    pent.push([0, a, b], [a, b, 0], [b, 0, a]);
  }
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) hex.push([x, y, z]);
  for (const [a, b] of [[1 / phi, phi], [-1 / phi, phi], [1 / phi, -phi], [-1 / phi, -phi]]) {
    hex.push([0, a, b], [a, b, 0], [b, 0, a]);
  }
  const norm = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };
  // face-plane distances for a truncated icosahedron (edge = 1)
  const faces = [
    ...pent.map((v) => ({ n: norm(v), h: 2.32744, p: true })),
    ...hex.map((v) => ({ n: norm(v), h: 2.26728, p: false })),
  ];
  for (let j = 0; j < H; j++) {
    const th = (j / H) * Math.PI;
    for (let i = 0; i < W; i++) {
      const ph = (i / W) * Math.PI * 2;
      const d = [-Math.cos(ph) * Math.sin(th), Math.cos(th), Math.sin(ph) * Math.sin(th)];
      let best = -1, second = -1, bp = false;
      for (const f of faces) {
        const s = (d[0] * f.n[0] + d[1] * f.n[1] + d[2] * f.n[2]) / f.h;
        if (s > best) { second = best; best = s; bp = f.p; } else if (s > second) second = s;
      }
      const seam = (best - second) * 2.3 < 0.006;
      let col = bp ? [22, 24, 30] : [238, 238, 234];
      if (seam) col = [90, 90, 92];
      const k = (j * W + i) * 4;
      img.data[k] = col[0]; img.data[k + 1] = col[1]; img.data[k + 2] = col[2]; img.data[k + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// ---------------------------------------------------------------------------
// Pitch
// ---------------------------------------------------------------------------
const pitch = new THREE.Mesh(
  new THREE.PlaneGeometry(40, 40),
  new THREE.MeshStandardMaterial({ map: makePitchTexture(), roughness: 0.92, metalness: 0 })
);
pitch.rotation.x = -Math.PI / 2;
pitch.position.z = 8;
pitch.receiveShadow = true;
scene.add(pitch);

// painted lines (goal line, six-yard box, penalty spot)
const lineMat = new THREE.MeshStandardMaterial({ color: 0xe9ece6, roughness: 0.85 });
const LINE_W = 0.12;
const lineRects = []; // for colouring grass blades over the paint
function line(x, z, w, d) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), lineMat);
  m.rotation.x = -Math.PI / 2;
  m.position.set(x, 0.004, z);
  m.receiveShadow = true;
  scene.add(m);
  lineRects.push([x - w / 2, x + w / 2, z - d / 2, z + d / 2]);
}
line(0, 0, 40, LINE_W); // goal line
line(-9.16, 2.75, LINE_W, 5.5);
line(9.16, 2.75, LINE_W, 5.5);
line(0, 5.5, 18.32 + LINE_W, LINE_W);
{
  const s = new THREE.Mesh(new THREE.CircleGeometry(0.11, 24), lineMat);
  s.rotation.x = -Math.PI / 2;
  s.position.set(0, 0.004, SPOT.z);
  scene.add(s);
}

// instanced turf blades — gives the close-up grass real depth
{
  const count = QUALITY === "high" ? 240000 : 90000;
  const blade = new THREE.BufferGeometry();
  blade.setAttribute("position", new THREE.Float32BufferAttribute([-0.0045, 0, 0, 0.0045, 0, 0, 0, 1, 0], 3));
  // two-sided via a mirrored triangle (DoubleSide would flip the normal and turn back faces black);
  // normals point up so every blade shades like turf
  blade.setAttribute("normal", new THREE.Float32BufferAttribute([0, 1, 0.15, 0, 1, 0.15, 0, 1, 0.3], 3));
  blade.setIndex([0, 1, 2, 0, 2, 1]);
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.62 });
  const mesh = new THREE.InstancedMesh(blade, mat, count);
  // thin blades self-shadow into black acne; the pitch underneath carries the shadows
  mesh.receiveShadow = false;
  const r = rand(42);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  const p = new THREE.Vector3(), s = new THREE.Vector3();
  const col = new THREE.Color();
  for (let i = 0; i < count; i++) {
    // denser toward the camera where blades are actually resolvable
    const z = 15.5 - Math.pow(r(), 1.6) * 16.5;
    const spread = 2.5 + (15.5 - z) * 0.55;
    const x = (r() * 2 - 1) * spread;
    p.set(x, 0, z);
    e.set((r() - 0.5) * 0.9, r() * Math.PI, (r() - 0.5) * 0.9);
    q.setFromEuler(e);
    const h = 0.018 + r() * 0.03;
    s.set(1, h, 1);
    m.compose(p, q, s);
    mesh.setMatrixAt(i, m);
    const onLine = lineRects.some(([x0, x1, z0, z1]) => x > x0 && x < x1 && z > z0 && z < z1)
      || Math.hypot(x, z - SPOT.z) < 0.11;
    const band = Math.floor((z - 8 + 20) / 2.5) % 2;
    if (onLine) col.setHSL(0.25, 0.08, 0.78 + r() * 0.1);
    else col.setHSL(0.27 + r() * 0.04, 0.42 + r() * 0.15, (band ? 0.2 : 0.17) + r() * 0.06);
    mesh.setColorAt(i, col);
  }
  scene.add(mesh);
}

// ---------------------------------------------------------------------------
// Goal frame + net
// ---------------------------------------------------------------------------
const postMat = new THREE.MeshStandardMaterial({ color: 0xf4f4f2, roughness: 0.28, metalness: 0.25 });
const frameMat = new THREE.MeshStandardMaterial({ color: 0x8a8d90, roughness: 0.5, metalness: 0.6 });

function bar(a, b, r, mat, shadow = true) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, dir.length(), 24), mat);
  m.position.copy(a).addScaledVector(dir, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  m.castShadow = shadow;
  m.receiveShadow = true;
  scene.add(m);
  return m;
}
const PX = GOAL_HALF_W + POST_R;
const BY = GOAL_H + POST_R;
bar(new THREE.Vector3(-PX, 0, 0), new THREE.Vector3(-PX, BY + POST_R, 0), POST_R, postMat);
bar(new THREE.Vector3(PX, 0, 0), new THREE.Vector3(PX, BY + POST_R, 0), POST_R, postMat);
bar(new THREE.Vector3(-PX - POST_R, BY, 0), new THREE.Vector3(PX + POST_R, BY, 0), POST_R, postMat);
// back stanchions
const D = -NET_DEPTH;
bar(new THREE.Vector3(-PX, 0, D), new THREE.Vector3(PX, 0, D), 0.025, frameMat);
bar(new THREE.Vector3(-PX, 0, 0), new THREE.Vector3(-PX, 0, D), 0.025, frameMat);
bar(new THREE.Vector3(PX, 0, 0), new THREE.Vector3(PX, 0, D), 0.025, frameMat);
bar(new THREE.Vector3(-PX, 0, D), new THREE.Vector3(-PX, BY, D + 0.6), 0.025, frameMat);
bar(new THREE.Vector3(PX, 0, D), new THREE.Vector3(PX, BY, D + 0.6), 0.025, frameMat);
bar(new THREE.Vector3(-PX, BY, 0), new THREE.Vector3(-PX, BY, D + 0.6), 0.025, frameMat);
bar(new THREE.Vector3(PX, BY, 0), new THREE.Vector3(PX, BY, D + 0.6), 0.025, frameMat);
bar(new THREE.Vector3(-PX, BY, D + 0.6), new THREE.Vector3(PX, BY, D + 0.6), 0.025, frameMat);

const netTex = makeNetTexture();
const CELL = 0.14;
function netMaterial(w, h, opacity = 0.75) {
  const t = netTex.clone();
  t.needsUpdate = true;
  t.repeat.set(w / CELL, h / CELL);
  return new THREE.MeshStandardMaterial({
    color: 0xd8d8d4, alphaMap: t, transparent: true, opacity, depthWrite: false,
    side: THREE.DoubleSide, roughness: 0.9,
  });
}

// back net is subdivided so it can bulge when the ball hits it
const backW = PX * 2, backH = BY;
const backGeo = new THREE.PlaneGeometry(backW, backH, 48, 18);
const backNet = new THREE.Mesh(backGeo, netMaterial(backW, backH));
backNet.position.set(0, backH / 2, D);
scene.add(backNet);
const backRest = backGeo.attributes.position.array.slice();
// the back net slopes from the ground to the top stanchion
function backNetZ(localY) {
  const t = (localY + backH / 2) / backH;
  return t * 0.6;
}
{
  const a = backGeo.attributes.position;
  for (let i = 0; i < a.count; i++) {
    const z = backNetZ(a.getY(i));
    a.setZ(i, z);
    backRest[i * 3 + 2] = z;
  }
  a.needsUpdate = true;
}

function netPlane(w, h, pos, rotY = 0, rotX = 0) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), netMaterial(w, h));
  m.position.copy(pos);
  m.rotation.set(rotX, rotY, 0, "YXZ");
  scene.add(m);
  return m;
}
// roof
{
  const depth = NET_DEPTH - 0.6;
  netPlane(backW, depth, new THREE.Vector3(0, BY, -depth / 2), 0, -Math.PI / 2);
}
// side nets (trapezoids)
for (const sx of [-1, 1]) {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(NET_DEPTH, 0);
  shape.lineTo(NET_DEPTH - 0.6, BY);
  shape.lineTo(0, BY);
  shape.closePath();
  const geo = new THREE.ShapeGeometry(shape);
  // map UVs in metres so the mesh cells match the other panels
  const uv = geo.attributes.uv;
  const pos = geo.attributes.position;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i) / NET_DEPTH, pos.getY(i) / BY);
  const mesh = new THREE.Mesh(geo, netMaterial(NET_DEPTH, BY));
  mesh.rotation.y = Math.PI / 2;
  mesh.position.set(sx * PX, 0, 0);
  scene.add(mesh);
}

// dark fence net far behind — reads as depth in the void
{
  const w = 40, h = 9;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), netMaterial(w * 1.6, h * 1.6, 0.12));
  m.material.color.set(0x5a6a74);
  m.position.set(0, h / 2, -7);
  scene.add(m);
}

// ---------------------------------------------------------------------------
// Ball
// ---------------------------------------------------------------------------
const ball = new THREE.Mesh(
  new THREE.SphereGeometry(BALL_R, 64, 48),
  new THREE.MeshStandardMaterial({ map: makeBallTexture(), roughness: 0.38, metalness: 0 })
);
ball.castShadow = true;
ball.receiveShadow = true;
scene.add(ball);

// ---------------------------------------------------------------------------
// Keeper — rigged + animated if assets/goalkeeper_rigged.glb exists, else the static mesh
// ---------------------------------------------------------------------------
const keeper = createKeeper(scene, {
  urls: KEEPER_URLS,
  rotY: KEEPER_ROT,
  base: new THREE.Vector3(0, 0, KEEPER_Z),
  perfect: params.has("perfectkeeper"),
});

// ---------------------------------------------------------------------------
// Post-processing: bloom + vignette / grain / slight chromatic aberration
// ---------------------------------------------------------------------------
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(VW(), VH()), 0.32, 0.55, 0.88);
composer.addPass(bloom);
composer.addPass(new OutputPass());
const filmPass = new ShaderPass({
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uVignette: { value: 1.15 },
    uGrain: { value: 0.045 },
    uCA: { value: 0.0012 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime, uVignette, uGrain, uCA;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 d = vUv - 0.5;
      float r2 = dot(d, d);
      vec2 off = d * uCA * (1.0 + r2 * 4.0);
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + off).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - off).b;
      col *= 1.0 - smoothstep(0.18, 0.75, r2 * uVignette);
      col += (hash(vUv * 1000.0 + uTime) - 0.5) * uGrain;
      gl_FragColor = vec4(col, 1.0);
    }
  `,
});
composer.addPass(filmPass);

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const reticle = $("reticle");
const powerArc = reticle.querySelector(".power");
const banner = $("banner");
const hint = $("hint");
const fade = $("fade");
const ARC = 2 * Math.PI * 26;

const HEX = "M32 2 L58 17 L58 47 L32 62 L6 47 L6 17 Z";
function renderRounds() {
  if (ROYALE) return; // royale draws its own tracker
  const el = $("rounds");
  el.innerHTML = "";
  for (let i = 0; i < ROUNDS; i++) {
    const done = i < game.results.length;
    const final = i === ROUNDS - 1;
    const cls = ["round"];
    if (done) cls.push("done", game.results[i] ? "goal" : "miss");
    else cls.push("next");
    if (final) cls.push("final");
    if (i === game.results.length && game.state !== "over") cls.push("current");
    const label = final ? "FINAL" : `ROUND ${i + 1}`;
    const shape = done ? `<circle class="shape" cx="32" cy="32" r="29" stroke-width="2"/>` : `<path class="shape" d="${HEX}" stroke-width="2"/>`;
    const d = document.createElement("div");
    d.className = cls.join(" ");
    d.innerHTML = `<svg viewBox="0 0 64 64">${shape}<text x="32" y="32" style="font-size:${final ? 14 : 11.5}px">${label}</text></svg>`;
    el.appendChild(d);
  }
  $("score-you").textContent = game.goals;
  $("score-gk").textContent = game.saves;
}

function showBanner(kind, text) {
  banner.className = kind;
  banner.firstElementChild.textContent = text;
  requestAnimationFrame(() => banner.classList.add("show"));
}
function hideBanner() { banner.className = ""; }

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------
const game = {
  state: "aim", // aim | charging | flight | result | over
  power: 0,
  goals: 0,
  saves: 0,
  results: [],
  aim: new THREE.Vector3(0, 1.2, 0),
  aimNdc: new THREE.Vector2(0, 0.1),
  vel: new THREE.Vector3(),
  decided: false,
  forced: null, // royale: on-chain verdict the shot must end in
  outcome: null,
  hitPost: false,
  resultTimer: 0,
  timeScale: 1,
  shotTime: 0,
};

const raycaster = new THREE.Raycaster();
const goalPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

function updateAimFromPointer(e) {
  const r = canvas.getBoundingClientRect();
  game.aimNdc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
}

function computeAim() {
  raycaster.setFromCamera(game.aimNdc, camera);
  const hit = new THREE.Vector3();
  if (raycaster.ray.intersectPlane(goalPlane, hit)) {
    hit.x = THREE.MathUtils.clamp(hit.x, -5.5, 5.5);
    hit.y = THREE.MathUtils.clamp(hit.y, 0.12, 3.6);
    game.aim.copy(hit);
  }
}

canvas.addEventListener("pointermove", updateAimFromPointer);
canvas.addEventListener("pointerdown", (e) => {
  updateAimFromPointer(e);
  if (ROYALE) {
    computeAim();
    royale.pointerDown(game.aim);
    return;
  }
  if (game.state === "over") return restart();
  if (game.state !== "aim") return;
  canvas.setPointerCapture(e.pointerId);
  game.state = "charging";
  game.power = 0;
  keeper.setReady(true);
  hint.classList.add("hidden");
});
canvas.addEventListener("pointerup", () => {
  if (game.state === "charging") shoot();
});
addEventListener("keydown", (e) => {
  if (!ROYALE && e.code === "Space" && game.state === "aim") {
    game.state = "charging"; game.power = 0; keeper.setReady(true); hint.classList.add("hidden");
  }
});
addEventListener("keyup", (e) => {
  if (e.code === "Space" && game.state === "charging") shoot();
});

function shoot() {
  const p = game.power;
  const target = game.aim.clone();
  // under-hit drops, over-hit sprays
  let err = 0.12;
  if (p > 0.9) err += (p - 0.9) * 4.5;
  if (p < 0.35) { err += (0.35 - p) * 1.2; target.y -= (0.35 - p) * 2.2; }
  const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * err;
  target.x += Math.cos(a) * rr;
  target.y += Math.sin(a) * rr * 1.3 + (p > 1 ? (p - 1) * 2.5 : 0);
  target.y = Math.max(target.y, BALL_R);
  shootAt(target, p);
}

// `forced` ('goal' | 'saved') is the multiplayer path: the contract already decided, so the keeper and ball
// are scripted to end in exactly that outcome. Physics only animates; it never decides in royale mode.
function shootAt(target, p, forced = null) {
  sfx.play("kick", { rate: 0.95 + Math.random() * 0.1 });
  sfx.play("whoosh", { delay: 0.05, vol: 0.6 + 0.4 * Math.min(p, 1) });
  sfx.duck(1, 0.3);
  const speed = 15 + 15 * Math.min(p, 1);
  const T = ball.position.distanceTo(target) / speed;
  game.vel.copy(target).sub(ball.position).addScaledVector(GRAVITY, -0.5 * T * T).divideScalar(T);
  game.state = "flight";
  game.decided = false;
  game.outcome = null;
  game.hitPost = false;
  game.held = false;
  game.shotTime = 0;
  game.forced = forced;
  reticle.classList.add("hidden");
  keeper.decide(target, p, (ball.position.z - KEEPER_Z) / Math.max(-game.vel.z, 1), forced);
}

function decide(outcome) {
  if (game.decided) return;
  if (game.forced) outcome = game.forced; // scripted shot: the on-chain verdict always wins over geometry
  game.decided = true;
  game.outcome = outcome;
  game.resultTimer = 0;
  if (outcome === "goal") sfx.play("crowd_goal");
  else sfx.play("crowd_save", { vol: outcome === "saved" ? 1 : 0.7 });
  sfx.duck(0.4, 1.2);
  if (ROYALE) {
    if (outcome === "goal") flash = 1;
    royale.onOutcome(outcome);
    return;
  }
  if (outcome === "goal") {
    game.goals++;
    showBanner("goal", "GOAL");
    flash = 1;
  } else if (outcome === "saved") {
    game.saves++;
    showBanner("saved", "SAVED");
  } else {
    showBanner("miss", game.hitPost ? "POST" : "MISS");
  }
  game.results.push(outcome === "goal");
  renderRounds();
}

let netImpact = null; // { x, y, amp }
let flash = 0;

function updateBall(dt) {
  if (game.state !== "flight" && game.state !== "result") return;
  if (game.held) {
    keeper.hands(ball.position).z += BALL_R * 0.6;
    return;
  }
  const v = game.vel;
  const prev = ball.position.clone();
  v.addScaledVector(GRAVITY, dt);
  v.multiplyScalar(1 - 0.02 * dt); // drag
  ball.position.addScaledVector(v, dt);
  const pos = ball.position;

  // spin
  const sp = v.length();
  if (sp > 0.01) {
    const axis = new THREE.Vector3(v.z, 0, -v.x).normalize();
    if (axis.lengthSq() > 0) ball.rotateOnWorldAxis(axis, (sp * dt) / BALL_R);
  }

  // posts / crossbar
  for (const sx of [-1, 1]) {
    const dx = pos.x - sx * PX, dz = pos.z;
    const d = Math.hypot(dx, dz);
    if (pos.y < BY + POST_R && d < POST_R + BALL_R) {
      const n = new THREE.Vector3(dx, 0, dz).normalize();
      pos.x = sx * PX + n.x * (POST_R + BALL_R);
      pos.z = n.z * (POST_R + BALL_R);
      v.reflect(n).multiplyScalar(0.62);
      if (!game.hitPost) sfx.play("post_clang");
      game.hitPost = true;
    }
  }
  {
    const dy = pos.y - BY, dz = pos.z;
    const d = Math.hypot(dy, dz);
    if (Math.abs(pos.x) < PX + POST_R && d < POST_R + BALL_R) {
      const n = new THREE.Vector3(0, dy, dz).normalize();
      pos.y = BY + n.y * (POST_R + BALL_R);
      pos.z = n.z * (POST_R + BALL_R);
      v.reflect(n).multiplyScalar(0.62);
      if (!game.hitPost) sfx.play("post_clang");
      game.hitPost = true;
    }
  }

  // keeper contact. Scripted shots: a forced goal ignores the keeper; a forced save always connects
  // (if the keeper's reach fell a little short, the ball is nudged onto the nearest glove at the line).
  let contact = false;
  if (!game.decided && pos.z < 1.2 && pos.z > -0.7 && game.forced !== "goal") {
    contact = keeper.hits(pos, BALL_R);
    if (!contact && game.forced === "saved" && pos.z <= 0.2) {
      keeper.hands(pos);
      pos.z += BALL_R * 0.6;
      contact = true;
    }
  }
  if (contact) {
    sfx.play("save_glove", { vol: keeper.catching ? 0.7 : 1 });
    if (keeper.catching) {
      game.held = true; // ball stays in the gloves for the rest of the clip
    } else {
      const away = new THREE.Vector3().subVectors(pos, keeper.center(new THREE.Vector3())).setZ(0).normalize();
      v.set(away.x * 3 + v.x * 0.2, 2.5 + Math.random() * 2, Math.abs(v.z) * 0.3 + 1.5); // cosmetic rebound
    }
    decide("saved");
  }

  // crossing the line
  if (!game.decided && prev.z >= -BALL_R && pos.z < -BALL_R) {
    const inMouth = Math.abs(pos.x) < GOAL_HALF_W - BALL_R * 0.2 && pos.y < GOAL_H;
    decide(game.forced ?? (inMouth ? "goal" : "miss"));
  }
  if (!game.decided && pos.z < -2 || (!game.decided && game.shotTime > 3)) decide("miss");

  // inside the net
  if (game.outcome === "goal") {
    const backZ = D + backNetZ(pos.y - backH / 2) + BALL_R;
    if (pos.z < backZ) {
      if (!netImpact) {
        netImpact = { x: pos.x, y: pos.y, amp: Math.min(0.55, Math.abs(v.z) * 0.025) };
        sfx.play("net_hit");
      }
      pos.z = backZ;
      v.z = Math.abs(v.z) * 0.08;
      v.x *= 0.3;
      v.y *= 0.3;
    }
    if (Math.abs(pos.x) > GOAL_HALF_W - BALL_R) { pos.x = Math.sign(pos.x) * (GOAL_HALF_W - BALL_R); v.x *= -0.2; }
    if (pos.y > GOAL_H - BALL_R) { pos.y = GOAL_H - BALL_R; v.y *= -0.2; }
  }

  // ground
  if (pos.y < BALL_R) {
    pos.y = BALL_R;
    if (v.y < 0) v.y *= -0.45;
    v.x *= 0.86; v.z *= 0.86;
  }
}

function updateNet(dt) {
  const a = backGeo.attributes.position;
  if (!netImpact) return;
  netImpact.amp *= Math.exp(-dt * 2.2);
  const wob = Math.cos(performance.now() * 0.012) * 0.25 + 0.75;
  for (let i = 0; i < a.count; i++) {
    const x = backRest[i * 3], y = backRest[i * 3 + 1] + backH / 2;
    const d2 = (x - netImpact.x) ** 2 + (y - netImpact.y) ** 2;
    a.setZ(i, backRest[i * 3 + 2] - netImpact.amp * wob * Math.exp(-d2 / 0.9));
  }
  a.needsUpdate = true;
  if (netImpact.amp < 0.002) {
    for (let i = 0; i < a.count; i++) a.setZ(i, backRest[i * 3 + 2]);
    a.needsUpdate = true;
    netImpact = null;
  }
}

function resetShot() {
  ball.position.copy(SPOT);
  ball.rotation.set(0.3, 0.8, 0);
  game.vel.set(0, 0, 0);
  game.held = false;
  game.forced = null;
  game.camCalm = false;
  sfx.duck(0, 1.5);
  if (ROYALE) {
    game.state = "idle";
    game.power = 0;
    keeper.reset();
    hideBanner();
    return;
  }
  game.state = game.results.length >= ROUNDS ? "over" : "aim";
  game.power = 0;
  keeper.reset();
  hideBanner();
  reticle.classList.toggle("hidden", game.state === "over");
  if (game.state === "over") {
    showBanner(game.goals >= 6 ? "goal" : "miss", `${game.goals} / ${ROUNDS}`);
    hint.textContent = "Click to play again";
    hint.classList.remove("hidden");
  }
  renderRounds();
}

function restart() {
  game.goals = 0;
  game.saves = 0;
  game.results = [];
  hint.textContent = "Aim with the cursor · Hold to power · Release to shoot";
  game.state = "aim";
  fade.classList.remove("clear");
  setTimeout(() => { resetShot(); fade.classList.add("clear"); }, 450);
}

// ---------------------------------------------------------------------------
// Camera direction
// ---------------------------------------------------------------------------
const camLook = CAM_LOOK.clone();
let camFov = BASE_FOV;

function baseFov() {
  // keep the whole goal mouth (+ margin) in frame on narrow screens
  const aspect = camera.aspect;
  // royale leaves room either side of the goal for its panels
  const needH = 2 * Math.atan((ROYALE ? 7.6 : 6.2) / CAM_BASE.z);
  const v = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(needH / 2) / aspect));
  return Math.max(BASE_FOV, v);
}

function updateCamera(dt, time) {
  const flying = (game.state === "flight" || game.state === "result") && !game.camCalm;
  const charging = game.state === "charging" || game.state === "focus";
  const base = baseFov();
  // handheld breathing
  const bx = Math.sin(time * 0.53) * 0.03 + Math.sin(time * 1.7) * 0.006;
  const by = Math.sin(time * 0.81) * 0.018 + Math.sin(time * 2.3) * 0.004;
  const push = flying ? Math.min(game.shotTime * 1.6, 1.2) : charging ? game.power * 0.25 : 0;
  camera.position.set(CAM_BASE.x + bx, CAM_BASE.y + by, CAM_BASE.z - push);

  const lookTarget = CAM_LOOK.clone();
  if (flying) lookTarget.lerp(ball.position, 0.22);
  // subtle parallax toward the aim point while aiming
  if (!flying) lookTarget.x += game.aim.x * 0.04;
  camLook.lerp(lookTarget, 1 - Math.exp(-dt * 4));
  camera.lookAt(camLook);

  const targetFov = flying ? base * 0.84 : charging ? base * (1 - game.power * 0.06) : base;
  camFov = THREE.MathUtils.damp(camFov, targetFov, 3.5, dt);
  if (Math.abs(camera.fov - camFov) > 1e-3) {
    camera.fov = camFov;
    camera.updateProjectionMatrix();
  }
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();
let time = 0;
const projected = new THREE.Vector3();

function tick() {
  simulate(Math.min(clock.getDelta(), 1 / 20));
  composer.render();
  requestAnimationFrame(tick);
}

function simulate(rawDt) {

  // slow motion as the ball reaches the keeper
  let wantScale = 1;
  if (game.state === "flight" && !game.decided && ball.position.z < 4.5) wantScale = 0.3;
  if (game.state === "result" && game.resultTimer < 0.5) wantScale = 0.45;
  game.timeScale = THREE.MathUtils.damp(game.timeScale, wantScale, 10, rawDt);
  const dt = rawDt * game.timeScale;
  time += rawDt;

  if (game.state === "charging") game.power = Math.min(game.power + rawDt / 1.05, 1.25);

  computeAim();
  if (game.state === "aim" || game.state === "charging" || (ROYALE && royaleReticle)) {
    projected.copy(game.aim).project(camera);
    const x = (projected.x * 0.5 + 0.5) * VW();
    const y = (-projected.y * 0.5 + 0.5) * VH();
    reticle.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%) scale(${1 - game.power * 0.15})`;
    powerArc.style.strokeDashoffset = ARC * (1 - Math.min(game.power, 1));
    reticle.classList.toggle("over", game.power > 0.92);
  }

  // sub-step the ball so fast shots don't tunnel through posts / keeper
  const steps = 4;
  for (let i = 0; i < steps; i++) updateBall(dt / steps);
  if (game.state === "flight") {
    game.shotTime += dt;
    if (game.decided) game.state = "result";
  }
  if (game.state === "result") {
    game.resultTimer += rawDt;
    if (!ROYALE && game.resultTimer > 2.6 && !fadingOut) {
      fadingOut = true;
      fade.classList.remove("clear");
      setTimeout(() => { resetShot(); fade.classList.add("clear"); fadingOut = false; }, 500);
    }
  }

  if (royale) royale.update(rawDt, time);
  keeper.update(dt, time);
  updateNet(dt);
  updateCamera(rawDt, time);

  flash = Math.max(0, flash - rawDt * 1.4);
  keyLight.intensity = 520 * (1 + flash * 0.6);
  bloom.strength = 0.32 + flash * 0.5;
  filmPass.uniforms.uTime.value = time;
}
let fadingOut = false;

new ResizeObserver(() => {
  if (!VW() || !VH()) return;
  camera.aspect = VW() / VH();
  camera.updateProjectionMatrix();
  renderer.setSize(VW(), VH());
  composer.setSize(VW(), VH());
}).observe(stage);

let royaleReticle = false;
const net = ROYALE ? createNet() : null;
const royale = ROYALE
  ? createRoyale({
      net,
      casino: createCasino(sfx, net),
      sfx,
      scene,
      hud: document.getElementById("hud"),
      game,
      keeper,
      shootAt,
      resetShot,
      setReticle: (on) => {
        royaleReticle = on;
        reticle.classList.toggle("hidden", !on);
      },
      // fade to black, run fn, fade back
      transition: (fn) => {
        fade.classList.remove("clear");
        setTimeout(() => { fn(); fade.classList.add("clear"); }, 480);
      },
    })
  : null;

if (params.has("debug")) window.__penalty = {
  game, ball, keeper, royale, sfx, net,
  step: (n, dt = 1 / 60) => { for (let i = 0; i < n; i++) simulate(dt); },

  // calibration hook ---------------------------------------------------------
  // Aim at goal-plane point (x, y), fire at `power`, run to a decision, return
  // the outcome string: "goal" | "saved" | "miss". Physics decides (forced = undefined).
  shoot: (x, y, power) => {
    game.results.length = 0;                 // keep solo mode off its 10-kick "over" path
    resetShot();
    shootAt(new THREE.Vector3(x, y, 0), power);
    let guard = 0;
    while (!game.decided && guard++ < 5000) simulate(1 / 60);
    return game.outcome;
  },
};

resetShot();
renderRounds();
requestAnimationFrame(() => fade.classList.add("clear"));
tick();
