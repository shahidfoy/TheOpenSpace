import * as THREE from 'three';
import { glowSprite } from './shaders.js';
import { instance, instanceChild, anchors, part } from './assets.js';
import { PBR, ROCK_NORMAL } from './materials.js';
import { buildMechRig, applyPose } from './mech/mechRig.js';
import { locoPose, newPose } from './mech/swordAnim.js';

// Hero assets come from Blender GLBs (blender/build_models.py); the procedural
// builders below are fallbacks with the same conventions (forward = +Z, up = +Y).
export const MAT = {
  hull: PBR.hull,
  hullDark: PBR.hullDark,
  hullLight: PBR.hullLight,
  hazard: PBR.yellow,
  accent: PBR.accent,
  panel: PBR.solar,
  glass: PBR.glass,
  foil: PBR.foil,
  window: PBR.window,
  cyan: PBR.cyan,
  magenta: PBR.magenta,
  amber: PBR.amber,
  red: PBR.red,
  engine: PBR.engine,
  white: new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffffff).multiplyScalar(3) }),
};

// Exhaust: soft additive cone, white-hot at the nozzle, fading and flickering toward the tip.
const PLUME_VERT = /* glsl */ `
varying vec2 vUv; varying float vFace;
void main(){
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 n = normalize(normalMatrix * normal);
  vFace = abs(dot(n, normalize(-mv.xyz)));
  gl_Position = projectionMatrix * mv;
}`;
const PLUME_FRAG = /* glsl */ `
uniform vec3 uColor; uniform float uThr; uniform float uTime;
varying vec2 vUv; varying float vFace;
void main(){
  float a = vUv.y;
  float flick = 0.82 + 0.18 * sin(uTime * 47.0 + a * 23.0) * sin(uTime * 31.0 + vUv.x * 40.0);
  float core = pow(1.0 - a, 3.0);
  float body = pow(1.0 - a, 1.3) * pow(vFace, 1.6);
  vec3 col = mix(uColor, vec3(1.0), core * 0.5) * (body + core * 0.35) * flick;
  gl_FragColor = vec4(col * uThr * 0.9, 1.0);
}`;
export function plumeMaterial(hex = 0x58b8ff) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(hex) }, uThr: { value: 0.3 }, uTime: { value: 0 } },
    vertexShader: PLUME_VERT, fragmentShader: PLUME_FRAG,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
}

const Y = new THREE.Vector3(0, 1, 0);
function mesh(geo, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  return m;
}
const box = (w, h, d, mat, x, y, z) => mesh(new THREE.BoxGeometry(w, h, d), mat, x, y, z);
function cylZ(rt, rb, len, seg, mat, x, y, z) {
  const m = mesh(new THREE.CylinderGeometry(rt, rb, len, seg), mat, x, y, z);
  m.rotation.x = Math.PI / 2;
  return m;
}
const cylY = (rt, rb, len, seg, mat, x, y, z) => mesh(new THREE.CylinderGeometry(rt, rb, len, seg), mat, x, y, z);
function strut(a, b, r, mat) {
  const d = b.clone().sub(a), m = mesh(new THREE.CylinderGeometry(r, r, d.length(), 8), mat);
  m.position.copy(a).addScaledVector(d, 0.5);
  m.quaternion.setFromUnitVectors(Y, d.normalize());
  return m;
}
function torus(r, t, mat, x = 0, y = 0, z = 0, rs = 8, ts = 48) {
  const m = mesh(new THREE.TorusGeometry(r, t, rs, ts), mat, x, y, z);
  m.rotation.x = Math.PI / 2;
  return m;
}

// Plume whose base sits on the nozzle and which stretches backward (-Z) when scaled on Y.
function plume(radius, length, hex) {
  const geo = new THREE.ConeGeometry(radius, length, 20, 1, true);
  geo.translate(0, length / 2, 0); // wide end (uv.y = 0) on the nozzle, tip (uv.y = 1) trailing
  const m = new THREE.Mesh(geo, plumeMaterial(hex));
  m.rotation.x = -Math.PI / 2;
  m.renderOrder = 2;
  return m;
}
function addPlumes(g, a, radius, length, hex) {
  const ex = [];
  for (const k in a) {
    if (!k.startsWith('exhaust')) continue;
    const p = plume(radius, length, hex);
    p.position.copy(a[k].position);
    ex.push(p);
    g.add(p);
  }
  g.userData.exhaust = ex;
}
export function setThrust(obj, thr, time) {
  for (const e of obj.userData.exhaust || []) {
    e.material.uniforms.uThr.value = thr;
    e.material.uniforms.uTime.value = time;
    e.scale.set(1, 0.35 + thr * 1.3, 1);
  }
}

