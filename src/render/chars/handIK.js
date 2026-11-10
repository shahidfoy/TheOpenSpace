import * as THREE from 'three';

// Arm helpers shared by the VRM characters and the mech: a two-bone IK that puts a hand on a world-space point
// (the off hand on the sword's handle, the gun arm on its aim line), and the centre of a fist from its finger joints.

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _t = new THREE.Vector3();
const _ba = new THREE.Vector3(), _bc = new THREE.Vector3(), _n = new THREE.Vector3(), _v = new THREE.Vector3();
const _qu = new THREE.Quaternion(), _ql = new THREE.Quaternion(), _qh = new THREE.Quaternion(), _qp = new THREE.Quaternion();
const _d1 = new THREE.Quaternion(), _d2 = new THREE.Quaternion(), _q = new THREE.Quaternion();
const _u0 = new THREE.Quaternion(), _l0 = new THREE.Quaternion(), _h0 = new THREE.Quaternion();
const _s = new THREE.Vector3();

const worldQ = (o, out) => { o.matrixWorld.decompose(_v, out, _s); return out; };

// Rotates `upper` and `lower` so `hand` lands on `target` (world). The elbow keeps bending in the plane it is
// already in (or toward `pole`, a world direction, when the arm is straight). The hand keeps its world orientation
// unless handQ (world) is given. weight blends from the animated pose. Bones must share uniform scale.
export function twoBoneIK(upper, lower, hand, target, weight = 1, { pole = null, handQ = null } = {}) {
  if (weight <= 0.001) return;
  upper.updateWorldMatrix(true, false); lower.updateWorldMatrix(true, false); hand.updateWorldMatrix(true, false);
  _a.setFromMatrixPosition(upper.matrixWorld); _b.setFromMatrixPosition(lower.matrixWorld); _c.setFromMatrixPosition(hand.matrixWorld);
  const lab = _a.distanceTo(_b), lcb = _b.distanceTo(_c);
  _t.copy(target).sub(_a);
  const lat = THREE.MathUtils.clamp(_t.length(), Math.abs(lab - lcb) * 1.02 + 1e-4, (lab + lcb) * 0.998);
  _t.normalize();
  _ba.copy(_a).sub(_b); _bc.copy(_c).sub(_b);
  const ang0 = _ba.angleTo(_bc);
  const ang1 = Math.acos(THREE.MathUtils.clamp((lab * lab + lcb * lcb - lat * lat) / (2 * lab * lcb), -1, 1));
  _n.crossVectors(_ba, _bc);
  if (_n.lengthSq() < 1e-8 * lab * lab * lcb * lcb) {
    if (pole) _n.crossVectors(_ba, pole); else _n.set(0, 1, 0).cross(_ba);
    if (_n.lengthSq() < 1e-10) _n.set(1, 0, 0);
  }
  _n.normalize();
  _d1.setFromAxisAngle(_n, ang1 - ang0);
  // the wrist after the elbow bend, then swing the whole arm onto the target line
  _v.copy(_bc).applyQuaternion(_d1).add(_b).sub(_a).normalize();
  _d2.setFromUnitVectors(_v, _t);
  worldQ(upper, _qu); worldQ(lower, _ql); worldQ(hand, _qh);
  _u0.copy(upper.quaternion); _l0.copy(lower.quaternion); _h0.copy(hand.quaternion);
  const through = (child, parentOldWorld, parentNewWorld, childNewWorld, out) => {
    // child's direct parent may sit below the driven bone (twist bones): carry the rest offset through
    worldQ(child.parent, _qp);
    _q.copy(parentOldWorld).invert().multiply(_qp);              // driven bone -> direct parent
    return out.copy(parentNewWorld).multiply(_q).invert().multiply(childNewWorld);
  };
  const nu = _d2.clone().multiply(_qu), nl = _d2.clone().multiply(_d1).multiply(_ql);
  const nh = handQ ? handQ.clone() : _qh.clone();
  // upper: local = parentWorld^-1 * newWorld
  worldQ(upper.parent, _qp);
  const lu = _qp.clone().invert().multiply(nu);
  const ll = through(lower, _qu, nu, nl, new THREE.Quaternion());
  const lh = through(hand, _ql, nl, nh, new THREE.Quaternion());
  upper.quaternion.copy(_u0).slerp(lu, weight);
  lower.quaternion.copy(_l0).slerp(ll, weight);
  hand.quaternion.copy(_h0).slerp(lh, weight);
  upper.updateWorldMatrix(false, true);
}

