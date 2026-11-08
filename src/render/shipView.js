import * as THREE from 'three';
import { VrmChar, CHARACTERS } from './chars/vrmChar.js';
import { Parkour } from './chars/parkour.js';
import { gridTexture, floorTexture, deckTexture, wallTexture, hexStoneTextures, starTexture, worldBox } from './chars/simTextures.js';

// Inside the mothership: you dock with the station and walk its hangar deck as one of the playable characters.
// The deck has a wardrobe (character select), the airlock back out to space, and the door to the training sim:
// a holographic gray-box course of orange grid towers and glowing hex-stone panels for wall-running and climbing.

const CHAR_KEY = 'openspace_char';
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

function label(text, sub = '', color = '#7fe6ff') {
  const c = document.createElement('canvas'); c.width = 512; c.height = 128;
  const g = c.getContext('2d');
  g.font = '700 54px "Rajdhani", "Segoe UI", sans-serif'; g.textAlign = 'center';
  g.shadowColor = color; g.shadowBlur = 18; g.fillStyle = color;
  g.fillText(text, 256, 66);
  if (sub) { g.font = '500 26px "Rajdhani", "Segoe UI", sans-serif'; g.shadowBlur = 8; g.fillStyle = '#cfefff'; g.fillText(sub, 256, 108); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false, toneMapped: false }));
  s.scale.set(4, 1, 1);
  return s;
}

class Area {
  constructor(name) {
    this.name = name;
    this.scene = new THREE.Scene();
    this.boxes = [];
    this.meshes = [];              // camera collision
    this.interact = [];
    this.spawn = { pos: new THREE.Vector3(), yaw: 0 };
    this.killY = -30;
  }
  // a box from min corner + size; kind: solid (default), run, climb
  box(x, y, z, w, h, d, mat, { kind = 'solid', tile = 1, collide = true, shadow = true } = {}) {
    const m = new THREE.Mesh(worldBox(w, h, d, tile), mat);
    m.position.set(x + w / 2, y + h / 2, z + d / 2);
    m.castShadow = shadow; m.receiveShadow = true;
    this.scene.add(m);
    if (collide) {
      this.boxes.push({ min: new THREE.Vector3(x, y, z), max: new THREE.Vector3(x + w, y + h, z + d), kind });
      this.meshes.push(m);
    }
    return m;
  }
}