// ---------------- skiff flight effects ----------------
// Navigation lights (red port, green starboard, white tail strobe) and attitude-thruster (RCS)
// puffs. Skiff frame: forward +Z, up +Y, its left +X. Each puff fires along `dir` and answers one
// rotation axis of the demand vector (x pitch nose-down +, y yaw nose-left +, z roll right-wing-down +).
const RCS = [
  // pitch: nose-top + tail-bottom push the nose down; nose-bottom + tail-top lift it
  [[0, 0.4, 3.3], [0, 1, 0], 'x', 1], [[0, -0.35, -3.6], [0, -1, 0], 'x', 1],
  [[0, -0.3, 3.3], [0, -1, 0], 'x', -1], [[0, 0.55, -3.6], [0, 1, 0], 'x', -1],
  // yaw: fire sideways at nose and tail in opposite directions
  [[-0.42, 0, 3.1], [-1, 0, 0], 'y', 1], [[0.6, 0.15, -3.6], [1, 0, 0], 'y', 1],
  [[0.42, 0, 3.1], [1, 0, 0], 'y', -1], [[-0.6, 0.15, -3.6], [-1, 0, 0], 'y', -1],
  // roll: up at one wingtip, down at the other
  [[-4.15, -0.1, -2.05], [0, 1, 0], 'z', 1], [[4.15, -0.55, -2.05], [0, -1, 0], 'z', 1],
  [[4.15, -0.1, -2.05], [0, 1, 0], 'z', -1], [[-4.15, -0.55, -2.05], [0, -1, 0], 'z', -1],
];
function addShipFX(g) {
  const nav = [
    [0xff3b3b, [4.25, -0.32, -2.05]], [0x3bff7a, [-4.25, -0.32, -2.05]], [0xffffff, [0, 0.95, -3.95]],
  ].map(([c, p]) => {
    const s = glowSprite(c, 1.1, 2.2);
    s.position.set(...p);
    g.add(s);
    return s;
  });
  const puffs = RCS.map(([p, dir, axis, sign]) => {
    const s = glowSprite(0xe8f0ff, 1, 1.4);
    s.position.set(...p).addScaledVector(new THREE.Vector3(...dir), 0.45);
    s.material.opacity = 0;
    g.add(s);
    return { s, base: s.position.clone(), dir: new THREE.Vector3(...dir), axis, sign };
  });
  g.userData.fx = { nav, puffs };
}
// rcs: what the attitude thrusters are fighting for this frame (rad/s per axis, ship frame)
export function updateShipFX(obj, time, rcs) {
  const fx = obj?.userData.fx;
  if (!fx) return;
  // steady red / green, double-flash white strobe every 1.3 s
  const ph = time % 1.3;
  fx.nav[0].material.opacity = fx.nav[1].material.opacity = 0.85;
  fx.nav[2].material.opacity = ph < 0.06 || (ph > 0.16 && ph < 0.22) ? 1 : 0;
  for (const p of fx.puffs) {
    const k = rcs ? THREE.MathUtils.clamp(p.sign * rcs[p.axis] * 0.7, 0, 1) : 0;
    p.s.material.opacity = k > 0.04 ? k * (0.55 + Math.random() * 0.45) : 0;
    const len = 0.5 + k * 1.6;
    p.s.scale.setScalar(0.35 + k * 0.9);
    p.s.position.copy(p.base).addScaledVector(p.dir, len * 0.5); // the gas jet streams out
  }
}

// ---------------- player skiff ----------------
export function makeSkiff() {
  const g = instance('skiff');
  if (!g) return skiffProc();
  const a = anchors(g);
  addPlumes(g, a, 0.36, 3.4);
  addShipFX(g);
  g.userData.muzzle = a.nose;
  const l = new THREE.PointLight(0xffc890, 3, 12, 2);
  l.position.set(0, 0.6, 4.4);
  g.add(l);
  return g;
}

