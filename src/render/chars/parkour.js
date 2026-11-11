import * as THREE from 'three';

// Third-person parkour controller for the VRM characters: run / sprint, jump + one air jump, wall-run along the
// glowing "run" panels, climb anything (the glowing "climb" panels freely, any other tall wall on stamina), leap up
// a wall while climbing, kick off walls, grab ledges and pull up onto them. The level is made of axis-
// aligned boxes ({ min, max, kind: 'solid' | 'run' | 'climb' }); the character is a vertical cylinder (feet at pos).

const G = 24, RUN = 6.2, SPRINT = 9.6, JUMP_V = 8.2, AIR_JUMP_V = 7.4;
const WALLRUN_T = 1.6, WALLRUN_V = 9, CLIMB_V = 2.6, CLIMB_SIDE = 1.6, MANTLE_T = 0.5;
const UP = new THREE.Vector3(0, 1, 0);
const _w = new THREE.Vector3(), _f = new THREE.Vector3(), _r = new THREE.Vector3(), _t = new THREE.Vector3(), _c = new THREE.Vector3();
const lerp = THREE.MathUtils.lerp, clamp = THREE.MathUtils.clamp;
const angDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
// linear sample of a keyed curve
function sampleCurve(T, V, t) {
  if (t <= T[0]) return V[0];
  for (let i = 1; i < T.length; i++) if (t <= T[i]) { const k = (t - T[i - 1]) / (T[i] - T[i - 1] || 1); return V[i - 1] + (V[i] - V[i - 1]) * k; }
  return V[V.length - 1];
}

export class Parkour {
  constructor(ch) {
    this.ch = ch;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.yaw = 0; this.roll = 0;
    this.R = 0.3; this.H = Math.max(1.2, ch.height * 0.95);
    this.state = 'air';
    this.grounded = false; this.coyote = 0; this.airJumps = 1;
    this.jumpHeld = false;
    this.wall = null;               // { n, box } current contact
    this.wallT = 0; this.wallCool = 0; this.lastWall = null; this.landT = 0;
    this.mantle = null;
    this.stamina = 1;               // free climbing on plain walls spends it; the ground refills it
    this.leapT = 0; this.wallPush = 0; this.kickWall = null;
    this.climbOff = 0; this.wrOff = 0;
  }

  spawn(p, yaw) {
    this.pos.copy(p); this.vel.set(0, 0, 0); this.yaw = yaw; this.state = 'air'; this.mantle = null;
  }

