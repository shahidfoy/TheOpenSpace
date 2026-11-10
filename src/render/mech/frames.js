import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// The player's mech frames, prepared at load from the artists' files (credits in public/models/CREDITS.txt):
//   x12    "X-12 Mech" by dronemaster: 193 loose hard-surface parts with no skeleton. A skeleton is placed from
//          measured joint positions and every part is hung rigidly on one bone, so nothing stretches; the parts are
//          merged into one skinned mesh per material.
//   omega  "Omega knight" by Professor_E12: an armoured suit that comes with a full skeleton (fingers included).
//          It is stood on the origin facing +Z and its hands are closed around the weapons.
// Both come without animation: every clip is retargeted onto them at load from the clip packs (chars/katanaPack.js).
// Each returns the asset shape SkinnedMechBody takes: { gltf: { scene, animations }, meta: { height, blade, clips,
// loops }, bones: canonical bone -> node name, hands: { left, right } }.

export const FRAMES = [
  { id: 'x12', name: 'X-12', blurb: 'Assault mech', by: 'dronemaster' },
  { id: 'omega', name: 'OMEGA', blurb: 'Armoured flight suit', by: 'Professor_E12' },
];
const FRAME_KEY = 'openspace_mech_frame';
export function loadFrame() {
  let id = null;
  try { id = localStorage.getItem(FRAME_KEY); } catch { /* private mode */ }
  return FRAMES.some((f) => f.id === id) ? id : FRAMES[0].id;
}
export function saveFrame(id) { try { localStorage.setItem(FRAME_KEY, id); } catch { /* ignore */ } }

const LOOPS = ['idle', 'walk', 'walk_b', 'run', 'sprint', 'fall'];
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const MIXAMO = {
  hips: 'Hips', spine: 'Spine1', chest: 'Spine2', neck: 'Neck', head: 'Head',
  leftShoulder: 'LeftShoulder', leftUpperArm: 'LeftArm', leftLowerArm: 'LeftForeArm', leftHand: 'LeftHand',
  rightShoulder: 'RightShoulder', rightUpperArm: 'RightArm', rightLowerArm: 'RightForeArm', rightHand: 'RightHand',
  leftUpperLeg: 'LeftUpLeg', leftLowerLeg: 'LeftLeg', leftFoot: 'LeftFoot', leftToes: 'LeftToeBase',
  rightUpperLeg: 'RightUpLeg', rightLowerLeg: 'RightLeg', rightFoot: 'RightFoot', rightToes: 'RightToeBase',
};

// ---------------------------------------------------------------- X-12
// Joints in the model's own units (18 tall), the mech centred on x = 0, z = 0, facing +Z, +X its left.
const X12_C = [28.0, -11.9];                      // the file's centre line (x, z)
const X12_J = {
  Hips: [0, 9.6, 0], Spine1: [0, 11.4, 0], Spine2: [0, 13.2, 0], Neck: [0, 15.6, 0.2], Head: [0, 16.3, 0.2],
  LeftShoulder: [1.5, 14.9, 0], LeftArm: [3.0, 14.9, -0.3], LeftForeArm: [3.55, 12.9, -0.4], LeftHand: [4.0, 10.95, 0.55],
  LeftUpLeg: [1.9, 9.1, 0], LeftLeg: [2.4, 5.3, 0.1], LeftFoot: [3.3, 1.9, -0.3], LeftToeBase: [3.5, 0.5, 1.4],
};
const X12_PARENT = { Spine1: 'Hips', Spine2: 'Spine1', Neck: 'Spine2', Head: 'Neck', Shoulder: 'Spine2', Arm: 'Shoulder', ForeArm: 'Arm', Hand: 'ForeArm', UpLeg: 'Hips', Leg: 'UpLeg', Foot: 'Leg', ToeBase: 'Foot' };