// ---------------- player craft: the Vesper flight frame or the Kestrel skiff ----------------
export const CRAFTS = { frame: 'Vesper Exosuit', skiff: 'Kestrel Mk II' };
export function makeCraft(type) {
  return (type === 'skiff' ? null : makeFrame()) || makeSkiff();
}

// The Vesper exosuit: a pressure suit over a real human body (Blender Studio base mesh), split into
// rigid segments at the joints like a hard suit (pelvis > thigh > shin > foot, torso > head / arm >
// forearm) plus MMU thruster pods that swing off its life-support pack. Jets fire from the pods, the
// boot soles and the palms. Its pivot sits at the hips so it banks like a ship.
export function makeFrame() {
  const m = instance('frame');
  if (!m) return null;
  const g = new THREE.Group(), body = new THREE.Group();
  const hip = part(m, 'pelvis').position.y;
  m.position.y = -hip;
  body.add(m);
  g.add(body);
  const a = anchors(m), ex = [], jets = { pods: [], boots: [], palms: [] };
  const spec = [['exhaust_0', 'pods', 0.05, 0.9], ['exhaust_1', 'pods', 0.05, 0.9], ['exhaust_2', 'boots', 0.045, 1.1], ['exhaust_3', 'boots', 0.045, 1.1],
    ['exhaust_4', 'palms', 0.025, 0.5], ['exhaust_5', 'palms', 0.025, 0.5]];
  for (const [k, grp, r, len] of spec) {
    if (!a[k]) continue;
    const p = plume(r, len);
    a[k].add(p);
    ex.push(p);
    jets[grp].push(p);
  }
  g.userData.exhaust = ex;
  g.userData.jets = jets;
  g.userData.muzzle = a.muzzle;
  g.userData.body = body;
  g.userData.size = hip;
  g.userData.parts = Object.fromEntries(['torso', 'head', 'arm_L', 'arm_R', 'forearm_L', 'forearm_R', 'thigh_L', 'thigh_R', 'shin_L', 'shin_R', 'foot_L', 'foot_R', 'booster_L', 'booster_R']
    .map((n) => [n, part(m, n)]));
  const l = new THREE.PointLight(0x9fd4ff, 0.5, 3, 2); // thruster glow on the legs, clear of the pack
  l.position.set(0, -0.6, -1.2);
  g.add(l);
  return g;
}

// Damped spring (semi-implicit, sub-stepped): gives the pose weight, follow-through and a little
// overshoot instead of the robotic ease of a plain lerp. f = natural frequency (Hz), z = damping ratio.
function spring(st, key, target, dt, f, z) {
  const s = st[key] || (st[key] = { x: target, v: 0 });
  const w = 2 * Math.PI * f, n = Math.ceil(dt / 0.012), h = dt / n;
  for (let i = 0; i < n; i++) {
    s.v += (w * w * (target - s.x) - 2 * z * w * s.v) * h;
    s.x += s.v * h;
  }
  return s.x;
}
function setJets(list, thr, time) {
  for (const e of list) {
    e.material.uniforms.uThr.value = thr;
    e.material.uniforms.uTime.value = time;
    e.scale.set(1, 0.35 + thr * 1.3, 1);
  }
}