// ---------------- hands of a VRM humanoid ----------------
// Measured once on the rest pose (T-pose, palms down), in the hand bone's own frame: where a handle sits in the fist
// (under the first finger bones, along the knuckle row), which way it runs, and finger poses that close around it.
// The katana pack and the Mixamo clips leave the fingers open, so the grip is posed here.
const GRIP = [1.2, 1.5, 1.05], RELAX = [0.28, 0.42, 0.3], THUMB = [1.15, 0.55, 0.6];
export class Hand {
  // node(b): the normalized bone for a humanoid bone name; root: the VRM scene; side: 'left' | 'right'
  constructor(node, root, side) {
    this.hand = node(`${side}Hand`);
    root.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(this.hand.matrixWorld).invert();
    const P = (b) => { const n = node(b); return n ? new THREE.Vector3().setFromMatrixPosition(n.matrixWorld).applyMatrix4(inv) : null; };
    const K = ['Index', 'Middle', 'Ring', 'Little'].map((f) => P(`${side}${f}Proximal`));
    this.ok = K.every(Boolean);
    if (!this.ok) return;
    // rest directions in the hand frame; the palm faces down in the T-pose
    const hq = new THREE.Quaternion(); this.hand.matrixWorld.decompose(_v, hq, _s);
    const rq = new THREE.Quaternion(); root.matrixWorld.decompose(_v, rq, _s);
    this.palm = new THREE.Vector3(0, -1, 0).applyQuaternion(rq).applyQuaternion(hq.clone().invert()).normalize();
    this.axis = K[0].clone().sub(K[3]).normalize();                       // knuckle row, little -> index
    this.width = K[0].distanceTo(K[3]);
    const kn = K.reduce((a, k) => a.add(k), new THREE.Vector3()).multiplyScalar(0.25);
    this.dir = kn.clone().addScaledVector(this.axis, -kn.dot(this.axis)).normalize();   // toward the fingers
    const hs = this.width / 0.067;                                        // hand size against the pack's mannequin
    this.size = hs;
    this.centre = kn.clone().addScaledVector(this.dir, 0.012 * hs).addScaledVector(this.palm, 0.027 * hs);
    // a held object's frame in the hand: +Y along the knuckle row out of the thumb side, +X toward the knuckles
    const X = this.dir.clone().addScaledVector(this.axis, -this.dir.dot(this.axis)).normalize();
    this.q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, this.axis, new THREE.Vector3().crossVectors(X, this.axis)));
    // finger joints: flex about (bone direction x palm normal), measured in each joint's parent frame at rest
    this.joints = [];
    for (const f of ['Index', 'Middle', 'Ring', 'Little', 'Thumb']) {
      const parts = f === 'Thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Intermediate', 'Distal'];
      let lastAxis = null;
      parts.forEach((part, i) => {
        const n = node(`${side}${f}${part}`), c = node(`${side}${f}${parts[i + 1]}`);
        if (!n) return;
        let ax = lastAxis;
        if (c) {
          const d = P(`${side}${f}${parts[i + 1]}`).sub(P(`${side}${f}${part}`)).normalize();
          ax = new THREE.Vector3().crossVectors(d, this.palm).normalize();
          // the thumb swings from beside the index finger down under the handle, closing the loop from below
          if (f === 'Thumb' && i === 0) ax = new THREE.Vector3().crossVectors(this.axis, this.palm).normalize();
          lastAxis = ax;
        }
        if (!ax) return;
        const grip = f === 'Thumb' ? THUMB[i] : GRIP[i] * (f === 'Little' ? 1.06 : f === 'Index' ? 0.94 : 1);
        const relax = f === 'Thumb' ? [0.15, 0.1, 0.15][i] : RELAX[i] * (f === 'Little' ? 1.3 : f === 'Index' ? 0.8 : 1);
        this.joints.push({ n, grip: new THREE.Quaternion().setFromAxisAngle(ax, grip), relax: new THREE.Quaternion().setFromAxisAngle(ax, relax) });
      });
    }
  }
  // k: 0 relaxed .. 1 closed around a handle
  curl(k) { for (const j of this.joints) j.n.quaternion.copy(j.relax).slerp(j.grip, k); }
}
