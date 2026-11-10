// Builds public/characters/anims/katana.{json,bin}: the anime katana pack (UE5 mannequin FBX) sampled into a compact
// clip pack that the game retargets onto any humanoid at load time (VRM characters and the NEXORION mech).
//
//   node scripts/build-katana.mjs [packDir]        (default D:/TAMAMO/game-assets/characters/katana)
//
// Per clip, at 30 fps: every mapped bone's rotation in a canonical character frame (X = character's left, Y = up,
// Z = forward), the pelvis position, the root motion (forward / left / up / yaw from the root bone, the Root_Motion
// versions carry the real footwork), and the detected blade swings (hit windows and arc planes, as the mech meta).
// The pack has no sword bone, so the grip is derived from the animation: in two-handed frames the handle runs from
// the left hand to the right hand, which gives the blade axis in the right hand's frame.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACK = process.argv[2] || 'D:/TAMAMO/game-assets/characters/katana';
const OUT = path.join(ROOT, 'public/characters/anims');
globalThis.self = globalThis; globalThis.window = globalThis;
globalThis.document = { createElementNS: () => ({ style: {} }), createElement: () => ({ style: {} }) };
const THREE = await import(`file:///${ROOT}/node_modules/three/build/three.module.js`);
const { FBXLoader } = await import(`file:///${ROOT}/node_modules/three/examples/jsm/loaders/FBXLoader.js`);

const FPS = 30;
// canonical (VRM humanoid) bone -> UE mannequin bone
export const BONES = {
  hips: 'pelvis', spine: 'spine_02', chest: 'spine_04', neck: 'neck_01', head: 'head',
  leftShoulder: 'clavicle_l', leftUpperArm: 'upperarm_l', leftLowerArm: 'lowerarm_l', leftHand: 'hand_l',
  rightShoulder: 'clavicle_r', rightUpperArm: 'upperarm_r', rightLowerArm: 'lowerarm_r', rightHand: 'hand_r',
  leftUpperLeg: 'thigh_l', leftLowerLeg: 'calf_l', leftFoot: 'foot_l', leftToes: 'ball_l',
  rightUpperLeg: 'thigh_r', rightLowerLeg: 'calf_r', rightFoot: 'foot_r', rightToes: 'ball_r',
};
const NAMES = Object.keys(BONES);
// The pack does not animate fingers (they stay in the mannequin's relaxed pose), so only their rest positions are
// kept: the knuckles give each hand its direction and roll, and place the handle in the fist. The game curls the
// fingers around the handle itself.
const REST_ONLY = {};
for (const [S, s] of [['left', 'l'], ['right', 'r']]) {
  for (const [vr, ue] of [['Index', 'index'], ['Middle', 'middle'], ['Ring', 'ring'], ['Little', 'pinky']]) REST_ONLY[`${S}${vr}Proximal`] = `${ue}_01_${s}`;
  REST_ONLY[`${S}ThumbProximal`] = `thumb_02_${s}`;
}
// [game name, file, folder, loop]
const CLIPS = [
  ['combo1', 'AS_Anime_KC_Combo_V1_RM', 'Root_Motion'], ['combo2', 'AS_Anime_KC_Combo_V2_RM', 'Root_Motion'],
  ['combo3', 'AS_Anime_KC_Combo_V3_RM', 'Root_Motion'], ['combo4', 'AS_Anime_KC_Combo_V4_RM', 'Root_Motion'],
  ['combo5', 'AS_Anime_KC_Combo_V5_RM', 'Root_Motion'], ['double_slash', 'AS_Anime_KC_Double_Slash_RM', 'Root_Motion'],
  ['strikes', 'AS_Anime_KC_Strikes_RM', 'Root_Motion'], ['strikes2', 'AS_Anime_KC_Strikes_V2_RM', 'Root_Motion'],
  ['aerial', 'AS_Anime_KC_Combo_Aerial_V1_RM', 'Root_Motion'], ['aerial2', 'AS_Anime_KC_Combo_Aerial_V2_RM', 'Root_Motion'],
  ['combo_down', 'AS_Anime_KC_Combo_Down_RM', 'Root_Motion'], ['combo_down2', 'AS_Anime_KC_Combo_Down_V2_RM', 'Root_Motion'],
  ['circle', 'AS_Anime_KC_Circle_RM', 'Root_Motion'], ['circle2', 'AS_Anime_KC_Circle_RM_V2', 'Root_Motion'],
  ['jump_attack', 'AS_Anime_KC_Jump_Attack_RM', 'Root_Motion'], ['jump_attack2', 'AS_Anime_KC_Jump_Attack_V2_RM', 'Root_Motion'],
  ['jump_attack3', 'AS_Anime_KC_Jump_Attack_V3_RM', 'Root_Motion'], ['rush', 'AS_Anime_KC_Rush_RM', 'Root_Motion'],
  ['swirl', 'AS_Anime_KC_Swirl_RM', 'Root_Motion'], ['thrust', 'AS_Anime_KC_Thrust_RM', 'Root_Motion'],
  ['idle', 'AS_Anime_KC_Idle', 'In_Place', true], ['run', 'AS_Anime_KC_Run', 'In_Place', true], ['run2', 'AS_Anime_KC_Run_V2', 'In_Place', true],
  ['run_stop', 'AS_Anime_KC_Run_Stop', 'In_Place'], ['dash', 'AS_Anime_KC_Dash', 'In_Place'], ['dodge', 'AS_Anime_KC_Dodge_V1', 'In_Place'],
  ['dodge2', 'AS_Anime_KC_Dodge_V2', 'In_Place'], ['roll', 'AS_Anime_KC_Roll', 'In_Place'], ['jump', 'AS_Anime_KC_Jump', 'In_Place'],
  ['block', 'AS_Anime_KC_Block_01', 'In_Place'], ['block_hit', 'AS_Anime_KC_Block_01_Hit', 'In_Place'],
  ['charge', 'AS_Anime_KC_Charge_Attack', 'In_Place'], ['charge2', 'AS_Anime_KC_Charge_Attack_V2', 'In_Place'],
  ['run_attack', 'AS_Anime_KC_Run_Attack_V1', 'In_Place'], ['run_thrust', 'AS_Anime_KC_Run_Thrust', 'In_Place'],
  ['waves', 'AS_Anime_KC_Waves', 'In_Place'], ['hit', 'AS_Anime_KC_Get_Hit_V1', 'In_Place'], ['hit2', 'AS_Anime_KC_Get_Hit_V2', 'In_Place'],
  ['death', 'AS_Anime_KC_Death', 'In_Place'],
];

