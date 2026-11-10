import * as THREE from 'three';
import { loadKatanaPack, loadPack, retargetPack, layerClip, rmAt } from './katanaPack.js';
import { makeWarp, clipTime, clipRate } from '../mech/mechSkin.js';
import { Beam } from '../mech/swordFx.js';
import { twoBoneIK } from './handIK.js';
import { BladeKit, KIT, RAGE_COLOR, shotgun, wound, woundMul, slow, makeLane, setLane, distToLane } from './bladeKit.js';
import { makeShotgun } from './gun.js';
import { mountFps } from './gunView.js';

// Sword and shotgun combat for the VRM characters, on the anime katana pack (see katanaPack.js) and the Daywalker
// kit (bladeKit.js: Blade's kit from Marvel Rivals).
// Footwork: the strikes carry the pack's root motion, so the body travels with the steps and the feet stay planted;
// toward a target the root motion is warped (stretched or shortened) so the cut lands at sword's reach. A foot pass
// keeps the lowest foot on the ground. Moves:
//   J / click (hold)     sword: 5-hit slash chain (sprinting: running slash; in the air: 3-hit air combo)
//                        shotgun: pellet blasts, six shells, reloads on its own
//   R / middle-click     swap sword and shotgun
//   E                    Daywalker Dash, two charges: the sword's ends in a cleaving strike that slows, the shotgun's
//                        in a wide blast that wounds; hold jump to dash upward (also in the air)
//   F / right-click hold Scarlet Shroud: block with the sword (you can still walk)
//   K / C                Bloodline Awakening: a sword stance; hits fill a meter that speeds the cuts into a whirlwind
//   Q                    Thousand-Fold Slash: lay a path, confirm with attack, dash down it; the path is cut to ribbons
//   L                    launcher: a rising cut that carries you into the air; in the air: plunge with a shockwave

const UP = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _U = new THREE.Vector3(), _V = new THREE.Vector3();
const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _s = new THREE.Vector3();
const clamp = THREE.MathUtils.clamp;
const angDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
const SWING_K = 1.25;                  // makeWarp's swing speed factor

// the VRM normalized humanoid as a retarget target (VRM 0.x faces -Z inside its scene: a half turn)
export function vrmRig(vrm) {
  return {
    root: vrm.scene,
    node: (b) => vrm.humanoid.getNormalizedBoneNode(b),
    G: new THREE.Quaternion().setFromAxisAngle(UP, vrm.meta?.metaVersion === '0' ? Math.PI : 0),
  };
}

// retarget the pack onto a VRM; clip names get a 'k_' prefix (the Mixamo locomotion uses idle / run / jump)
export async function retargetKatanaVrm(vrm) {
  const pack = await loadKatanaPack();
  const r = retargetPack(pack, vrmRig(vrm));
  const pre = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => ['k_' + k, v]));
  for (const [k, c] of Object.entries(r.clips)) c.name = 'k_' + k;
  // walking behind the block: the Mixamo walk's legs under the held guard
  try {
    const walk = retargetPack(await loadPack('loco'), vrmRig(vrm), ['walk']).clips.walk;
    const lower = ['hips', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes']
      .map((b) => vrm.humanoid.getNormalizedBoneNode(b)?.name).filter(Boolean);
    if (walk && r.clips.block) {
      r.clips.block_walk = layerClip('k_block_walk', walk, r.clips.block, 0.6, lower);
      const two = r.meta.clips.block.two?.[18] ?? 1;                     // both hands stay on the handle
      r.meta.clips.block_walk = { dur: walk.duration, swings: [], two: new Float32Array(Math.ceil(walk.duration * 30) + 2).fill(two) };
    }
  } catch (e) { console.warn('guard walk unavailable', e); }
  return { clips: Object.values(r.clips), meta: { ...r.meta, clips: pre(r.meta.clips) }, rm: pre(r.rm), grip: r.grip, height: r.meta.height };
}

// ---------------- moves from the swing data ----------------
// a move plays [start, end] of a clip; its hit window [t0, t1] spans swings i0..i1; time follows makeWarp's curve
function span(meta, rm, clip, i0, i1, { lead = 0.22, tail = 0.4, speed = 1, extra = {} } = {}) {
  const info = meta.clips[clip];
  const sw = info.swings.slice(Math.min(i0, info.swings.length - 1), i1 + 1);
  const t0 = sw[0].t0, t1 = sw[sw.length - 1].t1;
  const start = Math.max(0, t0 - lead), end = Math.min(info.dur, t1 + tail);
  const ss = speed * SWING_K;
  const reach = Math.max(...sw.map((s) => s.reach));
  const hang = Math.max(...sw.map((s) => Math.max(Math.abs(s.h0), Math.abs(s.h1))));
  return makeWarp({
    clip, start, speed, seg: [start, t0, t1, end], rm: rm[clip], dmg: 14, hitstop: 0.06,
    arcs: sw.map((p) => ({ ...p, dt: (p.t0 - t0) / ss, dur: Math.max(0.03, (p.t1 - p.t0) / ss) })),
    rangeM: reach + 0.35, cone: clamp(hang + 0.45, 0.8, Math.PI),
    ...extra,
  }, start);
}
// consecutive hits of one clip: swings grouped when closer than `gap`, each group one move whose segment runs
// from midway after the previous group to midway before the next (so chained hits flow through the clip)
function chainOf(meta, rm, clip, { minPeak = 16, gap = 0.12, limit = 9, speed = 1, base = {}, last = {}, lead = 0.2, tail = 0.4 } = {}) {
  const info = meta.clips[clip];
  const sw = info.swings.filter((s) => s.peak >= minPeak);
  const groups = [];
  for (let i = 0; i < sw.length; i++) {
    const g = groups[groups.length - 1];
    if (g && sw[i].t0 - sw[g[1]].t1 < gap) g[1] = i; else groups.push([i, i]);
  }
  const G = groups.slice(0, limit);
  const all = info.swings;
  return G.map(([i0, i1], k) => {
    const a = sw[i0], b = sw[i1];
    const ia = all.indexOf(a), ib = all.indexOf(b);
    const prevEnd = k ? sw[G[k - 1][1]].t1 : null, nextStart = k < G.length - 1 ? sw[G[k + 1][0]].t0 : null;
    const leadK = k ? (a.t0 - prevEnd) / 2 : lead, tailK = nextStart != null ? (nextStart - b.t1) / 2 : tail;
    return span(meta, rm, clip, ia, ib, { lead: leadK, tail: tailK, speed, extra: k === G.length - 1 ? { ...base, ...last } : base });
  });
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
  g.userData.edge = edge;
  return g;
}

