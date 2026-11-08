import * as THREE from 'three';

// Third-person parkour controller for the VRM characters: run / sprint, jump + one air jump, wall-run along the
// glowing "run" panels, climb the "climb" panels and mantle onto the ledge at the top. The level is made of axis-
// aligned boxes ({ min, max, kind: 'solid' | 'run' | 'climb' }); the character is a vertical cylinder (feet at pos).

const G = 24, RUN = 6.2, SPRINT = 9.6, JUMP_V = 8.2, AIR_JUMP_V = 7.4;
const WALLRUN_T = 1.5, WALLRUN_V = 8.5, CLIMB_V = 2.6, CLIMB_SIDE = 1.6, MANTLE_T = 0.5;
const UP = new THREE.Vector3(0, 1, 0);
const _w = new THREE.Vector3(), _f = new THREE.Vector3(), _r = new THREE.Vector3(), _t = new THREE.Vector3(), _c = new THREE.Vector3();
const lerp = THREE.MathUtils.lerp, clamp = THREE.MathUtils.clamp;
const angDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

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
      this.action.drive(dt, this);
      this.integrate(dt, ctx.boxes);
      if (this.pos.y < ctx.killY) { this.action = null; this.spawn(ctx.spawn.pos, ctx.spawn.yaw); }
      this.animate(dt, true);
      return;
    }

    if (st === 'climb') {
      const n = this.wall.n, b = this.wall.box;
      _t.crossVectors(UP, n);                                       // along the wall, to the climber's left
      v.copy(_t).multiplyScalar(-I.move.x * CLIMB_SIDE).addScaledVector(UP, I.move.y * CLIMB_V);
      this.yaw = Math.atan2(-n.x, -n.z);
      if (jumpEdge) { v.copy(n).multiplyScalar(5.5); v.y = JUMP_V * 0.85; this.leaveWall('air'); this.ch.play('jump', { time: 0.25, fade: 0.1, restart: true }); }
      else if (I.move.y > 0.1 && this.pos.y + this.H * 0.55 > b.max.y && this.tryMantle(b, n)) return;
      else if (I.move.y < -0.1 && this.grounded) this.leaveWall('ground');
    } else if (st === 'wallrun') {
      const n = this.wall.n;
      _t.crossVectors(UP, n);
      const s = Math.sign(v.dot(_t)) || 1;
      this.runDir = s;
      v.x = _t.x * s * WALLRUN_V - n.x * 1.5; v.z = _t.z * s * WALLRUN_V - n.z * 1.5;
      v.y -= G * 0.28 * dt;
      this.wallT += dt;
      this.yaw = Math.atan2(_t.x * s, _t.z * s);
      if (jumpEdge) {
        v.x = n.x * 7 + _t.x * s * 6; v.z = n.z * 7 + _t.z * s * 6; v.y = JUMP_V;
        this.airJumps = 1;
        this.leaveWall('air');
        this.ch.play('jump', { time: 0.25, fade: 0.1, restart: true });
      } else if (this.wallT > WALLRUN_T || v.y < -7) this.leaveWall('air');
    } else {
      // ground / air locomotion
      const top = this.grounded ? (I.boost ? SPRINT : RUN) : Math.max(RUN, Math.hypot(v.x, v.z));
      const k = 1 - Math.exp(-(this.grounded ? (this.landT > 0 ? 4 : 14) : 3) * dt);
      v.x = lerp(v.x, wish.x * top, k); v.z = lerp(v.z, wish.z * top, k);
      v.y -= G * dt;
      const hs = Math.hypot(v.x, v.z);
      if (hs > 0.4 && wish.lengthSq() > 0.01) this.yaw += angDiff(this.yaw, Math.atan2(v.x, v.z)) * (1 - Math.exp(-(this.grounded ? 12 : 5) * dt));
      if (jumpEdge && (this.grounded || this.coyote > 0)) {
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
        if (w.box.kind === 'climb' && into > 0.55) {
          this.state = 'climb'; v.set(0, 0, 0);
          this.ch.play('climb_up', { fade: 0.15 });
        } else if (w.box.kind === 'run' && !this.grounded && along > 3 && into > -0.2) {
          this.state = 'wallrun'; this.wallT = 0;
          v.y = Math.max(v.y, 3.2);
          this.ch.play('wallrun', { fade: 0.15 });
        }
      }
      // ledge grab: reach the top of any wall while pushing into it (jumping, falling, or a low wall on foot)
      // and pull yourself up onto it
      const L = this.wall;
      if (L && this.state !== 'climb' && this.state !== 'wallrun') {
        const into = -wish.dot(L.n), reach = L.box.max.y - this.pos.y;
        const air = !this.grounded && v.y < 4.5 && reach > this.H * 0.35 && reach < this.H * 1.3;
        const low = this.grounded && reach > 0.45 && reach < this.H * 0.95;
        if (into > 0.3 && (air || low) && this.tryMantle(L.box, L.n)) return;
      }
    }

    this.integrate(dt, ctx.boxes);
    if (this.pos.y < ctx.killY) this.spawn(ctx.spawn.pos, ctx.spawn.yaw);
    // climbing off the side of the panel or wall-running past its end
    if ((this.state === 'climb' || this.state === 'wallrun') && !this.wall) this.leaveWall('air');
    if (this.state === 'climb' && this.wall && this.wall.box.kind !== 'climb') this.leaveWall('air');
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
    this.mantle = { t: 0, dur: MANTLE_T * clamp(h / 1.3, 0.55, 1.25) + 0.1, from, to: end.clone(), yaw: Math.atan2(-n.x, -n.z) };
    this.state = 'mantle';
    this.vel.set(0, 0, 0);
    this.yaw = this.mantle.yaw;
    this.ch.play('climb_up', { fade: 0.08, speed: 2.4 });
    return true;
  }

  updateMantle(dt) {
    const m = this.mantle;
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
        if (prevY >= b.max.y - 0.06 && v.y <= 0.01) { p.y = b.max.y; v.y = 0; ground = true; continue; }        // landed on top
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
    if (ground) { this.airJumps = 1; this.coyote = 0.12; this.lastWall = null; if (this.state === 'air') this.state = 'ground'; }
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
      c.play('wallrun', { fade: 0.12 });
    } else if (st === 'mantle') {
      // the climb clip at speed sells the pull-up
    } else if (this.grounded) {
      if (this.landT > 0 && c.currentName === 'land') { /* let the landing play */ }
      else if (hs < 0.35) c.play(idle, { fade: 0.25 });
      else if (hs < 7.4) c.play(run, { fade: 0.2, speed: clamp(hs / RUN, 0.55, 1.25) * (run === 'run' ? 1 : 0.9) });
      else c.play('sprint', { fade: 0.2, speed: clamp(hs / SPRINT, 0.8, 1.2) });
    } else {
      const jumping = c.currentName === 'jump' && !c.done() && v.y > -2;
      if (!jumping) c.play('fall', { fade: 0.3 });
    }
    // wall-run lean: tilt away from the wall
    let wantRoll = 0;
    if (st === 'wallrun' && this.wall) {
      // head away from the wall: positive roll tips the head toward the character's right (local -X)
      const n = this.wall.n, leftX = Math.cos(this.yaw), leftZ = -Math.sin(this.yaw);
      wantRoll = 0.38 * Math.sign(-(n.x * leftX + n.z * leftZ));
    }
    this.roll += (wantRoll - this.roll) * Math.min(1, dt * 10);
    const root = c.root;
    root.position.copy(this.pos);
    root.rotation.set(0, this.yaw, this.roll, 'YXZ');
    c.update(dt);
  }
}