  // I: sampled input; ctx: { boxes, camYaw, killY, spawn: { pos, yaw } }
  update(dt, I, ctx) {
    this.boxes = ctx.boxes;
    const jumpEdge = I.jump && !this.jumpHeld;
    this.jumpHeld = I.jump;
    _f.set(-Math.sin(ctx.camYaw), 0, -Math.cos(ctx.camYaw));
    _r.set(Math.cos(ctx.camYaw), 0, -Math.sin(ctx.camYaw));
    const wish = _w.set(0, 0, 0).addScaledVector(_f, I.move.y).addScaledVector(_r, I.move.x);
    if (wish.lengthSq() > 1) wish.normalize();
    this.wallCool = Math.max(0, this.wallCool - dt);
    this.landT = Math.max(0, this.landT - dt);
    const v = this.vel, st = this.state;

    if (st === 'mantle') return this.updateMantle(dt);

    // a sword move owns the body: it sets the velocity, the clip and the facing
    if (this.action) {
      this.action.drive(dt, this, wish);
      this.integrate(dt, ctx.boxes);
      if (this.pos.y < ctx.killY) { this.action = null; this.spawn(ctx.spawn.pos, ctx.spawn.yaw); }
      this.animate(dt, true);
      return;
    }

    // deep water (ctx.water: { y, contains(x, z) }): float at the surface and swim; push into a quay or jump at it to
    // haul out
    const W = ctx.water;
    if (W && st !== 'climb' && W.contains(this.pos.x, this.pos.z)) {
      const floatY = W.y - this.H * 0.68;
      if (st === 'swim' || (this.pos.y < floatY + 0.1 && v.y <= 0.5)) {
        if (st !== 'swim') { this.state = 'swim'; this.splash = 1; v.y *= 0.25; }
        this.grounded = false; this.airJumps = 0;
        const top = I.boost ? 3.8 : 2.5, k = 1 - Math.exp(-2.5 * dt);
        v.x = lerp(v.x, wish.x * top, k); v.z = lerp(v.z, wish.z * top, k);
        this.bob = (this.bob || 0) + dt;
        v.y += ((floatY + Math.sin(this.bob * 2.1) * 0.05 - this.pos.y) * 10 - v.y * 4.5) * dt;
        const hs = Math.hypot(v.x, v.z);
        if (hs > 0.3 && wish.lengthSq() > 0.01) this.yaw += angDiff(this.yaw, Math.atan2(v.x, v.z)) * (1 - Math.exp(-6 * dt));
        const L = this.wall;
        const into = L ? -wish.dot(L.n) : 0;
        this.wallPush = L && into > 0.5 ? this.wallPush + dt : 0;
        if (L && (into > 0.3 && jumpEdge || this.wallPush > 0.35) && this.tryMantle(L.box, L.n)) { this.wallPush = 0; return; }
        if (jumpEdge) { v.y = 5; this.state = 'air'; this.ch.play('jump', { time: 0.22, fade: 0.08, restart: true }); }
        this.integrate(dt, ctx.boxes);
        if (this.state === 'ground') this.state = 'swim';
        this.animate(dt);
        return;
      }
    } else if (st === 'swim') this.state = 'air';

    if (st === 'climb') {
      const n = this.wall.n, b = this.wall.box;
      const free = b.kind !== 'climb';                               // a plain wall: on stamina
      _t.crossVectors(UP, n);                                       // along the wall, to the climber's left
      v.copy(_t).multiplyScalar(-I.move.x * CLIMB_SIDE).addScaledVector(UP, I.move.y * CLIMB_V);
      if (this.leapT > 0) { this.leapT -= dt; v.y = 2.5 + 7 * (this.leapT / 0.3); }        // climb leap: a burst up the wall
      this.yaw = Math.atan2(-n.x, -n.z);
      if (free) this.stamina -= dt * (0.08 + 0.05 * Math.abs(I.move.y) + 0.03 * Math.abs(I.move.x));
      if (jumpEdge && I.move.y > 0.3 && this.leapT <= 0 && (!free || this.stamina > 0.1)) {
        this.leapT = 0.3; if (free) this.stamina -= 0.12;
        this.ch.play('climb_up', { fade: 0.06, speed: 2.6 });
      } else if (jumpEdge) { v.copy(n).multiplyScalar(5.5); v.y = JUMP_V * 0.85; this.leaveWall('air'); this.ch.play('jump', { time: 0.25, fade: 0.1, restart: true }); }
      else if (free && this.stamina <= 0) { this.stamina = 0; v.copy(n).multiplyScalar(1.5); this.leaveWall('air'); }
      else if (I.move.y > 0.1 && this.pos.y + this.H * 0.55 > b.max.y && this.tryMantle(b, n)) return;
      else if (I.move.y < -0.1 && this.grounded) this.leaveWall('ground');
    } else if (st === 'wallrun') {
      const n = this.wall.n;
      _t.crossVectors(UP, n);
      const s = Math.sign(v.dot(_t)) || 1;
      this.runDir = s;
      const sp = (this.wrSpeed = Math.min(11.5, (this.wrSpeed || WALLRUN_V) + dt * 1.2));
      v.x = _t.x * s * sp - n.x * 1.5; v.z = _t.z * s * sp - n.z * 1.5;
      // light gravity at first, heavier toward the end: you rise along the wall and arc over, Titanfall-style
      v.y -= G * (0.16 + 0.6 * clamp(this.wallT / WALLRUN_T, 0, 1)) * dt;
      // stay on the glowing strip: no running up past its top edge
      if (this.pos.y + this.H * 0.55 > this.wall.box.max.y) v.y = Math.min(v.y, 0);
      this.wallT += dt;
      this.yaw = Math.atan2(_t.x * s, _t.z * s);
      if (jumpEdge) {
        // kick off away from the wall carrying your speed, with the air jump back: chain wall to wall
        const on = Math.max(sp, 8);
        v.x = n.x * 6.5 + _t.x * s * on; v.z = n.z * 6.5 + _t.z * s * on; v.y = 7.8;
        this.airJumps = 1;
        this.leaveWall('air');
        this.ch.play('jump', { time: 0.25, fade: 0.1, restart: true });
      } else if (this.wallT > WALLRUN_T || v.y < -6) this.leaveWall('air');
    } else {
      // ground / air locomotion
      // legs: gun mode's strafing (see bladeKit.strafeLegs): slower sideways and backward, and no sprinting back
      const LG = this.legs, slow = this.grounded && LG ? LG.speed : 1;
      const top = this.grounded ? (I.boost && !(LG && LG.back) ? SPRINT : RUN) * slow : Math.max(RUN, Math.hypot(v.x, v.z));
      const k = 1 - Math.exp(-(this.grounded ? (this.landT > 0 ? 4 : 14) : 3) * dt);
      v.x = lerp(v.x, wish.x * top, k); v.z = lerp(v.z, wish.z * top, k);
      v.y -= G * dt;
      const hs = Math.hypot(v.x, v.z);
      // faceYaw: something else decides the facing for a moment (aiming the shotgun)
      if (this.faceYaw != null) this.yaw += angDiff(this.yaw, this.faceYaw) * (1 - Math.exp(-20 * dt));
      else if (hs > 0.4 && wish.lengthSq() > 0.01) this.yaw += angDiff(this.yaw, Math.atan2(v.x, v.z)) * (1 - Math.exp(-(this.grounded ? 12 : 5) * dt));
      // wall kick: in the air, pushing into any wall, jump kicks you off it (two close walls make a chimney)
      const K = this.wall;
      const kick = jumpEdge && !this.grounded && this.coyote <= 0 && K && K.box !== this.kickWall && -wish.dot(K.n) > 0.2;
      if (kick) {
        _t.crossVectors(UP, K.n);
        const along = v.dot(_t);
        v.x = K.n.x * 7 + _t.x * along * 0.6; v.z = K.n.z * 7 + _t.z * along * 0.6; v.y = 8.4;
        this.kickWall = K.box; this.lastWall = K.box;
        this.yaw = Math.atan2(v.x, v.z);
        this.ch.play('jump', { time: 0.28, fade: 0.06, speed: 1.3, restart: true });
      } else if (jumpEdge && (this.grounded || this.coyote > 0)) {
        v.y = JUMP_V; this.grounded = false; this.coyote = 0;
        this.ch.play('jump', { time: 0.22, fade: 0.08, speed: 1.15, restart: true });
      } else if (jumpEdge && this.airJumps > 0) {
        v.y = AIR_JUMP_V; this.airJumps--;
        if (wish.lengthSq() > 0.05) { v.x = wish.x * Math.max(RUN, hs); v.z = wish.z * Math.max(RUN, hs); this.yaw = Math.atan2(wish.x, wish.z); }
        this.ch.play('jump', { time: 0.3, fade: 0.06, speed: 1.3, restart: true });
      }
      // walls: run along a run panel when moving fast beside it, climb a climb panel when pushing into it.
      // The wall you just left stays off-limits until you touch the ground (no endless re-runs up one wall).
      const w = this.wall && this.wall.box !== this.lastWall ? this.wall : null;
      if (w) {
        const into = -wish.dot(w.n);
        _t.crossVectors(UP, w.n);
        const along = Math.abs(v.dot(_t));
        const tall = w.box.max.y - this.pos.y > this.H * 1.25;
        this.wallPush = this.grounded && into > 0.7 && w.box.kind === 'solid' ? this.wallPush + dt : 0;
        const freeClimb = w.box.kind === 'solid' && tall && this.stamina > 0.08 && into > 0.55 && (!this.grounded || this.wallPush > 0.3);
        if ((w.box.kind === 'climb' && into > 0.55) || freeClimb) {
          this.state = 'climb'; v.set(0, 0, 0); this.leapT = 0; this.wallPush = 0;
          this.ch.play('climb_up', { fade: 0.15 });
        } else if (w.box.kind === 'run' && !this.grounded && along > 3 && into > -0.2) {
          this.state = 'wallrun'; this.wallT = 0;
          this.wrSpeed = clamp(along, WALLRUN_V, 11);
          v.y = Math.max(v.y, 3.4);
        }
      }
      // ledge grab: reach the top of any wall while pushing into it (jumping, falling, or a low wall on foot)
      // and pull yourself up onto it
      const L = this.wall;
      if (L && this.state !== 'climb' && this.state !== 'wallrun') {
        const into = -wish.dot(L.n), reach = L.box.max.y - this.pos.y;
        const air = !this.grounded && v.y < 4.5 && reach > this.H * 0.35 && reach < this.H * 1.3;
        const runUp = this.grounded && this.runMemo > 4.5 && wish.lengthSq() > 0.5 && reach > 0.45 && reach < this.climbRise() * 0.98;
        const low = this.grounded && reach > 0.45 && reach < this.H * 0.95;
        if ((into > 0.3 && (air || low)) || (into > 0.7 && runUp)) { if (this.tryMantle(L.box, L.n)) return; }
      }
    }

    // remember how fast you were running a moment ago (a wall you run into stops you dead, but you still ran at it)
    this.runMemo = Math.max(this.grounded ? Math.hypot(v.x, v.z) : 0, (this.runMemo || 0) - dt * 10);
    this.integrate(dt, ctx.boxes);
    if (this.pos.y < ctx.killY) this.spawn(ctx.spawn.pos, ctx.spawn.yaw);
    // climbing off the side of the panel or wall-running past its end
    if ((this.state === 'climb' || this.state === 'wallrun') && !this.wall) this.leaveWall('air');
    if (this.state === 'climb' && this.wall && this.wall.box.kind === 'run') this.leaveWall('air');
    if (this.state === 'wallrun' && this.wall && this.wall.box.kind !== 'run') this.leaveWall('air');
    if (this.state === 'wallrun' && this.grounded) this.leaveWall('ground');
    if (this.state === 'climb') this.grounded = false;
    this.animate(dt);
  }

