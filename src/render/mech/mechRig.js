import * as THREE from 'three';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';
import { JOINTS } from './swordAnim.js';
import { glowSprite } from '../shaders.js';
import { instance } from '../assets.js';
import { PBR } from '../materials.js';
import { plumeMaterial } from '../models.js';

// Procedural knight-frame mech: a joint hierarchy (one Object3D per joint, limbs hang along -Y, faces +Z) dressed in
// faceted armour plates. Built in rig units (~1.8 tall) and scaled up by S, so the Noir sword animation and arm IK
// run unchanged. Look: pale grey-green armour over a dark frame, layered box pauldrons, swept head crest, skirt
// armour, twin back binders with thrusters and a laser blade in the right hand.
//
// Joint convention (Euler 'YXZ'): x < 0 swings a limb forward, x > 0 bends knees back, z > 0 lifts the LEFT arm (+X).

export const S = 3.1;
const HIP_Y = 1.06;
const UA = 0.31, FA = 0.29, TH = 0.46, SH = 0.45, SW = 0.25;

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion();
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();
const _elbow = new THREE.Vector3();

// MeshStandardMaterial plus a fresnel rim so the silhouette reads against black space (from Noir's rimMat)
function rimMat({ color, rough = 0.5, metal = 0.2, rim = 0xdfe8ff, rimPow = 3.2, rimStr = 0.3, emissive = 0x000000 }) {
  const m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, emissive, flatShading: true });
  const rimColor = new THREE.Color(rim).multiplyScalar(rimStr);
  m.userData.flash = { value: 0 };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.rimColor = { value: rimColor };
    sh.uniforms.hitFlash = m.userData.flash;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 rimColor;\nuniform float hitFlash;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float rimF = 1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
        totalEmissiveRadiance += rimColor * pow(rimF, ${rimPow.toFixed(2)}) + vec3(hitFlash);`);
  };
  m.customProgramCacheKey = () => `mechrim${rimPow}`;
  return m;
}
const glow = (hex, k = 3) => new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(k), toneMapped: false });

let MATS = null;
function mats() {
  if (MATS) return MATS;
  MATS = {
    armor: rimMat({ color: 0xa9b8b1, rough: 0.46, metal: 0.35, rimStr: 0.2 }),
    armor2: rimMat({ color: 0x737f7d, rough: 0.5, metal: 0.4, rimStr: 0.16 }),
    frame: rimMat({ color: 0x23272b, rough: 0.55, metal: 0.6, rimStr: 0.12 }),
    red: rimMat({ color: 0xa8302a, rough: 0.4, metal: 0.3, rimStr: 0.2 }),
    gold: rimMat({ color: 0xc39a4c, rough: 0.25, metal: 0.95, rimStr: 0.3 }),
    eye: glow(0x5effc0, 1.8),
    vent: glow(0x58e6ff, 1.4),
  };
  return MATS;
}

// Chamfered, tapered box as a convex hull: w/h/d full size; tx/tz scale the top face, bx/bz the bottom face,
// sz shifts the top face forward (lean), c is the chamfer size. Flat-shaded facets give the hard-surface look.
const GEO_CACHE = new Map();
function hull(w, h, d, { tx = 1, tz = 1, bx = 1, bz = 1, sz = 0, c = 0.012 } = {}) {
  const key = [w, h, d, tx, tz, bx, bz, sz, c].join(',');
  if (GEO_CACHE.has(key)) return GEO_CACHE.get(key);
  const pts = [];
  for (const sy of [-1, 1]) {
    const kx = sy > 0 ? tx : bx, kz = sy > 0 ? tz : bz, oz = sy > 0 ? sz : 0;
    for (const sx of [-1, 1]) for (const sz2 of [-1, 1]) {
      const X = sx * w / 2 * kx, Y = sy * h / 2, Z = sz2 * d / 2 * kz + oz;
      const cc = Math.min(c, w * kx / 3, h / 3, d * kz / 3);
      pts.push(new THREE.Vector3(X - sx * cc, Y, Z), new THREE.Vector3(X, Y - sy * cc, Z), new THREE.Vector3(X, Y, Z - sz2 * cc));
    }
  }
  const g = new ConvexGeometry(pts);
  GEO_CACHE.set(key, g);
  return g;
}

// Laser sword: dark hilt, gold guard, emitter and a broad tapered energy blade (white core inside a cyan sheath).
// Local +Z runs along the blade, +Y is the edge direction (blade "up"), matching the hand socket.
function makeLaserSword(M) {
  const g = new THREE.Group();
  const add = (geo, mat, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); g.add(m); return m; };
  const grip = new THREE.CylinderGeometry(0.022, 0.024, 0.2, 8); grip.rotateX(Math.PI / 2);
  add(grip, M.frame, 0, 0, 0.0);
  add(hull(0.04, 0.04, 0.04, { c: 0.008 }), M.armor2, 0, 0, -0.11);
  add(hull(0.05, 0.14, 0.04, { tx: 0.6, c: 0.01 }), M.gold, 0, 0, 0.12);
  add(hull(0.045, 0.06, 0.07, { c: 0.01 }), M.armor, 0, 0, 0.17);
  add(hull(0.012, 0.03, 0.02, { c: 0.003 }), M.vent, 0, 0.03, 0.17);
  const L = 1.12;
  const blade = (wy, wx, mat) => {
    const geo = new THREE.BufferGeometry();
    // diamond cross-section: edges along ±Y, flats along ±X, tapering to a point; slight forward sweep of the tip
    const v = [];
    const ring = (z, k) => [[0, wy * k, z], [wx * k, 0, z], [0, -wy * k * 0.8, z], [-wx * k, 0, z]];
    const r0 = ring(0, 1), r1 = ring(L * 0.72, 0.82), tip = [0, wy * 0.15, L];
    const quad = (a, b, c, d) => v.push(...a, ...b, ...c, ...a, ...c, ...d);
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      quad(r0[i], r0[j], r1[j], r1[i]);
      v.push(...r1[i], ...r1[j], ...tip);
      v.push(...r0[j], ...r0[i], 0, 0, 0);
    }
    geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    geo.computeVertexNormals();
    geo.translate(0, 0, 0.2);
    const m = new THREE.Mesh(geo, mat);
    g.add(m);
    return m;
  };
  const core = blade(0.05, 0.008, new THREE.MeshBasicMaterial({ color: new THREE.Color(0xeaffff).multiplyScalar(3.2), toneMapped: false, side: THREE.DoubleSide }));
  const sheathMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x38d4ff).multiplyScalar(2.2), toneMapped: false, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const sheath = blade(0.075, 0.022, sheathMat);
  sheath.scale.set(1, 1, 1.03);
  const light = new THREE.PointLight(0x6fe4ff, 0, 16, 2);
  light.position.set(0, 0, 0.75);
  g.add(light);
  g.userData = { base: new THREE.Vector3(0, 0, 0.26), tip: new THREE.Vector3(0, 0.01, 0.2 + L), length: L + 0.2, core, sheath, light, sheathMat };
  return g;
}

// ---------- the rig ----------
// ---------- thrusters: additive plume cone + nozzle glow on an anchor whose local -Y is the exhaust ----------
const THRUST_SIZE = { back: 1.5, wing: 1.2, sh: 0.7, calf: 0.85, foot: 1.0 };
function makeThruster(anchor, group, k = THRUST_SIZE[group] ?? 1) {
  const len = 0.32 * k, rad = 0.045 * k;
  const geo = new THREE.ConeGeometry(rad, len, 18, 1, true);
  geo.translate(0, len / 2, 0);                      // wide end (uv.y = 0) on the nozzle
  const plume = new THREE.Mesh(geo, plumeMaterial(0x6fb8ff));
  plume.rotation.x = Math.PI;                        // stretch along local -Y (the exhaust)
  plume.renderOrder = 2;
  plume.frustumCulled = false;
  plume.visible = false;
  const glowS = glowSprite(0x8fd4ff, 0.1 * k, 0.9);
  glowS.visible = false;
  anchor.add(plume, glowS);
  return { anchor, group, plume, glow: glowS, k, thr: 0 };
}

// GLB materials (named mech_* in blender/build_mech.py) -> physical car paint, chrome, carbon, HDR glows
let GLB_MATS = null;
function glbMats() {
  if (GLB_MATS) return GLB_MATS;
  const paint = (color, o = {}) => new THREE.MeshPhysicalMaterial({
    color, metalness: 0.15, roughness: 0.34, clearcoat: 1, clearcoatRoughness: 0.06,
    normalMap: PBR.pearl.normalMap, normalScale: new THREE.Vector2(0.12, 0.12), envMapIntensity: 2.2, ...o,
  });
  GLB_MATS = {
    mech_white: paint(0xe4e8ec, { iridescence: 0.15, iridescenceThicknessRange: [200, 480] }),
    mech_grey: paint(0x5b626b, { metalness: 0.45, roughness: 0.38 }),
    mech_blue: paint(0x153d9a, { metalness: 0.55, roughness: 0.3 }),
    mech_red: paint(0xb3161a, { metalness: 0.3 }),
    mech_gold: new THREE.MeshPhysicalMaterial({ color: 0xe0a94a, metalness: 1, roughness: 0.22, clearcoat: 0.6, envMapIntensity: 2.4 }),
    mech_chrome: PBR.chrome,
    mech_carbon: PBR.carbon,
    mech_frame: new THREE.MeshStandardMaterial({ color: 0x2b2f35, metalness: 0.85, roughness: 0.42, envMapIntensity: 1.6 }),
    mech_glow: new THREE.MeshBasicMaterial({ color: new THREE.Color(0x58e8ff).multiplyScalar(3.2), toneMapped: false }),
    mech_eye: new THREE.MeshBasicMaterial({ color: new THREE.Color(0x5cffc4).multiplyScalar(4), toneMapped: false }),
    mech_nozzle: new THREE.MeshBasicMaterial({ color: new THREE.Color(0x3f7fd0).multiplyScalar(0.7), toneMapped: false }),
    mech_seam: new THREE.MeshStandardMaterial({ color: 0x0b0c0e, metalness: 0.3, roughness: 0.7 }),
    mech_decal_num: decalMat(drawNumber),
    mech_decal_text: decalMat(drawText),
    mech_decal_warn: decalMat(drawStripes),
    mech_decal_caution: decalMat(drawCaution),
  };
  return GLB_MATS;
}

// ---------- decals: markings drawn to canvas, printed on the armour (clear-coated, alpha-tested) ----------
function decalMat(draw, w = 512, h = 256) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return new THREE.MeshPhysicalMaterial({
    map: tex, transparent: true, alphaTest: 0.35, roughness: 0.35, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.08,
    polygonOffset: true, polygonOffsetFactor: -2, depthWrite: false, envMapIntensity: 1.8,
  });
}
const INK = '#1d2026', MONO = '600 {s}px "JetBrains Mono", "Consolas", monospace', SANS = '800 {s}px "Arial Black", "Helvetica Neue", sans-serif';
const font = (f, s) => f.replace('{s}', s);
function drawNumber(g, w, h) {
  g.fillStyle = INK;
  g.font = font(SANS, 170);
  g.textBaseline = 'alphabetic';
  g.fillText('07', 18, 190);
  g.fillStyle = '#b3161a';
  g.fillRect(268, 60, 14, 130);
  g.fillStyle = INK;
  g.font = font(MONO, 40);
  g.fillText('KF-07', 300, 100);
  g.font = font(MONO, 26);
  g.fillText('KNIGHT FRAME', 300, 140);
  g.fillText('LUNAR OPS', 300, 175);
}
function drawText(g, w, h) {
  g.fillStyle = INK;
  g.font = font(MONO, 64);
  g.fillText('KF-07 · TYPE K', 20, 120);
  g.fillRect(20, 150, w - 40, 8);
  g.font = font(MONO, 38);
  g.fillText('HIGH TORQUE · DO NOT STEP', 20, 215);
}
function drawStripes(g, w, h) {
  g.save();
  g.beginPath(); g.rect(8, 40, w - 16, h - 80); g.clip();
  g.fillStyle = '#e8b31c'; g.fillRect(0, 0, w, h);
  g.fillStyle = INK;
  for (let x = -h; x < w + h; x += 72) { g.beginPath(); g.moveTo(x, h); g.lineTo(x + 36, h); g.lineTo(x + 36 + h, 0); g.lineTo(x + h, 0); g.fill(); }
  g.restore();
}
function drawCaution(g, w, h) {
  g.fillStyle = '#b3161a';
  g.beginPath(); g.moveTo(20, 210); g.lineTo(100, 50); g.lineTo(180, 210); g.closePath(); g.fill();
  g.fillStyle = '#f2f2f2'; g.font = font(SANS, 100); g.fillText('!', 82, 195);
  g.fillStyle = INK; g.font = font(MONO, 62); g.fillText('CAUTION', 205, 120);
  g.font = font(MONO, 34); g.fillText('THRUSTER EXHAUST', 205, 175);
}

function buildFromGlb(model) {
  const MM = glbMats();
  const root = new THREE.Group();
  const body = new THREE.Group();
  body.scale.setScalar(S);
  root.add(body);
  body.add(model);
  const J = {};
  for (const j of JOINTS) {
    const o = model.getObjectByName(j);
    if (!o) return null;
    o.rotation.order = 'YXZ';
    J[j] = o;
  }
  model.traverse((o) => {
    if (!o.isMesh) return;
    const swap = (m) => MM[m.name.replace(/\.\d+$/, '')] || m;
    o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material);
    o.castShadow = true;
    o.receiveShadow = true;
  });
  const socket = model.getObjectByName('anchor_socket_R') || J.haR;
  const sword = makeLaserSword(mats());
  socket.add(sword);
  const thrusters = [];
  model.traverse((o) => {
    const m = /^anchor_jet_(\w+?)_[LR]$/.exec(o.name);
    if (m) thrusters.push(makeThruster(o, m[1]));
  });
  return { root, body, J, sword, thrusters, scale: S, lengths: { UA: UA * S, FA: FA * S }, mats: Object.values(MM), glb: true };
}

export function buildMechRig() {
  const g = instance('mech');
  const fromGlb = g && buildFromGlb(g);
  if (fromGlb) return fromGlb;
  const M = mats();
  const root = new THREE.Group();          // at the feet, yaw = facing
  const body = new THREE.Group();
  body.scale.setScalar(S);
  root.add(body);
  const J = {};
  const mk = (name, parent, x, y, z) => {
    const o = new THREE.Object3D();
    o.name = name; o.position.set(x, y, z); o.rotation.order = 'YXZ';
    parent.add(o); J[name] = o; return o;
  };
  const add = (parent, geo, mat, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z); m.rotation.set(rx, ry, rz);
    m.castShadow = true;
    parent.add(m); return m;
  };
  const H = hull;

  mk('hips', body, 0, HIP_Y, 0);
  mk('spine', J.hips, 0, 0.1, 0);
  mk('chest', J.spine, 0, 0.18, 0);
  mk('neck', J.chest, 0, 0.24, -0.01);
  mk('head', J.neck, 0, 0.05, 0.01);
  for (const [s, sx] of [['L', 1], ['R', -1]]) {
    mk('sh' + s, J.chest, sx * SW, 0.16, -0.01);
    mk('el' + s, J['sh' + s], 0, -UA, 0);
    mk('ha' + s, J['el' + s], 0, -FA, 0);
    mk('th' + s, J.hips, sx * 0.12, -0.05, 0);
    mk('kn' + s, J['th' + s], 0, -TH, 0);
    mk('an' + s, J['kn' + s], 0, -SH, 0);
  }

  // ---- pelvis + skirt armour ----
  add(J.hips, H(0.26, 0.13, 0.19, { bx: 0.8 }), M.frame, 0, -0.02, 0);
  add(J.hips, H(0.3, 0.05, 0.21, { c: 0.01 }), M.armor2, 0, 0.045, 0);
  add(J.hips, H(0.09, 0.15, 0.05, { bx: 0.55, c: 0.012 }), M.armor, 0, -0.07, 0.105, 0.1);
  add(J.hips, H(0.05, 0.02, 0.012, { c: 0.004 }), M.red, 0, -0.02, 0.135, 0.1);
  for (const sx of [1, -1]) {
    add(J.hips, H(0.13, 0.17, 0.028, { bx: 1.15, c: 0.008 }), M.armor, sx * 0.1, -0.08, 0.1, 0.22, sx * 0.3, sx * 0.06);
    add(J.hips, H(0.032, 0.22, 0.2, { bz: 1.15, c: 0.01 }), M.armor, sx * 0.175, -0.07, 0, 0, 0, sx * 0.2);
    add(J.hips, H(0.008, 0.14, 0.12, { c: 0.003 }), M.armor2, sx * 0.195, -0.06, 0, 0, 0, sx * 0.2);
  }
  add(J.hips, H(0.22, 0.16, 0.03, { bx: 1.1, c: 0.01 }), M.armor, 0, -0.07, -0.11, -0.2);

  // ---- waist ----
  add(J.spine, H(0.19, 0.17, 0.15, { tx: 1.15 }), M.frame, 0, 0.07, 0);
  add(J.spine, H(0.15, 0.1, 0.04, { c: 0.01 }), M.armor2, 0, 0.06, 0.07, -0.05);
  for (const sx of [1, -1]) add(J.spine, H(0.05, 0.12, 0.13, { c: 0.01 }), M.armor2, sx * 0.1, 0.07, 0);

  // ---- chest ----
  add(J.chest, H(0.34, 0.25, 0.22, { bx: 0.75 }), M.frame, 0, 0.1, 0);
  add(J.chest, H(0.47, 0.18, 0.28, { bx: 0.76, bz: 0.9, c: 0.022 }), M.armor, 0, 0.16, 0.01);
  for (const sx of [1, -1]) {
    add(J.chest, H(0.15, 0.13, 0.05, { bx: 0.7, c: 0.012 }), M.armor, sx * 0.085, 0.12, 0.135, -0.1, sx * 0.35);
    add(J.chest, H(0.06, 0.035, 0.02, { c: 0.005 }), M.frame, sx * 0.1, 0.05, 0.12, 0, sx * 0.3);
    add(J.chest, H(0.045, 0.01, 0.01, { c: 0.002 }), M.vent, sx * 0.1, 0.05, 0.132, 0, sx * 0.3);
    add(J.chest, H(0.08, 0.09, 0.13, { tx: 0.6, c: 0.01 }), M.armor, sx * 0.12, 0.28, 0.0, 0, 0, sx * -0.35);   // collar flaps
  }
  add(J.chest, H(0.07, 0.07, 0.03, { bx: 0.4, c: 0.01 }), M.red, 0, 0.15, 0.15, -0.1);
  add(J.chest, H(0.2, 0.05, 0.18, { c: 0.01 }), M.armor2, 0, 0.255, -0.01);
  // backpack + binders
  add(J.chest, H(0.28, 0.25, 0.12, { tx: 1.05, c: 0.02 }), M.armor2, 0, 0.13, -0.165);
  add(J.chest, H(0.1, 0.14, 0.04, { c: 0.01 }), M.frame, 0, 0.11, -0.235);
  const nozzles = [];
  for (const sx of [1, -1]) {
    const pivot = new THREE.Object3D();
    pivot.position.set(sx * 0.12, 0.17, -0.22);
    pivot.rotation.set(-0.45, 0, sx * -0.42, 'YXZ');
    J.chest.add(pivot);
    add(pivot, H(0.08, 0.46, 0.1, { tx: 0.55, tz: 0.7, c: 0.015 }), M.armor, 0, 0.2, 0);
    add(pivot, H(0.09, 0.18, 0.06, { c: 0.012 }), M.armor2, sx * 0.012, 0.08, -0.04);
    add(pivot, H(0.012, 0.3, 0.02, { c: 0.003 }), M.red, sx * 0.045, 0.24, 0.0);
    add(pivot, H(0.07, 0.07, 0.08, { bx: 1.2, bz: 1.2, c: 0.01 }), M.frame, 0, -0.05, -0.01);
    const n = new THREE.Object3D();
    n.position.set(0, -0.09, -0.01);
    pivot.add(n);
    nozzles.push(n);
  }

  // ---- head ----
  add(J.neck, new THREE.CylinderGeometry(0.045, 0.055, 0.1, 8), M.frame, 0, 0.02, 0);
  add(J.head, H(0.13, 0.12, 0.15, { tx: 0.85, tz: 0.85, c: 0.018 }), M.armor, 0, 0.08, -0.005);
  add(J.head, H(0.1, 0.06, 0.05, { bx: 0.6, c: 0.01 }), M.frame, 0, 0.045, 0.06);         // face mask
  add(J.head, H(0.09, 0.02, 0.02, { c: 0.004 }), M.eye, 0, 0.085, 0.075);
  add(J.head, H(0.07, 0.03, 0.06, { bx: 0.6, c: 0.008 }), M.armor2, 0, 0.025, 0.065);    // chin guard
  add(J.head, H(0.024, 0.06, 0.2, { tz: 0.5, sz: 0.04, c: 0.006 }), M.armor, 0, 0.165, 0.03, -0.25);  // crest
  add(J.head, H(0.03, 0.03, 0.06, { c: 0.006 }), M.red, 0, 0.145, 0.07, -0.2);
  for (const sx of [1, -1]) {
    add(J.head, H(0.03, 0.08, 0.09, { tz: 0.6, c: 0.008 }), M.armor2, sx * 0.075, 0.08, -0.01);
    add(J.head, H(0.012, 0.03, 0.12, { tz: 0.3, c: 0.003 }), M.armor, sx * 0.08, 0.13, -0.03, -0.4, sx * 0.25);  // ear fins
  }

  // ---- arms ----
  for (const [s, sx] of [['L', 1], ['R', -1]]) {
    const sh = J['sh' + s], el = J['el' + s], ha = J['ha' + s];
    add(sh, new THREE.SphereGeometry(0.06, 10, 8), M.frame);
    add(sh, H(0.22, 0.2, 0.26, { tx: 0.85, c: 0.024 }), M.armor, sx * 0.07, 0.045, 0, 0, 0, sx * -0.12);
    add(sh, H(0.24, 0.04, 0.28, { c: 0.01 }), M.armor2, sx * 0.07, 0.16, 0, 0, 0, sx * -0.22);
    add(sh, H(0.035, 0.24, 0.25, { bz: 0.8, c: 0.01 }), M.armor, sx * 0.19, -0.01, 0, 0, 0, sx * 0.12);
    add(sh, H(0.008, 0.05, 0.18, { c: 0.002 }), M.red, sx * 0.21, 0.05, 0, 0, 0, sx * 0.12);
    add(sh, H(0.08, UA, 0.08, { c: 0.01 }), M.frame, 0, -UA / 2, 0);
    add(sh, H(0.1, 0.13, 0.1, { c: 0.015 }), M.armor2, 0, -0.19, 0);
    add(el, new THREE.SphereGeometry(0.052, 10, 8), M.frame);
    add(el, H(0.12, 0.2, 0.13, { bx: 0.85, bz: 0.85, c: 0.018 }), M.armor, 0, -0.13, 0.005);
    add(el, H(0.13, 0.04, 0.14, { c: 0.01 }), M.armor2, 0, -0.245, 0.005);
    add(ha, H(0.075, 0.085, 0.085, { c: 0.012 }), M.frame, 0, -0.045, 0.012);
    add(ha, H(0.08, 0.045, 0.06, { c: 0.008 }), M.armor2, 0, -0.065, 0.04);
  }

  // ---- legs ----
  for (const [s, sx] of [['L', 1], ['R', -1]]) {
    const th = J['th' + s], kn = J['kn' + s], an = J['an' + s];
    add(th, new THREE.SphereGeometry(0.065, 10, 8), M.frame);
    add(th, H(0.11, TH, 0.12, { bx: 0.85, c: 0.015 }), M.frame, 0, -TH / 2, 0);
    add(th, H(0.17, 0.28, 0.09, { bx: 0.85, c: 0.015 }), M.armor, 0, -0.2, 0.055, -0.03);
    add(th, H(0.03, 0.2, 0.13, { c: 0.01 }), M.armor2, sx * 0.07, -0.22, 0.0);
    add(kn, new THREE.SphereGeometry(0.06, 10, 8), M.frame);
    add(kn, H(0.13, 0.15, 0.1, { tx: 0.6, tz: 0.7, c: 0.02 }), M.armor, 0, 0.01, 0.075, -0.25);
    add(kn, H(0.03, 0.05, 0.02, { c: 0.005 }), M.red, 0, -0.02, 0.13, -0.25);
    add(kn, H(0.2, 0.37, 0.22, { bx: 0.78, bz: 0.8, sz: -0.015, c: 0.026 }), M.armor, 0, -0.23, -0.008);
    add(kn, H(0.07, 0.28, 0.04, { c: 0.01 }), M.armor2, 0, -0.23, 0.108);
    add(kn, H(0.13, 0.16, 0.06, { c: 0.012 }), M.armor2, 0, -0.27, -0.12, 0.12);
    add(kn, H(0.08, 0.02, 0.012, { c: 0.003 }), M.vent, 0, -0.33, -0.152, 0.12);
    add(kn, H(0.17, 0.07, 0.18, { c: 0.012 }), M.armor2, 0, -0.415, 0);
    add(an, new THREE.SphereGeometry(0.05, 10, 8), M.frame);
    add(an, H(0.17, 0.08, 0.33, { tx: 0.85, tz: 0.75, c: 0.015 }), M.armor, 0, -0.06, 0.06);
    add(an, H(0.15, 0.05, 0.09, { tz: 0.6, c: 0.01 }), M.armor2, 0, -0.075, 0.25, 0.25);
    add(an, H(0.12, 0.05, 0.07, { c: 0.01 }), M.frame, 0, -0.075, -0.1);
  }

  // ---- sword socket ----
  const socket = new THREE.Object3D();
  socket.position.set(0, -0.065, 0.02);
  J.haR.add(socket);
  const sword = makeLaserSword(M);
  socket.add(sword);

  // the fallback frame only has the two binder nozzles (exhaust straight down)
  const thrusters = nozzles.map((n) => makeThruster(n, 'wing', 1));

  root.traverse((o) => { if (o.isMesh && !o.material.transparent) o.castShadow = true; });
  return {
    root, body, J, sword, thrusters, scale: S,
    lengths: { UA: UA * S, FA: FA * S },
    mats: Object.values(M),
  };
}

export function applyPose(rig, pose) {
  for (const k of JOINTS) {
    const r = pose[k];
    rig.J[k].rotation.set(r[0], r[1], r[2], 'YXZ');
  }
  rig.J.hips.position.y = HIP_Y + (pose.drop || 0);
  rig.J.hips.position.z = pose.shift || 0;
}

// Two-bone IK for one arm (from Noir's rig.js). target / pole / bladeDir / bladeUp are WORLD space; w blends with FK.
export function solveArm(rig, side, target, pole, bladeDir, bladeUp, w = 1) {
  if (w <= 0.001) return;
  const sh = rig.J['sh' + side], el = rig.J['el' + side], ha = rig.J['ha' + side];
  const a = rig.lengths.UA, b = rig.lengths.FA;
  sh.parent.updateWorldMatrix(true, false);
  const Sp = sh.getWorldPosition(_v1);
  const toT = _v2.subVectors(target, Sp);
  let d = toT.length();
  const dir = toT.divideScalar(d || 1);
  d = THREE.MathUtils.clamp(d, 0.05, (a + b) * 0.999);
  const cosA = THREE.MathUtils.clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  const perp = _v3.subVectors(pole, Sp);
  perp.addScaledVector(dir, -perp.dot(dir));
  if (perp.lengthSq() < 1e-6) perp.set(0, -1, 0);
  perp.normalize();
  const elbow = _elbow.copy(Sp).addScaledVector(dir, a * cosA).addScaledVector(perp, a * sinA);
  const hand = new THREE.Vector3().copy(Sp).addScaledVector(dir, d);

  _y.subVectors(Sp, elbow).normalize();
  _z.copy(perp).negate(); _z.addScaledVector(_y, -_z.dot(_y)).normalize();
  _x.crossVectors(_y, _z);
  const qShW = new THREE.Quaternion().setFromRotationMatrix(_m.makeBasis(_x, _y, _z));
  const zKeep = _z.clone();
  _y.subVectors(elbow, hand).normalize();
  _z.copy(zKeep).addScaledVector(_y, -zKeep.dot(_y)).normalize();
  _x.crossVectors(_y, _z);
  const qElW = new THREE.Quaternion().setFromRotationMatrix(_m.makeBasis(_x, _y, _z));
  _z.copy(bladeDir).normalize();
  _y.copy(bladeUp).addScaledVector(_z, -bladeUp.dot(_z));
  if (_y.lengthSq() < 1e-6) _y.set(0, 1, 0).addScaledVector(_z, -_z.y);
  _y.normalize();
  _x.crossVectors(_y, _z);
  const qHaW = new THREE.Quaternion().setFromRotationMatrix(_m.makeBasis(_x, _y, _z));

  const qParent = sh.parent.getWorldQuaternion(_q);
  const shL = qParent.clone().invert().multiply(qShW);
  const elL = qShW.clone().invert().multiply(qElW);
  const haL = qElW.clone().invert().multiply(qHaW);
  if (w >= 0.999) { sh.quaternion.copy(shL); el.quaternion.copy(elL); ha.quaternion.copy(haL); }
  else { sh.quaternion.slerp(shL, w); el.quaternion.slerp(elL, w); ha.quaternion.slerp(haL, w); }
  sh.updateWorldMatrix(false, true);
}
