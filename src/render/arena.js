import * as THREE from 'three';
import { MechEnemy, TYPES } from './mech/mechEnemy.js';
import { glowSprite } from './shaders.js';
import { MAT } from './models.js';
import { emit } from '../sim/state.js';

// Lunar mech arena: a grav-plated proving ground a short walk from the landing pad. Walk onto the grid and start
// a battle: hostile frames drop in on thrusters in escalating waves (lancers, gunners, brutes). The plating runs
// the floor at 1 g while the wall is up, so fights are snappy instead of floaty. Every cleared wave pays credits;
// the run ends when your frame goes down (or you leave), and your best wave is kept.

export const ARENA = { x: -95, z: -95, R: 46, G: 9.81 };
const MAX_LIVE = 4;
const RANKS = [[0, 'D'], [5, 'C'], [10, 'B'], [18, 'A'], [28, 'S'], [42, 'SS'], [60, 'SSS']];

function waveList(n) {
  const fixed = [
    ['lancer', 'lancer'],
    ['lancer', 'lancer', 'gunner'],
    ['lancer', 'gunner', 'brute'],
    ['lancer', 'lancer', 'gunner', 'gunner'],
    ['brute', 'lancer', 'lancer', 'gunner'],
  ];
  if (n <= fixed.length) return fixed[n - 1].slice();
  const count = Math.min(7, 4 + Math.floor((n - 5) / 2));
  const out = ['brute'];
  for (let i = 1; i < count; i++) out.push(Math.random() < 0.6 ? 'lancer' : Math.random() < 0.7 ? 'gunner' : 'brute');
  return out;
}