// the bone a part belongs to, from where it sits (p: centre in mech space) and the name of the group it came in
function x12Bone(p, group) {
  const side = p.x >= 0 ? 'Left' : 'Right', ax = Math.abs(p.x), y = p.y;
  if (/^Head/.test(group)) return 'Head';
  if (/^Shoulder|^upper_ar/.test(group)) return side + 'Arm';
  if (/^elbow|^lower_ar/.test(group)) return side + 'ForeArm';
  // arms: outside the torso, between shoulder and fist
  if (ax > 3.05 && y > 9.3 && y < 16.5) {
    if (y > 13.0) return side + 'Arm';
    if (y > 11.0 || ax > 4.55) return side + 'ForeArm';        // the shield rides the forearm
    return side + 'Hand';
  }
  // legs
  if (y < 9.2 && ax > 0.55) {
    if (y < 2.9) return side + (p.z > 1.3 && y < 1.4 ? 'ToeBase' : 'Foot');
    if (y < 5.4) return side + 'Leg';
    if (y < 8.6 || ax > 1.2) return side + 'UpLeg';
  }
  if (y < 10.9) return 'Hips';
  if (y < 12.6) return 'Spine1';
  if (y < 15.7) return 'Spine2';
  return 'Head';
}

// connected pieces of a geometry: vertices at the same place count as one (hard edges split them in the file)
function pieces(geo) {
  const P = geo.attributes.position, N = P.count, par = new Int32Array(N);
  for (let i = 0; i < N; i++) par[i] = i;
  const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  const seen = new Map();
  for (let i = 0; i < N; i++) {
    const k = `${Math.round(P.getX(i) * 200)},${Math.round(P.getY(i) * 200)},${Math.round(P.getZ(i) * 200)}`;
    const j = seen.get(k);
    if (j === undefined) seen.set(k, i); else par[find(i)] = find(j);
  }
  const idx = geo.index;
  const tri = idx ? idx.count / 3 : N / 3, at = (t, k) => (idx ? idx.getX(t * 3 + k) : t * 3 + k);
  for (let t = 0; t < tri; t++) { const a = find(at(t, 0)); par[find(at(t, 1))] = a; par[find(at(t, 2))] = a; }
  return find;
}