  leaveWall(next) {
    if (this.wall) this.lastWall = this.wall.box;
    this.wallCool = 0.35;
    this.state = next;
  }

  tryMantle(b, n) {
    // stand on top of the box, a little in from its edge
    const end = _c.copy(this.pos).addScaledVector(n, -(this.R + 0.45));
    const top = this.boxes.find((o) => o.max.y > b.max.y - 0.35 && o.max.y < b.max.y + 0.7 && end.x >= o.min.x && end.x <= o.max.x && end.z >= o.min.z && end.z <= o.max.z);
    if (!top) return false;
    // nothing in the way where you'd stand
    const clear = !this.boxes.some((o) => o !== top && end.x > o.min.x - this.R * 0.6 && end.x < o.max.x + this.R * 0.6 && end.z > o.min.z - this.R * 0.6 && end.z < o.max.z + this.R * 0.6
      && o.min.y < top.max.y + this.H * 0.9 && o.max.y > top.max.y + 0.05);
    if (!clear) return false;
    end.y = top.max.y;
    const h = end.y - this.pos.y;
    // catch the edge (hands at the ledge), then haul up and step over: longer for a higher pull
    const from = this.pos.clone();
    const m = (this.mantle = { t: 0, dur: MANTLE_T * clamp(h / 1.3, 0.55, 1.25) + 0.1, from, to: end.clone(), h, yaw: Math.atan2(-n.x, -n.z) });
    this.state = 'mantle';
    this.vel.set(0, 0, 0);
    this.yaw = m.yaw;
    // The climb clip runs up a wall and hauls itself over the top. Start it at the point where the rise still to go
    // matches this ledge, play to the top, and move the body along the clip's own rise and travel
    const cv = this.ch.actions.wall_start?.getClip().rootCurve;
    if (cv) {
      const T = cv.times, R = cv.rise, F = cv.fwd, N = T.length;
      let ie = 0; for (let i = 0; i < N; i++) if (R[i] > R[ie]) ie = i;
      let i0 = 0; while (i0 < ie && R[i0 + 1] - R[i0] < 0.004) i0++;          // skip the run-up
      let is = i0; for (let i = ie; i >= i0; i--) if (R[ie] - R[i] >= h) { is = i; break; }
      Object.assign(m, { curve: cv, ts: T[is], te: T[ie], r0: R[is], r1: R[ie], f0: F[is], f1: F[ie] });
      m.dur = (m.te - m.ts) / 1.45 + 0.04;
      this.ch.play('wall_start', { fade: 0.1, time: m.ts, restart: true });
      this.ch.scrub(m.ts);
    } else this.ch.play('climb_up', { fade: 0.08, speed: 2.4 });
    return true;
  }