const FLOOR_VERT = `varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;
const FLOOR_FRAG = `uniform float uR, uOn, uTime; varying vec2 vP;
  float line(float x, float w){ float d = abs(fract(x - 0.5) - 0.5); return 1.0 - smoothstep(0.0, w, d); }
  void main(){
    float r = length(vP) / uR;
    if (r > 1.0) discard;
    vec2 g = vP / 3.0;
    float grid = max(line(g.x, 0.03), line(g.y, 0.03));
    vec2 G = vP / 15.0;
    float major = max(line(G.x, 0.012), line(G.y, 0.012));
    float rim = smoothstep(0.955, 0.985, r) * (1.0 - smoothstep(0.985, 1.0, r));
    float ring2 = smoothstep(0.4, 0.405, r) * (1.0 - smoothstep(0.405, 0.41, r));
    float sweep = smoothstep(0.08, 0.0, abs(fract(r * 1.5 - uTime * 0.25) - 0.5)) * uOn;
    vec3 base = vec3(0.07, 0.08, 0.10);
    vec3 lineC = mix(vec3(0.35, 0.6, 0.85), vec3(1.0, 0.32, 0.18), uOn);
    float glow = grid * 0.35 + major * 0.7 + rim * 2.2 + ring2 * 0.6 + sweep * grid * 1.5;
    glow *= 0.55 + 0.45 * uOn;
    gl_FragColor = vec4(base * (1.0 - smoothstep(0.85, 1.0, r) * 0.5) + lineC * glow, 0.92);
  }`;
const WALL_FRAG = `uniform float uOn, uTime, uFlash; varying vec2 vUv;
  void main(){
    float fade = (1.0 - vUv.y) * (1.0 - vUv.y);
    float scan = 0.6 + 0.4 * sin(vUv.y * 90.0 - uTime * 6.0);
    float hexes = step(0.92, fract(vUv.x * 160.0)) + step(0.94, fract(vUv.y * 22.0 + uTime * 0.3));
    float a = (fade * 0.35 * scan + hexes * fade * 0.25) * uOn + uFlash * fade * 0.6;
    gl_FragColor = vec4(vec3(1.0, 0.28, 0.14) * a * 1.6, a);
  }`;

export class LunarArena {
  constructor(view) {
    this.view = view;
    this.center = new THREE.Vector3(ARENA.x, 0, ARENA.z);
    this.R = ARENA.R;
    this.pool = { lancer: [], gunner: [], brute: [] };
    this.enemies = [];          // every pooled enemy (active or not)
    this.live = [];             // active enemies this frame (alive or dying)
    this.targets = [];          // alive enemies (sword targets / lock-on)
    this.state = 'idle';
    this.info = { state: 'idle', wave: 0, kills: 0, score: 0, combo: 0, rank: 'D', banner: '', sub: '', bannerT: 0, inside: false, dist: 0, flash: 0, best: 0, payout: 0 };
    const tokens = (this.tokens = { max: 1, holders: new Set() });
    tokens.take = (e) => { if (tokens.holders.has(e)) return true; if (tokens.holders.size >= tokens.max) return false; tokens.holders.add(e); e.token = true; return true; };
    tokens.give = (e) => { tokens.holders.delete(e); e.token = false; };
    this.group = null;
  }

  get fighting() { return this.state === 'countdown' || this.state === 'fight' || this.state === 'clear'; }

  // ---------------- build ----------------
  build(content, height) {
    const y = height(this.center.x, this.center.z);
    this.center.y = y;
    const g = (this.group = new THREE.Group());
    g.position.copy(this.center);
    content.add(g);
    // grid floor (the reference look: dark plate, glowing lines)
    this.floorMat = new THREE.ShaderMaterial({
      uniforms: { uR: { value: this.R }, uOn: { value: 0 }, uTime: { value: 0 } },
      vertexShader: FLOOR_VERT, fragmentShader: FLOOR_FRAG, transparent: true, depthWrite: true,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    const floor = new THREE.Mesh(new THREE.CircleGeometry(this.R, 96), this.floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0.06;
    floor.renderOrder = 1;
    g.add(floor);
    const rimGeo = new THREE.TorusGeometry(this.R, 0.35, 6, 128);
    const rim = new THREE.Mesh(rimGeo, MAT.hullDark);
    rim.rotation.x = Math.PI / 2; rim.position.y = 0.15;
    rim.receiveShadow = true;
    g.add(rim);
    // pylons with hot strips
    this.strips = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x58c8ff).multiplyScalar(2.2), toneMapped: false });
    const pylonGeo = new THREE.BoxGeometry(1.1, 9, 1.1);
    const stripGeo = new THREE.BoxGeometry(0.2, 7, 1.16);
    this.lamps = [];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const p = new THREE.Group();
      p.position.set(Math.cos(a) * (this.R + 1.4), 0, Math.sin(a) * (this.R + 1.4));
      p.rotation.y = -a;
      const body = new THREE.Mesh(pylonGeo, MAT.hullDark);
      body.position.y = 4.5; body.castShadow = true;
      const strip = new THREE.Mesh(stripGeo, this.strips);
      strip.position.set(-0.5, 4.5, 0);
      const lamp = glowSprite(0x58c8ff, 4, 1.6);
      lamp.position.y = 9.4;
      p.add(body, strip, lamp);
      this.lamps.push(lamp);
      g.add(p);
    }
    // energy wall, raised during a battle
    this.wallMat = new THREE.ShaderMaterial({
      uniforms: { uOn: { value: 0 }, uTime: { value: 0 }, uFlash: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: WALL_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, toneMapped: false,
    });
    this.wall = new THREE.Mesh(new THREE.CylinderGeometry(this.R, this.R, 16, 128, 1, true), this.wallMat);
    this.wall.position.y = 8;
    this.wall.visible = false;
    g.add(this.wall);
    // guide beacon: a faint light column you can see from the pad
    this.beaconMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x58c8ff).multiplyScalar(0.5), transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    this.beacon = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 1.6, 220, 12, 1, true), this.beaconMat);
    this.beacon.position.y = 110;
    g.add(this.beacon);
    const top = glowSprite(0x58c8ff, 12, 0.8);
    top.position.y = 60;
    g.add(top);
    this.beaconTop = top;

    // one of each enemy, drawn once out of sight so their shaders compile before the first wave
    if (!this.enemies.length) for (const t of Object.keys(this.pool)) this.getEnemy(t);
    this.warm = 3;
    for (const e of this.enemies) { e.body.setVisible(true); e.pos.set(this.center.x, this.center.y - 400, this.center.z); e.body.root.position.copy(e.pos); if (e.beam) e.beam.set(e.pos, e.pos.clone().setY(e.pos.y - 5), 0.1, 1, 1, 0); }
  }

  getEnemy(type) {
    let e = this.pool[type].find((x) => !x.active);
    if (!e) {
      e = new MechEnemy(this.view.scene, this.view.pilot.fx, type);
      this.pool[type].push(e);
      this.enemies.push(e);
    }
    return e;
  }

  // flatten the terrain under the arena: { x, z, r (flat), blend }
  static flat() { return { x: ARENA.x, z: ARENA.z, r: ARENA.R + 6, blend: 30 }; }

  // ---------------- flow ----------------
  start() {
    if (this.fighting) return;
    const P = this.view.pilot;
    if (!P.alive) return;
    this.wave = 0; this.kills = 0; this.score = 0; this.combo = 0; this.comboT = 0; this.payout = 0;
    this.maxCombo = 0;
    this.nextWave();
    emit('toast', { text: 'Arena sealed · grav plating 1 g · clear the waves', kind: 'good' });
  }

  nextWave() {
    this.wave++;
    this.pending = waveList(this.wave);
    this.waveKills = 0;
    this.state = 'countdown';
    this.stateT = this.wave === 1 ? 3 : 2.2;
    this.tokens.max = this.wave < 3 ? 1 : 2;
    this.banner(`WAVE ${this.wave}`, this.pending.map((t) => t.toUpperCase()).join(' · '), this.stateT);
  }

  banner(text, sub = '', t = 2) { Object.assign(this.info, { banner: text, sub, bannerT: t }); }

  spawnSome() {
    const live = this.enemies.filter((e) => e.active && e.alive).length;
    let n = Math.min(MAX_LIVE - live, this.pending.length);
    const P = this.view.pilot;
    while (n-- > 0) {
      const type = this.pending.shift();
      const e = this.getEnemy(type);
      // drop in on the far side of the arena from the player, spread out
      const base = Math.atan2(P.pos.z - this.center.z, P.pos.x - this.center.x) + Math.PI;
      const a = base + (Math.random() - 0.5) * 2.2;
      const r = this.R * (0.45 + Math.random() * 0.35);
      const x = this.center.x + Math.cos(a) * r, z = this.center.z + Math.sin(a) * r;
      e.spawn(x, z, Math.atan2(P.pos.x - x, P.pos.z - z), this.view.terrain.height(x, z), this.wave);
    }
  }

  end(reason) {
    const best = this.view.app.state.stats.arenaBest || 0;
    const reached = Math.max(0, this.wave - (reason === 'clear' ? 0 : 1));
    if (reached > best) this.view.app.state.stats.arenaBest = reached;
    for (const e of this.enemies) if (e.active) e.despawn();
    this.tokens.holders.clear();
    this.state = 'idle';
    this.info.state = 'idle';
    if (reason === 'leave' && this.payout) emit('toast', { text: `Arena run over · wave ${this.wave} · ${this.kills} kills`, kind: 'good' });
  }

  pay(cr, why) {
    if (cr <= 0) return;
    const s = this.view.app.state;
    s.wallet.credits += cr;
    this.payout += cr;
    emit('toast', { text: `${why} · +${cr.toLocaleString()} credits`, kind: 'good' });
    emit('changed');
  }

  onPlayerDeath() {
    if (!this.fighting) { this.view.pilot.revive(); return; }
    this.state = 'down';
    this.stateT = 3.2;
    this.banner('FRAME DOWN', `wave ${this.wave} · ${this.kills} kills · ${Math.round(this.score).toLocaleString()} pts`, 3.2);
  }

  // ---------------- combat glue ----------------
  hitEnemy(e, mv, point, attacker = this.view.pilot) {
    const color = e.receiveHit(mv, attacker, this.ectx);
    this.combo++;
    this.comboT = 3;
    this.maxCombo = Math.max(this.maxCombo, this.combo);
    this.score += mv.dmg * (1 + this.combo * 0.06) * (e.state === 'launched' ? 1.5 : 1);
    return color;
  }

  hitPlayer(e, mv, kind) {
    const P = this.view.pilot;
    const res = P.takeHit({ dmg: mv.dmg * (1 + (this.wave - 1) * 0.05), mv, from: e.pos, attacker: e, kind, unblockable: !!mv.unblockable }, this.view.ctx);
    if (res === 'parry') {
      if (kind !== 'beam') e.parried(this.ectx);
      this.score += 60;
      this.banner('PARRY', '', 0.7);
    } else if (res === 'hit') {
      this.combo = 0; this.comboT = 0;
      this.info.flash = 1;
      this.wallMat.uniforms.uFlash.value = 0.6;
    } else if (res === 'dodge' && kind !== 'beam') this.score += 15;
    return res;
  }

  onKill(e) {
    this.kills++;
    this.waveKills++;
    this.score += TYPES[e.type].score * this.wave;
    this.view.pilot.slowmo = Math.max(this.view.pilot.slowmo, this.enemies.some((x) => x.active && x.alive) || this.pending.length ? 0.25 : 1.1);
  }

  // ---------------- per frame ----------------
  update(dt, rawDt) {
    const P = this.view.pilot, info = this.info, t = (this.time = (this.time || 0) + rawDt);
    if (this.warm > 0 && --this.warm === 0) for (const e of this.enemies) if (!e.active) { e.body.setVisible(false); e.beam?.hide(); }
    const dx = P.pos.x - this.center.x, dz = P.pos.z - this.center.z;
    info.dist = Math.hypot(dx, dz);
    info.inside = info.dist < this.R - 2;
    if (info.bannerT > 0) info.bannerT -= rawDt;
    info.flash = Math.max(0, info.flash - rawDt * 2.5);
    this.wallMat.uniforms.uFlash.value = Math.max(0, this.wallMat.uniforms.uFlash.value - rawDt * 2);

    if (!this.ectx) {
      this.ectx = {
        player: P, center: this.center, R: this.R, tokens: this.tokens, others: this.enemies,
        height: (x, z) => this.view.terrain.height(x, z),
        onHitPlayer: (e, mv, kind) => this.hitPlayer(e, mv, kind),
        hitEnemy: (e, mv, p) => this.hitEnemy(e, mv, p),
        onKill: (e) => this.onKill(e),
        puff: (p, s) => this.view.puff(p, s),
        shake: (k) => { P.shake = Math.max(P.shake, k); },
      };
    }
    this.ectx.g = this.fighting || this.state === 'down' ? ARENA.G : this.view.cfg.g;
    this.ectx.time = t;

    if (this.state === 'countdown') {
      this.stateT -= rawDt;
      if (this.stateT <= 0) { this.state = 'fight'; this.spawnSome(); }
    } else if (this.state === 'fight') {
      if (this.pending.length && Math.random() < rawDt * 2) this.spawnSome();
      const anyAlive = this.enemies.some((e) => e.active && e.alive);
      if (!anyAlive && !this.pending.length) {
        this.state = 'clear';
        this.stateT = 2.8;
        const cr = 200 * this.wave + this.waveKills * 60;
        this.banner('WAVE CLEAR', `+${cr.toLocaleString()} credits · max combo ${this.maxCombo}`, 2.6);
        this.pay(cr, `Arena wave ${this.wave} cleared`);
        P.hp = Math.min(100, P.hp + 25);              // field repair between waves
        P.fuel = 100;
      }
    } else if (this.state === 'clear') {
      this.stateT -= rawDt;
      if (this.stateT <= 0) this.nextWave();
    } else if (this.state === 'down') {
      this.stateT -= rawDt;
      if (this.stateT <= 0) { this.end('down'); P.revive(); }
    }

    // combo decay
    if (this.comboT > 0) { this.comboT -= rawDt; if (this.comboT <= 0) this.combo = 0; }
    let rank = 'D';
    for (const [n, r] of RANKS) if (this.combo >= n) rank = r;

    // enemies run on the player's clock (hitstop / slow motion freeze them too)
    const edt = rawDt * P.timeScale;
    this.live.length = 0; this.targets.length = 0;
    for (const e of this.enemies) {
      if (!e.active) continue;
      e.update(edt, this.ectx);
      if (e.active) this.live.push(e);
      if (e.alive) this.targets.push(e);
    }

    // visuals
    const on = this.fighting ? 1 : 0;
    const u = this.floorMat.uniforms;
    u.uOn.value += (on - u.uOn.value) * Math.min(1, rawDt * 3);
    u.uTime.value = t;
    const w = this.wallMat.uniforms;
    w.uOn.value += (on - w.uOn.value) * Math.min(1, rawDt * 2.5);
    w.uTime.value = t;
    this.wall.visible = w.uOn.value > 0.01 || w.uFlash.value > 0.01;
    this.strips.color.setHex(on ? 0xff4a24 : 0x58c8ff).multiplyScalar(2.2 + Math.sin(t * 6) * 0.4 * on);
    for (const l of this.lamps) l.material.color.copy(this.strips.color).multiplyScalar(0.7);
    // the guide beacon is for finding the arena: fade it out as you walk in
    const far = THREE.MathUtils.smoothstep(info.dist, this.R * 0.6, this.R * 2.2);
    this.beacon.visible = this.beaconTop.visible = !this.fighting && far > 0.02;
    this.beaconMat.opacity = (0.22 + 0.08 * Math.sin(t * 2)) * far;
    this.beaconTop.material.opacity = far;

    Object.assign(info, {
      state: this.state, wave: this.wave || 0, kills: this.kills || 0, score: this.score || 0, combo: this.combo || 0, rank,
      best: this.view.app.state.stats.arenaBest || 0, enemies: this.live, lock: P.lock, payout: this.payout || 0,
    });
  }
}
