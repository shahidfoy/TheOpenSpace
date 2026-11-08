import * as THREE from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { skinned } from '../assets.js';
import { chain, single, clipTime, makeWarp, clipRate } from '../mech/mechSkin.js';

// Katana for the VRM characters.
// The sword moves come from the anime katana pack already baked into the player mech (mech_player.glb): its clips are
// retargeted at load time onto the VRM's normalized humanoid. Every bone gets the source's world-space rotation
// change from its rest pose, applied on top of an alignment that turns the VRM's rest bone (T-pose) onto the
// source's rest bone, so A-pose / T-pose and facing differences cancel out. The swing metadata the mech uses
// (mech_player.json: hit windows and arc planes per clip) is the same for the same clips, so the characters' hit
// windows, slash crescents and the grip of the sword come straight from it.

const MAP = {
  hips: 'Hips', spine: 'Spine1', chest: 'Spine2', neck: 'Neck', head: 'Head',
  leftShoulder: 'LeftShoulder', leftUpperArm: 'LeftArm', leftLowerArm: 'LeftForeArm', leftHand: 'LeftHand',
  rightShoulder: 'RightShoulder', rightUpperArm: 'RightArm', rightLowerArm: 'RightForeArm', rightHand: 'RightHand',
  leftUpperLeg: 'LeftUpLeg', leftLowerLeg: 'LeftLeg', leftFoot: 'LeftFoot', leftToes: 'LeftToeBase',
  rightUpperLeg: 'RightUpLeg', rightLowerLeg: 'RightLeg', rightFoot: 'RightFoot', rightToes: 'RightToeBase',
};
// bone -> the bone whose position gives its direction (target name, source name)
const CHILD = {
  spine: ['chest', 'Spine2'], chest: ['neck', 'Neck'], neck: ['head', 'Head'],
  leftShoulder: ['leftUpperArm', 'LeftArm'], leftUpperArm: ['leftLowerArm', 'LeftForeArm'], leftLowerArm: ['leftHand', 'LeftHand'],
  rightShoulder: ['rightUpperArm', 'RightArm'], rightUpperArm: ['rightLowerArm', 'RightForeArm'], rightLowerArm: ['rightHand', 'RightHand'],
  leftUpperLeg: ['leftLowerLeg', 'LeftLeg'], leftLowerLeg: ['leftFoot', 'LeftFoot'], leftFoot: ['leftToes', 'LeftToeBase'],
  rightUpperLeg: ['rightLowerLeg', 'RightLeg'], rightLowerLeg: ['rightFoot', 'RightFoot'], rightFoot: ['rightToes', 'RightToeBase'],
};
const ORDER = Object.keys(MAP);   // parents before children
// clips taken from the mech: [name in game, clip in mech_player.glb, root mode]
export const KATANA_CLIPS = [['kc_idle', 'idle', 'loop'], ['kc_run', 'run', 'loop'], ['combo1', 'combo1', 'xz'], ['charge', 'charge', 'xz'],
  ['aerial', 'aerial', 'xz'], ['combo_down', 'combo_down', 'xz']];

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _m = new THREE.Matrix4(), _v = new THREE.Vector3(), _v2 = new THREE.Vector3();

function frameQuat(left, right, hips, head) {
  const X = _v.copy(left).sub(right).normalize();
  const Y = _v2.copy(head).sub(hips);
  Y.addScaledVector(X, -Y.dot(X)).normalize();
  const Z = new THREE.Vector3().crossVectors(X, Y);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(X.clone(), Y.clone(), Z));
}

let SRC = null;     // cached source rig: clone, rest data
function sourceRig() {
  if (SRC) return SRC;
  const asset = skinned('mech_player');
  if (!asset) return null;
  const root = SkeletonUtils.clone(asset.gltf.scene);
  root.traverse((o) => { if (o.isSkinnedMesh) o.skeleton.pose(); });
  root.updateMatrixWorld(true);
  const bones = {};
  root.traverse((o) => { if (o.isBone) bones[o.name] = o; });
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const rest = {};
  for (const n of Object.keys(bones)) {
    const w = new THREE.Matrix4().multiplyMatrices(inv, bones[n].matrixWorld);
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    w.decompose(p, q, s);
    rest[n] = { p, q };
  }
  SRC = { asset, root, bones, rest, inv, mixer: new THREE.AnimationMixer(root), meta: asset.meta };
  return SRC;
}