const load = (file) => {
  const b = fs.readFileSync(file);
  return new FBXLoader().parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), '');
};
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z), Q = () => new THREE.Quaternion();
const bonesOf = (o) => { const m = {}; o.traverse((x) => { if (x.isBone) m[x.name] = x; }); return m; };
const world = (b) => { const p = V(), q = Q(), s = V(); b.matrixWorld.decompose(p, q, s); return { p, q }; };

// ---------------- rest pose and the canonical frame ----------------
const first = load(path.join(PACK, 'In_Place', 'AS_Anime_KC_Idle.fbx'));
first.updateMatrixWorld(true);
const fb = bonesOf(first);
const restW = {};
for (const n of [...Object.values(BONES), ...Object.values(REST_ONLY), 'root']) restW[n] = world(fb[n]);
const left = restW.thigh_l.p.clone().sub(restW.thigh_r.p).normalize();
const up = restW.head.p.clone().sub(restW.pelvis.p); up.addScaledVector(left, -up.dot(left)).normalize();
const fwd = V().crossVectors(left, up);
let Sinv = Q().setFromRotationMatrix(new THREE.Matrix4().makeBasis(left, up, fwd)).invert();
const rootRest = restW.root;
const toCanon = (p) => p.clone().sub(rootRest.p).applyQuaternion(Sinv);
let unit = 1;
{
  const h = toCanon(restW.head.p).y - Math.min(toCanon(restW.foot_l.p).y, toCanon(restW.foot_r.p).y);
  if (h > 10) unit = 0.01;                                     // FBX in centimetres
}
const rest = {};
for (const n of NAMES) {
  const w = restW[BONES[n]];
  rest[n] = { p: toCanon(w.p).multiplyScalar(unit).toArray().map((x) => +x.toFixed(5)), q: Sinv.clone().multiply(w.q).toArray().map((x) => +x.toFixed(6)) };
}
const height = rest.head.p[1] - Math.min(rest.leftFoot.p[1], rest.rightFoot.p[1]) + 0.12;
console.log('rest height', height.toFixed(3), 'm; unit', unit, '; upper arm dir', V().fromArray(rest.leftLowerArm.p).sub(V().fromArray(rest.leftUpperArm.p)).normalize().toArray().map((x) => x.toFixed(2)).join(','));