// Iron-Man-style flight, driven by the suit's actual motion (after Marvel Rivals' hover / cruise /
// Hyper-Velocity split and physics-driven lean: angle = atan2(acceleration, g)).
//  - Hover: upright on the boot jets, knees soft, arms a little out with palms down, gentle bob.
//  - Cruise: the body leans into acceleration and holds a forward lean against drag; it banks into
//    turns from the centripetal term (speed x turn rate); legs trail with inertia; head stays level.
//  - Braking: the body flares back, legs swing forward and both palms push ahead like air brakes.
//  - Strafing: the palm on the far side pushes out. Descending tucks the knees, climbing straightens.
//  - Hyper-velocity (boost): a straight head-first line, arms pinned back, every jet at full burn.
// c = { vel, acc } in the suit frame (x left, y up, z forward), turn (rad/s, + = right), input,
// lift, boost and aim flags.
export function poseFrame(g, c, dt, time) {
  const p = g.userData.parts;
  if (!p) return;
  const st = g.userData.st || (g.userData.st = {});
  const C = THREE.MathUtils.clamp, L = THREE.MathUtils.lerp, SS = THREE.MathUtils.smoothstep, G = 9.8;
  const vf = c.vel.z, vu = c.vel.y, af = c.acc.z, ar = -c.acc.x;
  const cruise = SS(vf, 4, 24);
  const dash = spring(st, 'dash', c.boost && vf > 10 ? 1 : 0, dt, 1.3, 0.8);
  const brake = C(-af / 18, 0, 1) * SS(vf, 2, 8);
  const calm = C(1 - Math.max(cruise, dash), 0, 1);
  const wc = cruise * (1 - dash), wh = 1 - Math.max(cruise, dash);

  // whole body: lean into acceleration + cruise lean, bank into turns and sideways pushes
  const pitchT = C(Math.atan2(af * 0.45, G) + cruise * 0.55, -0.6, 1.1);
  const P = spring(st, 'p', L(pitchT, 1.45, dash), dt, 1.7, 0.5);
  const B = spring(st, 'b', C(Math.atan2(Math.max(vf, 0) * c.turn * 0.5 + ar * 0.5, G), -1.0, 1.0), dt, 1.5, 0.5);
  const Ps = spring(st, 'ps', P, dt, 0.7, 0.9), Bs = spring(st, 'bs', B, dt, 0.7, 0.9);
  const body = g.userData.body;
  body.rotation.x = P;
  body.rotation.z = B;
  body.position.y = Math.sin(time * 1.3) * 0.025 * calm;

  const tuck = C(-vu / 8, 0, 1) * calm, reach = C(vu / 8, 0, 1);
  const push = C(ar / 14 + c.turn * 0.25, -1, 1); // + = moving / turning toward the suit's right (-x)
  const set = (o, ax, key, v, f = 2.4, z = 0.55) => { if (o) o.rotation[ax] = spring(st, key, v, dt, f, z); };
  for (const [s, sg, ph] of [['L', -1, 0], ['R', 1, 1.9]]) {
    const idle = Math.sin(time * 1.1 + ph) * 0.04 * calm;
    // legs: soft knees in a hover, trailing in cruise, pointed in a dash; inertia lags body motion
    const lagX = -(P - Ps) * 0.6, lagZ = (B - Bs) * 0.5;
    set(p[`thigh_${s}`], 'x', `tx${s}`, (0.1 + idle) * wh + 0.05 * wc - 0.6 * tuck - 0.35 * brake - 0.1 * reach + lagX, 1.6, 0.45);
    set(p[`thigh_${s}`], 'z', `tz${s}`, sg * (0.05 * wh + 0.01 * (1 - wh)) + lagZ, 1.6, 0.45);
    set(p[`shin_${s}`], 'x', `sx${s}`, (0.25 + idle * 0.6) * wh + 0.1 * wc + 0.05 * dash + 0.9 * tuck + 0.3 * brake - 0.15 * reach * wh, 1.8, 0.5);
    set(p[`foot_${s}`], 'x', `fx${s}`, 0.2 * wh + 0.55 * wc + 0.8 * dash, 1.8, 0.6);
    // pods: against the push in a hover, swung to fire along the body at speed
    set(p[`booster_${s}`], 'x', `bx${s}`, L(L(C(0.61 - c.lift * 0.8, -0.6, 1.2), 0.15, cruise), -1.3, dash), 2, 0.7);
    set(p[`booster_${s}`], 'z', `bz${s}`, -push * sg * 0.3, 2, 0.7);
    if (s === 'R' && c.aim) continue;
    // arms: stabilisers. Out with palms down in a hover, back along the sides at speed, forward to
    // brake; the far-side palm pushes out when strafing or carving
    const out = Math.max(0, sg * push) * 0.55;
    set(p[`arm_${s}`], 'x', `ax${s}`, (-0.1 + idle) * wh + 0.35 * wc + 0.2 * dash - 1.2 * brake + 0.3 * reach * wh);
    set(p[`arm_${s}`], 'z', `az${s}`, sg * (0.12 * wh - 0.15 * wc - 0.32 * dash + 0.1 * brake + out));
    set(p[`forearm_${s}`], 'x', `fax${s}`, -0.35 * wh - 0.15 * wc - 0.5 * brake - out * 0.4);
  }
  if (c.aim) {
    // laser arm levels out along the line of fire, like a palm blast
    set(p.arm_R, 'x', 'axR', -Math.PI / 2 - P + 0.1, 3, 0.7);
    set(p.arm_R, 'z', 'azR', -0.3, 3, 0.7);
    set(p.forearm_R, 'x', 'faxR', -0.05, 3, 0.7);
  }
  // head stays level and looks where the suit is going
  set(p.head, 'x', 'hx', -P * 0.8, 3, 0.8);
  set(p.head, 'z', 'hz', -B * 0.45, 3, 0.8);

  // each jet group throttles for its job
  const j = g.userData.jets;
  setJets(j.boots, C(0.4 * wh + 0.35 * C(c.lift, 0, 1) + 0.6 * wc * Math.max(0, c.input.y) + dash, 0.15, 1.1), time);
  setJets(j.palms, C(0.12 + Math.abs(push) * 0.7 + brake * 0.9 + dash * 0.6, 0, 1), time);
  setJets(j.pods, C(0.08 + 0.7 * cruise * Math.max(0, c.input.y) + dash + 0.4 * C(c.lift, 0, 1) * wh, 0, 1.1), time);
}

