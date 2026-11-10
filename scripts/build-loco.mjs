// Builds public/characters/anims/loco.{json,bin}: Mixamo locomotion loops in the same pack format as the katana pack
// (see build-katana.mjs), so the game retargets them onto any humanoid with retargetPack(). The mech's walk and
// sprint come from here: retargeted at load with the same direction-aligned method as its sword clips, they keep
// the body upright and the hands in line with the forearms.
//
//   node scripts/build-loco.mjs [assetsDir]        (default D:/TAMAMO/game-assets)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.argv[2] || 'D:/TAMAMO/game-assets';
const OUT = path.join(ROOT, 'public/characters/anims');
globalThis.self = globalThis; globalThis.window = globalThis;
const stub = () => ({ style: {}, addEventListener() {}, removeEventListener() {} });
globalThis.document = { createElementNS: stub, createElement: stub };
const THREE = await import(`file:///${ROOT}/node_modules/three/build/three.module.js`);
const { FBXLoader } = await import(`file:///${ROOT}/node_modules/three/examples/jsm/loaders/FBXLoader.js`);

const FPS = 30;
const M = (n) => 'mixamorig' + n;
const BONES = {
  hips: M('Hips'), spine: M('Spine'), chest: M('Spine2'), neck: M('Neck'), head: M('Head'),
  leftShoulder: M('LeftShoulder'), leftUpperArm: M('LeftArm'), leftLowerArm: M('LeftForeArm'), leftHand: M('LeftHand'),
  rightShoulder: M('RightShoulder'), rightUpperArm: M('RightArm'), rightLowerArm: M('RightForeArm'), rightHand: M('RightHand'),
  leftUpperLeg: M('LeftUpLeg'), leftLowerLeg: M('LeftLeg'), leftFoot: M('LeftFoot'), leftToes: M('LeftToeBase'),
  rightUpperLeg: M('RightUpLeg'), rightLowerLeg: M('RightLeg'), rightFoot: M('RightFoot'), rightToes: M('RightToeBase'),
};
const NAMES = Object.keys(BONES);
const REST_ONLY = {};
for (const S of ['Left', 'Right']) {
  const s = S.toLowerCase();
  for (const [vr, mx] of [['Index', 'Index'], ['Middle', 'Middle'], ['Ring', 'Ring'], ['Little', 'Pinky']]) REST_ONLY[`${s}${vr}Proximal`] = M(`${S}Hand${mx}1`);
  REST_ONLY[`${s}ThumbProximal`] = M(`${S}HandThumb2`);
}
// [game name, file, one-shot]: loops are played in place; one-shots keep their own travel (a fall backwards)
const CLIPS = [
  ['walk', 'mech/mixamo/Walking.fbx'],
  ['walk_b', 'mech/mixamo/Walking Backwards.fbx'],
  ['sprint', 'characters/anims/Fast Run.fbx'],
  ['fall', 'mech/mixamo/Falling Idle.fbx'],
  ['jump', 'characters/anims/Jump.fbx', 'xz'],           // 'xz': only the vertical motion is kept
  ['land', 'mech/mixamo/Hard Landing.fbx', 'xz'],
  ['big_hit', 'mech/mixamo/Big Stomach Hit.fbx', true],
  ['knockdown', 'noir/arena/anims/Livershot Knockdown.fbx', true],
  ['getup', 'noir/arena/anims/Getting Up.fbx', true],
  ['death', 'noir/arena/anims/Dying Backwards.fbx', true],
];

const load = (file) => {
  const b = fs.readFileSync(file);
  return new FBXLoader().parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), '');
};
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z), Q = () => new THREE.Quaternion();
const bonesOf = (o) => { const m = {}; o.traverse((x) => { if (x.isBone) m[x.name] = x; }); return m; };
const world = (b) => { const p = V(), q = Q(), s = V(); b.matrixWorld.decompose(p, q, s); return { p, q }; };

// rest pose (the FBX bind pose, before any clip plays) and the canonical frame: X left, Y up, Z forward
const first = load(path.join(SRC, CLIPS[0][1]));
first.updateMatrixWorld(true);
const fb = bonesOf(first);
const restW = {};
for (const n of [...Object.values(BONES), ...Object.values(REST_ONLY)]) { if (fb[n]) restW[n] = world(fb[n]); }
const left = restW[BONES.leftUpperLeg].p.clone().sub(restW[BONES.rightUpperLeg].p).normalize();
const up = restW[BONES.head].p.clone().sub(restW[BONES.hips].p); up.addScaledVector(left, -up.dot(left)).normalize();
const fwd = V().crossVectors(left, up);
const Sinv = Q().setFromRotationMatrix(new THREE.Matrix4().makeBasis(left, up, fwd)).invert();
const floor = Math.min(restW[BONES.leftToes].p.y, restW[BONES.rightToes].p.y);
const origin = V(restW[BONES.hips].p.x, floor, restW[BONES.hips].p.z);
const toCanon = (p) => p.clone().sub(origin).applyQuaternion(Sinv);
const unit = toCanon(restW[BONES.head].p).y > 10 ? 0.01 : 1;
const R5 = (x) => +x.toFixed(5);
const rest = {}, restOnly = {};
for (const n of NAMES) rest[n] = { p: toCanon(restW[BONES[n]].p).multiplyScalar(unit).toArray().map(R5), q: Sinv.clone().multiply(restW[BONES[n]].q).toArray().map((x) => +x.toFixed(6)) };
for (const n of Object.keys(REST_ONLY)) if (restW[REST_ONLY[n]]) restOnly[n] = { p: toCanon(restW[REST_ONLY[n]].p).multiplyScalar(unit).toArray().map(R5) };
const height = rest.head.p[1] - Math.min(rest.leftFoot.p[1], rest.rightFoot.p[1]) + 0.12;
console.log('rest height', height.toFixed(3), 'm; hips', rest.hips.p.join(','));