  // how high the climb clip can carry you from a run (its full rise on this character)
  climbRise() {
    const cv = this.ch.actions.wall_start?.getClip().rootCurve;
    return cv ? Math.max(...cv.rise) : this.H * 0.95;
  }

  updateMantle(dt) {
    const m = this.mantle;
    if (m.curve) {
      m.t = Math.min(1, m.t + dt / m.dur);
      const tc = m.ts + (m.te - m.ts) * m.t;
      const cv = m.curve;
      const up = clamp((sampleCurve(cv.times, cv.rise, tc) - m.r0) / Math.max(1e-3, m.r1 - m.r0), 0, 1);
      // travel over the lip: the clip's own forward motion where it has some, else a late step
      const fr = m.f1 - m.f0 > 0.05 ? clamp((sampleCurve(cv.times, cv.fwd, tc) - m.f0) / (m.f1 - m.f0), 0, 1) : Math.max(0, (m.t - 0.6) / 0.4);
      const fw = Math.max(fr, Math.max(0, (up - 0.85) / 0.15) * 0.6);
      const e = (x) => x * x * (3 - 2 * x);
      this.pos.set(lerp(m.from.x, m.to.x, e(fw)), m.from.y + m.h * up, lerp(m.from.z, m.to.z, e(fw)));
      this.ch.scrub(tc);
      if (m.t >= 1) { this.pos.copy(m.to); this.state = 'ground'; this.grounded = true; this.mantle = null; this.airJumps = 1; this.lastWall = null; this.ch.play(this.idleClip || 'idle', { fade: 0.2 }); }
      this.animate(dt);
      return;
    }
    m.t = Math.min(1, m.t + dt / (m.dur || MANTLE_T));
    // a short catch at the edge, the haul (rises fast), then the step over the lip
    const hauling = Math.max(0, (m.t - 0.12) / 0.88);
    const up = Math.min(1, hauling / 0.62), fwd = Math.max(0, (hauling - 0.5) / 0.5);
    const e = (x) => x * x * (3 - 2 * x);
    this.pos.set(lerp(m.from.x, m.to.x, e(fwd)), lerp(m.from.y, m.to.y, e(up)), lerp(m.from.z, m.to.z, e(fwd)));
    if (m.t >= 1) { this.state = 'ground'; this.grounded = true; this.mantle = null; this.airJumps = 1; this.lastWall = null; this.ch.play(this.idleClip || 'idle', { fade: 0.25 }); }
    this.animate(dt);
  }