function skiffProc() {
  const g = new THREE.Group();
  g.add(cylZ(0.28, 0.55, 3.2, 8, MAT.hull, 0, 0, 0));
  const nose = mesh(new THREE.ConeGeometry(0.28, 0.9, 8), MAT.hullLight, 0, 0, 2.05);
  nose.rotation.x = Math.PI / 2;
  g.add(nose);
  for (const s of [-1, 1]) {
    g.add(box(1.9, 0.08, 1.3, MAT.hull, s * 1.15, -0.05, -0.45));
    g.add(cylZ(0.22, 0.27, 1.1, 10, MAT.hullDark, s * 0.48, 0, -1.55));
  }
  addPlumes(g, { exhaust_0: { position: new THREE.Vector3(-0.48, 0, -2.1) }, exhaust_1: { position: new THREE.Vector3(0.48, 0, -2.1) } }, 0.2, 1.8);
  g.userData.muzzle = new THREE.Object3D();
  g.userData.muzzle.position.set(0, -0.22, 2.2);
  g.add(g.userData.muzzle);
  return g;
}

// ---------------- hauler ----------------
export function makeHauler() {
  const g = instance('hauler');
  if (!g) return haulerProc();
  addPlumes(g, anchors(g), 0.5, 3.6);
  return g;
}

function haulerProc() {
  const g = new THREE.Group();
  g.add(box(0.8, 0.8, 12, MAT.hullDark, 0, 0, 0));
  g.add(box(2.4, 1.6, 2.4, MAT.hazard, 0, 0.2, 6.6));
  for (let i = 0; i < 4; i++) for (const s of [-1, 1]) g.add(box(1.5, 1.5, 2.2, MAT.accent, s * 1.2, 0, 3.4 - i * 2.5));
  addPlumes(g, { exhaust_0: { position: new THREE.Vector3(0, 0, -7) } }, 0.5, 3);
  return g;
}

// ---------------- seed ship ----------------
export function makeSeedShip() {
  const g = instance('seed');
  if (!g) return seedProc();
  addPlumes(g, anchors(g), 1.15, 5);
  return g;
}

function seedProc() {
  const g = new THREE.Group();
  g.add(mesh(new THREE.SphereGeometry(1.8, 20, 14), MAT.hullLight, 0, 0, 1));
  g.add(cylZ(0.5, 0.5, 6, 10, MAT.hullDark, 0, 0, -2));
  g.add(cylZ(0.9, 1.2, 1.4, 12, MAT.hull, 0, 0, -5.5));
  addPlumes(g, { exhaust_0: { position: new THREE.Vector3(0, 0, -6.2) } }, 1, 4);
  return g;
}

// ---------------- robot drone ----------------
export function makeDrone() {
  return instance('drone') || droneProc();
}

function droneProc() {
  const g = new THREE.Group();
  const b = new THREE.Mesh(new THREE.OctahedronGeometry(0.55, 0), MAT.hullLight);
  b.scale.set(1, 0.6, 1.2);
  g.add(b);
  g.add(mesh(new THREE.SphereGeometry(0.16, 8, 6), MAT.red, 0, 0, 0.58));
  return g;
}

// ---------------- mech ----------------
// Knight-frame mech (procedural, see mech/mechRig.js), posed in its idle guard stance with the blade lit.
// userData.parts maps the old Blender part names onto rig joints so the shipyard idle animation still works.
export function makeMech() {
  const rig = buildMechRig();
  const pose = locoPose(newPose(), 0, 0, 0);
  applyPose(rig, pose);
  const J = rig.J;
  rig.root.userData.parts = { torso: J.chest, head: J.head, arm_L: J.shL, arm_R: J.shR, pelvis: J.hips };
  rig.root.userData.rig = rig;
  return rig.root;
}