// ---------------- sample every clip ----------------
let sampled = [];
for (let pass = 0; pass < 2; pass++) {
sampled = [];
for (const [name, file, folder, loop] of CLIPS) {
  if (pass === 0 && folder !== 'Root_Motion') continue;
  const fp = path.join(PACK, folder, file + '.fbx');
  if (!fs.existsSync(fp)) { console.warn('missing', fp); continue; }
  const obj = load(fp);
  const clip = obj.animations[0];
  const bones = bonesOf(obj);
  const miss = [...Object.values(BONES), 'root'].filter((b) => !bones[b]);
  if (miss.length) { console.warn(name, 'missing bones', miss.join(','), 'has', Object.keys(bones).slice(0, 8).join(',')); continue; }
  const mixer = new THREE.AnimationMixer(obj);
  mixer.clipAction(clip).play();
  const n = Math.max(2, Math.round(clip.duration * FPS) + 1);
  const quats = new Float32Array(n * NAMES.length * 4), pelvis = new Float32Array(n * 3), rm = new Float32Array(n * 4);
  const handR = [], handL = [], qHandR = [], feet = [];
  let root0 = null;
  for (let f = 0; f < n; f++) {
    mixer.setTime(Math.min(clip.duration, f / FPS));
    obj.updateMatrixWorld(true);
    const rw = world(bones.root);
    if (!root0) root0 = rw;
    // pose relative to the moving root bone, expressed as if the root were at rest; then the canonical frame
    const undo = Q().copy(rootRest.q).multiply(rw.q.clone().invert());
    for (let i = 0; i < NAMES.length; i++) {
      const w = world(bones[BONES[NAMES[i]]]);
      const q = Sinv.clone().multiply(undo).multiply(w.q);
      q.toArray(quats, (f * NAMES.length + i) * 4);
      const p = w.p.clone().sub(rw.p).applyQuaternion(undo).add(rootRest.p);
      const pc = toCanon(p).multiplyScalar(unit);
      if (NAMES[i] === 'hips') pc.toArray(pelvis, f * 3);
      if (NAMES[i] === 'rightHand') { handR.push(pc); qHandR.push(q); }
      if (NAMES[i] === 'leftHand') handL.push(pc);
      if (/Foot$|Toes$/.test(NAMES[i])) { if (!feet[f]) feet[f] = 9; feet[f] = Math.min(feet[f], pc.y); }
    }
    // root motion in the canonical frame, relative to the first frame
    const d = rw.p.clone().sub(root0.p).applyQuaternion(Sinv).multiplyScalar(unit);
    const dq = Sinv.clone().multiply(rw.q).multiply(root0.q.clone().invert()).multiply(Sinv.clone().invert());
    const e = new THREE.Euler().setFromQuaternion(dq, 'YXZ');
    rm[f * 4] = d.z; rm[f * 4 + 1] = d.x; rm[f * 4 + 2] = d.y; rm[f * 4 + 3] = e.y;
  }
  // two-handed weight per frame: 1 while the left hand is on the handle
  const two = new Float32Array(n);
  for (let f = 0; f < n; f++) { const d = handR[f].distanceTo(handL[f]); two[f] = Math.max(0, Math.min(1, (0.27 - d) / 0.09)); }
  // These files carry their travel in the pelvis (no root bone track). The root motion is the pelvis's ground track,
  // smoothed (0.4 s window) so steps and sway stay in the pose; it is taken out of the pose and kept as data.
  if (!loop) {
    const raw = [];
    for (let f = 0; f < n; f++) raw.push([pelvis[f * 3] - pelvis[0], pelvis[f * 3 + 2] - pelvis[2]]);
    const W = 6, sm = [];
    for (let f = 0; f < n; f++) { let x = 0, z = 0, c = 0; for (let k = -W; k <= W; k++) { const j = Math.min(n - 1, Math.max(0, f + k)); x += raw[j][0]; z += raw[j][1]; c++; } sm.push([x / c, z / c]); }
    const s0 = sm[0];
    // vertical: the lowest foot's height over the first frame's (planted feet stay on the floor; real leaps are kept
    // as vertical root motion for the game to use or ignore)
    for (let f = 0; f < n; f++) {
      const mx = sm[f][0] - s0[0], mz = sm[f][1] - s0[1], my = feet[f] - feet[0];
      rm[f * 4] = mz; rm[f * 4 + 1] = mx; rm[f * 4 + 2] = my; rm[f * 4 + 3] = 0;
      pelvis[f * 3] -= mx; pelvis[f * 3 + 1] -= my; pelvis[f * 3 + 2] -= mz;
      handR[f].x -= mx; handR[f].z -= mz; handL[f].x -= mx; handL[f].z -= mz; handR[f].y -= my; handL[f].y -= my;
    }
  }
  sampled.push({ name, loop: !!loop, n, dur: clip.duration, quats, pelvis, rm, handR, handL, qHandR, two });
}
if (pass === 0) {
  let fz = 0, fx = 0;
  for (const s of sampled) { const l = (s.n - 1) * 4; fz += s.rm[l]; fx += s.rm[l + 1]; }
  const yaw = Math.atan2(fx, fz);
  console.log('facing correction', (yaw * 57.3).toFixed(2), 'deg');
  Sinv = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -yaw).multiply(Sinv);
  for (const n of NAMES) {
    const w = restW[BONES[n]];
    rest[n] = { p: toCanon(w.p).multiplyScalar(unit).toArray().map((x) => +x.toFixed(5)), q: Sinv.clone().multiply(w.q).toArray().map((x) => +x.toFixed(6)) };
  }
}
}
const restOnly = {};
for (const n of Object.keys(REST_ONLY)) restOnly[n] = { p: toCanon(restW[REST_ONLY[n]].p).multiplyScalar(unit).toArray().map((x) => +x.toFixed(5)) };