  // move with sub-steps and resolve the cylinder against every box
  integrate(dt, boxes) {
    const v = this.vel, p = this.pos;
    if (this.grounded) this.stamina = Math.min(1, this.stamina + dt * 0.45);
    const steps = Math.max(1, Math.ceil((v.length() * dt) / 0.2));
    const h = dt / steps;
    const wasGrounded = this.grounded;
    let ground = false, wall = null;
    for (let s = 0; s < steps; s++) {
      const prevY = p.y;
      p.addScaledVector(v, h);
      for (const b of boxes) {
        if (p.y + this.H <= b.min.y || p.y >= b.max.y + 0.001) continue;
        const cx = clamp(p.x, b.min.x, b.max.x), cz = clamp(p.z, b.min.z, b.max.z);
        let dx = p.x - cx, dz = p.z - cz;
        const d = Math.hypot(dx, dz);
        if (d >= this.R) continue;
        const thin = b.kind !== 'solid' && Math.min(b.max.x - b.min.x, b.max.z - b.min.z) < 0.3;   // panel lips are not floors
        if (!thin && prevY >= b.max.y - 0.06 && v.y <= 0.01) { p.y = b.max.y; v.y = 0; ground = true; continue; }        // landed on top
        if (prevY + this.H <= b.min.y + 0.06 && v.y > 0) { p.y = b.min.y - this.H; v.y = 0; continue; }         // head bump
        if (b.max.y - p.y < 0.45 && (wasGrounded || ground) && this.state !== 'climb') { p.y = b.max.y; v.y = Math.max(0, v.y); ground = true; continue; }   // step up
        let nx, nz, pen;
        if (d > 1e-5) { nx = dx / d; nz = dz / d; pen = this.R - d; }
        else {
          // centre inside the box footprint: leave by the nearest face
          const o = [[p.x - b.min.x, -1, 0], [b.max.x - p.x, 1, 0], [p.z - b.min.z, 0, -1], [b.max.z - p.z, 0, 1]].sort((a, c) => a[0] - c[0])[0];
          nx = o[1]; nz = o[2]; pen = o[0] + this.R;
        }
        p.x += nx * pen; p.z += nz * pen;
        const vn = v.x * nx + v.z * nz;
        if (vn < 0) { v.x -= vn * nx; v.z -= vn * nz; }
        if (!wall || b.kind !== 'solid') wall = { n: new THREE.Vector3(nx, 0, nz), box: b };
      }
    }
    // still on a top surface (not moving down this frame)?
    if (!ground && v.y <= 0) {
      for (const b of boxes) {
        if (Math.abs(p.y - b.max.y) > 0.05) continue;
        if (b.kind !== 'solid' && Math.min(b.max.x - b.min.x, b.max.z - b.min.z) < 0.3) continue;
        const cx = clamp(p.x, b.min.x, b.max.x), cz = clamp(p.z, b.min.z, b.max.z);
        if (Math.hypot(p.x - cx, p.z - cz) < this.R * 0.6) { ground = true; p.y = b.max.y; v.y = 0; break; }
      }
    }
    // keep touching the wall we climb / run on even when not pushing into it this frame
    if (!wall && (this.state === 'climb' || this.state === 'wallrun') && this.wall) {
      const b = this.wall.box, n = this.wall.n;
      const cx = clamp(p.x, b.min.x, b.max.x), cz = clamp(p.z, b.min.z, b.max.z);
      const d = Math.hypot(p.x - cx, p.z - cz);
      const vert = p.y + this.H * 0.3 < b.max.y && p.y + this.H > b.min.y;
      if (d < this.R + 0.12 && vert) { wall = this.wall; p.x = cx + n.x * this.R; p.z = cz + n.z * this.R; }
    }
    if (ground && !wasGrounded) this.onLand(v);
    this.grounded = ground;
    if (ground) { this.airJumps = 1; this.coyote = 0.12; this.lastWall = null; this.kickWall = null; if (this.state === 'air') this.state = 'ground'; }
    else { this.coyote = Math.max(0, this.coyote - dt); if (this.state === 'ground') this.state = 'air'; }
    this.wall = wall;
    this.lastVy = v.y;
  }