// ---------------- the fighter ----------------
const DASH_DIST = 8.5, DASH_DUR = 0.34, AIR_DASH_DUR = 0.26;
const ULT_LEN = 16, ULT_W = 3.8;             // the Thousand-Fold Slash's path: length and width, metres
const GUN_RANGE = 24, PELLET_DMG = 4.4;
// Rush clip phases (seconds): crouch, held iai stance, the dash, the finish
const RUSH = { crouch: 0.6, holdA: 0.85, holdB: 2.2, dash0: 2.45, dash1: 4.15, end: 4.9 };
const STEEL = 0x9fd8ff;

export class HumanSword {
  // ch: VrmChar with ch.katana from retargetKatanaVrm; fx: SwordFx in the same scene
  constructor(ch, fx, scene) {
    this.ch = ch; this.fx = fx;
    this.kit = new BladeKit();
    const k = ch.katana, meta = k.meta, rm = k.rm;
    const last = (c) => meta.clips[c].swings.length - 1;
    this.moves = {
      ground: chainOf(meta, rm, 'k_combo1', { speed: 1.12, minPeak: 25, gap: 0.09, limit: 5, base: { dmg: 14 }, last: { dmg: 26, finisher: true, hitstop: 0.1 } }),
      run: span(meta, rm, 'k_run_attack', 0, last('k_run_attack'), { lead: 0.08, tail: 0.25, speed: 1, extra: { dmg: 18, run: true, cone: 1.2 } }),
      launch: span(meta, rm, 'k_jump_attack', 0, 0, { lead: 0.2, tail: 0.18, speed: 1.05, extra: { dmg: 18, launch: true, hitstop: 0.08 } }),
      air: chainOf(meta, rm, 'k_aerial', { speed: 1.25, minPeak: 40, gap: 0.09, limit: 3, base: { dmg: 12, air: true }, last: { dmg: 20, heavy: true, hitstop: 0.1 } }),
      // Bloodline Awakening's whirlwind: the spinning cuts of the circle clip, repeated while the attack is held
      whirl: span(meta, rm, 'k_circle', 1, 1, { lead: 0.06, tail: 0.1, speed: 1.35, extra: { dmg: 11, cone: Math.PI, rangeM: 2.5, whirl: true, hitstop: 0.02 } }),
      plunge: span(meta, rm, 'k_combo_down', 1, 1, { lead: 0.3, tail: 0.35, speed: 1.15, extra: { dmg: 30, plunge: true, heavy: true, hitstop: 0.1 } }),
    };
    this.act = null;                     // current action: { kind: 'move' | 'dash' | 'guard', ... }
    this.combo = 0; this.comboGap = 9; this.buf = null; this.bufT = 0;
    this.drawnT = 0; this.hitstop = 0; this.shake = 0; this.now = 0;
    this.airDashes = 1; this.zone = null;
    this.trail = fx.makeTrail(0xcfe9ff);
    this.hits = new Set();
    this.katana = makeKatana(k.grip.length * 0.95);
    this.edgeMat = this.katana.userData.edge;
    const H = ch.vrm.humanoid;
    this.handNode = H.getNormalizedBoneNode('rightHand');
    this.hipNode = H.getNormalizedBoneNode('hips');
    this.feet = ['leftFoot', 'rightFoot', 'leftToes', 'rightToes'].map((b) => H.getNormalizedBoneNode(b)).filter(Boolean);
    this.footRest = this.footHeight();
    this.sheathPose();
    const nb = (b) => H.getNormalizedBoneNode(b);
    this.hands = ch.hands;                                                   // measured on the rest pose (vrmChar)
    this.armL = ['leftUpperArm', 'leftLowerArm', 'leftHand'].map(nb);
    this.armR = ['rightUpperArm', 'rightLowerArm', 'rightHand'].map(nb);
    this.twoK = 0;
    // the shotgun: in the right hand when it is the weapon, holstered on the right thigh otherwise
    this.gun = makeShotgun(0.5 * Math.max(0.9, this.hands?.right?.size || 1));
    this.aimK = 0; this.recoil = 0; this.aimDir = new THREE.Vector3(0, 0, 1);
    this.held = null;
    this.beam = new Beam(scene, 0xbfe6ff);
    this.beamT = 0;
    // the Thousand-Fold Slash's path on the floor
    this.lane = makeLane();
    scene.add(this.lane);
    this.hold('');
    ch.onPose = () => this.pose();
  }

  get busy() { return !!this.act; }