export function buildX12(gltf) {
  const src = gltf.scene;
  src.updateMatrixWorld(true);
  const bones = {}, order = [];
  const add = (name, p, parent) => {
    const b = new THREE.Bone(); b.name = name;
    b.userData.world = V(...p);
    b.position.copy(b.userData.world).sub(parent ? parent.userData.world : V(0, 0, 0));
    (parent || rig).add(b); bones[name] = b; order.push(b);
    return b;
  };
  const scene = new THREE.Group(); scene.name = 'mech_x12';
  const rig = new THREE.Group(); rig.name = 'rig'; scene.add(rig);
  for (const n of ['Hips', 'Spine1', 'Spine2', 'Neck', 'Head']) add(n, X12_J[n], bones[X12_PARENT[n]]);
  for (const side of ['Left', 'Right']) for (const n of ['Shoulder', 'Arm', 'ForeArm', 'Hand', 'UpLeg', 'Leg', 'Foot', 'ToeBase']) {
    const p = X12_J['Left' + n].slice(); if (side === 'Right') p[0] = -p[0];
    const pn = X12_PARENT[n];
    add(side + n, p, bones[/^(Hips|Spine|Neck)/.test(pn) ? pn : side + pn]);
  }
  const boneIndex = Object.fromEntries(order.map((b, i) => [b.name, i]));

  // every mesh into mech space, split into pieces, each piece on one bone
  const byMat = new Map(), c = V(), p = V();
  const toMech = new THREE.Matrix4().makeTranslation(-X12_C[0], 0, -X12_C[1]);
  src.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(toMech, o.matrixWorld));
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
    if (!g.attributes.normal) g.computeVertexNormals();
    // the group this mesh came in (a compact, named assembly moves as one)
    let grp = o.parent; while (grp && /^Object_/.test(grp.name)) grp = grp.parent;
    const group = grp?.name || '';
    const P = g.attributes.position, N = P.count, find = pieces(g);
    const sum = new Map();
    for (let i = 0; i < N; i++) { const r = find(i); let s = sum.get(r); if (!s) sum.set(r, (s = [0, 0, 0, 0, 1e9, -1e9])); s[0] += P.getX(i); s[1] += P.getY(i); s[2] += P.getZ(i); s[3]++; s[4] = Math.min(s[4], P.getX(i)); s[5] = Math.max(s[5], P.getX(i)); }
    g.computeBoundingBox();
    const bb = g.boundingBox, whole = /^(Head|Shoulder|upper_ar|elbow|lower_ar)/.test(group) || (bb.max.x - bb.min.x < 3 && bb.max.y - bb.min.y < 3.2 && bb.min.x * bb.max.x >= -0.04);
    bb.getCenter(c);
    const si = new Uint16Array(N * 4), sw = new Float32Array(N * 4), cache = new Map();
    for (let i = 0; i < N; i++) {
      let b;
      if (whole) b = cache.get(0) ?? (cache.set(0, boneIndex[x12Bone(c, group)]), cache.get(0));
      else {
        const r = find(i);
        b = cache.get(r);
        if (b === undefined) {
          const s = sum.get(r);
          p.set(s[0] / s[3], s[1] / s[3], s[2] / s[3]);
          // a piece that straddles the centre line belongs to the body's own centre
          if (s[4] < -0.3 && s[5] > 0.3) p.x = 0;
          cache.set(r, (b = boneIndex[x12Bone(p, '')]));
        }
      }
      si[i * 4] = b; sw[i * 4] = 1;
    }
    g.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
    g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
    const list = byMat.get(o.material) || []; list.push(g.index ? g.toNonIndexed() : g); byMat.set(o.material, list);
  });
  scene.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(order);
  for (const [mat, list] of byMat) {
    // painted armour: the file's pure whites are pulled under the bloom threshold
    if (mat.color) { const l = Math.max(mat.color.r, mat.color.g, mat.color.b); if (l > 0.6) mat.color.multiplyScalar(0.6 / l); }
    mat.roughness = 0.5; mat.metalness = 0.25;
    const m = new THREE.SkinnedMesh(mergeGeometries(list, false), mat);
    m.name = 'x12_' + mat.name;
    scene.add(m);
    m.bind(skeleton, new THREE.Matrix4());
  }
  // the fists: closed blocks hanging at the sides, thumbs forward. In the hand bones' frame (world axes at rest)
  const hand = (s) => ({ dir: V(0, -1, 0), axis: V(0, 0, 1), centre: V(0, -0.62, 0.05), knuckle: V(s * 0.25, -0.5, 0.05), half: 0.3 });
  return {
    gltf: { scene, animations: [] }, meta: { height: 17.96, blade: 9.4, clips: {}, loops: LOOPS.slice() },
    bones: MIXAMO, hands: { left: hand(1), right: hand(-1) },
  };
}

// ---------------------------------------------------------------- Omega
const UE = {
  hips: 'pelvis', spine: 'spine_02', chest: 'spine_04', neck: 'neck_01', head: 'head',
  leftShoulder: 'clavicle_l', leftUpperArm: 'upperarm_l', leftLowerArm: 'lowerarm_l', leftHand: 'hand_l',
  rightShoulder: 'clavicle_r', rightUpperArm: 'upperarm_r', rightLowerArm: 'lowerarm_r', rightHand: 'hand_r',
  leftUpperLeg: 'thigh_l', leftLowerLeg: 'calf_l', leftFoot: 'foot_l', leftToes: 'ball_l',
  rightUpperLeg: 'thigh_r', rightLowerLeg: 'calf_r', rightFoot: 'foot_r', rightToes: 'ball_r',
};
const CURL = [1.15, 1.45, 1.0], THUMB = [0.5, 0.45, 0.5];

