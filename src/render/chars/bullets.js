import * as THREE from 'three';

// Visible shots for the pulse scattergun: every pellet is a glowing bolt that flies from the muzzle to wherever its
// line ends, far across the level, and marks what it strikes: a flash and sparks on arrival, and on walls and floors
// a scorch with an ember ring that cools and fades. The hit itself is decided at the trigger pull (bladeKit.shotgun
// with a `world` ray); this is what you see of it. Everything is pooled.
//
// world rays: (origin, dir, max) -> { t, n } | null, the first solid thing along a line and its surface normal.

const _v = new THREE.Vector3(), _n = new THREE.Vector3(), _z = new THREE.Vector3(0, 0, 1), _y = new THREE.Vector3(0, 1, 0);

// against a level's boxes ({ min, max }), floor included
export function worldOfBoxes(boxes) {
  const n = new THREE.Vector3();
  return (o, d, max) => {
    let best = max, axis = -1, sign = 0;
    for (const b of boxes) {
      let t0 = 0, t1 = best, ax = -1, sg = 0, miss = false;
      for (let k = 0; k < 3; k++) {
        const oo = o.getComponent(k), dd = d.getComponent(k), lo = b.min.getComponent(k), hi = b.max.getComponent(k);
        if (Math.abs(dd) < 1e-9) { if (oo < lo || oo > hi) { miss = true; break; } continue; }
        let a = (lo - oo) / dd, c = (hi - oo) / dd, s = -1;
        if (a > c) { const x = a; a = c; c = x; s = 1; }
        if (a > t0) { t0 = a; ax = k; sg = s; }
        if (c < t1) t1 = c;
        if (t0 > t1) { miss = true; break; }
      }
      if (miss || ax < 0 || t0 >= best) continue;            // ax < 0: the ray starts inside this box
      best = t0; axis = ax; sign = sg;
    }
    if (axis < 0) return null;
    n.set(0, 0, 0).setComponent(axis, sign);
    return { t: best, n };
  };
}
// against open ground given as a height field
export function worldOfHeight(height) {
  const n = new THREE.Vector3();
  return (o, d, max) => {
    let prev = 0;
    for (let t = 2; t <= max; t += Math.max(2, t * 0.04)) {
      const x = o.x + d.x * t, z = o.z + d.z * t;
      if (o.y + d.y * t <= height(x, z)) {
        let a = prev, b = t;
        for (let i = 0; i < 10; i++) { const m = (a + b) / 2; if (o.y + d.y * m <= height(o.x + d.x * m, o.z + d.z * m)) b = m; else a = m; }
        const hx = o.x + d.x * b, hz = o.z + d.z * b, e = 0.5;
        n.set(height(hx - e, hz) - height(hx + e, hz), 2 * e, height(hx, hz - e) - height(hx, hz + e)).normalize();
        return { t: b, n };
      }
      prev = t;
    }
    return null;
  };
}