// ---------------- field objects: rocks, ice, orbital junk, canisters ----------------
export function rockGeometry(seed, detail = 4) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.attributes.position, v = new THREE.Vector3();
  const craters = Array.from({ length: 7 }, (_, i) => ({
    c: new THREE.Vector3(Math.sin(seed * 12.9 + i * 4.1), Math.cos(seed * 7.3 + i * 2.7), Math.sin(seed * 3.1 + i * 9.7)).normalize(),
    r: 0.25 + 0.2 * Math.abs(Math.sin(seed + i * 1.7)),
  }));
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).normalize();
    let d = 1 + 0.3 * Math.sin(v.x * 2.1 + seed) * Math.sin(v.y * 1.7 + seed * 1.7) * Math.sin(v.z * 2.4 + seed * 0.6)
      + 0.12 * Math.sin(v.x * 6 + v.y * 5 + seed * 3) * Math.cos(v.z * 5 - seed)
      + 0.05 * Math.sin(v.z * 13 + v.x * 11) + 0.025 * Math.sin(v.y * 29 + v.x * 23 + seed);
    for (const cr of craters) {
      const t = v.distanceTo(cr.c) / cr.r;
      if (t < 1.3) d += t < 1 ? -0.12 * (1 - t * t) : 0.04 * (1 - (t - 1) / 0.3);
    }
    v.multiplyScalar(d);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

export const FIELD_MATS = {
  rock: new THREE.MeshStandardMaterial({ color: 0x4a443e, roughness: 0.93, metalness: 0.05, normalMap: ROCK_NORMAL, normalScale: new THREE.Vector2(1.4, 1.4) }),
  ice: new THREE.MeshStandardMaterial({ color: 0xcfe6ff, roughness: 0.25, metalness: 0.0, normalMap: ROCK_NORMAL, normalScale: new THREE.Vector2(0.6, 0.6), emissive: 0x0a2a44, emissiveIntensity: 0.6 }),
};

const JUNK = ['junk_sat', 'junk_stage', 'junk_panel', 'junk_bus', 'junk_tank'];
export function makeJunk(i) {
  return instanceChild('junk', JUNK[i % JUNK.length]) || makeDebris();
}

export function makeCanister() {
  const g = new THREE.Group();
  g.add(cylY(0.8, 0.8, 2.6, 16, MAT.hullLight, 0, 0, 0));
  for (const y of [-1.0, 1.0]) g.add(cylY(0.84, 0.84, 0.25, 16, MAT.accent, 0, y, 0));
  g.add(cylY(0.3, 0.3, 0.4, 10, MAT.hullDark, 0, 1.5, 0));
  const b = mesh(new THREE.SphereGeometry(0.12, 8, 6), MAT.amber, 0, 1.75, 0);
  g.add(b);
  g.userData.blink = b;
  return g;
}

export function makeDebris() {
  const g = new THREE.Group();
  g.add(box(1.2, 1, 1.6, MAT.foil, 0, 0, 0));
  const pan = box(3.2, 0.05, 1.1, MAT.panel, 2.2, 0, 0);
  pan.rotation.z = 0.4;
  g.add(pan);
  g.add(box(3.2, 0.05, 1.1, MAT.panel, -2.2, 0, 0));
  return g;
}