// Retargets the katana clips onto a loaded VRM. Returns { clips: [AnimationClip], grip: { q, p } } (grip relative to
// the normalized right hand) or null when the mech asset isn't available.
export function retargetKatana(vrm) {
  const S = sourceRig();
  if (!S) return null;
  const H = vrm.humanoid, scene = vrm.scene;
  scene.updateMatrixWorld(true);
  const sInv = new THREE.Matrix4().copy(scene.matrixWorld).invert();
  const tPos = {};
  for (const b of ORDER) {
    const n = H.getNormalizedBoneNode(b);
    if (n) tPos[b] = new THREE.Vector3().setFromMatrixPosition(_m.multiplyMatrices(sInv, n.matrixWorld));
  }
  if (!tPos.hips || !tPos.head || !tPos.leftUpperLeg) return null;
  const R = S.rest;
  const qFace = frameQuat(R.LeftUpLeg.p, R.RightUpLeg.p, R.Hips.p, R.Head.p).multiply(frameQuat(tPos.leftUpperLeg, tPos.rightUpperLeg, tPos.hips, tPos.head).invert());
  const align = {};
  for (const b of ORDER) {
    if (!tPos[b] || !R[MAP[b]]) continue;
    const c = CHILD[b];
    if (c && tPos[c[0]] && R[c[1]]) {
      const dt = tPos[c[0]].clone().sub(tPos[b]).normalize().applyQuaternion(qFace);
      const ds = R[c[1]].p.clone().sub(R[MAP[b]].p).normalize();
      align[b] = new THREE.Quaternion().setFromUnitVectors(dt, ds).multiply(qFace);
    } else align[b] = qFace.clone();
  }
  // VRM 0.x models face -Z inside vrm.scene (rotateVRM0 turns the scene, not the bones); the clips face +Z
  const G = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), vrm.meta?.metaVersion === '0' ? Math.PI : 0);
  const scale = (tPos.hips.y) / Math.max(1e-3, R.Hips.p.y);
  // nearest mapped ancestor (unmapped normalized bones like upperChest keep their rest pose)
  const parentOf = {};
  for (const b of ORDER) {
    let n = H.getNormalizedBoneNode(b)?.parent, found = null;
    while (n && !found) { found = ORDER.find((x) => H.getNormalizedBoneNode(x) === n) || null; n = n.parent; }
    parentOf[b] = found;
  }
  const restInv = {};
  for (const b of ORDER) if (align[b]) restInv[b] = R[MAP[b]].q.clone().invert();

  const clips = [];
  const fps = 30;
  for (const [name, src, mode] of KATANA_CLIPS) {
    const clip = S.asset.gltf.animations.find((c) => c.name === src);
    if (!clip) continue;
    S.mixer.stopAllAction();
    const act = S.mixer.clipAction(clip);
    act.reset().play();
    const n = Math.max(2, Math.round(clip.duration * fps) + 1);
    const times = new Float32Array(n);
    const qv = {}, hv = new Float32Array(n * 3);
    for (const b of ORDER) if (align[b]) qv[b] = new Float32Array(n * 4);
    const W = {};
    for (let f = 0; f < n; f++) {
      const t = Math.min(clip.duration, f / fps);
      times[f] = t;
      S.mixer.setTime(t);
      S.root.updateMatrixWorld(true);
      for (const b of ORDER) {
        if (!align[b]) continue;
        const bone = S.bones[MAP[b]];
        _m.multiplyMatrices(S.inv, bone.matrixWorld).decompose(_v, _q, _v2);
        // world target = G * Qs(t) * Qs_rest^-1 * align
        W[b] = (W[b] || new THREE.Quaternion()).copy(G).multiply(_q).multiply(restInv[b]).multiply(align[b]);
        const pw = parentOf[b] ? W[parentOf[b]] : null;
        _q2.copy(W[b]);
        if (pw) _q2.premultiply(_q.copy(pw).invert());
        _q2.toArray(qv[b], f * 4);
        if (b === 'hips') {
          _m.multiplyMatrices(S.inv, bone.matrixWorld);
          _v.setFromMatrixPosition(_m).multiplyScalar(scale).applyQuaternion(G);
          hv[f * 3] = _v.x; hv[f * 3 + 1] = _v.y; hv[f * 3 + 2] = _v.z;
        }
      }
    }
    // root motion: keep it in place (and seamless for loops)
    const x0 = hv[0], y0 = hv[1], z0 = hv[2], dy = hv[(n - 1) * 3 + 1] - y0;
    for (let f = 0; f < n; f++) {
      hv[f * 3] = x0; hv[f * 3 + 2] = z0;
      if (mode === 'loop') hv[f * 3 + 1] -= dy * (f / (n - 1));
    }
    const tracks = [];
    for (const b of ORDER) {
      if (!qv[b]) continue;
      const node = H.getNormalizedBoneNode(b);
      tracks.push(new THREE.QuaternionKeyframeTrack(`${node.name}.quaternion`, times, qv[b]));
    }
    tracks.push(new THREE.VectorKeyframeTrack(`${H.getNormalizedBoneNode('hips').name}.position`, times, hv));
    clips.push(new THREE.AnimationClip(name, clip.duration, tracks));
    act.stop();
  }
  // the sword grip, relative to the normalized right hand
  const grip = R.katana_grip, hand = R.RightHand;
  const gq = align.rightHand.clone().invert().multiply(grip.q);
  const gp = grip.p.clone().sub(hand.p).multiplyScalar(scale).applyQuaternion(align.rightHand.clone().invert());
  const height = tPos.head.y + 0.15;
  return { clips, grip: { q: gq, p: gp }, scale, meta: S.meta, height };
}