export class Bullets {
  // k: size of everything (1 for a person, the mech's scale for a mech)
  constructor(scene, fx, k = 1) {
    this.fx = fx; this.k = k;
    const add = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false };
    // bolts: a hot core in a coloured sheath, unit length along +Z
    const core = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true).rotateX(Math.PI / 2).translate(0, 0, -0.5);
    this.bolts = [];
    for (let i = 0; i < 40; i++) {
      const g = new THREE.Group();
      const sheath = new THREE.Mesh(core, new THREE.MeshBasicMaterial({ ...add, color: 0x39d8ff, opacity: 0.55, side: THREE.DoubleSide }));
      const hot = new THREE.Mesh(core, new THREE.MeshBasicMaterial({ ...add, color: 0xffffff, side: THREE.DoubleSide }));
      hot.scale.set(0.4, 0.4, 1);
      g.add(sheath, hot); g.visible = false; g.frustumCulled = false; sheath.frustumCulled = hot.frustumCulled = false;
      scene.add(g);
      this.bolts.push({ g, sheath, live: false, from: new THREE.Vector3(), dir: new THREE.Vector3(), n: new THREE.Vector3() });
    }
    // marks: a dark scorch with an ember ring over it
    const disc = new THREE.CircleGeometry(1, 14), ring = new THREE.RingGeometry(0.45, 1, 14);
    this.marks = [];
    for (let i = 0; i < 56; i++) {
      const g = new THREE.Group();
      const scorch = new THREE.Mesh(disc, new THREE.MeshBasicMaterial({ color: 0x050607, transparent: true, opacity: 0.7, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
      const ember = new THREE.Mesh(ring, new THREE.MeshBasicMaterial({ ...add, color: 0x39d8ff, polygonOffset: true, polygonOffsetFactor: -3 }));
      g.add(scorch, ember); g.visible = false; g.renderOrder = 1;
      scene.add(g);
      this.marks.push({ g, scorch, ember, t: 9 });
    }
    this.bi = 0; this.mi = 0;
  }

  // one bolt from `from` to `to`. kind: 'world' (leaves a mark; n is the surface normal), 'target', or 'air'
  fire(from, to, { kind = 'air', n = null, color = 0x39d8ff, speed = 240 } = {}) {
    const b = this.bolts[this.bi]; this.bi = (this.bi + 1) % this.bolts.length;
    b.from.copy(from); b.dir.copy(to).sub(from);
    b.len = b.dir.length(); if (b.len < 1e-3) return;
    b.dir.multiplyScalar(1 / b.len);
    b.s = 0; b.speed = speed * this.k; b.kind = kind; b.color = color; b.live = true;
    if (n) b.n.copy(n); else b.n.copy(b.dir).negate();
    b.sheath.material.color.set(color);
    b.g.quaternion.setFromUnitVectors(_z, b.dir);
    b.g.visible = false;                      // shown from its first step, clear of the muzzle
  }

  impact(b) {
    const k = this.k, p = _v.copy(b.from).addScaledVector(b.dir, b.len);
    this.fx.sparksAt(p, b.kind === 'world' ? 5 : 3, { dir: b.n, spread: 0.9, speed: 5 * k, life: 0.28, width: 0.022 * k, grav: 6, color: b.color, intensity: 5 });
    if (b.kind !== 'world') return;
    const m = this.marks[this.mi]; this.mi = (this.mi + 1) % this.marks.length;
    m.g.position.copy(p).addScaledVector(b.n, 0.012 * k);
    m.g.quaternion.setFromUnitVectors(_z, _n.copy(b.n));
    m.g.rotateZ(Math.random() * 6.28);
    m.size = (0.09 + Math.random() * 0.05) * k;
    m.g.scale.setScalar(m.size);
    m.ember.material.color.set(b.color);
    m.t = 0; m.g.visible = true;
  }

  update(dt) {
    const k = this.k;
    for (const b of this.bolts) {
      if (!b.live) continue;
      b.s += b.speed * dt;
      if (b.s >= b.len) { b.live = false; b.g.visible = false; if (b.kind !== 'air') this.impact(b); continue; }
      // a streak behind the head, never longer than what it has flown
      const tail = Math.min(b.s, 3.4 * k);
      b.g.position.copy(b.from).addScaledVector(b.dir, b.s);
      b.g.scale.set(0.032 * k, 0.032 * k, Math.max(0.05, tail));
      b.g.visible = true;
    }
    for (const m of this.marks) {
      if (m.t > 8) continue;
      m.t += dt;
      // the ember flares and cools in half a second; the scorch stays, then fades out
      const e = Math.max(0, 1 - m.t / 0.55);
      m.ember.visible = e > 0; m.ember.material.opacity = e; m.ember.scale.setScalar(1 + (1 - e) * 0.8);
      m.scorch.material.opacity = 0.7 * Math.min(1, (8 - m.t) / 2);
      if (m.t > 8) m.g.visible = false;
    }
  }
}
