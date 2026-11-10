import * as THREE from 'three';
import { BODY } from '../sim/orbits.js';
import { RES } from '../data/economy.js';
import { deposit, emit } from '../sim/state.js';
import { atmosphereMaterial, glowSprite } from './shaders.js';
import { planetMaterial, ringMesh, bodyQuat } from './planets.js';
import { distKm } from '../sim/orbits.js';
import { simNow } from '../sim/state.js';
import { makeSky } from './sky.js';
import { makeSeedShip, makeDrone, rockGeometry, MAT } from './models.js';
import { MechPilot } from './mech/mechPilot.js';
import { GunView, ADS_FOV } from './chars/gunView.js';
import { S as MECH_S } from './mech/mechRig.js';
import { LunarArena, ARENA } from './arena.js';
import { ROCK_NORMAL } from './materials.js';
import { haptic } from '../telegram.js';

// Walkable worlds. g in m/s² (real values); sky/fog only where there is an atmosphere.
export const SURFACES = {
  // Earth: a desert canyon of terraced mesas under a blue sky, with a proving ground beside the pad
  earth: { g: 9.81, ground: [0xb98a56, 0xdcb37c, 0x8e4426], sky: 0x8fb8de, fog: [0xc9d6dc, 160, 1250], arena: true, terrain: 'canyon', haze: 0xe8d2b0 },
  moon: { g: 1.62, ground: [0x6b6965, 0x9a968f, 0x34332f], parent: 'earth', arena: true },
  mercury: { g: 3.7, ground: [0x5f5953, 0x8a8178, 0x302c28] },
  mars: { g: 3.72, ground: [0x7a3418, 0xb8673a, 0x45190a], sky: 0xb98a62, fog: [0xc29268, 120, 1100] },
  ceres: { g: 0.28, ground: [0x45423f, 0x6e6a64, 0x262422] },
  europa: { g: 1.31, ground: [0xb8b2a6, 0xe8e2d6, 0x7a4a30], parent: 'jupiter' },
  titan: { g: 1.35, ground: [0x4a3014, 0x7a5228, 0x26180a], sky: 0xa86e2c, fog: [0xb07a38, 40, 520] },
  pluto: { g: 0.62, ground: [0xa8947a, 0xe0d4c0, 0x5a3c28] },
};

const SIZE = 1400, SEG = 220, PAD_R = 14, CAP = 60, BOUND = 560;
const SUN_DIR = new THREE.Vector3(0.62, 0.38, -0.69).normalize();
const DETAIL_GEO = rockGeometry(7, 2);
const CRYSTAL = new THREE.OctahedronGeometry(0.5, 0);