// A katana, +Y along the blade, +X the cutting edge: wrapped grip, gold tsuba, slightly curved steel blade.
export function makeKatana(L = 0.85) {
  const g = new THREE.Group();
  const steel = new THREE.MeshStandardMaterial({ color: 0xdfe6ee, metalness: 1, roughness: 0.16, envMapIntensity: 1.6 });
  const edge = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 1, roughness: 0.06, emissive: 0x9fd8ff, emissiveIntensity: 0.25 });
  const wrap = new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: 0.85 });
  const gold = new THREE.MeshStandardMaterial({ color: 0xc9a24a, metalness: 0.9, roughness: 0.3 });
  const grip = L * 0.3;
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.018, grip, 10), wrap);
  handle.position.y = -grip * 0.5;
  for (let i = 0; i < 6; i++) {
    const d = new THREE.Mesh(new THREE.TorusGeometry(0.018, 0.003, 4, 8), gold);
    d.rotation.x = Math.PI / 2; d.position.y = -grip * (0.12 + i * 0.15); g.add(d);
  }
  const kashira = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.02, 10), gold); kashira.position.y = -grip - 0.008;
  const tsuba = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.008, 18), gold); tsuba.position.y = 0.004;
  // blade: tapered, curved toward the back (-X), with a bright edge strip
  const bl = new THREE.BoxGeometry(0.03, L, 0.006, 1, 24, 1);
  const pos = bl.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) + L / 2, k = y / L;
    const w = 1 - 0.35 * k - (k > 0.92 ? (k - 0.92) / 0.08 * 0.6 : 0);
    let x = pos.getX(i) * w;
    if (k > 0.92 && pos.getX(i) > 0) x -= (k - 0.92) / 0.08 * 0.02;            // kissaki: the point sweeps back
    pos.setX(i, x - 0.035 * k * k);
    pos.setY(i, y);
  }
  bl.computeVertexNormals();
  const blade = new THREE.Mesh(bl, steel);
  blade.position.y = 0.01;
  const eg = new THREE.BoxGeometry(0.004, L * 0.94, 0.0065, 1, 24, 1);
  const ep = eg.attributes.position;
  for (let i = 0; i < ep.count; i++) { const y = ep.getY(i) + L * 0.47, k = y / L; ep.setX(i, 0.015 * (1 - 0.35 * k) - 0.035 * k * k); ep.setY(i, y); }
  const edgeM = new THREE.Mesh(eg, edge); edgeM.position.y = 0.01;
  g.add(handle, kashira, tsuba, blade, edgeM);
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  g.userData.length = L;
  return g;
}

