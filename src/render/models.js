import * as THREE from 'three';
import { glowSprite } from './shaders.js';
import { instance, instanceChild, anchors, part } from './assets.js';
import { PBR, ROCK_NORMAL } from './materials.js';

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

// ---------------- player skiff ----------------
export function makeSkiff() {
  const g = instance('skiff');
  if (!g) return skiffProc();
  const a = anchors(g);
  addPlumes(g, a, 0.27, 2.2);
  g.userData.nose = a.nose.position.clone();
  const l = new THREE.PointLight(0xffc890, 3, 12, 2);
  l.position.set(0, 0.2, 3.2);
  g.add(l);
  return g;
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
  g.userData.nose = new THREE.Vector3(0, -0.22, 2.2);
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
// The Blender mech is articulated: pelvis > thigh_* > shin_* > foot_*, pelvis > torso > head / arm_*.
export function makeMech() {
  const g = instance('mech');
  if (!g) return mechProc();
  g.userData.parts = Object.fromEntries(['pelvis', 'torso', 'head', 'arm_L', 'arm_R', 'thigh_L', 'thigh_R', 'shin_L', 'shin_R'].map((n) => [n, part(g, n)]));
  return g;
}

function mechProc() {
  const g = new THREE.Group();
  g.add(box(1.6, 0.6, 1, MAT.hull, 0, 3, 0));
  for (const s of [-1, 1]) {
    g.add(box(0.55, 1.5, 0.7, MAT.hullLight, s * 0.6, 2.1, 0));
    g.add(box(0.6, 1.6, 0.8, MAT.hull, s * 0.65, 0.9, 0.12));
    g.add(box(0.9, 0.8, 1.1, MAT.accent, s * 1.55, 4.55, 0));
  }
  g.add(box(2.2, 1.6, 1.5, MAT.hullLight, 0, 4.1, 0));
  g.add(box(1.0, 0.5, 0.4, MAT.glass, 0, 4.4, 0.78));
  return g;
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