// ---------------- the grip, from two-handed frames ----------------
const acc = V(); let cnt = 0;
for (const s of sampled) for (let f = 0; f < s.n; f++) {
  const d = s.handR[f].clone().sub(s.handL[f]);
  const len = d.length();
  if (len < 0.06 || len > 0.2) continue;                         // both hands on the handle
  acc.add(d.normalize().applyQuaternion(s.qHandR[f].clone().invert()));
  cnt++;
}
acc.normalize();
// the fist, in the right hand's frame: the handle lies along the knuckle row under the first finger bones
const restHandQ = Q().fromArray(rest.rightHand.q), restHandP = V().fromArray(rest.rightHand.p);
const inHand = (n) => V().fromArray(restOnly[n].p).sub(restHandP).applyQuaternion(restHandQ.clone().invert());
const K4 = ['Index', 'Middle', 'Ring', 'Little'].map((f) => inHand(`right${f}Proximal`));
const knuckles = K4.reduce((a, k) => a.add(k), V()).multiplyScalar(0.25);
const fistA = K4[0].clone().sub(K4[3]).normalize(), fistW = K4[0].distanceTo(K4[3]);
const fingerDir = knuckles.clone().addScaledVector(fistA, -knuckles.dot(fistA)).normalize();
const palmN = V().crossVectors(fistA, fingerDir).normalize();
if (palmN.dot(inHand('rightThumbProximal')) < 0) palmN.negate();          // the thumb sits on the palm side
const fistC = knuckles.clone().addScaledVector(fingerDir, 0.012).addScaledVector(palmN, 0.03);
console.log('fist centre', fistC.toArray().map((x) => x.toFixed(3)).join(','), 'axis little->index', fistA.toArray().map((x) => x.toFixed(2)).join(','), 'width', fistW.toFixed(3), 'palm normal', palmN.toArray().map((x) => x.toFixed(2)).join(','));
// the blade runs through the fist, out of the thumb side (a hammer grip): the knuckle row, little finger to index
const bladeLocal = fistA.clone();
// spread: how consistent the axis is
let spread = 0, sc = 0;
for (const s of sampled) for (let f = 0; f < s.n; f++) {
  const d = s.handR[f].clone().sub(s.handL[f]); const len = d.length();
  if (len < 0.06 || len > 0.2) continue;
  spread += Math.acos(Math.min(1, d.normalize().applyQuaternion(s.qHandR[f].clone().invert()).dot(bladeLocal))); sc++;
}
// the palm: a little past the wrist along the forearm (hand bone origin is the wrist)
const forearmLocal = V().fromArray(rest.rightHand.p).sub(V().fromArray(rest.rightLowerArm.p)).normalize().applyQuaternion(restHandQ.clone().invert());
const palmLocal = fistC.clone();
// edge: the direction the blade sweeps toward in fast frames, perpendicular to the blade
const BLADE = 0.8, GUARD = +(fistW / 2 + 0.022).toFixed(4);     // the tsuba sits just above the index finger
const tipAt = (s, f) => s.handR[f].clone().add(palmLocal.clone().applyQuaternion(s.qHandR[f])).add(bladeLocal.clone().applyQuaternion(s.qHandR[f]).multiplyScalar(GUARD + BLADE));
const edgeAcc = V();
for (const s of sampled) for (let f = 1; f < s.n; f++) {
  const vel = tipAt(s, f).sub(tipAt(s, f - 1)).multiplyScalar(FPS);
  if (vel.length() < 6) continue;
  const l = vel.applyQuaternion(s.qHandR[f].clone().invert());
  l.addScaledVector(bladeLocal, -l.dot(bladeLocal));
  edgeAcc.add(l.normalize());
}
const edgeMeasured = edgeAcc.clone().normalize();
// the edge leads with the knuckles: along the forearm, squared to the blade
const edgeLocal = forearmLocal.clone().addScaledVector(bladeLocal, -forearmLocal.dot(bladeLocal)).normalize();
console.log('edge measured from fast frames', edgeMeasured.toArray().map((x) => x.toFixed(2)).join(','));
// diagnostics: per clip two-handed axis in hand frame, angle to the forearm
if (process.env.GRIPDIAG) {
  for (const s2 of sampled) { const ac2 = V(); let c2 = 0; const ds = [];
    for (let f = 0; f < s2.n; f++) { const d = s2.handR[f].clone().sub(s2.handL[f]); const len = d.length(); if (len < 0.06 || len > 0.2) continue; const l = d.normalize().applyQuaternion(s2.qHandR[f].clone().invert()); ac2.add(l); c2++; ds.push(len); }
    if (c2) { ac2.normalize(); console.log('  ', s2.name.padEnd(12), c2, 'axis', ac2.toArray().map((x) => x.toFixed(2)).join(','), 'vs forearm', (Math.acos(ac2.dot(forearmLocal)) * 57.3).toFixed(0), 'dist', (ds.reduce((x, y) => x + y, 0) / ds.length).toFixed(3)); }
  }
  console.log('forearm local', forearmLocal.toArray().map((x) => x.toFixed(2)).join(','));
}
console.log(`grip from ${cnt} two-handed frames, spread ${(spread / Math.max(1, sc) * 57.3).toFixed(1)} deg; blade`, bladeLocal.toArray().map((x) => x.toFixed(3)).join(','), 'edge', edgeLocal.toArray().map((x) => x.toFixed(3)).join(','));