export function buildOmega(gltf) {
  const src = gltf.scene;
  src.updateMatrixWorld(true);
  // the exporter suffixes every joint with its index: find them by their plain names
  const byName = {};
  src.traverse((o) => { if (o.isBone) byName[o.name.replace(/_\d+$/, '')] = o; });
  const node = (n) => byName[n] || null;
  const map = {};
  for (const [k, n] of Object.entries(UE)) { if (!node(n)) return null; map[k] = node(n).name; }
  const W = (n) => new THREE.Vector3().setFromMatrixPosition(node(n).matrixWorld);
  // stand it on the origin, facing +Z, in a wrapper (the skeleton's own transforms stay as authored)
  const left = W('thigh_l').sub(W('thigh_r')).setY(0).normalize();
  const yaw = Math.atan2(left.z, left.x);                       // turn `left` onto +X
  const scene = new THREE.Group(); scene.name = 'mech_omega';
  scene.add(src);
  src.rotation.y += yaw; src.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(src);
  src.position.x -= (box.min.x + box.max.x) / 2; src.position.z -= (W('thigh_l').z + W('thigh_r').z) / 2; src.position.y -= box.min.y;
  scene.updateMatrixWorld(true);
  const height = box.max.y - box.min.y;
  src.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });

  // hands, in each hand bone's frame: the knuckle row, the way the fingers point, where a handle sits in the fist
  const hands = {};
  for (const [side, s] of [['left', 'l'], ['right', 'r']]) {
    const hb = node(`hand_${s}`), inv = new THREE.Matrix4().copy(hb.matrixWorld).invert();
    const L = (n) => W(n).applyMatrix4(inv);
    const K = ['index', 'middle', 'ring', 'pinky'].map((f) => L(`${f}_01_${s}`));
    const knuckle = K.reduce((a, k) => a.add(k), V(0, 0, 0)).multiplyScalar(0.25);
    const axis = K[0].clone().sub(K[3]).normalize(), half = K[0].distanceTo(K[3]) / 2;
    const dir = knuckle.clone().addScaledVector(axis, -knuckle.dot(axis)).normalize();
    const palm = new THREE.Vector3().crossVectors(axis, dir).normalize();
    if (palm.dot(L(`thumb_02_${s}`).sub(knuckle)) < 0) palm.negate();          // the thumb sits on the palm side
    const centre = knuckle.clone().addScaledVector(dir, half * 0.36).addScaledVector(palm, half * 0.8);
    hands[side] = { dir, axis, centre, knuckle, half };
    // close the fingers: each joint flexes toward the palm, about an axis found in its own frame
    const k = side === 'right' ? 1 : 0.8;
    for (const f of ['index', 'middle', 'ring', 'pinky', 'thumb']) {
      for (let i = 1; i <= 3; i++) {
        const j = node(`${f}_0${i}_${s}`), c = node(`${f}_0${Math.min(3, i + 1)}_${s}`);
        if (!j) continue;
        const ji = new THREE.Matrix4().copy(j.matrixWorld).invert();
        const d = i < 3 ? W(c.name.replace(/_\d+$/, '')).applyMatrix4(ji).normalize() : j.userData.flexDir;
        const hq = new THREE.Quaternion().setFromRotationMatrix(hb.matrixWorld), jq = new THREE.Quaternion().setFromRotationMatrix(j.matrixWorld);
        const pn = palm.clone().applyQuaternion(hq).applyQuaternion(jq.invert());
        if (i < 3 && c) c.userData.flexDir = d.clone();
        if (!d) continue;
        const ax = new THREE.Vector3().crossVectors(d, pn).normalize();
        j.userData.flex = { ax, a: (f === 'thumb' ? THUMB : CURL)[i - 1] * k };
      }
    }
  }
  src.traverse((o) => { if (o.userData.flex) o.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(o.userData.flex.ax, o.userData.flex.a)); });
  scene.updateMatrixWorld(true);
  return {
    gltf: { scene, animations: [] }, meta: { height, blade: height * 0.52, clips: {}, loops: LOOPS.slice() },
    bones: map, hands, fingers: true,
  };
}
