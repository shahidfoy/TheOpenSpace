import * as THREE from 'three';

// The anime katana pack (built by scripts/build-katana.mjs from the UE5-mannequin FBX clips) and its retargeter.
// The pack stores, per clip at 30 fps, every bone's rotation in a canonical character frame (X = left, Y = up,
// Z = forward), the pelvis position, root motion (forward / left / up, taken out of the pose) and the detected blade
// swings. retargetPack() turns it into AnimationClips for any humanoid rig, the VRM characters and the NEXORION
// mech alike. Each bone gets the source's rotation change from its rest pose, on top of an alignment that turns the
// target's rest bone onto the source's, so A/T-pose, stance and facing differences cancel; feet stay planted because
// the root motion drives the character instead of being baked into the pose.

const BASE = '/characters/anims/';
const PACKS = {};
// 'katana': the sword pack; 'loco': Mixamo locomotion loops in the same format (scripts/build-loco.mjs)
export function loadPack(name) {
  return (PACKS[name] ||= Promise.all([fetch(`${BASE}${name}.json`).then((r) => r.json()), fetch(`${BASE}${name}.bin`).then((r) => r.arrayBuffer())])
    .then(([json, bin]) => ({ json, bin })));
}
export const loadKatanaPack = () => loadPack('katana');

// bone -> the bone whose position gives its direction
const CHILD = {
  spine: 'chest', chest: 'neck', neck: 'head',
  leftShoulder: 'leftUpperArm', leftUpperArm: 'leftLowerArm', leftLowerArm: 'leftHand',
  rightShoulder: 'rightUpperArm', rightUpperArm: 'rightLowerArm', rightLowerArm: 'rightHand',
  leftUpperLeg: 'leftLowerLeg', leftLowerLeg: 'leftFoot', leftFoot: 'leftToes',
  rightUpperLeg: 'rightLowerLeg', rightLowerLeg: 'rightFoot', rightFoot: 'rightToes',
  leftHand: 'leftMiddleProximal', rightHand: 'rightMiddleProximal',
};

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _v = new THREE.Vector3(), _m = new THREE.Matrix4();
const v3 = (a) => new THREE.Vector3().fromArray(a);
function frameQuat(left, right, hips, head) {
  const X = left.clone().sub(right).normalize();
  const Y = head.clone().sub(hips); Y.addScaledVector(X, -Y.dot(X)).normalize();
  const Z = new THREE.Vector3().crossVectors(X, Y);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, Y, Z));
}