// ---------------- station ----------------
// Rebuilt whenever a base's buildings change; each module is visibly represented.
// docked: ship types parked at this base (shown on the shipyard gantry / berths).
export function makeStation(L, bodyId, docked = []) {
  const g = new THREE.Group();
  const anim = { spin: [], blink: [], bay: new THREE.Vector3(0, -3, 12) };
  g.userData.anim = anim;

  const core = instance('station');
  if (core) {
    core.rotation.x = 0;
    g.add(core);
    const ring = core.getObjectByName('ring');
    if (ring) anim.spin.push({ obj: ring, speed: 0.12 });
  } else {
    g.add(cylY(1.6, 1.6, 12, 14, MAT.hull, 0, 0, 0));
    g.add(cylY(2.4, 2.4, 3, 18, MAT.hullLight, 0, 0, 0));
    const ring = new THREE.Group();
    ring.add(torus(7, 0.9, MAT.hullLight, 0, 0, 0, 12, 64));
    anim.spin.push({ obj: ring, speed: 0.12 });
    g.add(ring);
  }
  const tip = mesh(new THREE.SphereGeometry(0.22, 8, 6), MAT.red.clone(), 0, 12.6, 0);
  anim.blink.push(tip);
  g.add(tip);
  const flood = new THREE.PointLight(0xffd6a0, 30, 40, 2);
  flood.position.set(0, -2, 9);
  g.add(flood);

  const hub = new THREE.Vector3(0, 0, 0);
  const n = (k, cap) => Math.min(L[k] || 0, cap);

  // Solar wings on +/-X: truss + panel pairs
  for (let i = 0; i < n('solar', 8); i++) {
    const s = i % 2 ? 1 : -1, x = s * (11 + Math.floor(i / 2) * 7);
    g.add(strut(new THREE.Vector3(s * 2.4, 3.5, 0), new THREE.Vector3(x + s * 3, 3.5, 0), 0.18, MAT.hullDark));
    g.add(box(6.2, 0.2, 0.2, MAT.hull, x, 3.5, 0));
    for (const z of [-2, 2]) {
      g.add(box(6, 0.06, 3, MAT.panel, x, 3.5, z));
      g.add(box(6.1, 0.1, 0.1, MAT.hullLight, x, 3.5, z + (z > 0 ? 1.5 : -1.5)));
    }
    g.add(box(0.3, 0.3, 0.3, MAT.amber, x + s * 3.1, 3.5, 0));
  }
  // Drone bay toward +Z
  if (L.drones) {
    g.add(strut(hub, new THREE.Vector3(0, -3, 9), 0.3, MAT.hullDark));
    g.add(box(4.5, 2.6, 3.5, MAT.hull, 0, -3, 10));
    g.add(box(3.2, 1.6, 0.1, MAT.window, 0, -3, 11.8));
    g.add(box(4.6, 0.25, 0.25, MAT.hazard, 0, -1.6, 11.8));
    g.add(box(4.6, 0.25, 0.25, MAT.hazard, 0, -4.4, 11.8));
  }
  // Refinery tanks
  for (let i = 0; i < n('refinery', 3); i++) {
    const x = -8 - i * 2.6;
    if (i === 0) g.add(strut(hub, new THREE.Vector3(-8, -3, 7), 0.28, MAT.hullDark));
    g.add(cylY(1.1, 1.1, 3.6, 20, MAT.hullLight, x, -3, 7));
    g.add(mesh(new THREE.SphereGeometry(1.1, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), MAT.hullLight, x, -1.2, 7));
    g.add(torus(1.13, 0.1, MAT.accent, x, -2, 7, 6, 24));
    g.add(torus(1.13, 0.1, MAT.accent, x, -4, 7, 6, 24));
    g.add(box(0.3, 0.3, 0.3, MAT.amber, x, -0.05, 7));
  }
  // Research lab dome
  if (L.lab) {
    g.add(strut(hub, new THREE.Vector3(9, -3, 7), 0.28, MAT.hullDark));
    g.add(cylY(2.3, 2.5, 1, 24, MAT.hull, 9, -3.6, 7));
    g.add(mesh(new THREE.SphereGeometry(2.2, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2), MAT.glass, 9, -3.1, 7));
    const inner = new THREE.PointLight(0x9fe6ff, 8, 8, 2);
    inner.position.set(9, -2.4, 7);
    g.add(inner);
    const dish = mesh(new THREE.SphereGeometry(1.4, 20, 8, 0, Math.PI * 2, 0, 0.9), MAT.hullLight, 9, 0.4, 7);
    dish.rotation.x = Math.PI;
    g.add(dish);
    g.add(cylY(0.08, 0.08, 2, 6, MAT.hullDark, 9, -0.6, 7));
    for (let i = 1; i < (L.lab || 0) && i < 4; i++) g.add(mesh(new THREE.SphereGeometry(1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), MAT.glass, 9 + i * 2.2, -3.1, 9));
  }
  // Depot containers toward -Z
  const dc = n('depot', 5) * 2;
  if (dc) g.add(strut(hub, new THREE.Vector3(0, -2, -9), 0.3, MAT.hullDark));
  const paints = [PBR.paintRed, PBR.paintBlue, PBR.paintOlive, PBR.paintTeal, PBR.accent];
  for (let i = 0; i < dc; i++) {
    const x = (i % 2 ? 1 : -1) * 1.7, z = -10 - Math.floor(i / 2) * 3.4;
    g.add(box(3, 2.6, 3, paints[i % paints.length], x, -2, z));
    g.add(box(3.05, 0.15, 3.05, MAT.hullDark, x, -0.75, z));
  }
  // Fusion reactor ring
  if (L.reactor) {
    const core2 = new THREE.Group();
    core2.add(torus(3.4, 0.55, MAT.hull, 0, 0, 0, 12, 48));
    core2.add(torus(3.4, 0.25, new THREE.MeshBasicMaterial({ color: new THREE.Color(0x7ad8ff).multiplyScalar(3) }), 0, 0, 0, 6, 48));
    core2.position.y = -6.5;
    anim.spin.push({ obj: core2, speed: 1.2 });
    g.add(core2);
    const gl = glowSprite(0x7ad8ff, 7, 1.2);
    gl.position.set(0, -6.5, 0);
    g.add(gl);
  }
  // Shipyard gantry with docked ships + mech
  if (L.shipyard) {
    const y = -12;
    g.add(strut(new THREE.Vector3(0, -6, 0), new THREE.Vector3(0, y + 2.6, 0), 0.35, MAT.hullDark));
    for (const s of [-1, 1]) for (const z of [-8, 0, 8]) g.add(box(0.35, 6, 0.35, MAT.hazard, s * 3.4, y, z));
    for (const s of [-1, 1]) g.add(box(0.3, 0.3, 16.3, MAT.hullDark, s * 3.4, y + 3, 0));
    g.add(box(7, 0.3, 0.3, MAT.hullDark, 0, y + 3, -8));
    g.add(box(7, 0.3, 0.3, MAT.hullDark, 0, y + 3, 8));
    for (const z of [-8, 8]) g.add(box(0.25, 0.25, 0.25, MAT.amber, 3.4, y + 3.2, z));
    const yl = new THREE.PointLight(0xffc070, 25, 26, 2);
    yl.position.set(0, y + 4, 0);
    g.add(yl);
    if (docked.includes('hauler') || !docked.length) {
      const h = makeHauler();
      h.scale.setScalar(0.7);
      h.position.set(0, y, 0);
      h.userData.exhaust?.forEach((e) => (e.visible = false));
      g.add(h);
    }
    docked.filter((t) => t === 'seed').slice(0, 3).forEach((_, i) => {
      const sd = makeSeedShip();
      sd.scale.setScalar(0.8);
      sd.position.set(-9 - i * 6.5, y, 0);
      sd.userData.exhaust?.forEach((e) => (e.visible = false));
      g.add(sd);
    });
    g.add(box(5, 0.3, 5, MAT.hullDark, 8, y - 2.5, 0));
    g.add(box(5, 0.05, 0.2, MAT.hazard, 8, y - 2.33, 2.5));
    const mech = makeMech();
    mech.position.set(8, y - 2.35, 0);
    mech.rotation.y = -0.6;
    anim.mech = mech;
    g.add(mech);
  } else if (docked.length) {
    // outposts: ships moor alongside the hub
    docked.slice(0, 3).forEach((t, i) => {
      const sh = t === 'seed' ? makeSeedShip() : makeHauler();
      sh.scale.setScalar(0.7);
      sh.position.set(-12 - i * 7, -4, -4);
      sh.userData.exhaust?.forEach((e) => (e.visible = false));
      g.add(sh);
    });
  }
  // Antimatter forge (Sun)
  if (L.forge) {
    const fr = new THREE.Group();
    fr.add(torus(15, 0.7, MAT.hull, 0, 0, 0, 10, 96));
    fr.add(torus(15, 0.25, MAT.white, 0, 0, 0, 4, 96));
    fr.rotation.z = 0.4;
    anim.spin.push({ obj: fr, speed: 0.3 });
    g.add(fr);
    g.add(glowSprite(0xffe0c0, 10, 2));
  }
  return g;
}

// Chase-camera distance factor for narrow (portrait) screens: 1 on landscape, ~1.6 on a phone held
// upright, so the craft keeps roughly the same share of the screen width.
export const portraitPullback = (aspect) => Math.pow(Math.max(1, 1 / Math.max(0.3, aspect)), 0.75);