  onLand() {
    const vy = this.fallV ?? 0;
    if (vy < -11) { this.landT = 0.32; this.ch.play('land', { time: 0.18, fade: 0.06, speed: 1.6, restart: true }); }
  }

  animate(dt, locked = false) {
    const c = this.ch, st = this.state, v = this.vel;
    const idle = this.idleClip || 'idle', run = this.runClip || 'run';
    this.fallV = this.grounded ? 0 : v.y;
    const hs = Math.hypot(v.x, v.z);
    if (locked) {
      // the sword move drives the clip
    } else if (st === 'climb') {
      const mv = v.y;
      c.play(mv < -0.1 ? 'climb_down' : 'climb_up', { fade: 0.15, speed: Math.abs(mv) > 0.1 || Math.abs(hs) > 0.1 ? 1 : 0 });
    } else if (st === 'wallrun') {
      c.play(c.actions.k_run ? 'k_run' : 'sprint', { fade: 0.12, speed: clamp((this.wrSpeed || WALLRUN_V) / WALLRUN_V, 0.95, 1.35) });
    } else if (st === 'mantle') {
      // the climb clip at speed sells the pull-up
    } else if (st === 'swim') {
      // treading water when still, a slow stroke (the run, leaned forward) when moving
      if (hs > 0.4) c.play(run, { fade: 0.35, speed: clamp(hs / 4, 0.4, 0.8) });
      else c.play(idle, { fade: 0.35, speed: 0.7 });
    } else if (this.grounded) {
      if (this.landT > 0 && c.currentName === 'land') { /* let the landing play */ }
      else if (hs < 0.35) c.play(idle, { fade: 0.25 });
      // backpedalling: the same stride, run in reverse
      else if (hs < 7.4) c.play(run, { fade: 0.2, speed: clamp(hs / RUN, 0.55, 1.25) * (run === 'run' ? 1 : 0.9) * (this.legs?.back ? -1 : 1) });
      else c.play('sprint', { fade: 0.2, speed: clamp(hs / SPRINT, 0.8, 1.2) });
    } else {
      const jumping = c.currentName === 'jump' && !c.done() && v.y > -2;
      if (!jumping) c.play('fall', { fade: 0.3 });
    }
    // wall-run lean: tilt away from the wall
    let wantRoll = 0;
    if (st === 'wallrun' && this.wall) {
      // which side the wall is on (+1 left); lean the head away from it with the feet planted on the wall
      // (positive roll tips the head toward the character's right, local -X)
      const n = this.wall.n, leftX = Math.cos(this.yaw), leftZ = -Math.sin(this.yaw);
      this.wallSide = Math.sign(-(n.x * leftX + n.z * leftZ)) || 1;
      wantRoll = 0.8 * this.wallSide;           // ~45 degrees: running on the wall, not beside it
    }
    this.roll += (wantRoll - this.roll) * Math.min(1, dt * 12);
    const root = c.root;
    root.position.copy(this.pos);
    // contact: slide the body along the wall normal so the hands (climbing) or the nearer foot (wall-running) meet
    // the wall; measured after each pose and settled over a few frames
    const contact = (st === 'climb' || st === 'wallrun') && this.wall;
    if (!contact) { this.climbOff *= 0.8; this.wrOff *= 0.8; }
    if (this.wall && (st === 'climb' || Math.abs(this.climbOff) > 1e-3)) root.position.addScaledVector(this.wall.n, this.climbOff);
    if (this.wall && (st === 'wallrun' || Math.abs(this.wrOff) > 1e-3)) root.position.addScaledVector(this.wall.n, this.wrOff);
    this.pitch = (this.pitch || 0) + ((st === 'swim' ? 0.55 * clamp(hs / 2.5, 0, 1) : 0) - (this.pitch || 0)) * Math.min(1, dt * 5);
    root.rotation.set(this.pitch, this.yaw + (this.legs?.leg || 0), this.roll, 'YXZ');
    c.update(dt);
    if (contact) {
      root.updateMatrixWorld(true);
      const H = c.vrm.humanoid, n = this.wall.n;
      const wallX = this.pos.x - n.x * this.R, wallZ = this.pos.z - n.z * this.R;          // a point on the wall face
      const dist = (b) => { const nd = H.getNormalizedBoneNode(b); if (!nd) return null; _c.setFromMatrixPosition(nd.matrixWorld); return (_c.x - wallX) * n.x + (_c.z - wallZ) * n.z; };
      if (st === 'climb') {
        const l = dist('leftHand'), r = dist('rightHand');
        if (l != null && r != null) this.climbOff = clamp(this.climbOff + (0.06 - (l + r) / 2) * 0.5, -0.45, 0.45);
      } else {
        const ds = ['leftFoot', 'rightFoot', 'leftToes', 'rightToes'].map(dist).filter((x) => x != null);
        if (ds.length) this.wrOff = clamp(this.wrOff + (0.03 - Math.min(...ds)) * 0.5, -0.9, 0.3);
      }
    }
  }
}