// A rig adapter describes the target:
//   node(b)      the Object3D animated for canonical bone b (or null)
//   root         the Object3D whose frame the rig is measured in (tracks' parent chain starts below it)
//   G            quaternion: canonical frame (facing +Z) -> root frame (e.g. a VRM 0.x scene faces -Z: a half turn)
//   point(b)     optional: rest position (root frame) of a canonical bone the rig has no node for. A rig without
//                finger bones gives its hands a direction with 'leftMiddleProximal' / 'rightMiddleProximal'
//   names        optional subset of clip names
// Returns { clips: { name: AnimationClip }, meta: { height, clips: { name: { dur, swings } } }, rm: { name: {...} },
//           grip: { q, p, length }, scale }.
export function retargetPack(pack, rig, names = null) {
  const { json, bin } = pack;
  const B = json.bones;
  const root = rig.root;
  root.updateMatrixWorld(true);
  const rootInv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  // target rest, in the root frame
  const tRestQ = {}, tRestP = {}, node = {};
  for (const b of B) {
    const n = rig.node(b);
    if (!n) continue;
    node[b] = n;
    _m.multiplyMatrices(rootInv, n.matrixWorld);
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    _m.decompose(p, q, s);
    tRestQ[b] = q; tRestP[b] = p;
  }
  const G = rig.G || new THREE.Quaternion(), Ginv = G.clone().invert();
  // source rest (canonical)
  const sQ = {}, sP = {};
  for (const b of B) { sQ[b] = new THREE.Quaternion().fromArray(json.rest[b].q); sP[b] = v3(json.rest[b].p); }
  // target rest positions seen in the canonical frame
  const tC = {};
  for (const b of B) if (tRestP[b]) tC[b] = tRestP[b].clone().applyQuaternion(Ginv);
  // knuckles: rest positions only (the pack does not animate fingers); they give the hands direction and roll
  for (const b of Object.keys(json.restOnly || {})) {
    sP[b] = v3(json.restOnly[b].p);
    const n = rig.node(b);
    const p = n ? new THREE.Vector3().setFromMatrixPosition(_m.multiplyMatrices(rootInv, n.matrixWorld)) : rig.point?.(b);
    if (p) tC[b] = p.clone().applyQuaternion(Ginv);
  }
  const qFace = frameQuat(sP.leftUpperLeg, sP.rightUpperLeg, sP.hips, sP.head)
    .multiply(frameQuat(tC.leftUpperLeg, tC.rightUpperLeg, tC.hips, tC.head).invert());
  const align = {}, sRestInv = {};
  for (const b of B) {
    if (!node[b]) continue;
    const c = CHILD[b];
    // target rest bone frame in the canonical frame: G^-1 * Rt
    const tq = Ginv.clone().multiply(tRestQ[b]);
    let A;
    if (c && tC[c]) {
      const dt = tC[c].clone().sub(tC[b]).normalize().applyQuaternion(qFace);
      const ds = sP[c].clone().sub(sP[b]).normalize();
      A = new THREE.Quaternion().setFromUnitVectors(dt, ds).multiply(qFace);
      // hands: the direction alone leaves the roll about it open; square the knuckle row (little -> index) too, so
      // the palm faces the way the source's does
      const side = /^(left|right)Hand$/.exec(b)?.[1];
      const i = side && `${side}IndexProximal`, l = side && `${side}LittleProximal`;
      if (side && tC[i] && tC[l]) {
        const at = tC[i].clone().sub(tC[l]).applyQuaternion(A), as = sP[i].clone().sub(sP[l]);
        at.addScaledVector(ds, -at.dot(ds)).normalize(); as.addScaledVector(ds, -as.dot(ds)).normalize();
        A.premultiply(new THREE.Quaternion().setFromUnitVectors(at, as));
      }
    } else A = qFace.clone();
    // W_target(t) = G * Qs(t) * Qs_rest^-1 * A * (G^-1 Rt)   ->  at rest: G * A * G^-1 Rt
    align[b] = A.multiply(tq);
    sRestInv[b] = sQ[b].clone().invert();
  }
  // parent chain: nearest mapped ancestor, and the rest offset through unmapped bones in between
  const parentOf = {}, through = {};
  for (const b of B) {
    if (!node[b]) continue;
    let p = node[b].parent, found = null;
    while (p && p !== root && !found) { found = B.find((x) => node[x] === p) || null; if (!found) p = p.parent; }
    parentOf[b] = found;
    // rest world of the direct parent in the root frame, relative to the found ancestor's rest world
    const par = node[b].parent;
    _m.multiplyMatrices(rootInv, par.matrixWorld);
    const pq = new THREE.Quaternion(); _m.decompose(_v, pq, new THREE.Vector3());
    through[b] = found ? tRestQ[found].clone().invert().multiply(pq) : pq;   // ancestor-rest -> direct-parent-rest
  }
  // hips: position in its parent's frame
  const hipsParentInv = new THREE.Matrix4().multiplyMatrices(rootInv, node.hips.parent.matrixWorld).invert();
  const scale = (tRestP.hips.y) / Math.max(1e-3, sP.hips.y);

  const out = { clips: {}, meta: { height: json.height * scale, blade: json.blade * scale, clips: {} }, rm: {}, scale };
  const fps = json.fps;
  for (const name of Object.keys(json.clips)) {
    if (names && !names.includes(name)) continue;
    const c = json.clips[name], n = c.n;
    const q16 = new Int16Array(bin, c.q, n * B.length * 4);
    const pel = new Float32Array(bin, c.pelvis, n * 3);
    const rm = new Float32Array(bin, c.rm, n * 4);
    const times = new Float32Array(n);
    for (let f = 0; f < n; f++) times[f] = Math.min(c.dur, f / fps);
    const qv = {}, hv = new Float32Array(n * 3), W = {};
    for (const b of B) if (node[b]) qv[b] = new Float32Array(n * 4);
    for (let f = 0; f < n; f++) {
      for (let i = 0; i < B.length; i++) {
        const b = B[i];
        if (!node[b]) continue;
        const o = (f * B.length + i) * 4;
        _q.set(q16[o] / 32767, q16[o + 1] / 32767, q16[o + 2] / 32767, q16[o + 3] / 32767).normalize();
        const w = (W[b] ||= new THREE.Quaternion());
        w.copy(G).multiply(_q).multiply(sRestInv[b]).multiply(align[b]);
        // local = (ancestor W * through)^-1 * W
        _q2.copy(parentOf[b] ? W[parentOf[b]] : new THREE.Quaternion()).multiply(through[b]).invert().multiply(w);
        _q2.toArray(qv[b], f * 4);
      }
      _v.set(pel[f * 3], pel[f * 3 + 1], pel[f * 3 + 2]).multiplyScalar(scale).applyQuaternion(G).applyMatrix4(hipsParentInv);
      hv[f * 3] = _v.x; hv[f * 3 + 1] = _v.y; hv[f * 3 + 2] = _v.z;
    }
    const tracks = [];
    for (const b of B) if (qv[b]) tracks.push(new THREE.QuaternionKeyframeTrack(`${node[b].name}.quaternion`, times, qv[b]));
    tracks.push(new THREE.VectorKeyframeTrack(`${node.hips.name}.position`, times, hv));
    const clip = new THREE.AnimationClip(name, c.dur, tracks);
    clip.loop = c.loop;
    out.clips[name] = clip;
    // root motion (metres on this rig), and swings scaled into its frame (facing +Z like the canonical frame)
    const r = { times: Array.from(times), fwd: [], left: [], up: [] };
    for (let f = 0; f < n; f++) { r.fwd.push(rm[f * 4] * scale); r.left.push(rm[f * 4 + 1] * scale); r.up.push(rm[f * 4 + 2] * scale); }
    out.rm[name] = r;
    out.meta.clips[name] = {
      dur: c.dur, two: c.two != null ? new Float32Array(bin, c.two, n) : null,
      swings: c.swings.map((s) => ({ ...s, c: s.c.map((x) => x * scale), r: s.r * scale, reach: s.reach * scale })),
    };
  }
  if (!json.grip) return out;
  // the sword grip, relative to the right hand node: katana axes (+Y blade, +X edge) in the hand's frame
  const gb = v3(json.grip.blade), ge = v3(json.grip.edge);
  const K = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(ge, gb, new THREE.Vector3().crossVectors(ge, gb)));
  // katana world (root frame) = G Qs_hand K;  hand node world = G Qs_hand Qs_rest^-1 align  ->  local = align^-1 Qs_rest K
  const h = 'rightHand';
  const local = align[h].clone().invert().multiply(sQ[h]).multiply(K);
  const handScale = new THREE.Vector3();
  _m.multiplyMatrices(rootInv, node[h].matrixWorld).decompose(_v, _q, handScale);
  const palm = v3(json.grip.palm).add(gb.clone().multiplyScalar(json.guard));     // tsuba = palm + a little up the blade
  const p = palm.applyQuaternion(sQ[h]).applyQuaternion(align[h].clone().invert()).multiplyScalar(scale).divide(handScale);
  out.grip = { q: local, p, length: json.blade * scale, handScale };
  return out;
}

// root motion helpers: value of a curve at clip time t, and its rate
export function rmAt(r, key, t) {
  const T = r.times, V = r[key];
  if (t <= T[0]) return V[0];
  const n = T.length;
  if (t >= T[n - 1]) return V[n - 1];
  const f = t * 30, i = Math.min(n - 2, Math.floor(f)), k = f - i;
  return V[i] + (V[i + 1] - V[i]) * k;
}