// ---------------- sword combat for a VRM character ----------------
const UP = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _U = new THREE.Vector3(), _V = new THREE.Vector3();

export class HumanSword {
  // ch: VrmChar (with ch.katana from retargetKatana), fx: SwordFx in the same scene
  constructor(ch, fx) {
    this.ch = ch; this.fx = fx;
    const k = ch.katana;
    this.metaK = k.height / k.meta.height;          // mech model units -> metres on this character
    const meta = k.meta;
    const K = this.metaK;
    const reach = (list) => list.map((m) => Object.assign(m, { rangeM: 1.15 + (meta.blade || 3) * K * 0.9 }));
    this.moves = {
      ground: reach(chain(1, meta, 'combo1', { speed: 1.15, minPeak: 22, gap: 0.12, limit: 5, base: { dmg: 14 }, last: { dmg: 26, hitstop: 0.1, finisher: true } })),
      heavy: reach([single(1, meta, 'charge', { speed: 1.1, extra: { dmg: 34, hitstop: 0.12, heavy: true } })])[0],
      air: reach(chain(1, meta, 'aerial', { speed: 1.3, minPeak: 30, limit: 3, base: { dmg: 12, air: true }, last: { dmg: 20, heavy: true, hitstop: 0.1 } })),
      plunge: reach([single(1, meta, 'combo_down', { speed: 1.3, extra: { dmg: 28, plunge: true, heavy: true, hitstop: 0.1 } })])[0],
    };
    this.move = null; this.moveE = 0; this.combo = 0; this.comboGap = 9; this.buf = null; this.bufT = 0;
    this.drawnT = 0; this.hitstop = 0; this.shake = 0;
    this.trail = fx.makeTrail(0xcfe9ff);
    this.hits = new Set();
    // the sword and the hand that holds it
    this.katana = makeKatana((meta.blade || 3) * K * 0.92);
    this.handNode = ch.vrm.humanoid.getNormalizedBoneNode('rightHand');
    this.hipNode = ch.vrm.humanoid.getNormalizedBoneNode('hips');
    this.sheathPose();
    this.fingers = this.makeFist();
    ch.onPose = () => this.pose();
  }

  get active() { return !!this.move; }