const parts = [], clips = {};
let off = 0;
for (const [name, file, once] of CLIPS) {
  const fp = path.join(SRC, file);
  if (!fs.existsSync(fp)) { console.warn('missing', fp); continue; }
  const obj = load(fp);
  const clip = obj.animations.find((a) => a.name === 'mixamo.com') || obj.animations[0];
  const bones = {};
  for (const [k, b] of Object.entries(bonesOf(obj))) bones[k.replace(/^mixamorigd*:?/, 'mixamorig')] = b;
  if (Object.values(BONES).some((b) => !bones[b])) { console.warn(name, 'missing bones'); continue; }
  const mixer = new THREE.AnimationMixer(obj);
  mixer.clipAction(clip).play();
  // a loop's last frame equals its first: sample one period without the duplicate
  const n = Math.max(2, Math.round(clip.duration * FPS) + 1);
  const quats = new Float32Array(n * NAMES.length * 4), pelvis = new Float32Array(n * 3);
  for (let f = 0; f < n; f++) {
    mixer.setTime(Math.min(clip.duration - 1e-4, f / FPS));
    obj.updateMatrixWorld(true);
    for (let i = 0; i < NAMES.length; i++) {
      const w = world(bones[BONES[NAMES[i]]]);
      Sinv.clone().multiply(w.q).toArray(quats, (f * NAMES.length + i) * 4);
      if (NAMES[i] === 'hips') toCanon(w.p).multiplyScalar(unit).toArray(pelvis, f * 3);
    }
  }
  // in place: take the pelvis's steady drift out, and its average sideways offset
  const l = (n - 1) * 3, dx = pelvis[l] - pelvis[0], dz = pelvis[l + 2] - pelvis[2];
  let mx = 0;
  if (once === 'xz') { for (let f = 0; f < n; f++) { pelvis[f * 3] = pelvis[0]; pelvis[f * 3 + 2] = pelvis[2]; } mx = pelvis[0]; }
  else if (once) { mx = pelvis[0]; }
  else for (let f = 0; f < n; f++) { const k = f / (n - 1); pelvis[f * 3] -= dx * k; pelvis[f * 3 + 2] -= dz * k; mx += pelvis[f * 3] / n; }
  const z0 = pelvis[2];
  for (let f = 0; f < n; f++) { pelvis[f * 3] -= mx; pelvis[f * 3 + 2] -= z0 - rest.hips.p[2]; }
  const q16 = new Int16Array(quats.length);
  for (let i = 0; i < quats.length; i++) q16[i] = Math.round(Math.max(-1, Math.min(1, quats[i])) * 32767);
  const rec = { n, dur: +clip.duration.toFixed(4), loop: !once, q: off };
  parts.push(Buffer.from(q16.buffer)); off += q16.byteLength;
  if (off % 4) { const pad = 4 - (off % 4); parts.push(Buffer.alloc(pad)); off += pad; }
  rec.pelvis = off; parts.push(Buffer.from(pelvis.buffer)); off += pelvis.byteLength;
  rec.rm = off; parts.push(Buffer.alloc(n * 16)); off += n * 16;
  rec.travel = [+(Math.hypot(dx, dz)).toFixed(3), 0, 0, 0];      // metres walked per loop: the speed the feet match
  rec.swings = [];
  clips[name] = rec;
  console.log(name.padEnd(8), clip.duration.toFixed(2) + 's', n, 'frames, stride', rec.travel[0], 'm per loop =', (rec.travel[0] / clip.duration).toFixed(2), 'm/s at', height.toFixed(2), 'm tall');
}
fs.writeFileSync(path.join(OUT, 'loco.bin'), Buffer.concat(parts));
fs.writeFileSync(path.join(OUT, 'loco.json'), JSON.stringify({ fps: FPS, bones: NAMES, rest, restOnly, height: +height.toFixed(3), blade: 0.8, guard: 0.05, clips }));
console.log(`wrote ${Object.keys(clips).length} clips, ${(off / 1024).toFixed(0)} KB`);