// ---------------- swings (hit windows + arc planes), as the Blender analysis ----------------
const thr = 8.0 * height / 1.72;
for (const s of sampled) {
  const tips = [], speed = [0];
  for (let f = 0; f < s.n; f++) tips.push(tipAt(s, f));
  for (let f = 1; f < s.n; f++) speed.push(tips[f].distanceTo(tips[f - 1]) * FPS);
  const centers = [], hips = [];
  for (let f = 0; f < s.n; f++) {
    // chest centre ~ between the shoulders; approximate with pelvis + 0.45 m up
    hips.push(V().fromArray(s.pelvis, f * 3));
    centers.push(V().fromArray(s.pelvis, f * 3).add(V(0, 0.42, 0)));
  }
  const ranges = [];
  let i = 0;
  while (i < speed.length) {
    if (speed[i] > thr) {
      let j = i;
      while (j + 1 < speed.length && (speed[j + 1] > thr || (j + 2 < speed.length && speed[j + 2] > thr))) j++;
      if (j - i >= 1) ranges.push([i - 1, j]);
      i = j + 1;
    } else i++;
  }
  s.swings = [];
  for (let [a, b] of ranges) {
    a = Math.max(a, 0);
    const c = V();
    for (let k = a; k <= b; k++) c.add(centers[k]);
    c.divideScalar(b - a + 1);
    const nrm = V();
    for (let k = a; k < b; k++) nrm.add(V().crossVectors(tips[k].clone().sub(c), tips[k + 1].clone().sub(c)));
    if (nrm.length() < 1e-6) continue;
    nrm.normalize();
    const u = tips[a].clone().sub(c); u.addScaledVector(nrm, -u.dot(nrm)).normalize();
    const v = V().crossVectors(nrm, u);
    let ang = 0, r = 0, reach = 0, h0 = 9, h1 = -9;
    for (let k = a; k < b; k++) {
      const p0 = tips[k].clone().sub(c), p1 = tips[k + 1].clone().sub(c);
      p0.addScaledVector(nrm, -p0.dot(nrm)); p1.addScaledVector(nrm, -p1.dot(nrm));
      ang += Math.atan2(V().crossVectors(p0, p1).dot(nrm), p0.dot(p1));
    }
    for (let k = a; k <= b; k++) {
      const p = tips[k].clone().sub(c); p.addScaledVector(nrm, -p.dot(nrm)); r += p.length();
      const dx = tips[k].x - hips[k].x, dz = tips[k].z - hips[k].z;
      reach = Math.max(reach, Math.hypot(dx, dz));
      const h = Math.atan2(dx, dz); h0 = Math.min(h0, h); h1 = Math.max(h1, h);
    }
    r /= b - a + 1;
    const R4 = (x) => +x.toFixed(4);
    s.swings.push({ t0: +(a / FPS).toFixed(3), t1: +(b / FPS).toFixed(3), peak: +(Math.max(...speed.slice(a, b + 1)) / height * 1.72).toFixed(1),
      c: c.toArray().map(R4), u: u.toArray().map(R4), v: v.toArray().map(R4), a1: +ang.toFixed(3), r: +r.toFixed(3),
      reach: +reach.toFixed(2), h0: +h0.toFixed(2), h1: +h1.toFixed(2) });
  }
}