  // sheathed at the left hip, edge up, point trailing behind
  sheathPose() {
    const H = this.ch.vrm.humanoid, scene = this.ch.vrm.scene;
    scene.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(scene.matrixWorld).invert();
    const p = (b) => new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().multiplyMatrices(inv, H.getNormalizedBoneNode(b).matrixWorld));
    const hips = p('hips'), lleg = p('leftUpperLeg'), rleg = p('rightUpperLeg'), head = p('head');
    const left = lleg.clone().sub(rleg).normalize();
    const fwd = new THREE.Vector3().crossVectors(left, head.clone().sub(hips).normalize()).normalize();
    this.sheath = {
      p: lleg.clone().sub(hips).multiplyScalar(1.7).addScaledVector(fwd, 0.04).add(new THREE.Vector3(0, 0.04, 0)),
      q: new THREE.Quaternion().setFromUnitVectors(UP, fwd.clone().multiplyScalar(-0.85).addScaledVector(UP, -0.5).normalize()),
    };
  }
  setDrawn(on) {
    if (this.drawn === on) return;
    this.drawn = on;
    const k = this.katana, g = this.ch.katana.grip;
    if (on) { this.handNode.add(k); k.position.copy(g.p); k.quaternion.copy(g.q); }
    else { this.hipNode.add(k); k.position.copy(this.sheath.p); k.quaternion.copy(this.sheath.q); }
  }

  // a fist around the grip: curl the right hand's fingers toward the palm (rest frame axes)
  makeFist() {
    const H = this.ch.vrm.humanoid, scene = this.ch.vrm.scene;
    const inv = new THREE.Matrix4().copy(scene.matrixWorld).invert();
    const pos = (n) => new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().multiplyMatrices(inv, n.matrixWorld));
    const out = [];
    const down = new THREE.Vector3(0, -1, 0);
    for (const f of ['Thumb', 'Index', 'Middle', 'Ring', 'Little']) {
      const parts = f === 'Thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Intermediate', 'Distal'];
      const angles = f === 'Thumb' ? [0.35, 0.5, 0.5] : [1.25, 1.45, 0.9];
      for (let i = 0; i < 3; i++) {
        const n = H.getNormalizedBoneNode(`right${f}${parts[i]}`), c = i < 2 ? H.getNormalizedBoneNode(`right${f}${parts[i + 1]}`) : null;
        if (!n) continue;
        const dir = c ? pos(c).sub(pos(n)).normalize() : null;
        if (!dir) { out.push({ n, q: out[out.length - 1]?.q.clone() || new THREE.Quaternion() }); continue; }
        const axis = new THREE.Vector3().crossVectors(dir, down).normalize();
        out.push({ n, q: new THREE.Quaternion().setFromAxisAngle(axis, angles[i]) });
      }
    }
    return out;
  }
  pose() { if (this.drawn) for (const f of this.fingers) f.n.quaternion.copy(f.q); }

  // targets: [{ pos, radius, alive, hit(dmg, dir) }]
  update(dt, I, P, targets, enabled) {
    if (this.hitstop > 0) { this.hitstop -= dt; dt *= 0.05; }
    this.shake = Math.max(0, this.shake - dt * 3);
    if (!enabled) { if (this.move) this.end(P); this.setDrawn(false); this.trail.on = false; return dt; }
    this.trail.on = true;
    if (I.attack) { this.buf = 'attack'; this.bufT = 0.35; }
    if (I.heavy) { this.buf = 'heavy'; this.bufT = 0.35; }
    if (this.bufT > 0) this.bufT -= dt; else this.buf = null;
    this.comboGap += dt;

    const mv = this.move;
    const recovering = mv && this.moveE > mv.t[0] + mv.t[1] + 0.05;
    const busy = P.state === 'climb' || P.state === 'mantle' || P.state === 'wallrun';
    if (this.buf && !busy && (!mv || recovering)) { this.start(this.buf, P, targets); this.buf = null; }
    if (this.move) this.step(dt, P, targets);

    // sheathe after a few quiet seconds
    this.drawnT = this.move ? 3 : Math.max(0, this.drawnT - dt);
    this.setDrawn(this.drawnT > 0);
    // sword-stance idle and run while drawn
    P.idleClip = this.drawnT > 0 ? 'kc_idle' : 'idle';
    P.runClip = this.drawnT > 0 ? 'kc_run' : 'run';
    this.updateTrail(!!this.move && this.move.phase === 'swing');
    return dt;
  }

  start(kind, P, targets) {
    const prev = this.move, prevE = this.moveE;
    let mv;
    if (!P.grounded) {
      if (kind === 'heavy') mv = this.moves.plunge;
      else { const n = prev?.air ? this.combo : 0; mv = this.moves.air[n % this.moves.air.length]; this.combo = n + 1; }
    } else if (kind === 'heavy') { mv = this.moves.heavy; this.combo = 0; }
    else {
      if (!(prev || this.comboGap < 0.45) || this.combo >= this.moves.ground.length) this.combo = 0;
      mv = this.moves.ground[this.combo++];
    }
    this.move = { ...mv, t: mv.t.slice() };
    this.moveE = 0; this.arcI = 0; this.hits.clear(); this.comboGap = 0;
    // face the nearest target in front
    let best = null, bs = Infinity;
    const fx = Math.sin(P.yaw), fz = Math.cos(P.yaw);
    for (const t of targets) {
      if (!t.alive) continue;
      const dx = t.pos.x - P.pos.x, dz = t.pos.z - P.pos.z, d = Math.hypot(dx, dz);
      if (d > 6 || Math.abs(t.pos.y - P.pos.y) > 2.5) continue;
      const s = d * (1.6 - (dx * fx + dz * fz) / Math.max(d, 1e-3));
      if (s < bs) { bs = s; best = t; }
    }
    this.target = best;
    if (best) P.yaw = Math.atan2(best.pos.x - P.pos.x, best.pos.z - P.pos.z);
    // continue the same clip from where the last hit left it, else blend in
    const c = this.ch;
    if (prev?.warp && prev.clip === this.move.clip && c.currentName === this.move.clip) {
      const ct = clipTime(prev, prevE);
      if (ct > this.move.seg[0] - 0.45 && ct < this.move.seg[1] - 0.04) { makeWarp(this.move, ct, clipRate(prev, prevE)); P.action = this; return; }
    }
    makeWarp(this.move, this.move.seg[0]);
    c.play(this.move.clip, { fade: 0.08, time: this.move.seg[0], restart: true });
    c.scrub(this.move.seg[0]);
    P.action = this;
    if (this.move.air) P.vel.y = Math.max(P.vel.y, 2.5);
  }

  // called by the Parkour controller while an attack owns the body
  drive(dt, P) {
    const mv = this.move, [tw, ts] = mv.t;
    const v = P.vel;
    if (mv.plunge) {
      v.x *= Math.exp(-dt * 6); v.z *= Math.exp(-dt * 6);
      v.y = this.moveE > tw ? -24 : Math.max(v.y - 10 * dt, 0);
      return;
    }
    let want = 0;
    if (this.moveE < tw + ts * 0.6) {
      want = 3.2;
      const t = this.target;
      if (t && t.alive) {
        const d = Math.hypot(t.pos.x - P.pos.x, t.pos.z - P.pos.z) - t.radius;
        want = THREE.MathUtils.clamp((d - mv.rangeM * 0.6) * 8, 0, 9);
        P.yaw += Math.atan2(Math.sin(Math.atan2(t.pos.x - P.pos.x, t.pos.z - P.pos.z) - P.yaw), Math.cos(Math.atan2(t.pos.x - P.pos.x, t.pos.z - P.pos.z) - P.yaw)) * Math.min(1, dt * 18);
      }
    }
    const k = 1 - Math.exp(-(this.moveE < tw ? 12 : 20) * dt);
    v.x += (Math.sin(P.yaw) * want - v.x) * k;
    v.z += (Math.cos(P.yaw) * want - v.z) * k;
    if (mv.air) v.y = Math.max(v.y - 24 * 0.22 * dt, -2.5);       // anime hang time while cutting in the air
    else v.y -= 24 * dt;
  }

  step(dt, P, targets) {
    const mv = this.move;
    this.moveE += dt;
    const [tw, ts, tr] = mv.t;
    mv.phase = this.moveE < tw ? 'wind' : this.moveE < tw + ts ? 'swing' : 'recover';
    this.ch.scrub(clipTime(mv, this.moveE));
    if (mv.phase !== 'wind') this.slashes(P);
    if (mv.phase === 'swing' || (mv.phase === 'recover' && this.moveE < tw + ts + 0.04)) this.sweep(P, targets);
    if (mv.plunge && P.grounded && this.moveE > tw) {
      if (!this.slammed) {
        this.slammed = true;
        this.fx.ring(_a.copy(P.pos).setY(P.pos.y + 0.1), 3.2, { life: 0.45, color: 0xcfe9ff });
        this.fx.sparksAt(_a.copy(P.pos).setY(P.pos.y + 0.2), 26, { speed: 9, dir: UP, spread: 1.4, floor: P.pos.y, color: 0xcfe9ff, width: 0.03 });
        for (const t of targets) if (t.alive && t.pos.distanceTo(P.pos) < 3.2 + t.radius && !this.hits.has(t)) this.hit(t, mv, P);
        this.shake = Math.max(this.shake, 0.5);
        this.moveE = Math.max(this.moveE, tw + ts);
      }
    } else this.slammed = false;
    if (mv.air && P.grounded && this.moveE > tw) return this.end(P);
    if (this.moveE >= tw + ts + tr) this.end(P);
  }

  end(P) { this.move = null; P.action = null; this.comboGap = 0; }

  sweep(P, targets) {
    const mv = this.move;
    const fx = Math.sin(P.yaw), fz = Math.cos(P.yaw);
    for (const t of targets) {
      if (!t.alive || this.hits.has(t)) continue;
      const dx = t.pos.x - P.pos.x, dz = t.pos.z - P.pos.z, d = Math.hypot(dx, dz);
      if (d > mv.rangeM + t.radius || Math.abs(t.pos.y + 1 - (P.pos.y + 1)) > 2.2) continue;
      const cos = d > 0.01 ? (dx * fx + dz * fz) / d : 1;
      if (Math.acos(THREE.MathUtils.clamp(cos, -1, 1)) > mv.cone && d > 0.9) continue;
      this.hit(t, mv, P);
    }
  }

  hit(t, mv, P) {
    this.hits.add(t);
    const p = _a.copy(t.pos); p.y += 1.2;
    t.hit?.(mv.dmg, _b.set(Math.sin(P.yaw), 0, Math.cos(P.yaw)), mv);
    const big = mv.heavy || mv.finisher;
    this.fx.sparksAt(p, big ? 34 : 18, { color: 0xffe2a8, speed: 9, life: 0.45, width: 0.035, grav: 6, floor: t.pos.y });
    this.fx.sparksAt(p, 8, { color: 0xffffff, speed: 14, life: 0.18, width: 0.025 });
    this.hitstop = Math.max(this.hitstop, mv.hitstop || 0.06);
    this.shake = Math.max(this.shake, big ? 0.35 : 0.16);
  }

  // slash crescents along the clip's detected swing arcs, scaled from the mech onto this character
  slashes(P) {
    const mv = this.move, tw = mv.t[0];
    const m = this.ch.root.matrixWorld;
    const k = this.metaK;
    while (this.arcI < mv.arcs.length && this.moveE >= tw + mv.arcs[this.arcI].dt) {
      const a = mv.arcs[this.arcI++];
      // arcs are in the mech clip's space (character facing +Z), like the root of this character
      _c.set(a.c[0], a.c[1], a.c[2]).multiplyScalar(k).applyMatrix4(m);
      _U.set(a.u[0], a.u[1], a.u[2]).transformDirection(m);
      _V.set(a.v[0], a.v[1], a.v[2]).transformDirection(m);
      const big = mv.heavy || mv.finisher;
      const ang = THREE.MathUtils.clamp(a.a1, -Math.PI * 2 + 0.01, Math.PI * 2 - 0.01);
      this.fx.crescent(_c, _U, _V, 0, ang, Math.max(0.05, a.dur), { radius: (a.r * k + 0.25) * (big ? 1.15 : 1.05), innerFrac: 0.55, life: big ? 0.3 : 0.2, color: big ? 0xd8f0ff : 0xbfe6ff });
    }
  }

  updateTrail(swinging) {
    const k = this.katana;
    if (!this.drawn) return;
    k.updateMatrixWorld(true);
    const L = k.userData.length;
    const base = _a.set(0, L * 0.25, 0).applyMatrix4(k.matrixWorld);
    const tip = _b.set(-0.035, L, 0).applyMatrix4(k.matrixWorld);
    this.fx.pushTrail(base, tip, swinging, this.trail);
  }
}