  // the lowest foot's height in the VRM scene frame (feet / toes)
  footHeight() {
    const scene = this.ch.vrm.scene;
    scene.updateMatrixWorld(true);
    const inv = _m.copy(scene.matrixWorld).invert();
    let y = Infinity;
    for (const n of this.feet) { _p.setFromMatrixPosition(n.matrixWorld).applyMatrix4(inv); y = Math.min(y, _p.y); }
    return y;
  }

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
    // holster: on the right thigh, barrels down, the grip to the rear
    const down = new THREE.Vector3(0, -1, 0);
    this.holster = {
      p: rleg.clone().sub(hips).multiplyScalar(1.75).addScaledVector(fwd, -0.02).add(new THREE.Vector3(0, -0.02, 0)),
      q: new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(down, fwd, new THREE.Vector3().crossVectors(down, fwd))),
    };
  }

  // what the right hand holds: 'sword', 'gun' or '' (both stowed)
  hold(what) {
    if (this.held === what) return;
    this.held = what;
    const k = this.katana, gun = this.gun, g = this.ch.katana.grip, R = this.hands?.right;
    this.drawn = what === 'sword';
    if (what === 'sword' && R?.ok) {
      // in the fist: the handle through the finger loops, the tsuba just above the index finger
      this.handNode.add(k); k.quaternion.copy(R.q); k.scale.set(1, 1, 1);
      k.position.copy(R.centre).addScaledVector(R.axis, R.width * 0.5 + 0.02 * R.size);
    } else if (what === 'sword') { this.handNode.add(k); k.position.copy(g.p); k.quaternion.copy(g.q); k.scale.set(1, 1, 1).divide(g.handScale); }
    else { this.hipNode.add(k); k.position.copy(this.sheath.p); k.quaternion.copy(this.sheath.q); k.scale.set(1, 1, 1); }
    if (what === 'gunfps') { /* on the camera: mounted each frame in update */ }
    else if (what === 'gun' && R?.ok) { this.handNode.add(gun); gun.quaternion.copy(R.q); gun.position.copy(R.centre); gun.scale.set(1, 1, 1); gun.rotation.order = 'XYZ'; }
    else { this.hipNode.add(gun); gun.position.copy(this.holster.p); gun.quaternion.copy(this.holster.q); gun.scale.set(1, 1, 1); }
  }

  // after the clip is applied, before the humanoid drives the mesh: the grip, the gun arm, the feet on the ground
  pose() {
    if (this.held === 'sword') this.seatKatana();
    else if (this.held === 'gun') this.aimGun();
    if (this.ground) {
      const y = this.footHeight();
      let off = this.footRest - y;
      // standing / striking: plant the lowest foot exactly; running: only keep feet out of the floor
      off = this.ground === 'full' ? clamp(off, -0.35, 0.3) : clamp(off, 0, 0.3);
      if (Math.abs(off) > 1e-4) this.hipNode.position.y += off;
    }
  }

  // The right hand closes around the handle; in the pack's two-handed frames the left hand is brought onto the
  // handle below it and closes too, otherwise it hangs relaxed.
  seatKatana() {
    const k = this.katana, R = this.hands?.right, L = this.hands?.left;
    if (!R?.ok) return;
    R.curl(1);
    const a = this.ch.current, name = this.ch.currentName;
    const two = a && name.startsWith('k_') ? this.ch.katana.meta.clips[name]?.two : null;
    let tw = 0;
    if (two) {
      const f = a.time * 30, i = Math.max(0, Math.min(two.length - 1, Math.floor(f))), j = Math.min(two.length - 1, i + 1);
      tw = two[i] + (two[j] - two[i]) * (f - i);
    }
    this.twoK += (tw - this.twoK) * 0.35;
    if (!L?.ok) return;
    L.curl(name.startsWith('k_') ? Math.max(0.25, this.twoK) : 0.25);
    if (this.twoK <= 0.02 || !this.armL[0]) return;
    const [up, lo, hd] = this.armL;
    hd.updateWorldMatrix(true, false); k.updateWorldMatrix(true, false);
    // the left fist's place on the handle, then the wrist that puts it there
    _c.set(0, -(R.width * 0.5 + 0.02 * R.size) - (R.width * 0.5 + L.width * 0.5 + 0.012 * R.size), 0).applyMatrix4(k.matrixWorld);
    _b.copy(L.centre).applyMatrix4(hd.matrixWorld).sub(_p.setFromMatrixPosition(hd.matrixWorld));
    twoBoneIK(up, lo, hd, _c.sub(_b), this.twoK);
  }

  // The shotgun in the fist. After a shot the arm comes up onto the aim line and holds there for a moment, kicking
  // with the recoil; otherwise the gun swings with the arm.
  aimGun() {
    const R = this.hands?.right, L = this.hands?.left;
    if (!R?.ok) return;
    R.curl(0.92); if (L?.ok) L.curl(0.25);
    if (this.aimK < 0.01) return;
    const [up, lo, hd] = this.armR;
    up.updateWorldMatrix(true, false); lo.updateWorldMatrix(true, false); hd.updateWorldMatrix(true, false);
    const sh = _a.setFromMatrixPosition(up.matrixWorld);
    const len = sh.distanceTo(_b.setFromMatrixPosition(lo.matrixWorld)) + _b.distanceTo(_c.setFromMatrixPosition(hd.matrixWorld));
    // barrels along the aim (kicked up by the recoil), the gun upright
    const X = _U.copy(this.aimDir).addScaledVector(UP, this.recoil * 0.35).normalize();
    const Z = _V.crossVectors(X, UP).normalize(), Y = _s.crossVectors(Z, X);
    _q.setFromRotationMatrix(_m.makeBasis(X, Y, Z)).multiply(_q2.copy(R.q).invert());           // hand = gun * grip^-1
    // the wrist: out along the aim from the shoulder, a little low so the sights sit under the eye line
    const wrist = _c.copy(sh).addScaledVector(X, len * (0.8 - this.recoil * 0.14)).addScaledVector(UP, -0.03 + this.recoil * 0.05);
    wrist.sub(_b.copy(R.centre).applyQuaternion(_q));
    twoBoneIK(up, lo, hd, wrist, this.aimK, { handQ: _q, pole: _b.set(0, -1, 0) });
  }

  // targets: [{ pos, radius, alive, hit(dmg, dir, mv) }]. Returns the body's time step (hitstop slows it).
  update(dt, I, P, targets, enabled) {
    if (this.hitstop > 0) { this.hitstop -= dt; dt *= 0.05; }
    this.now += dt;
    this.shake = Math.max(0, this.shake - dt * 3);
    this.updateBeam(dt);
    this.gun.userData.update(dt);
    const K = this.kit;
    if (!enabled) {
      if (this.act) this.end(P);
      this.hold(''); this.trail.on = false; this.ground = null; this.zone = null; this.lane.visible = false; K.aiming = false;
      this.aimK = 0; P.faceYaw = null;
      P.idleClip = 'idle'; P.runClip = 'run';
      return dt;
    }
    K.update(dt);
    this.trail.on = true;
    if (P.grounded || P.state === 'climb' || P.state === 'wallrun') this.airDashes = 1;
    const parkourBusy = P.state === 'climb' || P.state === 'mantle' || P.state === 'wallrun';
    const free = !this.act || this.cancellable(this.act);

    // ---- inputs ----
    if (I.swap && free) this.swap(P);
    if (K.gun) {
      if ((I.attack || I.attackHold) && K.canFire() && !this.act && !parkourBusy) this.fireGun(P, targets);
    } else if (I.attack || (I.attackHold && !this.buf && free)) this.bufIn('attack');
    if (I.launch) this.bufIn(P.grounded ? 'launch' : 'plunge');
    if (I.dodge) this.bufIn('dash');
    if (I.spin) this.bufIn('ult');
    // laying the ultimate's path: attack (or the ultimate again) confirms, dash or block calls it off
    if (this.act?.kind === 'aim') {
      if (I.dodge || I.guard) { this.buf = null; this.end(P); }
      else if ((I.attack || I.spin) && this.t > 0.15) { this.buf = null; this.confirmUlt(P); }
    }
    if ((I.heavy || I.rage) && K.canRage() && free) this.toggleRage(P);
    if (this.bufT > 0) this.bufT -= dt; else this.buf = null;
    this.comboGap += dt;

    // Scarlet Shroud: block with the sword while held
    if (I.guard && P.grounded && !parkourBusy && (!this.act || this.act.kind === 'guard')) { if (!this.act) this.startGuard(P); else this.guardWalk(P); }
    else if (this.act?.kind === 'guard') this.end(P);
    // buffered actions
    if (this.buf && !parkourBusy && (!this.act || this.cancellable(this.act))) {
      const b = this.buf;
      if (b === 'dash') { if (K.canDash() && (P.grounded || this.airDashes > 0)) { this.startDash(P, I); this.buf = null; } }
      else if (b === 'ult') { if (K.canUlt() && P.grounded) this.startAim(P); this.buf = null; }
      else { if (K.gun) this.swap(P, 'sword'); this.startMove(b, P, targets); this.buf = null; }
    }
    if (this.act) this.step(dt, P, targets);
    this.updateZone(dt, P, targets);

    // what is in the hand: the gun whenever it is the weapon; the katana while fighting, sheathed after a few
    // quiet seconds. Sword-stance idle and run while it is drawn
    this.drawnT = this.act || this.zone ? 3 : Math.max(0, this.drawnT - dt);
    const sword = !K.gun && this.drawnT > 0;
    // first person (aim held): the gun rides the camera as a view model
    const fps = K.gun && this.aim?.fps && this.cam;
    this.hold(K.gun ? (fps ? 'gunfps' : 'gun') : sword ? 'sword' : '');
    if (fps) mountFps(this.gun, this.cam, this.ch.root.parent, this.recoil);
    P.idleClip = sword ? 'k_idle' : 'idle';
    P.runClip = sword ? 'k_run' : 'run';
    // the gun arm: up while a shot is fresh, the body turned onto the aim
    // with a crosshair to aim by, the body keeps facing where the camera looks
    if (K.gun && this.aim && !this.act) { K.aimT = Math.max(K.aimT, 0.35); this.aimDir.copy(this.aim.d); }
    const aiming = K.gun && K.aimT > 0 && !this.act && !parkourBusy;
    this.aimK += ((aiming ? 1 : 0) - this.aimK) * Math.min(1, dt * (aiming ? 22 : 7));
    this.recoil = Math.max(0, this.recoil - dt * 7);
    P.faceYaw = aiming && K.aimT > 0.3 ? Math.atan2(this.aimDir.x, this.aimDir.z) : null;
    // feet on the ground: planted while standing or striking, kept out of the floor while running
    const st = P.state;
    this.ground = !P.grounded || st === 'mantle' || st === 'climb' || st === 'wallrun' || this.act?.kind === 'dash' ? null
      : this.act || Math.hypot(P.vel.x, P.vel.z) < 0.6 ? 'full' : 'floor';
    this.updateLook(dt, P);
    this.updateTrail(this.act?.kind === 'move' ? this.act.mv.phase === 'swing' : this.act?.kind === 'dash' && !this.act.gun);
    return dt;
  }

  bufIn(b) { this.buf = b; this.bufT = 0.35; }
  // a move can be cut into by the next action once its hit window is over (the dash any time after the windup);
  // the guard is always interruptible
  cancellable(a) {
    if (a.kind === 'guard') return true;
    if (a.kind === 'aim') return false;
    if (a.kind === 'move') return this.t > a.mv.t[0] + a.mv.t[1] + 0.04 || (this.buf === 'dash' && this.t > a.mv.t[0]);
    return false;
  }

  nearestTarget(P, targets, maxD = 6, yaw = P.yaw) {
    let best = null, bs = Infinity;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    for (const t of targets) {
      if (!t.alive) continue;
      const dx = t.pos.x - P.pos.x, dz = t.pos.z - P.pos.z, d = Math.hypot(dx, dz);
      if (d > maxD || Math.abs(t.pos.y - P.pos.y) > 2.5) continue;
      const s = d * (1.6 - (dx * fx + dz * fz) / Math.max(d, 1e-3));
      if (s < bs) { bs = s; best = t; }
    }
    return best;
  }
  // camera forward on the ground plane, as a yaw
  camForward() { return (this.camYaw ?? 0) + Math.PI; }

  // ---------------- weapons ----------------
  swap(P, to = null) {
    const w = this.kit.swap(to);
    if (this.act?.kind === 'guard') this.end(P);
    this.drawnT = 3; this.combo = 0;
    this.fx.sparksAt(_a.copy(P.pos).setY(P.pos.y + 1.0), 6, { speed: 3, life: 0.25, width: 0.02, grav: 0, color: w === 'gun' ? 0xffb080 : 0xcfe9ff });
  }

  // one blast: toward the nearest target in front of the camera, else straight along the camera
  fireGun(P, targets, { free = false, wide = false } = {}) {
    const K = this.kit, yaw = free ? P.yaw : this.camForward(), A = free ? null : this.aim;
    const t = A ? null : this.nearestTarget(P, targets, GUN_RANGE, yaw);
    const o = _a.copy(P.pos); o.y += this.ch.height * 0.78;
    const d = this.aimDir.set(Math.sin(yaw), 0, Math.cos(yaw));
    if (A) {
      // through the crosshair: whatever the camera's line meets first is the point the shot converges on
      const far = shotgun(A.o, A.d, targets, { range: 60, spread: 0, pellets: 1 }).ends[0];
      if (A.fps) o.copy(A.o).addScaledVector(A.d, 0.1).addScaledVector(UP, -0.1);
      d.copy(far).sub(o).normalize();
      this.onFire?.();
    }
    if (t) {
      _b.copy(t.pos); _b.y += (t.height || 1.7) * 0.6;
      _b.sub(o).normalize();
      if (_b.dot(d) > (wide ? 0.3 : 0.86)) d.copy(_b);              // aim assist inside a narrow cone
    }
    o.addScaledVector(d, A?.fps ? 0.5 : 0.45);
    const origin = o.clone();
    const res = shotgun(origin, d, targets, wide ? { range: 11, spread: 0.3, pellets: 14 } : { range: GUN_RANGE });
    for (const [tg, n] of res.hits) {
      const dist = Math.hypot(tg.pos.x - P.pos.x, tg.pos.z - P.pos.z);
      const fall = wide ? 1 : clamp(1.25 - dist / GUN_RANGE * 1.1, 0.4, 1);
      if (wide) wound(tg, this.now);                                 // the dash's blast leaves them wounded
      this.hit(tg, { dmg: n * PELLET_DMG * fall * (wide ? 1.3 : 1), gun: true, heavy: wide || n >= 7, hitstop: wide ? 0.07 : 0.03, wound: wide }, P, d);
    }
    for (const e of res.ends) {
      _b.copy(e).sub(origin); const L = _b.length(); _b.multiplyScalar(1 / Math.max(L, 1e-3));
      this.fx.sparksAt(origin, 1, { dir: _b, spread: 0, speed: Math.min(200, L / 0.07), life: 0.09, width: 0.022, grav: 0, color: K.raging ? 0xff8a7a : 0xffd9a0, intensity: 5 });
      if (L < (wide ? 10.9 : GUN_RANGE - 0.1)) this.fx.sparksAt(e, 2, { speed: 4, life: 0.2, width: 0.02, color: 0xffe2a8 });
    }
    this.fx.sparksAt(origin, wide ? 16 : 9, { dir: d, spread: 0.5, speed: 9, life: 0.14, width: 0.03, grav: 0, color: 0xffc080 });
    this.gun.userData.fire();
    this.recoil = 1; this.aimK = Math.max(this.aimK, 0.55);
    this.shake = Math.max(this.shake, wide ? 0.45 : 0.28);
    this.punchCb?.(wide ? 0.5 : 0.22);
    K.fire(free);
    if (free) K.aimT = 0.5;
  }

  // ---------------- Bloodline Awakening ----------------
  toggleRage(P) {
    const on = this.kit.toggleStance();
    this.fx.ring(_a.copy(P.pos).setY(P.pos.y + 0.05), on ? 3.2 : 1.6, { life: on ? 0.5 : 0.35, color: RAGE_COLOR });
    if (!on) return;
    this.fx.sparksAt(_a.copy(P.pos).setY(P.pos.y + 0.9), 30, { speed: 7, dir: UP, spread: 1.6, life: 0.6, width: 0.03, grav: -2, color: RAGE_COLOR });
    this.flashCb?.('#ff2a3a', 0.2);
    this.punchCb?.(0.5);
    this.drawnT = 3;
  }
  // blade, trail and aura follow the frenzy
  updateLook(dt, P) {
    const rage = this.kit.raging;
    if (rage !== this.rageLook) {
      this.rageLook = rage;
      this.edgeMat.emissive.setHex(rage ? RAGE_COLOR : STEEL);
      this.edgeMat.emissiveIntensity = rage ? 3.2 : 0.25;
      this.trail.mesh.material.uniforms.color.value.set(rage ? RAGE_COLOR : 0xcfe9ff).multiplyScalar(2);
    }
    if (rage && Math.random() < dt * 14) {
      const a = Math.random() * Math.PI * 2;
      this.fx.sparksAt(_a.set(P.pos.x + Math.cos(a) * 0.4, P.pos.y + 0.1 + Math.random() * 1.2, P.pos.z + Math.sin(a) * 0.4), 1, { speed: 2.2, dir: UP, spread: 0.3, life: 0.45, width: 0.02, grav: -1.5, color: RAGE_COLOR });
    }
  }
  slashColor(big) { return this.kit.raging ? (big ? 0xff9a8a : 0xff5a5a) : (big ? 0xd8f0ff : 0xbfe6ff); }

  // ---------------- clip moves ----------------
  startMove(kind, P, targets) {
    const prev = this.act?.kind === 'move' ? this.act : null;
    let mv;
    if (kind === 'plunge') { if (P.grounded) return; mv = this.moves.plunge; }
    else if (!P.grounded) {
      if (kind !== 'attack') return;
      const n = prev?.mv.air ? this.combo : 0; mv = this.moves.air[n % this.moves.air.length]; this.combo = n + 1;
    } else if (kind === 'launch') { mv = this.moves.launch; this.combo = 0; }
    else if (Math.hypot(P.vel.x, P.vel.z) > 7.2 && !prev) { mv = this.moves.run; this.combo = 0; }
    else if (this.kit.whirl && (prev?.mv.whirl || this.combo >= this.moves.ground.length)) { mv = this.moves.whirl; this.kit.mark('whirlCut'); }
    else {
      if (!(prev || this.comboGap < 0.45) || this.combo >= this.moves.ground.length) this.combo = 0;
      mv = this.moves.ground[this.combo++];
    }
    if (kind === 'launch') this.kit.mark('launch');
    // the frenzy speeds every cut up
    const sp = this.kit.speed;
    mv = { ...mv, t: mv.t.slice(), speed: mv.speed * sp, arcs: sp === 1 ? mv.arcs : mv.arcs.map((a) => ({ ...a, dt: a.dt / sp, dur: a.dur / sp })) };
    const a = { kind: 'move', mv };
    this.hits.clear(); this.arcI = 0; this.comboGap = 0; this.slammed = false; this.rehitT = 0;
    const t = this.nearestTarget(P, targets, mv.run ? 9 : 6);
    a.target = t;
    if (t) P.yaw = Math.atan2(t.pos.x - P.pos.x, t.pos.z - P.pos.z);
    const c = this.ch;
    let c0 = mv.seg[0], v0 = null;
    if (prev && prev.mv.clip === mv.clip && c.currentName === mv.clip) {
      const ct = clipTime(prev.mv, this.t);
      if (ct > mv.seg[0] - 0.45 && ct < mv.seg[1] - 0.04) { c0 = ct; v0 = clipRate(prev.mv, this.t); }
    }
    makeWarp(mv, c0, v0);
    if (v0 == null) { c.play(mv.clip, { fade: 0.08, time: c0, restart: true }); c.scrub(c0); }
    // motion warping: stretch or shorten the clip's travel so the cut lands at reach (no target: travel as recorded)
    a.warp = 1;
    if (t && mv.rm && !mv.air) {
      const need = Math.hypot(t.pos.x - P.pos.x, t.pos.z - P.pos.z) - t.radius - mv.rangeM * 0.55;
      const avail = rmAt(mv.rm, 'fwd', mv.seg[2]) - rmAt(mv.rm, 'fwd', c0);
      a.warp = avail > 0.2 ? clamp(need / avail, 0, 2.2) : 1;
      a.home = avail <= 0.2 ? Math.max(0, need) : 0;
    }
    if (mv.air) P.vel.y = Math.max(P.vel.y, 2.5);
    this.act = a; this.t = 0;
    this.drawnT = 3;
    P.action = this;
  }

  // ---------------- Daywalker Dash ----------------
  dirFrom(P, I) {
    const cy = this.camYaw ?? P.yaw;
    const f = _a.set(-Math.sin(cy), 0, -Math.cos(cy)), r = _b.set(Math.cos(cy), 0, -Math.sin(cy));
    const d = _c.set(0, 0, 0).addScaledVector(f, I.move.y).addScaledVector(r, I.move.x);
    if (d.lengthSq() < 0.05) d.set(Math.sin(P.yaw), 0, Math.cos(P.yaw));          // no stick: straight ahead
    return d.normalize().clone();
  }
  // a dash along the stick (or straight ahead). opts.ult: the Thousand-Fold Slash's entry, to opts.to
  startDash(P, I, opts = {}) {
    const K = this.kit, air = !P.grounded;
    let dist = DASH_DIST, d;
    if (opts.ult) { d = opts.to.clone().sub(P.pos).setY(0); dist = d.length(); d.normalize(); }
    else { d = this.dirFrom(P, I); K.useDash(); if (air) this.airDashes--; }
    const up = !opts.ult && !!I?.jump;                                   // jump held: the dash carries you upward
    P.yaw = Math.atan2(d.x, d.z);
    const gun = K.gun && !opts.ult;
    const dur = opts.ult ? 0.4 : air ? AIR_DASH_DUR : DASH_DUR;
    this.act = { kind: 'dash', dir: d, dist, dur, from: P.pos.clone(), gun, ult: !!opts.ult, air: air || up, up, zone: opts.to || null };
    if (up) { P.grounded = false; P.state = 'air'; P.pos.y += 0.05; K.mark('dashUp'); }
    this.t = 0; this.hits.clear();
    if (gun) this.ch.play('k_dash', { fade: 0.05, time: 0.05, speed: 1.7, restart: true });
    else { this.ch.play('k_rush', { fade: 0.04, time: RUSH.dash0, restart: true }); this.ch.scrub(RUSH.dash0); }
    const col = opts.ult || K.raging ? RAGE_COLOR : 0xcfe9ff;
    this.fx.ring(_a.copy(P.pos).setY(P.pos.y + 0.05), opts.ult ? 3.4 : 2.2, { life: 0.35, color: col });
    this.fx.sparksAt(_a.copy(P.pos).setY(P.pos.y + 0.6), opts.ult ? 30 : 14, { speed: 7, dir: d.clone().negate(), spread: 0.8, floor: P.pos.y, color: col, width: 0.03, grav: 0 });
    if (opts.ult) this.flashCb?.('#ff2a3a', 0.22);
    this.punchCb?.(opts.ult ? 0.9 : 0.4);
    this.drawnT = 3;
    P.action = this;
  }

  // ---------------- Thousand-Fold Slash ----------------
  // lay the path: an iai crouch, the strip on the floor following the camera
  startAim(P) {
    const K = this.kit;
    if (K.gun) this.swap(P, 'sword');
    K.aiming = true;
    this.act = { kind: 'aim' }; this.t = 0;
    this.ch.play('k_rush', { fade: 0.12, time: 0, restart: true }); this.ch.scrub(0);
    this.drawnT = 3;
    P.action = this;
  }
  confirmUlt(P) {
    const to = P.pos.clone().addScaledVector(_a.set(Math.sin(P.yaw), 0, Math.cos(P.yaw)), ULT_LEN);
    this.kit.useUlt();
    this.startDash(P, null, { ult: true, to });
  }
  openZone(from, to) {
    this.zone = { a: from.clone(), b: to.clone(), t: 0, tick: 0 };
    this.zone.a.y = this.zone.b.y = from.y;
    setLane(this.lane, from, Math.atan2(to.x - from.x, to.z - from.z), from.distanceTo(to), ULT_W);
  }
  // the path cuts everything on it, over and over, then bursts
  updateZone(dt, P, targets) {
    const Z = this.zone;
    if (!Z) return;
    Z.t += dt; Z.tick -= dt;
    const done = Z.t >= KIT.ultT;
    if (Z.tick <= 0 || done) {
      Z.tick = KIT.ultTick;
      // slashes criss-crossing the path
      for (let i = 0; i < (done ? 8 : 3); i++) {
        _c.copy(Z.a).lerp(Z.b, Math.random());
        _c.x += (Math.random() - 0.5) * ULT_W * 0.5; _c.z += (Math.random() - 0.5) * ULT_W * 0.5; _c.y += 0.6 + Math.random() * 1.4;
        const b = Math.random() * Math.PI * 2, tilt = (Math.random() - 0.5) * 2.2;
        _U.set(Math.cos(b), 0, Math.sin(b));
        _V.set(-Math.sin(b) * Math.sin(tilt), Math.cos(tilt), Math.cos(b) * Math.sin(tilt));
        const a0 = Math.random() * 6.28, sw = (1.6 + Math.random() * 1.6) * (Math.random() < 0.5 ? -1 : 1);
        this.fx.crescent(_c, _U, _V, a0, a0 + sw, 0.07, { radius: (done ? 2.4 : 1.4) + Math.random() * 1.2, innerFrac: 0.62, life: 0.2, color: i % 2 ? 0xffffff : 0xff4a55 });
      }
      for (const t of targets) {
        if (!t.alive || distToLane(t.pos, Z.a, Z.b) > ULT_W * 0.5 + t.radius || Math.abs(t.pos.y - Z.a.y) > 3) continue;
        wound(t, this.now);
        _V.set(Z.b.x - Z.a.x, 0, Z.b.z - Z.a.z).normalize();
        this.hit(t, done ? { dmg: 42, heavy: true, finisher: true, hitstop: 0.12, zone: true } : { dmg: 9, hitstop: 0.012, zone: true, light: true }, P, _V);
      }
    }
    if (done) {
      this.fx.sparksAt(_a.copy(Z.a).lerp(Z.b, 0.5).setY(Z.a.y + 0.6), 40, { speed: 12, dir: UP, spread: 1.6, color: RAGE_COLOR, width: 0.035, floor: Z.a.y });
      this.flashCb?.('#ffffff', 0.25); this.punchCb?.(1);
      this.shake = Math.max(this.shake, 0.6);
      this.zone = null; this.lane.visible = false;
    }
  }

  // A foe's blow reaches you, from a point on the ground. Returns 'dodge' (mid-dash), 'block' (the Shroud took it:
  // the dash comes back sooner) or 'hit' (a stagger).
  takeHit(from, P) {
    if (this.act?.kind === 'dash') return 'dodge';
    const dx = from.x - P.pos.x, dz = from.z - P.pos.z, d = Math.hypot(dx, dz) || 1;
    const facing = (dx * Math.sin(P.yaw) + dz * Math.cos(P.yaw)) / d;
    if (this.act?.kind === 'guard' && facing > 0.1) {
      this.kit.blocked();
      P.vel.x -= dx / d * 2.5; P.vel.z -= dz / d * 2.5;
      this.shake = Math.max(this.shake, 0.18);
      return 'block';
    }
    if (this.act) this.end(P);
    this.act = { kind: 'hit' }; this.t = 0;
    this.kit.mark('struck');
    this.ch.play(Math.random() < 0.5 ? 'k_hit' : 'k_hit2', { fade: 0.05, time: 0.05, speed: 1.5, restart: true });
    P.vel.x = -dx / d * 5.5; P.vel.z = -dz / d * 5.5;
    this.flashCb?.('#ff3a2a', 0.22);
    this.shake = Math.max(this.shake, 0.32);
    this.drawnT = 3;
    P.action = this;
    return 'hit';
  }

  // ---------------- Scarlet Shroud ----------------
  startGuard(P) {
    if (this.kit.gun) this.swap(P, 'sword');
    this.act = { kind: 'guard' }; this.t = 0;
    this.kit.mark('block');
    this.ch.play('k_block', { fade: 0.12, time: 0.6, speed: 0, restart: true });
    this.drawnT = 3;
    P.action = this;
  }

  // behind the Shroud you can still walk: the legs step under the held block
  guardWalk(P) {
    const sp = Math.hypot(P.vel.x, P.vel.z), c = this.ch, walk = c.actions.k_block_walk;
    if (walk && sp > 0.35) c.play('k_block_walk', { fade: 0.18, speed: clamp(sp / 1.6, 0.5, 1.3) });
    else if (c.currentName !== 'k_block') c.play('k_block', { fade: 0.18, time: 0.6, speed: 0, restart: true });
  }

  // called by the Parkour controller while an action owns the body
  drive(dt, P, wish) {
    const a = this.act, v = P.vel;
    if (!a) return;
    if (a.kind === 'move') {
      const mv = a.mv;
      if (mv.plunge) {
        v.x *= Math.exp(-dt * 6); v.z *= Math.exp(-dt * 6);
        v.y = this.t > mv.t[0] ? -24 : Math.max(v.y - 10 * dt, 0);
        return;
      }
      // root motion: the clip's own travel (warped toward the target), along the facing
      const tc = clipTime(mv, this.t), rate = clipRate(mv, this.t);
      let f = 0, l = 0;
      if (mv.rm) {
        f = (rmAt(mv.rm, 'fwd', tc + 0.01) - rmAt(mv.rm, 'fwd', tc - 0.01)) / 0.02 * rate * a.warp;
        l = (rmAt(mv.rm, 'left', tc + 0.01) - rmAt(mv.rm, 'left', tc - 0.01)) / 0.02 * rate * Math.min(1, a.warp);
      }
      if (a.home && this.t < mv.t[0] + mv.t[1] * 0.6) f += Math.min(9, a.home * 6);
      const t = a.target;
      if (t && t.alive && this.t < mv.t[0] + mv.t[1] * 0.6) P.yaw += angDiff(P.yaw, Math.atan2(t.pos.x - P.pos.x, t.pos.z - P.pos.z)) * Math.min(1, dt * 16);
      const sy = Math.sin(P.yaw), cy = Math.cos(P.yaw);
      const k = 1 - Math.exp(-30 * dt);
      v.x += (sy * f + cy * l - v.x) * k;
      v.z += (cy * f - sy * l - v.z) * k;
      if (mv.launch) {
        // ride the clip's leap up, then hand over to the air with the jump's speed
        const up = (rmAt(mv.rm, 'up', tc + 0.01) - rmAt(mv.rm, 'up', tc - 0.01)) / 0.02 * rate;
        v.y = this.t > mv.t[0] * 0.6 ? Math.max(up * 1.25, -2) : v.y - 24 * dt;
      } else if (mv.air) v.y = Math.max(v.y - 24 * 0.22 * dt, -2.5);
      else v.y -= 24 * dt;
      return;
    }
    if (a.kind === 'dash') {
      // a fast start easing out; the whole distance in the dash's time
      const k = Math.min(1, this.t / a.dur), sp = a.dist / a.dur * 2 * (1 - k);
      v.x = a.dir.x * sp * (a.up ? 0.6 : 1); v.z = a.dir.z * sp * (a.up ? 0.6 : 1);
      v.y = a.up ? sp * 0.62 : P.grounded || a.air ? 0 : v.y - 24 * dt;
      return;
    }
    if (a.kind === 'hit') { v.x *= Math.exp(-dt * 8); v.z *= Math.exp(-dt * 8); v.y -= 24 * dt; return; }
    if (a.kind === 'aim') {
      // stand in the stance, turning with the camera
      P.yaw += angDiff(P.yaw, this.camForward()) * Math.min(1, dt * 12);
      v.x *= Math.exp(-dt * 14); v.z *= Math.exp(-dt * 14); v.y -= 24 * dt;
      return;
    }
    if (a.kind === 'guard') {
      const k = 1 - Math.exp(-10 * dt);
      v.x += (wish.x * 1.8 - v.x) * k; v.z += (wish.z * 1.8 - v.z) * k; v.y -= 24 * dt;
    }
  }

  step(dt, P, targets) {
    const a = this.act;
    this.t += dt;
    if (a.kind === 'move') return this.stepMove(dt, P, targets);
    if (a.kind === 'hit') { if (this.t >= 0.42) this.end(P); return; }
    if (a.kind === 'aim') {
      const tc = this.t < RUSH.crouch ? this.t : RUSH.holdA + (Math.sin((this.t - RUSH.crouch) * 1.4) * 0.5 + 0.5) * (RUSH.holdB - RUSH.holdA) * 0.6;
      this.ch.scrub(tc);
      setLane(this.lane, P.pos, P.yaw, ULT_LEN, ULT_W);
      return;
    }
    if (a.kind === 'dash') {
      const k = Math.min(1, this.t / a.dur);
      if (!a.gun) {
        this.ch.scrub(RUSH.dash0 + (RUSH.dash1 - RUSH.dash0) * k);
        // the cleaving strike: everything along the path gets cut, and slowed
        for (const t of targets) {
          if (!t.alive || this.hits.has(t)) continue;
          if (distToSeg(t.pos, a.from, P.pos) < t.radius + 1.0 && Math.abs(t.pos.y - P.pos.y) < 2.2) {
            this.hits.add(t);
            slow(t, this.now);
            this.hit(t, { dmg: a.ult ? 30 : 24, heavy: true, hitstop: 0.09, wound: true }, P);
          }
        }
      }
      if (k < 1) return;
      if (a.gun) {
        // out of the dash with a wide blast at whatever is in front
        this.fireGun(P, targets, { free: true, wide: true });
        P.vel.multiplyScalar(0.3);
        return this.end(P);
      }
      // the flash line along the cut, and the finish
      this.beam.set(_a.copy(a.from).setY(a.from.y + 1.1), _b.copy(P.pos).setY(P.pos.y + 1.1), a.ult ? 0.16 : 0.09, 1, 1);
      this.beamT = 0.35;
      this.fx.crescent(_c.copy(P.pos).setY(P.pos.y + 1.1), _U.set(Math.cos(P.yaw), 0, -Math.sin(P.yaw)), _V.set(Math.sin(P.yaw), 0, Math.cos(P.yaw)), -1.2, 1.2, 0.08, { radius: a.ult ? 3 : 2.3, innerFrac: 0.6, life: 0.3, color: this.slashColor(true) });
      if (a.ult) this.openZone(a.from, P.pos);
      P.vel.multiplyScalar(0.2);
      this.act = { kind: 'move', mv: this.finishMove(), warp: 0 };
      this.t = 0;
    }
  }

  // the end of the rush: the follow-through after the dash, quickly back to stance
  finishMove() {
    const mv = { clip: 'k_rush', start: RUSH.dash1, speed: 1.6, seg: [RUSH.dash1, RUSH.dash1 + 0.01, RUSH.dash1 + 0.02, RUSH.end], arcs: [], rangeM: 0, cone: 0, dmg: 0, rm: null };
    return makeWarp(mv, RUSH.dash1);
  }

  stepMove(dt, P, targets) {
    const a = this.act, mv = a.mv;
    const [tw, ts, tr] = mv.t;
    mv.phase = this.t < tw ? 'wind' : this.t < tw + ts ? 'swing' : 'recover';
    this.ch.scrub(clipTime(mv, this.t));
    if (mv.phase !== 'wind') this.slashes(P);
    // the whirlwind cuts again and again as it turns
    if (mv.whirl && mv.phase === 'swing' && (this.rehitT += dt) > 0.2 / this.kit.speed) { this.rehitT = 0; this.hits.clear(); }
    if (mv.phase === 'swing' || (mv.phase === 'recover' && this.t < tw + ts + 0.04)) this.sweep(P, targets);
    if (mv.plunge && P.grounded && this.t > tw && !this.slammed) {
      this.slammed = true;
      this.fx.ring(_a.copy(P.pos).setY(P.pos.y + 0.1), 3.4, { life: 0.45, color: 0xcfe9ff });
      this.fx.sparksAt(_a.copy(P.pos).setY(P.pos.y + 0.2), 26, { speed: 9, dir: UP, spread: 1.4, floor: P.pos.y, color: 0xcfe9ff, width: 0.03 });
      for (const t of targets) if (t.alive && t.pos.distanceTo(P.pos) < 3.4 + t.radius && !this.hits.has(t)) { this.hits.add(t); this.hit(t, mv, P); }
      this.shake = Math.max(this.shake, 0.5);
      this.punchCb?.(0.6);
      this.t = Math.max(this.t, tw + ts);
    }
    if (mv.launch && this.t >= tw + ts) { this.end(P); P.grounded = false; P.state = 'air'; return; }
    if (mv.air && P.grounded && this.t > tw) return this.end(P);
    if (this.t >= tw + ts + tr) this.end(P);
  }

  end(P) {
    if (this.act?.kind === 'aim') { this.kit.aiming = false; if (!this.zone) this.lane.visible = false; }
    this.act = null; P.action = null; this.comboGap = 0;
  }

  sweep(P, targets) {
    const mv = this.act.mv;
    const fx = Math.sin(P.yaw), fz = Math.cos(P.yaw);
    for (const t of targets) {
      if (!t.alive || this.hits.has(t)) continue;
      const dx = t.pos.x - P.pos.x, dz = t.pos.z - P.pos.z, d = Math.hypot(dx, dz);
      if (d > mv.rangeM + t.radius || Math.abs(t.pos.y - P.pos.y) > 2.2) continue;
      const cos = d > 0.01 ? (dx * fx + dz * fz) / d : 1;
      if (Math.acos(clamp(cos, -1, 1)) > mv.cone && d > 0.9) continue;
      this.hits.add(t);
      this.hit(t, mv, P);
    }
  }

  // every hit goes through here: the frenzy and a wound scale it, and it charges the ultimate
  hit(t, mv, P, dir = null) {
    const K = this.kit;
    const dmg = mv.dmg * K.dmg * woundMul(t, this.now);
    const p = _p.copy(t.pos); p.y += 1.2;
    t.hit?.(dmg, dir ? _s.copy(dir) : _s.set(Math.sin(P.yaw), 0, Math.cos(P.yaw)), { ...mv, dmg });
    if (!mv.zone) K.dealt(dmg);
    if (!mv.zone && !mv.gun) K.swordHit();
    if (mv.gun) K.mark('gunHit');
    if (mv.finisher && !mv.zone) K.mark('finisher');
    const big = mv.heavy || mv.finisher;
    const col = K.raging || mv.zone || mv.wound ? 0xff6a5a : 0xffe2a8;
    if (mv.light) this.fx.sparksAt(p, 6, { color: col, speed: 7, life: 0.3, width: 0.03, grav: 6, floor: t.pos.y });
    else {
      this.fx.sparksAt(p, big ? 34 : 18, { color: col, speed: 9, life: 0.45, width: 0.035, grav: 6, floor: t.pos.y });
      this.fx.sparksAt(p, 8, { color: 0xffffff, speed: 14, life: 0.18, width: 0.025 });
    }
    this.hitstop = Math.max(this.hitstop, mv.hitstop ?? 0.06);
    this.shake = Math.max(this.shake, big ? 0.35 : mv.light ? 0.08 : 0.16);
    if (big) this.punchCb?.(0.5);
  }

  // slash crescents along the swing arcs (in the character's frame, facing +Z)
  slashes(P) {
    const mv = this.act.mv, tw = mv.t[0];
    if (!mv.arcs.length) return;
    const m = this.ch.root.matrixWorld;
    while (this.arcI < mv.arcs.length && this.t >= tw + mv.arcs[this.arcI].dt) {
      const a = mv.arcs[this.arcI++];
      _c.set(a.c[0], a.c[1], a.c[2]).applyMatrix4(m);
      _U.set(a.u[0], a.u[1], a.u[2]).transformDirection(m);
      _V.set(a.v[0], a.v[1], a.v[2]).transformDirection(m);
      const big = mv.heavy || mv.finisher;
      const ang = clamp(a.a1, -Math.PI * 2 + 0.01, Math.PI * 2 - 0.01);
      this.fx.crescent(_c, _U, _V, 0, ang, Math.max(0.05, a.dur), { radius: (a.r + 0.2) * (big ? 1.15 : 1.05), innerFrac: 0.55, life: big ? 0.3 : 0.2, color: this.slashColor(big) });
    }
  }

  updateTrail(swinging) {
    const k = this.katana;
    if (!this.drawn) { this.fx.pushTrail(_a.set(0, -99, 0), _b.set(0, -99, 0), false, this.trail); return; }
    k.updateMatrixWorld(true);
    const L = k.userData.length;
    const base = _a.set(0, L * 0.25, 0).applyMatrix4(k.matrixWorld);
    const tip = _b.set(-0.035, L, 0).applyMatrix4(k.matrixWorld);
    this.fx.pushTrail(base, tip, swinging, this.trail);
  }

  updateBeam(dt) {
    if (this.beamT <= 0) return;
    this.beamT -= dt;
    const k = Math.max(0, this.beamT / 0.35);
    this.beam.mat.uniforms.alpha.value = k;
    this.beam.mesh.visible = k > 0.01;
  }

  dispose() {
    this.katana.removeFromParent(); this.gun.removeFromParent(); this.lane.removeFromParent();
    this.trail.on = false; this.trail.mesh.visible = false;
    this.beam.hide();
  }
}

function distToSeg(p, a, b) {
  const abx = b.x - a.x, abz = b.z - a.z, l2 = abx * abx + abz * abz;
  const t = l2 > 1e-6 ? clamp(((p.x - a.x) * abx + (p.z - a.z) * abz) / l2, 0, 1) : 0;
  return Math.hypot(p.x - (a.x + abx * t), p.z - (a.z + abz * t));
}