// ---------------- write ----------------
const parts = [];
let off = 0;
const clips = {};
for (const s of sampled) {
  const q16 = new Int16Array(s.quats.length);
  for (let i = 0; i < s.quats.length; i++) q16[i] = Math.round(Math.max(-1, Math.min(1, s.quats[i])) * 32767);
  const rec = { n: s.n, dur: +s.dur.toFixed(4), loop: s.loop, q: off };
  parts.push(Buffer.from(q16.buffer)); off += q16.byteLength;
  rec.pelvis = off; parts.push(Buffer.from(s.pelvis.buffer)); off += s.pelvis.byteLength;
  rec.rm = off; parts.push(Buffer.from(s.rm.buffer)); off += s.rm.byteLength;
  rec.two = off; parts.push(Buffer.from(s.two.buffer)); off += s.two.byteLength;
  const last = (s.n - 1) * 4;
  rec.travel = [+s.rm[last].toFixed(3), +s.rm[last + 1].toFixed(3), +s.rm[last + 2].toFixed(3), +s.rm[last + 3].toFixed(3)];
  rec.swings = s.swings;
  clips[s.name] = rec;
}
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'katana.bin'), Buffer.concat(parts));
fs.writeFileSync(path.join(OUT, 'katana.json'), JSON.stringify({
  fps: FPS, bones: NAMES, rest, restOnly, height: +height.toFixed(3), blade: BLADE, guard: GUARD,
  grip: { blade: bladeLocal.toArray().map((x) => +x.toFixed(4)), edge: edgeLocal.toArray().map((x) => +x.toFixed(4)), palm: palmLocal.toArray().map((x) => +x.toFixed(4)),
    fist: fistC.toArray().map((x) => +x.toFixed(4)), fistAxis: fistA.toArray().map((x) => +x.toFixed(4)), fistWidth: +fistW.toFixed(4), palmNormal: palmN.toArray().map((x) => +x.toFixed(4)) },
  clips,
}));
console.log(`wrote ${sampled.length} clips, ${(off / 1024).toFixed(0)} KB`);
for (const s of sampled) console.log(s.name.padEnd(13), s.dur.toFixed(2) + 's', 'travel', clips[s.name].travel.slice(0, 3).map((x) => x.toFixed(2)).join(','), 'yaw', clips[s.name].travel[3].toFixed(2), 'swings', s.swings.map((w) => `${w.t0}-${w.t1}`).join(' '));