export class ShipView {
  constructor(app) {
    this.app = app;
    this.camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 2000);
    this.camYaw = Math.PI; this.camPitch = 0.22; this.camDist = 4.2;
    this.char = null; this.ctrl = null; this.loading = null;
    this.time = 0;
    this.hex = hexStoneTextures();
    this.deck = this.buildDeck();
    this.sim = this.buildSim();
    this.area = this.deck;
    this.scene = this.deck.scene;
    this.ray = new THREE.Raycaster();
    this.buildHud();
  }

  get scenes() { return [this.deck.scene, this.sim.scene]; }

  // ---------------- the hangar deck ----------------
  buildDeck() {
    const A = new Area('deck'), S = A.scene;
    S.background = new THREE.Color(0x05070c);
    S.fog = new THREE.Fog(0x0a0e16, 30, 70);
    const floor = new THREE.MeshStandardMaterial({ map: deckTexture(), metalness: 0.6, roughness: 0.45 });
    const wall = new THREE.MeshStandardMaterial({ map: wallTexture(), metalness: 0.4, roughness: 0.6 });
    const trim = new THREE.MeshStandardMaterial({ color: 0x1a1e25, metalness: 0.8, roughness: 0.35 });
    const glow = new THREE.MeshStandardMaterial({ color: 0x0b1c24, emissive: 0x58e4ff, emissiveIntensity: 1.3 });
    const amber = new THREE.MeshStandardMaterial({ color: 0x241808, emissive: 0xffb040, emissiveIntensity: 2.2 });
    const W = 14, L = 44, H = 7;
    floor.map.repeat.set(1, 1);
    A.box(-W / 2, -0.5, -L / 2, W, 0.5, L, floor, { tile: 4 });                // floor (top at y = 0)
    A.box(-W / 2, H, -L / 2, W, 0.5, L, trim, { tile: 4, shadow: false });     // ceiling
    // side walls; the +x wall has a long window onto Earth
    A.box(-W / 2 - 0.5, 0, -L / 2, 0.5, H, L, wall, { tile: 4 });
    A.box(W / 2, 0, -L / 2, 0.5, H, 12, wall, { tile: 4 });
    A.box(W / 2, 0, 10, 0.5, H, 12, wall, { tile: 4 });
    A.box(W / 2, 0, -10, 0.5, 1.4, 20, wall, { tile: 4 });
    A.box(W / 2, 5.6, -10, 0.5, 1.4, 20, wall, { tile: 4 });
    const win = new THREE.Mesh(new THREE.PlaneGeometry(20, 4.2), new THREE.MeshBasicMaterial({ map: starTexture(), toneMapped: false }));
    win.position.set(W / 2 + 0.4, 3.5, 0); win.rotation.y = -Math.PI / 2;
    S.add(win);
    A.boxes.push({ min: new THREE.Vector3(W / 2, 0, -10), max: new THREE.Vector3(W / 2 + 0.5, H, 10), kind: 'solid' });
    for (const z of [-10, -5, 0, 5, 10]) A.box(W / 2 - 0.2, 1.4, z - 0.15, 0.3, 4.2, 0.3, trim);   // window mullions
    // end walls
    A.box(-W / 2, 0, -L / 2 - 0.5, W, H, 0.5, wall, { tile: 4 });
    A.box(-W / 2, 0, L / 2, W, H, 0.5, wall, { tile: 4 });
    // light strips along the ceiling and the floor edges
    for (const x of [-3, 3]) A.box(x - 0.15, H - 0.08, -L / 2 + 1, 0.3, 0.08, L - 2, glow, { collide: false, shadow: false });
    for (const x of [-W / 2 + 0.05, W / 2 - 0.35]) A.box(x, 0.02, -L / 2 + 1, 0.3, 0.06, L - 2, glow, { collide: false, shadow: false });
    // pillars and crates
    for (const z of [-15, -5, 5, 15]) { A.box(-W / 2, 0, z - 0.5, 0.8, H, 1, trim); }
    A.box(-6.3, 0, 8, 1.4, 1.2, 1.4, trim); A.box(-6.4, 1.2, 8.2, 1.1, 0.9, 1.1, trim); A.box(-4.6, 0, 9.5, 1.2, 0.8, 1.2, trim);

    // wardrobe: a holo pedestal with a ring of light
    const ped = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.3, 0.3, 32), trim);
    ped.position.set(-4.8, 0.15, -1); S.add(ped);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.15, 0.04, 8, 48), glow);
    ring.rotation.x = Math.PI / 2; ring.position.set(-4.8, 0.32, -1); S.add(ring);
    this.wardrobeRing = ring;
    const wl = label('WARDROBE', 'choose your character'); wl.position.set(-4.8, 3.1, -1); S.add(wl);
    A.boxes.push({ min: new THREE.Vector3(-6.1, 0, -2.3), max: new THREE.Vector3(-3.5, 0.3, 0.3), kind: 'solid' });
    A.interact.push({ pos: new THREE.Vector3(-4.8, 0, -1), r: 2.6, text: 'Change character', act: 'wardrobe' });

    // training sim door at the far end: a hex-stone gate
    const hexMat = new THREE.MeshStandardMaterial({ map: this.hex.map, emissiveMap: this.hex.emissive, emissive: 0xffffff, emissiveIntensity: 1.6, bumpMap: this.hex.bump, bumpScale: 3, roughness: 0.35, metalness: 0.1 });
    A.box(-3, 0, -L / 2 + 0.05, 6, 5, 0.3, hexMat, { tile: 2 });
    A.box(-3.6, 0, -L / 2 + 0.05, 0.6, 5.6, 0.6, trim); A.box(3, 0, -L / 2 + 0.05, 0.6, 5.6, 0.6, trim); A.box(-3.6, 5, -L / 2 + 0.05, 7.2, 0.6, 0.6, trim);
    const sl = label('TRAINING SIM', 'holo course · parkour'); sl.position.set(0, 6.3, -L / 2 + 1); S.add(sl);
    A.interact.push({ pos: new THREE.Vector3(0, 0, -L / 2 + 1.5), r: 3, text: 'Enter the training sim', act: 'sim' });

    // airlock at the near end
    A.box(-2.5, 0, L / 2 - 0.35, 5, 4.6, 0.3, amber, { tile: 2 });
    const al = label('AIRLOCK', 'back to space · EVA', '#ffc46a'); al.position.set(0, 5.6, L / 2 - 1); S.add(al);
    A.interact.push({ pos: new THREE.Vector3(0, 0, L / 2 - 1.5), r: 3, text: 'Cycle the airlock · back to space', act: 'exit' });

    S.add(new THREE.HemisphereLight(0x9fc8ff, 0x1a1c22, 0.45));
    for (const z of [-14, 0, 14]) {
      const l = new THREE.PointLight(0xbfe8ff, 12, 20, 1.6);
      l.position.set(0, H - 0.6, z); S.add(l);
    }
    const key = new THREE.DirectionalLight(0xdfeeff, 1.2);
    key.position.set(-6, 14, 8); key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    Object.assign(key.shadow.camera, { left: -12, right: 12, top: 26, bottom: -26, near: 1, far: 40 });
    key.shadow.bias = -0.0005;
    S.add(key);
    A.spawn.pos.set(0, 0, L / 2 - 6); A.spawn.yaw = Math.PI;
    A.title = 'HANGAR DECK';
    return A;
  }

  // ---------------- the training sim ----------------
  buildSim() {
    const A = new Area('sim'), S = A.scene;
    // sky: a gradient dome
    const sky = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16), new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false,
      uniforms: { top: { value: new THREE.Color(0x3d7fd6) }, hor: { value: new THREE.Color(0xd8ecff) } },
      vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'uniform vec3 top, hor; varying vec3 vP; void main(){ float h = clamp(vP.y, 0.0, 1.0); gl_FragColor = vec4(mix(hor, top, pow(h, 0.55)), 1.0); }',
    }));
    S.add(sky);
    // a few soft clouds
    const cc = document.createElement('canvas'); cc.width = cc.height = 128;
    const cg = cc.getContext('2d'), grd = cg.createRadialGradient(64, 64, 4, 64, 64, 64);
    grd.addColorStop(0, 'rgba(255,255,255,0.95)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
    cg.fillStyle = grd; cg.fillRect(0, 0, 128, 128);
    const cloudMat = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cc), transparent: true, depthWrite: false, fog: false });
    for (let i = 0; i < 40; i++) {
      const s = new THREE.Sprite(cloudMat);
      const a = (i / 40) * Math.PI * 2 + Math.random() * 0.3, r = 260 + Math.random() * 260;
      s.position.set(Math.cos(a) * r, 40 + Math.random() * 90, Math.sin(a) * r);
      s.scale.set(90 + Math.random() * 90, 30 + Math.random() * 20, 1);
      S.add(s);
    }
    S.fog = new THREE.Fog(0xd8ecff, 120, 600);

    const orange = new THREE.MeshStandardMaterial({ map: gridTexture(), roughness: 0.8 });
    const ground = new THREE.MeshStandardMaterial({ map: floorTexture(), roughness: 0.9 });
    const hexMat = new THREE.MeshStandardMaterial({ map: this.hex.map, emissiveMap: this.hex.emissive, emissive: 0xffffff, emissiveIntensity: 1.1, bumpMap: this.hex.bump, bumpScale: 4, roughness: 0.3, metalness: 0.15 });
    const pad = new THREE.MeshStandardMaterial({ color: 0x0f2230, emissive: 0x3fd8ff, emissiveIntensity: 1.6 });
    const T = 1;   // texture tile (m)

    A.box(-90, -1, -60, 180, 1, 180, ground, { tile: T });

    // panels sit nearly flush with their walls (5 cm proud) so nothing catches on their edges
    // 1. warm-up steps
    for (let i = 0; i < 4; i++) A.box(1 + i * 1.6, 0, -9, 1.6, 0.5 + i * 0.5, 3, orange, { tile: T });
    // 2. climb tower with the bridge, then a second tower (like the reference: hex bridge high between two towers)
    A.box(-3, 0, 18, 6, 10, 6, orange, { tile: T });
    A.box(-1.5, 0, 17.95, 3, 10, 0.25, hexMat, { kind: 'climb', tile: 2 });
    A.box(-1.25, 8.8, 24, 2.5, 1.2, 17, hexMat, { kind: 'run', tile: 2 });
    A.box(-3, 0, 41, 6, 10, 6, orange, { tile: T });
    A.box(2.8, 0, 42.5, 0.25, 10, 3, hexMat, { kind: 'climb', tile: 2 });
    // 3. wall-run lane: run along +x beside the wall, jump at it, run along the glowing strip
    A.box(9, 0, 0, 1, 7, 34, orange, { tile: T });
    A.box(8.95, 1.4, 3, 0.25, 4.6, 28, hexMat, { kind: 'run', tile: 2 });
    A.box(10, 0, 32, 6, 3.5, 6, orange, { tile: T });
    // 4. a second lane on the far side with floating stepping stones between
    A.box(-10, 0, 4, 1, 8, 30, orange, { tile: T });
    A.box(-9.2, 1.6, 7, 0.25, 4.8, 24, hexMat, { kind: 'run', tile: 2 });
    for (const [x, y, z] of [[-6, 1.6, 8], [-6.5, 3, 13], [-5.5, 4.4, 18], [-6.2, 5.8, 23]]) A.box(x, y, z, 2, 0.5, 2, orange, { tile: T });
    // 5. tall tower with a long hex beam into the sky
    A.box(-24, 0, 26, 5, 16, 5, orange, { tile: T });
    A.box(-19.2, 0, 27, 0.25, 16, 3, hexMat, { kind: 'climb', tile: 2 });
    A.box(-23, 14.8, 31, 3, 1.2, 26, hexMat, { kind: 'run', tile: 2 });
    A.box(-25, 0, 57, 5, 16, 5, orange, { tile: T });
    // 6. a gap course: platforms at rising heights
    for (let i = 0; i < 6; i++) A.box(16 + (i % 2) * 3, 1 + i * 1.3, 8 + i * 4, 3, 0.6, 3, orange, { tile: T });
    // start / exit pad
    const exitPad = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 0.08, 40), pad);
    exitPad.position.set(-4, 0.04, -4); S.add(exitPad);
    const el = label('EXIT SIM', 'back to the deck'); el.position.set(-4, 2.6, -4); S.add(el);
    A.interact.push({ pos: new THREE.Vector3(-4, 0, -4), r: 2, text: 'Leave the sim · back to the deck', act: 'deck' });
    const hint = label('CLIMB', 'push into the glowing wall'); hint.position.set(0, 3.2, 16.8); S.add(hint);
    const hint2 = label('WALL RUN', 'sprint beside it · jump at it'); hint2.position.set(6.5, 3.4, 4); S.add(hint2);

    S.add(new THREE.HemisphereLight(0xcfe6ff, 0x8a8f96, 1.1));
    const sun = new THREE.DirectionalLight(0xfff2dd, 2.4);
    sun.position.set(30, 60, -20); sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45, near: 1, far: 160 });
    sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02;
    S.add(sun, sun.target);
    this.sun = sun;
    A.spawn.pos.set(0, 0, 0); A.spawn.yaw = 0;
    A.killY = -20;
    A.title = 'TRAINING SIM';
    return A;
  }

  // ---------------- entering / areas ----------------
  enter(baseName = 'EDEN') {
    this.baseName = baseName;
    this.go(this.deck);
    this.hud.hidden = false;
    this.ensureChar();
  }
  leave() { this.hud.hidden = true; this.closeWardrobe(); }

  go(area) {
    this.area = area;
    this.scene = area.scene;
    if (this.ctrl) { this.ctrl.spawn(area.spawn.pos, area.spawn.yaw); area.scene.add(this.char.root); }
    this.camYaw = area.spawn.yaw + Math.PI; this.snapCam = true;
    this.$title.textContent = `${this.baseName} · ${area.title}`;
  }

  async ensureChar(id = null) {
    id = id || (() => { try { return localStorage.getItem(CHAR_KEY); } catch { return null; } })() || CHARACTERS[0].id;
    const def = CHARACTERS.find((c) => c.id === id) || CHARACTERS[0];
    if (this.char?.def.id === def.id || this.loading === def.id) return;
    this.loading = def.id;
    this.$load.hidden = false; this.$load.textContent = `LOADING ${def.name.toUpperCase()}…`;
    try {
      const c = await VrmChar.load(def, (k) => { this.$load.textContent = `LOADING ${def.name.toUpperCase()} · ${Math.round(k * 100)}%`; });
      if (this.loading !== def.id) { c.dispose(); return; }
      const keep = this.ctrl ? { pos: this.ctrl.pos.clone(), yaw: this.ctrl.yaw } : null;
      this.char?.dispose();
      this.char = c;
      this.ctrl = new Parkour(c);
      this.area.scene.add(c.root);
      if (keep) this.ctrl.spawn(keep.pos, keep.yaw); else this.ctrl.spawn(this.area.spawn.pos, this.area.spawn.yaw);
      try { localStorage.setItem(CHAR_KEY, def.id); } catch {}
    } catch (e) {
      console.error('character load failed', e);
      this.app.hud?.toast(`Couldn't load ${def.name}`, 'bad');
    }
    this.loading = null;
    this.$load.hidden = true;
  }

  act(a) {
    if (a === 'wardrobe') this.openWardrobe();
    else if (a === 'sim') this.fade(() => this.go(this.sim));
    else if (a === 'deck') this.fade(() => this.go(this.deck));
    else if (a === 'exit') this.fade(() => this.app.setMode('local'));
  }

  fade(fn) {
    this.$fade.classList.add('on');
    setTimeout(() => { fn(); setTimeout(() => this.$fade.classList.remove('on'), 60); }, 260);
  }

  // ---------------- HUD (own overlay; the pilot HUD is hidden in this mode) ----------------
  buildHud() {
    const el = document.createElement('div');
    el.className = 'ship-hud'; el.hidden = true;
    el.innerHTML = `
      <div class="sh-title"></div>
      <div class="sh-help">WASD move · Shift sprint · Space jump (again in the air) · drag to look · E interact</div>
      <button class="sh-prompt" hidden></button>
      <div class="sh-load" hidden></div>
      <div class="sh-fade"></div>
      <div class="sh-ward" hidden><div class="sh-card-wrap"><h3>WARDROBE</h3><div class="sh-cards"></div><button class="sh-close">CLOSE</button></div></div>`;
    document.body.appendChild(el);
    this.hud = el;
    this.$title = el.querySelector('.sh-title');
    this.$prompt = el.querySelector('.sh-prompt');
    this.$load = el.querySelector('.sh-load');
    this.$fade = el.querySelector('.sh-fade');
    this.$ward = el.querySelector('.sh-ward');
    el.querySelector('.sh-cards').innerHTML = CHARACTERS.map((c) => `
      <button class="sh-card" data-id="${c.id}"><img src="/characters/${c.thumb}" alt=""><b>${c.name}</b><small>${c.blurb}</small></button>`).join('');
    el.querySelector('.sh-cards').addEventListener('click', (e) => {
      const b = e.target.closest('.sh-card');
      if (!b) return;
      this.closeWardrobe();
      this.ensureChar(b.dataset.id);
    });
    el.querySelector('.sh-close').addEventListener('click', () => this.closeWardrobe());
    this.$prompt.addEventListener('click', () => { if (this.near) this.act(this.near.act); });
  }
  openWardrobe() {
    this.$ward.hidden = false;
    const cur = this.char?.def.id;
    this.$ward.querySelectorAll('.sh-card').forEach((b) => b.classList.toggle('on', b.dataset.id === cur));
  }
  closeWardrobe() { this.$ward.hidden = true; }

  // ---------------- per frame ----------------
  update(dt, input) {
    this.time += dt;
    const I = input.sample(dt);
    if (!this.$ward.hidden) { I.move.x = I.move.y = 0; I.jump = false; I.dodge = 0; }
    this.camYaw -= I.lookX * 0.006;
    this.camPitch = THREE.MathUtils.clamp(this.camPitch + I.lookY * 0.004, -0.5, 1.2);
    this.camDist = THREE.MathUtils.clamp(this.camDist * I.zoom, 1.8, 9);
    if (this.wardrobeRing) this.wardrobeRing.scale.setScalar(1 + Math.sin(this.time * 3) * 0.03);

    const P = this.ctrl;
    if (!P) { this.camera.position.set(0, 2, this.area.spawn.pos.z + 4); this.camera.lookAt(this.area.spawn.pos.x, 1.4, this.area.spawn.pos.z); return; }
    P.update(dt, I, { boxes: this.area.boxes, camYaw: this.camYaw, killY: this.area.killY, spawn: this.area.spawn });

    // interaction prompt
    let near = null;
    for (const it of this.area.interact) if (_v.copy(it.pos).setY(P.pos.y).distanceTo(P.pos) < it.r && Math.abs(P.pos.y - it.pos.y) < 2) near = it;
    if (near !== this.near) {
      this.near = near;
      this.$prompt.hidden = !near;
      if (near) this.$prompt.innerHTML = `<kbd>E</kbd> ${near.text}`;
    }
    if (near && I.dodge) this.act(near.act);

    // sun shadows follow the player in the sim
    if (this.area === this.sim) { this.sun.position.set(P.pos.x + 30, 60, P.pos.z - 20); this.sun.target.position.copy(P.pos); }

    // third-person camera, pulled in when something is between it and the character
    const head = _v.copy(P.pos).add(_v2.set(0, P.H * 0.88, 0));
    const cp = this.camPitch;
    const want = _v2.set(Math.sin(this.camYaw) * Math.cos(cp), Math.sin(cp), Math.cos(this.camYaw) * Math.cos(cp));
    this.ray.set(head, want); this.ray.far = this.camDist;
    const hit = this.ray.intersectObjects(this.area.meshes, false)[0];
    const dist = hit ? Math.max(0.2, hit.distance - 0.25) : this.camDist;
    const target = want.multiplyScalar(dist).add(head);
    if (this.snapCam) { this.camera.position.copy(target); this.snapCam = false; }
    else this.camera.position.lerp(target, 1 - Math.exp(-14 * dt));
    this.camera.lookAt(head);
  }
}