// ---------------- deterministic heightfield (shared by mesh + physics) ----------------
function hash2(x, y, s) {
  const h = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453;
  return h - Math.floor(h);
}
function vnoise(x, y, s) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, s), b = hash2(xi + 1, yi, s), c = hash2(xi, yi + 1, s), d = hash2(xi + 1, yi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm2(x, y, s, oct = 4) {
  let v = 0, a = 0.5;
  for (let i = 0; i < oct; i++) { v += a * vnoise(x, y, s + i * 13); x *= 2.03; y *= 2.03; a *= 0.5; }
  return v;
}

class Terrain {
  // flat: optional { x, z, r, blend } plateau (the arena) blended into the heightfield
  constructor(seed, flat = null, style = null) {
    this.seed = seed;
    this.canyon = style === 'canyon';
    this.flat = null;
    this.craters = [];
    let r = seed * 9.31;
    const rnd = () => { r = (r * 16807 + 11) % 2147483647; return r / 2147483647; };
    for (let i = 0; i < (this.canyon ? 0 : 46); i++) {
      const x = (rnd() - 0.5) * SIZE * 0.95, z = (rnd() - 0.5) * SIZE * 0.95;
      if (Math.hypot(x, z) < 90) continue;
      const rad = 14 + Math.pow(rnd(), 2.2) * 110;
      this.craters.push({ x, z, r: rad, d: rad * (0.12 + rnd() * 0.08) });
    }
    if (flat) { this.flatH = this.sample(flat.x, flat.z).h; this.flat = flat; }
  }
  // returns height and a 0..1 "crater floor" darkness term for colouring
  sample(x, z, out = {}) {
    let h = (fbm2(x * 0.005, z * 0.005, this.seed) - 0.5) * 34 + (fbm2(x * 0.03, z * 0.03, this.seed + 5, 3) - 0.5) * 4;
    let floor = 0;
    if (this.canyon) {
      // sandy floor with low dunes; mesas rise in terraced steps where the large-scale noise crosses a threshold
      const n = fbm2(x * 0.0042, z * 0.0042, this.seed, 5);
      const m = THREE.MathUtils.smoothstep(n, 0.5, 0.6);
      let top = m * 52;
      const step = 9, k = top / step, fi = Math.floor(k), fr = k - fi;
      top = (fi + THREE.MathUtils.smoothstep(fr, 0.55, 0.85)) * step;
      const dunes = Math.sin(x * 0.018 + Math.sin(z * 0.011) * 2.2) * 0.9 + (fbm2(x * 0.02, z * 0.02, this.seed + 7, 3) - 0.5) * 3;
      h = top + dunes * (1 - m) + (fbm2(x * 0.06, z * 0.06, this.seed + 3, 2) - 0.5) * 1.2 * m;
      floor = Math.min(1, m * 1.3);
    }
    for (const c of this.craters) {
      const dx = x - c.x, dz = z - c.z, d2 = (dx * dx + dz * dz) / (c.r * c.r);
      if (d2 > 2.6) continue;
      const d = Math.sqrt(d2);
      if (d < 1) { h += c.d * (d2 - 1); floor = Math.max(floor, 1 - d); }
      h += c.d * 0.38 * Math.exp(-Math.pow((d - 1) * 3.2, 2));
    }
    const rr = Math.hypot(x, z);
    const flat = THREE.MathUtils.smoothstep(rr, 26, 70);
    h *= flat;
    if (this.canyon) floor *= flat;
    h -= (rr * rr) / 5200; // exaggerated curvature drops the edges below the horizon
    const F = this.flat;
    if (F) {
      const df = Math.hypot(x - F.x, z - F.z);
      if (df < F.r + F.blend) {
        const w = 1 - THREE.MathUtils.smoothstep(df, F.r, F.r + F.blend);
        h += (this.flatH - h) * w;
        floor *= 1 - w;
      }
    }
    out.h = h; out.floor = this.canyon ? floor : floor * flat;
    return out;
  }
  height(x, z) { return this.sample(x, z).h; }
}

export class SurfaceView {
  constructor(app) {
    this.app = app;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 30000);
    this.sky = makeSky();
    this.scene.add(this.sky);
    this.sun = new THREE.DirectionalLight(0xfff4e6, 3.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    Object.assign(this.sun.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45, near: 1, far: 300 });
    this.sun.shadow.bias = -0.0008;
    this.hemi = new THREE.HemisphereLight(0x8090b0, 0x201814, 0.25);
    this.scene.add(this.sun, this.sun.target, this.hemi);

    this.pilot = new MechPilot(this.scene);
    this.mech = this.pilot.root;
    this.scene.add(this.mech);

    this.dust = glowSprite(0xffd2a0, 3, 1.2);
    this.dust.visible = false;
    this.scene.add(this.dust);

    this.camDist = 19;
    this.camYaw = Math.PI;
    this.camPitch = 0.28;
    this.cargo = {};
    this.time = 0;
    this.info = { cargo: 0, cap: CAP, target: null, speed: 0, dock: 0, dockRange: PAD_R, fuel: 100, g: 1.62 };
    this.content = null;
    this.baseId = null;
    this.arena = new LunarArena(this);
    this.lockYawHold = 0;
  }

  // leaving the surface (orbit, uplink): an arena run ends
  leave() {
    this.gunView?.hide(); this.app?.input?.setAim?.(false);
    if (this.arena.fighting || this.arena.state === 'down') this.arena.end('leave');
    if (!this.pilot.alive) this.pilot.revive();
  }

  setBase(id) {
    if (this.baseId === id && this.content) return;
    if (this.content) {
      this.scene.remove(this.content);
      this.content.traverse((o) => { if (o.isMesh && o.geometry !== DETAIL_GEO && o.geometry !== CRYSTAL) o.geometry.dispose(); });
    }
    this.baseId = id;
    const cfg = (this.cfg = SURFACES[id]);
    const body = BODY[id];
    this.content = new THREE.Group();
    this.scene.add(this.content);
    if (this.arena.fighting) this.arena.end('leave');
    this.terrain = new Terrain(id.length * 3 + id.charCodeAt(0), cfg.arena ? LunarArena.flat() : null, cfg.terrain);
    this.hasArena = !!cfg.arena;

    // atmosphere vs vacuum
    const atmo = !!cfg.sky;
    this.sky.visible = !atmo;
    this.scene.background = atmo ? new THREE.Color(cfg.sky) : null;
    this.scene.fog = cfg.fog ? new THREE.Fog(cfg.fog[0], cfg.fog[1], cfg.fog[2]) : null;
    this.sun.intensity = atmo ? 1.8 : 3.2;
    this.hemi.intensity = atmo ? 0.8 : 0.18;
    this.hemi.color.set(atmo ? cfg.sky : 0x8090b0);

    this.buildGround(cfg);
    this.buildOutpost();
    this.buildNodes(body);
    if (this.hasArena) this.arena.build(this.content, (x, z) => this.terrain.height(x, z));

    if (!atmo) {
      const sunG = glowSprite(0xfff0d8, 900, 3);
      sunG.position.copy(SUN_DIR).multiplyScalar(8000);
      this.content.add(sunG);
    }
    if (cfg.parent && !atmo) {
      const p = BODY[cfg.parent];
      // true angular size from the real distance right now (Earth from the Moon: ~1.9°)
      const t = simNow(this.app.state);
      const R = 7000 * Math.tan(Math.atan(p.radiusKm / distKm(id, p.id, t)));
      const m = new THREE.Mesh(new THREE.SphereGeometry(R, 96, 48), planetMaterial(p, { hi: true }));
      m.position.set(-0.45, 0.28, 0.85).normalize().multiplyScalar(7000);
      m.quaternion.copy(bodyQuat(p.id, t));
      m.material.userData.sunDir.copy(SUN_DIR);
      this.content.add(m);
      if (p.atmo) {
        const a = new THREE.Mesh(new THREE.SphereGeometry(R * 1.03, 48, 24), atmosphereMaterial(p.atmo));
        a.material.uniforms.uSunDir.value.copy(SUN_DIR);
        m.add(a);
      }
      if (p.rings) {
        const r = ringMesh(R);
        r.userData.sunDir.copy(SUN_DIR);
        m.add(r);
      }
      this.skyPlanet = m;
    } else this.skyPlanet = null;

    this.pilot.reset();
    this.pilot.pos.set(0, 0, PAD_R + 4);
    this.camYaw = Math.PI;
    this.info.g = cfg.g;
    this.applyQuality();
  }

  applyQuality() {
    this.sun.castShadow = this.app.quality !== 'low';
  }

  buildGround(cfg) {
    const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position, colors = new Float32Array(pos.count * 3);
    const [cA, cB, cC] = cfg.ground.map((h) => new THREE.Color(h));
    const c = new THREE.Color(), s = {};
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      this.terrain.sample(x, z, s);
      pos.setY(i, s.h);
      const n = fbm2(x * 0.02, z * 0.02, 99, 3);
      c.copy(cA).lerp(cB, THREE.MathUtils.clamp(n * 1.6 - 0.3, 0, 1)).lerp(cC, Math.min(1, s.floor * 1.4));
      c.multiplyScalar(0.85 + hash2(x, z, 3) * 0.25);
      colors.set([c.r, c.g, c.b], i * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const detail = ROCK_NORMAL.clone();
    detail.repeat.set(160, 160);
    detail.needsUpdate = true;
    const ground = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.97, metalness: 0, normalMap: detail, normalScale: new THREE.Vector2(0.9, 0.9) }));
    ground.receiveShadow = true;
    this.content.add(ground);

    // scattered boulders for scale
    const n = 420;
    const rocks = new THREE.InstancedMesh(DETAIL_GEO, new THREE.MeshStandardMaterial({ color: cfg.ground[0], roughness: 1, flatShading: true }), n);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sc = new THREE.Vector3(), p = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const x = (Math.random() - 0.5) * SIZE * 0.8, z = (Math.random() - 0.5) * SIZE * 0.8;
      if (Math.hypot(x, z) < 30 || (cfg.arena && Math.hypot(x - ARENA.x, z - ARENA.z) < ARENA.R + 10)) { i--; continue; }
      const k = 0.25 + Math.pow(Math.random(), 3) * 3.2;
      p.set(x, this.terrain.height(x, z) + k * 0.2, z);
      q.setFromEuler(e.set(Math.random() * 3, Math.random() * 3, Math.random() * 3));
      m.compose(p, q, sc.set(k, k * 0.7, k));
      rocks.setMatrixAt(i, m);
    }
    rocks.castShadow = rocks.receiveShadow = true;
    this.content.add(rocks);
  }

  buildOutpost() {
    const g = new THREE.Group();
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(PAD_R, PAD_R + 1, 0.6, 48), MAT.hullDark);
    pad.position.y = 0.1;
    pad.receiveShadow = true;
    g.add(pad);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(PAD_R - 0.6, 0.12, 6, 64), MAT.amber);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.45;
    g.add(ring);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const l = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.1, 2.2), i % 2 ? MAT.amber : MAT.hazard);
      l.position.set(Math.cos(a) * (PAD_R - 2.5), 0.45, Math.sin(a) * (PAD_R - 2.5));
      l.rotation.y = -a;
      g.add(l);
    }
    // the seed ship that founded this outpost, standing on its engine
    const seed = makeSeedShip();
    seed.rotation.x = -Math.PI / 2;
    seed.position.set(-PAD_R - 10, 5.4, -6);
    seed.userData.exhaust?.forEach((e) => (e.visible = false));
    seed.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    g.add(seed);
    // hab dome + antenna mast
    const dome = new THREE.Mesh(new THREE.SphereGeometry(6, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), MAT.glass);
    dome.position.set(PAD_R + 12, 0, -10);
    g.add(dome);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(6.3, 6.6, 1.2, 32), MAT.hull);
    base.position.copy(dome.position);
    g.add(base);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.25, 22, 6), MAT.hullLight);
    mast.position.set(PAD_R + 4, 11, -22);
    mast.castShadow = true;
    g.add(mast);
    this.beacon = new THREE.Mesh(new THREE.SphereGeometry(0.4, 10, 8), MAT.red.clone());
    this.beacon.position.set(PAD_R + 4, 22.2, -22);
    g.add(this.beacon);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.3;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 4, 6), MAT.hullDark);
      pole.position.set(Math.cos(a) * (PAD_R + 3), 2, Math.sin(a) * (PAD_R + 3));
      g.add(pole);
      const lamp = glowSprite(0xffc070, 2.5, 2);
      lamp.position.set(pole.position.x, 4.2, pole.position.z);
      g.add(lamp);
    }
    this.padDrones = [0, 1].map((i) => {
      const d = makeDrone();
      d.scale.setScalar(1.4);
      g.add(d);
      return d;
    });
    this.content.add(g);
  }

  buildNodes(body) {
    const weights = Object.entries(body.drones).map(([r, v]) => [r, Math.sqrt(v) * (RES[r].value > 300 ? 2.5 : 1)]);
    if (!weights.length) weights.push(['ore', 1]);
    const total = weights.reduce((a, [, w]) => a + w, 0);
    const pick = () => {
      let x = Math.random() * total;
      for (const [r, w] of weights) if ((x -= w) <= 0) return r;
      return weights[0][0];
    };
    const rockMat = new THREE.MeshStandardMaterial({ color: this.cfg.ground[2], roughness: 0.9, flatShading: true });
    this.nodes = [];
    for (let i = 0; i < 34; i++) {
      const res = pick();
      const g = new THREE.Group();
      const rock = new THREE.Mesh(DETAIL_GEO, rockMat);
      rock.scale.set(2.2, 1.3, 2.2);
      rock.castShadow = true;
      g.add(rock);
      const cm = new THREE.MeshBasicMaterial({ color: new THREE.Color(RES[res].color).multiplyScalar(2.6) });
      for (let k = 0; k < 6; k++) {
        const c = new THREE.Mesh(CRYSTAL, cm);
        const a = (k / 6) * Math.PI * 2 + Math.random();
        c.position.set(Math.cos(a) * 1.1, 1 + Math.random() * 0.6, Math.sin(a) * 1.1);
        c.scale.set(0.6, 1.6 + Math.random() * 1.2, 0.6);
        c.rotation.set((Math.random() - 0.5) * 0.8, a, (Math.random() - 0.5) * 0.8);
        g.add(c);
      }
      g.add(glowSprite(RES[res].color, 7, 0.8));
      const node = { group: g, pos: g.position, radius: 2.4, res, hp: 0, maxHp: 14, alive: true, respawnAt: 0, wobble: 0 };
      this.placeNode(node);
      this.content.add(g);
      this.nodes.push(node);
    }
  }

  placeNode(node) {
    let x, z;
    do {
      const a = Math.random() * Math.PI * 2, r = 40 + Math.pow(Math.random(), 0.8) * 420;
      x = Math.cos(a) * r; z = Math.sin(a) * r;
    } while (Math.hypot(x, z) < 35 || (this.hasArena && Math.hypot(x - ARENA.x, z - ARENA.z) < ARENA.R + 8));
    node.group.position.set(x, this.terrain.height(x, z) - 0.3, z);
    node.group.scale.setScalar(1);
    node.group.visible = true;
    node.hp = node.maxHp;
    node.alive = true;
  }

  cargoTotal() {
    return Object.values(this.cargo).reduce((a, b) => a + b, 0);
  }

  unload() {
    const n = this.cargoTotal();
    if (!n) return 0;
    const s = this.app.state;
    const got = deposit(s, this.baseId, this.cargo);
    s.stats.surface = (s.stats.surface || 0) + got;
    this.cargo = {};
    emit('toast', { text: `Mech unloaded ${Math.round(got)} t at ${BODY[this.baseId].base}`, kind: 'good' });
    emit('changed');
    haptic('medium');
    return got;
  }

  update(dt, input) {
    this.time += dt;
    const I = input.sample(dt);
    const T = this.terrain, P = this.pilot, m = { position: P.pos };

    // orbit camera from drag, zoom from wheel / pinch
    // the wheel swaps weapons; with the shotgun out the right button looks down the sights and the mouse is captured
    const kit = P.kit;
    this.gunView ||= new GunView();
    let ads = false;
    if (I.wheel) { I.swap = (I.swap || 0) + 1; I.zoom = 1; }
    if (kit.gun) { ads = !!I.rmb; I.guard = !!I.guardKey; }
    input.setAim?.(kit.gun);
    const adsK = this.gunView.update(dt, kit.gun, ads, { lookX: I.lookX, lookY: I.lookY, kit, on: P.aimOn, speed: Math.hypot(P.vel.x, P.vel.z) / (MECH_S * 4) }), sens = 1 - adsK * 0.5;
    this.gunView.begin(this.camera);
    this.camYaw -= I.lookX * 0.006 * sens;
    if (I.lookX) this.lockYawHold = 1.2;
    this.camPitch = THREE.MathUtils.clamp(this.camPitch + I.lookY * 0.004 * sens, kit.gun ? -0.9 : -0.15, 1.1);
    this.camDist = THREE.MathUtils.clamp(this.camDist * I.zoom, 10, 45);

    const A = this.arena, fight = this.hasArena && (A.fighting || A.state === 'down');
    if (!this.ctx) {
      this.ctx = {
        height: (x, z) => this.terrain.height(x, z),
        bound: BOUND,
        targets: this.nodes,
        onHit: (n, mv, p) => (n.isEnemy ? this.arena.hitEnemy(n, mv, p) : this.strikeNode(n, mv)),
        onDeath: () => this.arena.onPlayerDeath(),
        onPerfect: () => this.arena.banner('PERFECT DODGE', '', 0.7),
        onSpend: () => {
          if (this.time - (this.lowWarned || 0) > 3) { this.lowWarned = this.time; emit('toast', { text: 'Not enough thruster charge for an arc slash', kind: 'bad' }); }
        },
        puff: (p, s) => this.puff(p, s),
        haptic,
      };
    }
    // inside a running arena: grav plating, the wall, enemies as the only sword targets
    this.ctx.g = fight ? ARENA.G : this.cfg.g;
    this.ctx.targets = fight ? A.targets : this.nodes;
    this.ctx.enemies = fight ? A.targets : null;
    this.ctx.center = fight ? A.center : null;
    this.ctx.bound = fight ? A.R - 1.5 : BOUND;
    this.ctx.camYaw = this.camYaw;
    this.ctx.aim = this.gunView.ray(); this.ctx.onFire = () => this.gunView.fired(); this.ctx.onGunHit = (k) => this.gunView.hit(k); P.vm = this.gunView.vm;
    P.fpsCam = adsK > 0.6 ? this.camera : null;
    if (I.arena && this.hasArena && A.info.inside && !A.fighting && P.alive) A.start();
    P.update(dt, I, this.ctx);
    if (this.hasArena) A.update(dt, dt);

    this.updateTarget();
    if (this.dustT > 0) {
      this.dustT -= dt;
      this.dust.material.opacity = Math.max(0, this.dustT / 0.6) * 0.8;
      if (this.dustT <= 0) this.dust.visible = false;
    }

    // nodes respawn (and wobble when struck), drones hover over the pad, beacon blinks
    for (const n of this.nodes) {
      if (!n.alive && this.time > n.respawnAt) this.placeNode(n);
      if (n.alive && n.wobble > 0) {
        n.wobble = Math.max(0, n.wobble - dt * 3);
        const k = 0.45 + 0.55 * (n.hp / n.maxHp);
        n.group.scale.setScalar(k * (1 + Math.sin(this.time * 60) * 0.06 * n.wobble));
      }
    }
    this.padDrones.forEach((dr, i) => {
      const a = this.time * 0.4 + i * Math.PI;
      dr.position.set(Math.cos(a) * 9, 7 + Math.sin(this.time * 1.3 + i) * 0.8, Math.sin(a) * 9);
      dr.rotation.y = -a;
    });
    this.beacon.visible = Math.sin(this.time * 3) > 0;

    const dock = Math.hypot(m.position.x, m.position.z);
    if (dock < PAD_R && P.grounded && this.cargoTotal() > 0) this.unload();

    // lock-on: swing the camera behind the player, facing the locked enemy (a drag overrides it for a moment)
    this.lockYawHold = Math.max(0, this.lockYawHold - dt);
    const L = fight && P.lock && P.lock.alive ? P.lock : null;
    if (L && this.lockYawHold <= 0 && P.alive) {
      const want = Math.atan2(P.pos.x - L.pos.x, P.pos.z - L.pos.z);
      const d = Math.atan2(Math.sin(want - this.camYaw), Math.cos(want - this.camYaw));
      this.camYaw += d * Math.min(1, dt * 2.2);
    }
    // chase camera, kept above the ground, with impact shake
    const cp = this.camPitch, dist = this.camDist * (fight ? 1.15 : 1);
    const desired = new THREE.Vector3(
      m.position.x + Math.sin(this.camYaw) * Math.cos(cp) * dist,
      m.position.y + 4.2 + Math.sin(cp) * dist,
      m.position.z + Math.cos(this.camYaw) * Math.cos(cp) * dist,
    );
    desired.y = Math.max(desired.y, T.height(desired.x, desired.z) + 1.2);
    this.camera.position.lerp(desired, 1 - Math.exp(-10 * dt));
    const lk = L ? 0.3 : 0;
    this.camera.lookAt(
      m.position.x + (L ? (L.pos.x - m.position.x) * lk : 0),
      m.position.y + 4.4 + (L ? Math.max(-3, Math.min(6, (L.pos.y - m.position.y))) * lk : 0),
      m.position.z + (L ? (L.pos.z - m.position.z) * lk : 0));
    this.gunView.apply(this.camera, new THREE.Vector3(m.position.x, m.position.y + 1.72 * MECH_S, m.position.z), 2.6);
    P.body.root.visible = adsK < 0.6;
    if (adsK > 0 || this.adsFov) { this.adsFov = adsK > 0; this.camera.fov = THREE.MathUtils.lerp(60, ADS_FOV, adsK); this.camera.updateProjectionMatrix(); }
    if (P.shake > 0) {
      const k = P.shake * P.shake * 0.6;
      this.camera.position.x += (Math.random() - 0.5) * k;
      this.camera.position.y += (Math.random() - 0.5) * k;
    }
    this.sky.position.copy(this.camera.position);

    this.sun.position.copy(m.position).addScaledVector(SUN_DIR, 120);
    this.sun.target.position.copy(m.position);

    Object.assign(this.info, {
      cargo: this.cargoTotal(), speed: P.speed, dock, fuel: P.fuel, g: this.ctx.g, hp: P.hp,
      alt: P.alt, target: this.target && !fight ? { res: this.target.res, dist: this.targetDist, hp: this.target.hp / this.target.maxHp } : null,
      arena: this.hasArena ? A.info : null,
    });
  }

  puff(pos, scale = 1) {
    this.dust.visible = true;
    this.dust.position.set(pos.x, pos.y + 0.6, pos.z);
    this.dust.scale.setScalar(6 * scale);
    this.dustT = 0.6;
  }

  // nearest live deposit in front of the mech (HUD bracket)
  updateTarget() {
    const P = this.pilot, m = { position: P.pos };
    const f = P.forward(new THREE.Vector3());
    let best = null, bd = 22;
    for (const n of this.nodes) {
      if (!n.alive) continue;
      const v = n.group.position.clone().sub(m.position);
      v.y = 0;
      const d = v.length();
      if (d < bd && (d < 8 || v.normalize().dot(f) > 0.3)) { bd = d; best = n; }
    }
    this.target = best;
    this.targetDist = bd;
  }

  // a sword strike on a deposit: every 4 damage cuts a tonne of ore loose into the hopper
  strikeNode(n, mv) {
    const color = RES[n.res].color;
    n.wobble = 1;
    if (this.cargoTotal() >= CAP) {
      if (this.time - (this.fullWarned || 0) > 4) {
        this.fullWarned = this.time;
        emit('toast', { text: 'Mech hopper full — walk back to the landing pad', kind: 'bad' });
      }
      return color;
    }
    const units = Math.min(n.hp, CAP - this.cargoTotal(), Math.max(1, Math.round(mv.dmg / 4)));
    this.cargo[n.res] = (this.cargo[n.res] || 0) + units;
    n.hp -= units;
    if (n.hp <= 0) {
      n.alive = false;
      n.group.visible = false;
      n.respawnAt = this.time + 60;
      this.pilot.fx.sparksAt(n.group.position.clone().setY(n.group.position.y + 1.5), 60, { color, speed: 22, life: 0.9, floor: n.group.position.y });
      this.pilot.fx.ring(n.group.position.clone().setY(n.group.position.y + 0.4), 7, { color, life: 0.5 });
      this.puff(n.group.position, 1.4);
      haptic('heavy');
    }
    return color;
  }
}
