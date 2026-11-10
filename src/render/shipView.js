import * as THREE from 'three';
import { VrmChar, CHARACTERS, SWATCHES, applyColours } from './chars/vrmChar.js';
import { Parkour } from './chars/parkour.js';
import { MechPilot } from './mech/mechPilot.js';
import { FRAMES, loadFrame, saveFrame } from './mech/frames.js';
import { SwordFx } from './mech/swordFx.js';
import { HumanSword } from './chars/katana.js';
import { KitHud } from '../ui/kitHud.js';
import { SparBots } from './chars/sparBots.js';
import { GunView, ADS_FOV } from './chars/gunView.js';
import { worldOfBoxes } from './chars/bullets.js';
import { KitTutorial } from '../ui/kitTutorial.js';
import { LunarArena, ARENA } from './arena.js';
import { S as MECH_S } from './mech/mechRig.js';
import { gridTexture, floorTexture, deckTexture, wallTexture, hexStoneTextures, worldBox, concreteTexture, pavingTexture, facadeTexture, brickTexture, ladderTexture } from './chars/simTextures.js';

// Inside the mothership: you dock with the station and walk it as one of the playable characters.
// Hangar deck: a long hall whose whole outer wall is glass, the airlock back to space, the door to the training
// sim and a side door into the wardrobe (character select). Down a short corridor is the command deck, glass on
// three sides and overhead, with the helm. The windows show the live orbit scene (LocalView): it is rendered every
// frame from the station with the camera's own orientation and sampled in screen space, so Earth, the Sun, the
// stars, drones and your parked ship sit where they really are, at infinity, with no fake backdrop.
// Training sim: a holographic gray-box course for parkour, plus a mech yard with training dummies where you can
// take the NEXORION mech out.

const CHAR_KEY = 'openspace_char', MECH_KEY = 'openspace_sim_mech', LOOK_KEY = 'openspace_look';
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4();
const _size = new THREE.Vector2();
// deck-frame basis around NADIR (about 52° off straight down, toward the hangar windows and the bridge's front glass)
const NADIR = new THREE.Vector3(0.5, -0.62, -0.6).normalize();
const DECK_FRAME_INV = (() => {
  const b = new THREE.Vector3().crossVectors(NADIR, new THREE.Vector3(0, 0, 1)).normalize();
  const c = new THREE.Vector3().crossVectors(NADIR, b);
  return new THREE.Matrix4().makeBasis(NADIR, b, c).transpose();
})();
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

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

// a console screen: readouts drawn once
function screenTexture(seed, tint = '#58e4ff') {
  const c = document.createElement('canvas'); c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#04121a'; g.fillRect(0, 0, 256, 128);
  let r = seed;
  const rand = () => { r = (r * 16807) % 2147483647; return r / 2147483647; };
  g.strokeStyle = tint; g.fillStyle = tint; g.lineWidth = 2;
  g.beginPath();
  for (let x = 0; x < 120; x += 4) g.lineTo(8 + x, 70 - Math.sin(x * 0.08 + seed) * 18 - rand() * 8);
  g.stroke();
  for (let i = 0; i < 6; i++) g.fillRect(140, 14 + i * 17, 20 + rand() * 90, 8);
  g.globalAlpha = 0.5; g.strokeRect(4, 4, 248, 120);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Holographic sparring for the mech yard: the lunar arena's enemy waves (lancers, gunners, brutes with telegraphed
// attacks, parries and dodges) projected by the sim. Nothing here pays out or counts toward your arena record.
class HoloArena extends LunarArena {
  pay() {}
  end(reason) {
    const st = this.view.app.state.stats, best = st.arenaBest;
    super.end(reason);
    st.arenaBest = best;
  }
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
    if (collide) { this.collider(x, y, z, w, h, d, kind); this.meshes.push(m); }
    return m;
  }
  collider(x, y, z, w, h, d, kind = 'solid') {
    this.boxes.push({ min: new THREE.Vector3(x, y, z), max: new THREE.Vector3(x + w, y + h, z + d), kind });
  }
}

export class ShipView {
  constructor(app) {
    this.app = app;
    this.camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 2000);
    this.camYaw = Math.PI; this.camPitch = 0.22; this.camDist = 4.2; this.mechDist = 20;
    this.char = null; this.ctrl = null; this.loading = null;
    this.mech = null; this.mechActive = false;
    this.simMech = store.get(MECH_KEY) === '1';
    try { this.looks = JSON.parse(store.get(LOOK_KEY) || '{}') || {}; } catch { this.looks = {}; }
    this.helm = false;
    this.time = 0;
    this.hex = hexStoneTextures();
    // the view out of the windows
    this.spaceRT = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType });
    this.spaceCam = new THREE.PerspectiveCamera(60, 1, 0.5, 30000);
    this.windowMat = new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      uniforms: { tSpace: { value: this.spaceRT.texture }, res: { value: new THREE.Vector2(1, 1) } },
      vertexShader: 'void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform sampler2D tSpace; uniform vec2 res;
        void main(){
          vec3 c = texture2D(tSpace, gl_FragCoord.xy / res).rgb;
          gl_FragColor = vec4(c * 0.96 + vec3(0.004, 0.007, 0.012), 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.deck = this.buildDeck();
    this.sim = this.buildSim();
    this.area = this.deck;
    this.scene = this.deck.scene;
    this.ray = new THREE.Raycaster();
    this.buildHud();
  }

  get scenes() { return [this.deck.scene, this.sim.scene]; }

  // a glass pane looking into space: a plane at the given centre, facing `normal` (into the room)
  pane(A, cx, cy, cz, w, h, normal) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), this.windowMat);
    m.position.set(cx, cy, cz);
    m.lookAt(_v.set(cx, cy, cz).add(normal));
    A.scene.add(m);
    A.meshes.push(m);
    return m;
  }

  // ---------------- the station interior ----------------
  buildDeck() {
    const A = new Area('deck'), S = A.scene;
    S.background = new THREE.Color(0x020306);
    const floor = new THREE.MeshStandardMaterial({ map: deckTexture(), metalness: 0.6, roughness: 0.45 });
    const wall = new THREE.MeshStandardMaterial({ map: wallTexture(), metalness: 0.4, roughness: 0.6 });
    const trim = new THREE.MeshStandardMaterial({ color: 0x1a1e25, metalness: 0.8, roughness: 0.35 });
    const glow = new THREE.MeshStandardMaterial({ color: 0x0b1c24, emissive: 0x58e4ff, emissiveIntensity: 1.3 });
    const amber = new THREE.MeshStandardMaterial({ color: 0x241808, emissive: 0xffb040, emissiveIntensity: 2.2 });
    const pink = new THREE.MeshStandardMaterial({ color: 0x24101c, emissive: 0xff6ec7, emissiveIntensity: 1.4 });
    const W = 14, L = 44, H = 7;
    const X0 = -W / 2, X1 = W / 2, Z0 = -L / 2, Z1 = L / 2;

    // ===== hangar hall =====
    A.box(X0, -0.5, Z0, W, 0.5, L, floor, { tile: 4 });
    A.box(X0, H, Z0, W, 0.5, L, trim, { tile: 4, shadow: false });
    // outer (+x) wall: one long window from knee height to the ceiling, mullions every 5 m
    A.box(X1, 0, Z0, 0.5, 0.4, L, wall, { tile: 4, collide: false });
    A.box(X1, 6.6, Z0, 0.5, 0.4, L, wall, { tile: 4, collide: false });
    A.box(X1, 0, Z0, 0.5, H, 2, wall, { tile: 4, collide: false });
    A.box(X1, 0, Z1 - 2, 0.5, H, 2, wall, { tile: 4, collide: false });
    A.collider(X1, 0, Z0, 0.5, H, L);
    this.pane(A, X1 + 0.15, 3.5, 0, L - 4, 6.2, _v2.set(-1, 0, 0));
    for (let z = -15; z <= 15; z += 5) A.box(X1 - 0.15, 0.4, z - 0.12, 0.3, 6.2, 0.24, trim, { collide: false });
    A.box(X1 - 0.6, 0, Z0 + 2, 0.6, 0.9, L - 4, trim);                       // window ledge
    // inner (-x) wall with the wardrobe door (z 6.5..9.5)
    A.box(X0 - 0.5, 0, Z0, 0.5, H, 6.5 - Z0, wall, { tile: 4 });
    A.box(X0 - 0.5, 0, 9.5, 0.5, H, Z1 - 9.5, wall, { tile: 4 });
    A.box(X0 - 0.5, 3.6, 6.5, 0.5, H - 3.6, 3, wall, { tile: 4 });
    A.box(X0 - 0.1, 3.6, 6.3, 0.2, 0.2, 3.4, pink, { collide: false, shadow: false });
    const wdl = label('WARDROBE', '', '#ff9edb'); wdl.position.set(X0 + 0.3, 4.3, 8); wdl.scale.set(3, 0.75, 1); S.add(wdl);
    // near end: airlock
    A.box(X0, 0, Z1, W, H, 0.5, wall, { tile: 4 });
    A.box(-2.5, 0, Z1 - 0.35, 5, 4.6, 0.3, amber, { tile: 2 });
    const al = label('AIRLOCK', 'back to space · EVA', '#ffc46a'); al.position.set(0, 5.6, Z1 - 1); S.add(al);
    A.interact.push({ pos: new THREE.Vector3(0, 0, Z1 - 1.5), r: 3, text: 'Cycle the airlock · back to space', act: 'exit' });
    // far end: opening to the command deck corridor (x -3..3, up to 4.5 m)
    A.box(X0, 0, Z0 - 0.5, 4, H, 0.5, wall, { tile: 4 });
    A.box(3, 0, Z0 - 0.5, 4, H, 0.5, wall, { tile: 4 });
    A.box(-3, 4.5, Z0 - 0.5, 6, H - 4.5, 0.5, wall, { tile: 4 });
    const cl = label('COMMAND DECK', ''); cl.position.set(0, 5.4, Z0 + 0.4); cl.scale.set(3.2, 0.8, 1); S.add(cl);
    // training sim gate set into the inner wall
    const hexMat = new THREE.MeshStandardMaterial({ map: this.hex.map, emissiveMap: this.hex.emissive, emissive: 0xffffff, emissiveIntensity: 1.6, bumpMap: this.hex.bump, bumpScale: 3, roughness: 0.35, metalness: 0.1 });
    A.box(X0, 0, -15, 0.3, 5, 6, hexMat, { tile: 2 });
    A.box(X0, 0, -15.6, 0.6, 5.6, 0.6, trim); A.box(X0, 0, -9, 0.6, 5.6, 0.6, trim); A.box(X0, 5, -15.6, 0.6, 0.6, 7.2, trim);
    const sl = label('TRAINING SIM', 'holo course · mech yard'); sl.position.set(X0 + 1.2, 6.3, -12); S.add(sl);
    A.interact.push({ pos: new THREE.Vector3(X0 + 1.6, 0, -12), r: 2.8, text: 'Enter the training sim', act: 'sim' });
    // light strips, pillars, crates
    for (const x of [-3, 3]) A.box(x - 0.15, H - 0.08, Z0 + 1, 0.3, 0.08, L - 2, glow, { collide: false, shadow: false });
    A.box(X0 + 0.05, 0.02, Z0 + 1, 0.3, 0.06, L - 2, glow, { collide: false, shadow: false });
    for (const z of [-19, -5, 3, 13]) A.box(X0, 0, z - 0.5, 0.8, H, 1, trim);
    A.box(-6.3, 0, 16, 1.4, 1.2, 1.4, trim); A.box(-6.4, 1.2, 16.2, 1.1, 0.9, 1.1, trim); A.box(-4.6, 0, 17.5, 1.2, 0.8, 1.2, trim);

    // ===== wardrobe room (x -17..-7.5, z 3..14) =====
    const WX0 = -17, WX1 = X0 - 0.5, WZ0 = 3, WZ1 = 14, WH = 4.5;
    A.box(WX0, -0.5, WZ0, WX1 - WX0, 0.5, WZ1 - WZ0, floor, { tile: 4 });
    A.box(WX0, WH, WZ0, WX1 - WX0, 0.5, WZ1 - WZ0, trim, { shadow: false });
    A.box(WX0 - 0.5, 0, WZ0 - 0.5, 0.5, WH, WZ1 - WZ0 + 1, wall, { tile: 4 });
    A.box(WX0, 0, WZ0 - 0.5, WX1 - WX0, WH, 0.5, wall, { tile: 4 });
    A.box(WX0, 0, WZ1, WX1 - WX0, WH, 0.5, wall, { tile: 4 });
    const mirror = new THREE.MeshStandardMaterial({ color: 0xdfe8f0, metalness: 1, roughness: 0.04 });
    A.box(WX0 + 1, 0.3, WZ1 - 0.12, 4, 3.6, 0.1, mirror, { collide: false });
    for (let i = 0; i < 2; i++) {
      const rz = WZ0 + 1.2 + i * 6.8;
      A.box(WX0 + 0.3, 2.6, rz, 0.08, 0.08, 2.4, trim, { collide: false });
      const cols = [0x2a1d3a, 0xd7d9de, 0x14161b, 0x7a1830, 0x24344f, 0xe0b0c8];
      for (let k = 0; k < 6; k++) {
        const m = new THREE.MeshStandardMaterial({ color: cols[(k + i * 2) % 6], roughness: 0.8 });
        A.box(WX0 + 0.12, 1.2, rz + 0.1 + k * 0.38, 0.45, 1.35, 0.3, m, { collide: false });
      }
      A.collider(WX0, 0, rz, 0.8, 2.8, 2.4);
    }
    A.box(WX0 + 0.05, WH - 0.1, WZ0 + 0.5, 0.08, 0.06, WZ1 - WZ0 - 1, pink, { collide: false, shadow: false });
    const ped = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.3, 0.3, 32), trim);
    const PX = -12, PZ = 8.5;
    ped.position.set(PX, 0.15, PZ); S.add(ped);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.15, 0.04, 8, 48), pink);
    ring.rotation.x = Math.PI / 2; ring.position.set(PX, 0.32, PZ); S.add(ring);
    this.wardrobeRing = ring;
    this.pedestal = new THREE.Vector3(PX, 0.3, PZ);
    const wl = label('WARDROBE', 'choose your character', '#ff9edb'); wl.position.set(PX, 3.4, PZ); S.add(wl);
    A.collider(PX - 1.3, 0, PZ - 1.3, 2.6, 0.3, 2.6);
    A.interact.push({ pos: new THREE.Vector3(PX, 0, PZ), r: 2.8, text: 'Change character', act: 'wardrobe' });
    const wlight = new THREE.PointLight(0xffb0e0, 9, 12, 1.6); wlight.position.set(PX, 3.8, PZ); S.add(wlight);

    // ===== corridor (x -3..3, z -26..-22) =====
    A.box(-3, -0.5, -26, 6, 0.5, 4, floor, { tile: 4 });
    A.box(-3.5, 0, -26, 0.5, 4.5, 4, wall, { tile: 4 }); A.box(3, 0, -26, 0.5, 4.5, 4, wall, { tile: 4 });
    A.box(-3, 4.5, -26, 6, 0.5, 4, trim, { shadow: false });
    A.box(-0.15, 4.42, -26, 0.3, 0.08, 4, glow, { collide: false, shadow: false });

    // ===== command deck (x -10..10, z -42..-26) =====
    const CX0 = -10, CX1 = 10, CZ0 = -42, CZ1 = -26, CH = 8;
    A.box(CX0, -0.5, CZ0, CX1 - CX0, 0.5, CZ1 - CZ0, floor, { tile: 4 });
    // back wall with the doorway
    A.box(CX0, 0, CZ1, 7, CH, 0.5, wall, { tile: 4 }); A.box(3, 0, CZ1, 7, CH, 0.5, wall, { tile: 4 });
    A.box(-3, 4.5, CZ1, 6, CH - 4.5, 0.5, wall, { tile: 4 });
    // front: glass from 0.8 m to the ceiling
    A.box(CX0, 0, CZ0 - 0.5, CX1 - CX0, 0.8, 0.5, wall, { tile: 4, collide: false });
    A.collider(CX0, 0, CZ0 - 0.5, CX1 - CX0, CH, 0.5);
    this.pane(A, 0, 4.4, CZ0 - 0.25, CX1 - CX0, 7.2, _v2.set(0, 0, 1));
    // sides: glass for most of their length
    for (const [x, n] of [[CX0 - 0.5, 1], [CX1, -1]]) {
      A.box(x, 0, CZ0, 0.5, 1, CZ1 - CZ0, wall, { tile: 4, collide: false });
      A.box(x, 0, CZ1 - 2, 0.5, CH, 2, wall, { tile: 4, collide: false });
      A.collider(x, 0, CZ0, 0.5, CH, CZ1 - CZ0);
      this.pane(A, x + 0.25, 4.5, (CZ0 + CZ1 - 2) / 2, CZ1 - 2 - CZ0, 7, _v2.set(n, 0, 0));
    }
    // ceiling with a skylight
    A.box(CX0, CH, CZ1 - 4, CX1 - CX0, 0.5, 4, trim, { shadow: false });
    A.box(CX0, CH, CZ0, 3, 0.5, CZ1 - 4 - CZ0, trim, { shadow: false });
    A.box(CX1 - 3, CH, CZ0, 3, 0.5, CZ1 - 4 - CZ0, trim, { shadow: false });
    this.pane(A, 0, CH + 0.2, (CZ0 + CZ1 - 4) / 2, CX1 - CX0 - 6, CZ1 - 4 - CZ0, _v2.set(0, -1, 0));
    for (let x = -4.5; x <= 4.5; x += 3) A.box(x - 0.1, CH - 0.15, CZ0, 0.2, 0.3, CZ1 - 4 - CZ0, trim, { collide: false });
    for (let x = -7.5; x <= 7.5; x += 3.75) A.box(x - 0.1, 0.8, CZ0 - 0.2, 0.2, 7.2, 0.2, trim, { collide: false });
    // consoles: two arcs of desks with screens
    let seed = 3;
    for (const [r, n] of [[5.5, 7], [8.5, 9]]) {
      for (let i = 0; i < n; i++) {
        const a = -0.95 + (1.9 * i) / (n - 1);
        const cx = Math.sin(a) * r, cz = -30 - Math.cos(a) * r * 0.75;
        if (r < 6 && Math.abs(cx) < 1.2) continue;           // aisle to the window
        const desk = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.75, 0.8), trim);
        desk.position.set(cx, 0.375, cz); desk.rotation.y = -a; desk.castShadow = true; S.add(desk);
        const scr = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 0.62), new THREE.MeshBasicMaterial({ map: screenTexture(seed++), toneMapped: false }));
        scr.position.set(cx + Math.sin(a) * 0.05, 1.0, cz + Math.cos(a) * 0.05); scr.rotation.set(-0.6, -a, 0, 'YXZ'); S.add(scr);
        A.collider(cx - 0.6, 0, cz - 0.6, 1.2, 0.75, 1.2);
      }
    }
    // helm chair and a holo globe of the world below
    const chair = new THREE.Group();
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.18, 0.9), trim); seat.position.y = 0.6;
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.3, 0.16), trim); back.position.set(0, 1.25, 0.42);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.25, 0.6, 12), trim); stem.position.y = 0.3;
    chair.add(seat, back, stem); chair.position.set(0, 0, -30.5); S.add(chair);
    A.collider(-0.45, 0, -31, 0.9, 0.7, 1);
    this.helmSeat = new THREE.Vector3(0, 1.45, -30.5);
    A.interact.push({ pos: new THREE.Vector3(0, 0, -29.6), r: 1.6, text: 'Take the helm · look out', act: 'helm' });
    const globe = new THREE.Mesh(new THREE.SphereGeometry(0.55, 32, 16), new THREE.MeshBasicMaterial({ color: 0x3aa8ff, wireframe: true, transparent: true, opacity: 0.6, toneMapped: false }));
    globe.position.set(0, 1.6, -38.5); S.add(globe);
    this.globe = globe;
    const gbase = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.75, 0.9, 24), trim); gbase.position.set(0, 0.45, -38.5); S.add(gbase);
    A.collider(-0.75, 0, -39.25, 1.5, 0.9, 1.5);
    const bl = label('COMMAND DECK', ''); bl.position.set(0, 6.6, CZ1 - 1); bl.scale.set(3.2, 0.8, 1); S.add(bl);

    // ===== lights =====
    S.add(new THREE.HemisphereLight(0x9fc8ff, 0x1a1c22, 0.45));
    for (const z of [-14, 0, 14]) { const l = new THREE.PointLight(0xbfe8ff, 12, 20, 1.6); l.position.set(-2, H - 0.6, z); S.add(l); }
    const cdl = new THREE.PointLight(0x9fd4ff, 10, 22, 1.6); cdl.position.set(0, 5.5, -32); S.add(cdl);
    const key = new THREE.DirectionalLight(0xdfeeff, 1.0);
    key.position.set(10, 16, 6); key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    Object.assign(key.shadow.camera, { left: -26, right: 26, top: 46, bottom: -46, near: 1, far: 60 });
    key.target.position.set(-4, 0, -10);
    key.shadow.bias = -0.0005;
    S.add(key, key.target);
    A.spawn.pos.set(0, 0, Z1 - 6); A.spawn.yaw = Math.PI;
    A.title = 'HANGAR DECK';
    A.zoneTitle = (p) => (p.z < -22 ? 'COMMAND DECK' : p.x < X0 ? 'WARDROBE' : 'HANGAR DECK');
    return A;
  }

  // ---------------- the training sim ----------------
  buildSim() {
    const A = new Area('sim'), S = A.scene;
    const sky = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16), new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false,
      uniforms: { top: { value: new THREE.Color(0x3d7fd6) }, hor: { value: new THREE.Color(0xd8ecff) } },
      vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'uniform vec3 top, hor; varying vec3 vP; void main(){ float h = clamp(vP.y, 0.0, 1.0); gl_FragColor = vec4(mix(hor, top, pow(h, 0.55)), 1.0); }',
    }));
    S.add(sky);
    const cc = document.createElement('canvas'); cc.width = cc.height = 128;
    const cg = cc.getContext('2d'), grd = cg.createRadialGradient(64, 64, 4, 64, 64, 64);
    grd.addColorStop(0, 'rgba(255,255,255,0.95)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
    cg.fillStyle = grd; cg.fillRect(0, 0, 128, 128);
    const cloudMat = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cc), transparent: true, depthWrite: false, fog: false });
    for (let i = 0; i < 40; i++) {
      const s = new THREE.Sprite(cloudMat);
      const a = (i / 40) * Math.PI * 2 + Math.random() * 0.3, r = 300 + Math.random() * 260;
      s.position.set(40 + Math.cos(a) * r, 40 + Math.random() * 90, Math.sin(a) * r);
      s.scale.set(90 + Math.random() * 90, 30 + Math.random() * 20, 1);
      S.add(s);
    }
    S.fog = new THREE.Fog(0xd8ecff, 140, 650);

    // a city block: cast-concrete walls, stone paving, brick for the walls you run along, steel ladder frames for
    // the ones you climb, and buildings all around
    const concrete = new THREE.MeshStandardMaterial({ map: concreteTexture(), roughness: 0.92 });
    const ground = new THREE.MeshStandardMaterial({ map: floorTexture(), roughness: 0.9 });
    const runMat = new THREE.MeshStandardMaterial({ map: brickTexture(), roughness: 0.9 });
    const climbMat = new THREE.MeshStandardMaterial({ map: ladderTexture(), roughness: 0.5, metalness: 0.6 });
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x2c2f35, roughness: 0.95 });
    const fronts = [['#6f7480', 0.3, 41], ['#8a7566', 0.22, 52], ['#55606e', 0.4, 63], ['#7d8086', 0.15, 74]].map(([c, l, sd]) => {
      const f = facadeTexture(c, l, sd);
      return new THREE.MeshStandardMaterial({ map: f.map, emissiveMap: f.emissive, emissive: 0xffffff, emissiveIntensity: 0.45, roughness: 0.85 });
    });
    // a building: storeys of windows under a flat roof. Solid all the way through, and you can stand on the roof
    const building = (x, z, w, d, h, look = 0) => {
      A.box(x, 0, z, w, h, d, fronts[look % fronts.length], { tile: 4 });
      A.box(x, h, z, w, 0.4, d, roofMat, {});
    };
    const pad = new THREE.MeshStandardMaterial({ color: 0x0f2230, emissive: 0x3fd8ff, emissiveIntensity: 1.6 });
    const amberPad = new THREE.MeshStandardMaterial({ color: 0x2a1a06, emissive: 0xffa030, emissiveIntensity: 1.6 });
    const T = 1;

    A.box(-90, -1, -70, 270, 1, 200, ground, { tile: T });

    // ===== parkour course (panels sit nearly flush with their walls so nothing catches on their edges) =====
    for (let i = 0; i < 4; i++) A.box(1 + i * 1.6, 0, -9, 1.6, 0.5 + i * 0.5, 3, concrete, { tile: 3 });
    A.box(-3, 0, 18, 6, 10, 6, concrete, { tile: 3 });
    A.box(-1.5, 0, 17.95, 3, 10, 0.25, climbMat, { kind: 'climb', tile: 1.5 });
    A.box(-1.25, 8.8, 24, 2.5, 1.2, 17, runMat, { kind: 'run', tile: 3 });
    A.box(-3, 0, 41, 6, 10, 6, concrete, { tile: 3 });
    A.box(2.8, 0, 42.5, 0.25, 10, 3, climbMat, { kind: 'climb', tile: 1.5 });
    A.box(9, 0, 0, 1, 7, 34, concrete, { tile: 3 });
    A.box(8.95, 1.4, 3, 0.25, 4.6, 28, runMat, { kind: 'run', tile: 3 });
    A.box(10, 0, 32, 6, 3.5, 6, concrete, { tile: 3 });
    A.box(-10, 0, 4, 1, 8, 30, concrete, { tile: 3 });
    A.box(-9.2, 1.6, 7, 0.25, 4.8, 24, runMat, { kind: 'run', tile: 3 });
    for (const [x, y, z] of [[-6, 1.6, 8], [-6.5, 3, 13], [-5.5, 4.4, 18], [-6.2, 5.8, 23]]) A.box(x, y, z, 2, 0.5, 2, concrete, { tile: 3 });
    A.box(-24, 0, 26, 5, 16, 5, concrete, { tile: 3 });
    A.box(-19.2, 0, 27, 0.25, 16, 3, climbMat, { kind: 'climb', tile: 1.5 });
    A.box(-23, 14.8, 31, 3, 1.2, 26, runMat, { kind: 'run', tile: 3 });
    A.box(-25, 0, 57, 5, 16, 5, concrete, { tile: 3 });
    for (let i = 0; i < 6; i++) A.box(16 + (i % 2) * 3, 1 + i * 1.3, 8 + i * 4, 3, 0.6, 3, concrete, { tile: 3 });
    const exitPad = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 0.08, 40), pad);
    exitPad.position.set(22, 0.04, -17); S.add(exitPad);
    const el = label('EXIT SIM', 'back to the deck'); el.position.set(22, 2.6, -17); S.add(el);
    A.interact.push({ pos: new THREE.Vector3(22, 0, -17), r: 2, text: 'Leave the sim · back to the deck', act: 'deck' });
    const pk = label('PARKOUR COURSE', 'climb · wall run · ledges'); pk.position.set(12, 5, -4); pk.scale.set(6, 1.5, 1); S.add(pk);
    const hint = label('CLIMB', 'push into the ladder wall'); hint.position.set(0, 3.2, 16.8); S.add(hint);
    const hint2 = label('WALL RUN', 'sprint beside it · jump at it'); hint2.position.set(6.5, 3.4, 4); S.add(hint2);

    // ===== wall-run gauntlet: alternating glowing walls between two raised platforms; wall-jump from one to the next =====
    for (let i = 0; i < 3; i++) A.box(44, 0, 3 + i * 1.6, 4, 1 + i, 1.6, concrete, { tile: 3 });     // stairs up
    A.box(40, 0, 7.8, 12, 4, 5, concrete, { tile: 3 });                                                // start platform (top 4 m)
    A.box(40, 0, 14, 1, 9, 12, concrete, { tile: 3 }); A.box(40.8, 2.4, 15, 0.25, 5, 10, runMat, { kind: 'run', tile: 3 });   // left
    A.box(47, 0, 22, 1, 9, 12, concrete, { tile: 3 }); A.box(46.95, 2.4, 23, 0.25, 5, 10, runMat, { kind: 'run', tile: 3 });  // right
    A.box(40, 0, 30, 1, 9, 12, concrete, { tile: 3 }); A.box(40.8, 2.4, 31, 0.25, 5, 10, runMat, { kind: 'run', tile: 3 });   // left
    A.box(40, 0, 44, 12, 4, 5, concrete, { tile: 3 });                                                 // finish platform
    const gl = label('WALL RUN GAUNTLET', 'run the right wall · jump across to the next'); gl.position.set(46, 6.4, 9); gl.scale.set(6, 1.5, 1); S.add(gl);
    const gl2 = label('FINISH', ''); gl2.position.set(46, 6, 46.5); S.add(gl2);
    A.box(-3, 0, 8, 6, 2.2, 1, concrete, { tile: 3 });                                                // a 2.2 m wall to run up and over
    const hint3 = label('LEDGE', 'sprint into it to run up and climb over'); hint3.position.set(0, 3.4, 7.6); S.add(hint3);

    // ===== mech bay and the mech yard =====
    const bayPad = new THREE.Mesh(new THREE.CylinderGeometry(2, 2, 0.08, 40), amberPad);
    bayPad.position.set(38, 0.04, -17); S.add(bayPad);
    const bl = label('MECH BAY', 'board your mech', '#ffc46a'); bl.position.set(38, 3, -17); S.add(bl);
    A.interact.push({ pos: new THREE.Vector3(38, 0, -17), r: 2.4, text: 'Board your mech', act: 'mech' });
    this.bayPos = new THREE.Vector3(38, 0, -14);
    const YC = new THREE.Vector3(110, 0, 10);
    this.yard = { center: YC, R: 46 };
    const yl = label('MECH YARD', 'dummies · Enter: holo sparring', '#ffc46a'); yl.position.set(YC.x - 40, 8, YC.z); yl.scale.set(12, 3, 1); S.add(yl);
    // training dummies: posts that wobble when struck, burst when broken and come back
    this.dummies = [];
    const postMat = new THREE.MeshStandardMaterial({ map: concreteTexture('#6c7078'), roughness: 0.7, metalness: 0.3 });
    const headMat = new THREE.MeshStandardMaterial({ color: 0x0f2230, emissive: 0x3fd8ff, emissiveIntensity: 1.2 });
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2, r = i % 2 ? 26 : 16;
      const g = new THREE.Group();
      const post = new THREE.Mesh(worldBox(1.6, 4.6, 1.6, 1), postMat); post.position.y = 2.3; post.castShadow = true;
      const head = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.7, 2.4), headMat); head.position.y = 5.4; head.castShadow = true;
      const arm = new THREE.Mesh(worldBox(5.5, 0.7, 0.7, 1), postMat); arm.position.y = 3.6; arm.castShadow = true;
      g.add(post, head, arm);
      g.position.set(YC.x + Math.cos(a) * r, 0, YC.z + Math.sin(a) * r);
      g.rotation.y = -a;
      S.add(g);
      this.dummies.push({ group: g, pos: g.position, radius: 2, height: 6, alive: true, hp: 60, maxHp: 60, wobble: 0, respawnAt: 0 });
    }

    // ===== dojo: human-scale dummies for katana practice =====
    this.simFx = new SwordFx(S);
    this.dojo = [];
    const dl = label('PRACTICE RANGE', 'follow the tutorial · sword, pistol and abilities'); dl.position.set(30, 4.2, 1); dl.scale.set(6, 1.5, 1); S.add(dl);
    // a low wall behind the targets and two side walls frame the range
    A.box(20, 0, 3.5, 20, 3, 0.8, concrete, { tile: 3 });
    A.box(19.2, 0, -6, 0.8, 1.2, 9.5, concrete, { tile: 3 }); A.box(40, 0, -6, 0.8, 1.2, 9.5, concrete, { tile: 3 });
    const dojoPad = new THREE.Mesh(new THREE.CylinderGeometry(8, 8, 0.05, 48), new THREE.MeshStandardMaterial({ color: 0x33373d, roughness: 0.9 }));
    dojoPad.position.set(30, 0.025, -6); dojoPad.receiveShadow = true; S.add(dojoPad);
    const wood = new THREE.MeshStandardMaterial({ color: 0xb08356, roughness: 0.8 });
    const straw = new THREE.MeshStandardMaterial({ color: 0xd6c08a, roughness: 0.95 });
    for (let i = 0; i < 5; i++) {
      const a = -0.9 + i * 0.45, r = 4.5;
      const g = new THREE.Group();
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 1.9, 10), wood); post.position.y = 0.95;
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.9, 12), straw); body.position.y = 1.25;
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 8), straw); head.position.y = 1.9;
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.1, 8), wood); arm.rotation.z = Math.PI / 2; arm.position.y = 1.45;
      for (const m of [post, body, head, arm]) { m.castShadow = true; g.add(m); }
      g.position.set(30 + Math.sin(a) * r, 0, -6 + Math.cos(a) * r);
      g.rotation.y = a + Math.PI;
      S.add(g);
      const d = { group: g, pos: g.position, radius: 0.35, height: 2, alive: true, hp: 60, maxHp: 60, wobble: 0, respawnAt: 0, small: true };
      d.hit = (dmg, dir) => this.damageDummy(d, dmg, this.simFx, dir);
      this.dojo.push(d);
    }

    // ===== rooftop run: a street of buildings to climb and leap across (each one solid, none touching) =====
    building(-60, 70, 14, 14, 8, 0); building(-42, 70, 12, 14, 12, 1); building(-26, 72, 14, 12, 12, 2);
    building(-8, 70, 12, 14, 16, 3); building(8, 70, 14, 14, 12, 0);
    A.box(-55, 0, 69.75, 3, 8.4, 0.25, climbMat, { kind: 'climb', tile: 1.5 });                  // the way up
    const rl = label('ROOFTOP RUN', 'climb the ladder · leap roof to roof'); rl.position.set(-53.5, 4, 67); rl.scale.set(6, 1.5, 1); S.add(rl);
    const rf = label('FINISH', ''); rf.position.set(15, 15, 77); S.add(rf);

    // ===== dash course: gaps a jump will not clear, and ledges a dash carries you up =====
    A.box(-40, 0, -34, 4, 3, 6, concrete, { tile: 3 }); A.box(-51, 0, -34, 4, 3, 6, concrete, { tile: 3 });
    A.box(-62, 0, -34, 4, 4.5, 6, concrete, { tile: 3 }); A.box(-73, 0, -34, 4, 6, 6, concrete, { tile: 3 });
    const dc = label('DASH COURSE', 'E across the gaps · Space + E up the ledges'); dc.position.set(-33, 3.4, -31); dc.scale.set(6, 1.5, 1); S.add(dc);
    const df = label('FINISH', ''); df.position.set(-71, 8.6, -31); S.add(df);

    // ===== battle areas: sparring bots that fight back, in waves =====
    // the pit: a walled square with a gate facing the range
    A.box(19.2, 0, -24, 8.8, 2.5, 0.8, concrete, { tile: 3 }); A.box(32, 0, -24, 8.8, 2.5, 0.8, concrete, { tile: 3 });
    A.box(19.2, 0, -46.8, 21.6, 2.5, 0.8, concrete, { tile: 3 });
    A.box(19.2, 0, -46, 0.8, 2.5, 22, concrete, { tile: 3 }); A.box(40, 0, -46, 0.8, 2.5, 22, concrete, { tile: 3 });
    const pl = label('SPARRING PIT', 'bots fight back · block, dash, cut them down', '#ff9a6a'); pl.position.set(30, 4.2, -24); pl.scale.set(6, 1.5, 1); S.add(pl);
    // the alley: a long walled lane, made for the dash and the Thousand-Fold Slash
    A.box(51.2, 0, -46, 0.8, 3, 36, concrete, { tile: 3 }); A.box(58, 0, -46, 0.8, 3, 36, concrete, { tile: 3 });
    A.box(51.2, 0, -46.8, 7.6, 3, 0.8, concrete, { tile: 3 });
    const al = label('AMBUSH ALLEY', 'a lane of bots · dash and ultimate down the line', '#ff9a6a'); al.position.set(55, 4.6, -10); al.scale.set(6, 1.5, 1); S.add(al);
    this.bots = new SparBots(S, this.simFx, [
      { name: 'SPARRING PIT', rect: [20, 40, -46, -24.5], count: 3, max: 6 },
      { name: 'AMBUSH ALLEY', rect: [52, 58, -46, -11], count: 4, max: 7 },
    ], (Z, n) => this.app.hud?.toast(`${Z.name} · WAVE ${n}`, 'good'));
    this.simTargets = [...this.dojo, ...this.bots.targets];

    S.add(new THREE.HemisphereLight(0xcfe6ff, 0x8a8f96, 1.1));
    const sun = new THREE.DirectionalLight(0xfff2dd, 2.4);
    sun.position.set(30, 60, -20); sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -50, right: 50, top: 50, bottom: -50, near: 1, far: 180 });
    sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02;
    S.add(sun, sun.target);
    this.sun = sun;
    A.spawn.pos.set(30, 0, -13); A.spawn.yaw = 0;
    A.killY = -20;
    A.title = 'TRAINING SIM';
    return A;
  }

  // ---------------- entering / areas ----------------
  enter(baseName = 'EDEN') {
    this.baseName = baseName;
    const craft = this.app.localView.craft;
    if (craft) craft.visible = false;          // you're inside now
    this.go(this.deck);
    this.hud.hidden = false;
    this.ensureChar();
  }
  leave() {
    this.hud.hidden = true; this.closeWardrobe();
    this.gunView.hide(); this.app.input?.setAim?.(false);
    this.stopMech(false); this.setHelm(false);
    const craft = this.app.localView.craft;
    if (craft) craft.visible = true;
  }

  go(area) {
    if (this.area === this.sim && area !== this.sim) this.stopMech(false);
    this.setHelm(false);
    this.area = area;
    this.scene = area.scene;
    if (this.ctrl) { this.ctrl.spawn(area.spawn.pos, area.spawn.yaw); area.scene.add(this.char.root); this.char.root.visible = true; }
    this.camYaw = area.spawn.yaw + Math.PI; this.snapCam = true;
    this.zone = '';
    this.syncButtons();
    if (area === this.sim && this.simMech) this.startMech();
  }

  look(id) { return (this.looks[id] ||= { outfit: null, cloth: null, hair: null }); }
  saveLooks() { store.set(LOOK_KEY, JSON.stringify(this.looks)); }

  // load (or switch to) a character in its saved outfit and colours
  async ensureChar(id = null) {
    id = id || store.get(CHAR_KEY) || CHARACTERS[0].id;
    const def = CHARACTERS.find((c) => c.id === id) || CHARACTERS[0];
    const look = this.look(def.id);
    const outfit = def.outfits.find((o) => o.id === look.outfit) || def.outfits[0];
    const key = `${def.id}:${outfit.id}`;
    if (this.char?.key === key) { applyColours(this.char.vrm, look); return; }
    if (this.loading === key) return;
    this.loading = key;
    this.$load.hidden = false; this.$load.textContent = `LOADING ${def.name.toUpperCase()}…`;
    try {
      const c = await VrmChar.load(def, outfit, (k) => { this.$load.textContent = `LOADING ${def.name.toUpperCase()} · ${Math.round(k * 100)}%`; });
      if (this.loading !== key) { c.dispose(); return; }
      c.key = key;
      applyColours(c.vrm, this.look(def.id));
      const keep = this.ctrl ? { pos: this.ctrl.pos.clone(), yaw: this.ctrl.yaw } : null;
      this.char?.dispose();
      this.char = c;
      this.ctrl = new Parkour(c);
      this.sword?.dispose();
      this.sword = c.katana ? new HumanSword(c, this.simFx, this.sim.scene) : null;
      if (this.sword) { this.sword.flashCb = (col, a) => this.flash(col, a); this.sword.punchCb = (k) => this.punch(k); }
      this.area.scene.add(c.root);
      c.root.visible = !this.mechActive && !this.helm;
      if (keep) this.ctrl.spawn(keep.pos, keep.yaw); else this.ctrl.spawn(this.area.spawn.pos, this.area.spawn.yaw);
      store.set(CHAR_KEY, def.id);
    } catch (e) {
      console.error('character load failed', e);
      this.app.hud?.toast(`Couldn't load ${def.name}`, 'bad');
    }
    this.loading = null;
    this.$load.hidden = true;
  }

  // ---------------- mech in the sim ----------------
  startMech() {
    if (!this.mech) {
      this.mech = new MechPilot(this.sim.scene, { clone: true });
      const A = (this.arena = new HoloArena({
        scene: this.sim.scene, pilot: this.mech, terrain: { height: () => 0 }, app: this.app,
        puff: () => {}, cfg: { g: 9.81 }, ctx: null,
      }));
      A.center.copy(this.yard.center); A.R = this.yard.R;
      A.build(this.sim.scene, () => 0);
      this.mechCtx = {
        g: 9.81, height: () => 0, bound: this.yard.R - 2, center: A.center, camYaw: 0,
        targets: this.dummies, enemies: this.dummies,
        onHit: (t, mv, p) => {
          const c = t.isEnemy ? A.hitEnemy(t, mv, p) : this.hitDummy(t, mv);
          this.punch(mv.heavy || mv.finisher || mv.launch ? 1 : 0.35);
          if (mv.finisher || mv.heavy) this.flash('#ffffff', 0.18);
          return c;
        },
        onDeath: () => A.onPlayerDeath(),
        onPerfect: () => { A.banner('PERFECT DODGE', 'witch time', 0.8); this.flash('#7fd4ff', 0.22); },
        onSpend: () => {},
      };
      A.view.ctx = this.mechCtx;
      this.arenaView = { info: { arena: A.info }, pilot: this.mech, camera: this.camera, arena: A };
    }
    const M = this.mech;
    M.reset();
    M.pos.copy(this.yard.center).add(_v.set(0, 0, -this.yard.R + 8));
    M.yaw = 0;
    M.setVisible(true);
    this.mechActive = true;
    if (this.char) this.char.root.visible = false;
    this.camYaw = Math.PI; this.camPitch = 0.25; this.snapCam = true;
    this.near = null; this.$prompt.hidden = true;
    this.syncButtons();
  }
  stopMech(placeHuman = true) {
    if (!this.mechActive) return;
    if (this.arena?.fighting || this.arena?.state === 'down') this.arena.end('leave');
    this.mechActive = false;
    this.camera.fov = 60; this.camera.updateProjectionMatrix();
    this.mech?.setVisible(false);
    if (this.char) this.char.root.visible = true;
    if (placeHuman && this.ctrl) { this.ctrl.spawn(this.bayPos, 0); this.camYaw = Math.PI; this.snapCam = true; }
    this.syncButtons();
  }
  hitDummy(t, mv) { return this.damageDummy(t, mv.dmg || 10, this.mech.fx); }
  // a dummy takes a hit: wobble away from the blow, burst when broken, come back after a few seconds
  damageDummy(t, dmg, fx, dir = null) {
    t.hp -= dmg;
    t.wobble = 1;
    t.wobbleDir = dir ? Math.atan2(dir.x, dir.z) : 0;
    if (t.hp <= 0 && t.alive) {
      t.alive = false;
      t.group.visible = false;
      t.respawnAt = this.time + 4;
      const s = t.small ? 0.25 : 1;
      fx.sparksAt(_v.copy(t.pos).setY(5 * s), t.small ? 40 : 70, { color: 0xffb040, speed: 24 * s + 4, life: 0.9, floor: 0, width: t.small ? 0.035 : 0.07 });
      fx.ring(_v.copy(t.pos).setY(0.2), 9 * s + 1, { color: 0xffa030, life: 0.6 });
    }
    return 0xffc46a;
  }
  punch(k) { this.fovKick = Math.max(this.fovKick || 0, k); }
  // climbing stamina (shown while it's not full) and the sword-dash charge pips
  updateMeters(P) {
    const st = P.stamina ?? 1, showS = st < 0.995 || (P.state === 'climb' && P.wall?.box.kind !== 'climb');
    if (this.$stam.classList.contains('on') !== showS) this.$stam.classList.toggle('on', showS);
    if (showS) { this.$stamBar.style.width = `${Math.round(st * 100)}%`; this.$stam.classList.toggle('low', st < 0.25); }
    const kit = this.area === this.sim && this.sword && this.$ward.hidden ? this.sword.kit : null;
    this.kitHud.update(kit);
    this.tutorial.update(kit, this.app.hud?.keyboard !== false);
  }
  flash(color, a) {
    const f = this.$impact;
    f.style.transition = 'none'; f.style.background = color; f.style.opacity = a;
    requestAnimationFrame(() => { f.style.transition = 'opacity 0.22s ease-out'; f.style.opacity = 0; });
  }

  // ---------------- helm (seated, looking out of the command deck) ----------------
  setHelm(on) {
    if (this.helm === on) return;
    this.helm = on;
    if (this.char) this.char.root.visible = !on && !this.mechActive;
    if (on) { this.camYaw = 0; this.camPitch = 0.05; }
    else if (this.ctrl) { this.camYaw = 0; this.camPitch = 0.2; this.snapCam = true; }
    this.syncButtons();
  }

  act(a) {
    if (a === 'wardrobe') this.openWardrobe();
    else if (a === 'sim') this.fade(() => this.go(this.sim));
    else if (a === 'deck') this.fade(() => this.go(this.deck));
    else if (a === 'exit') this.fade(() => this.app.setMode('local'));
    else if (a === 'mech') this.fade(() => this.startMech());
    else if (a === 'leaveMech') this.fade(() => this.stopMech(true));
    else if (a === 'spar') { if (this.arena && !this.arena.fighting && this.mech?.alive) this.arena.start(); }
    else if (a === 'helm') this.setHelm(!this.helm);
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
      <div class="sh-btns"><button class="sh-btn" data-act="leaveMech" hidden>⏏ LEAVE MECH <kbd>X</kbd></button><button class="sh-btn" data-act="deck" hidden>⟲ EXIT SIM</button><button class="sh-btn" data-act="helm" hidden>STAND UP <kbd>E</kbd></button><button class="sh-btn spar" data-act="spar" hidden>⚔ START SPARRING <kbd>Enter</kbd></button></div>
      <div class="sh-help"></div>
      <button class="sh-prompt" hidden></button>
      <div class="sh-load" hidden></div>
      <div class="sh-fade"></div>
      <div class="sh-impact"></div>
      <div class="sh-meters"><div class="sh-stam"><i></i></div><div class="sh-charge"><b></b><b></b><b></b></div></div>
      <div class="sh-ward" hidden><div class="sh-card-wrap"><h3>WARDROBE</h3>
        <div class="sh-sec">CHARACTER</div><div class="sh-cards sh-chars"></div>
        <div class="sh-look"><div class="sh-sec">OUTFIT</div><div class="sh-cards sh-outfits"></div>
        <div class="sh-sec">OUTFIT COLOUR</div><div class="sh-sw" data-k="cloth"></div>
        <div class="sh-sec">HAIR COLOUR</div><div class="sh-sw" data-k="hair"></div></div>
        <div class="sh-mechnote" hidden>Mechs are piloted in the training sim's mech yard, and on the surface of other worlds.</div>
        <button class="sh-close">DONE</button></div></div>`;
    document.body.appendChild(el);
    this.hud = el;
    this.$title = el.querySelector('.sh-title');
    this.$help = el.querySelector('.sh-help');
    this.$prompt = el.querySelector('.sh-prompt');
    this.$load = el.querySelector('.sh-load');
    this.$fade = el.querySelector('.sh-fade');
    this.$ward = el.querySelector('.sh-ward');
    this.$btns = el.querySelector('.sh-btns');
    this.$impact = el.querySelector('.sh-impact');
    this.$stam = el.querySelector('.sh-stam'); this.$stamBar = el.querySelector('.sh-stam i');
    this.$charge = el.querySelector('.sh-charge');
    this.kitHud = new KitHud(el);
    this.gunView = new GunView();
    this.tutorial = new KitTutorial(el);
    el.querySelector('.sh-chars').innerHTML = CHARACTERS.map((c) => `
      <button class="sh-card" data-id="${c.id}"><img src="/characters/${c.thumb}" alt=""><b>${c.name}</b><small>${c.blurb}</small></button>`).join('') + FRAMES.map((f) => `
      <button class="sh-card mech" data-id="mech:${f.id}"><div class="sh-mech-pic"><span>${f.name}</span></div><b>${f.name}</b><small>${f.blurb} · mech</small></button>`).join('');
    const swatches = SWATCHES.map((h) => `<button class="sw${h ? '' : ' orig'}" data-c="${h || ''}" style="${h ? `background:${h}` : ''}" title="${h || 'Original'}"></button>`).join('');
    el.querySelectorAll('.sh-sw').forEach((d) => (d.innerHTML = swatches));
    el.querySelector('.sh-chars').addEventListener('click', (e) => {
      const b = e.target.closest('.sh-card');
      if (!b) return;
      if (b.dataset.id.startsWith('mech:')) {
        const id = b.dataset.id.slice(5), f = FRAMES.find((x) => x.id === id);
        this.simMech = true; store.set(MECH_KEY, '1');
        // the frame is yours everywhere: the sim's mech yard and the surface of other worlds
        saveFrame(id);
        this.mech?.setFrame(id);
        this.app.surfaceView?.pilot?.setFrame(id);
        this.app.hud?.toast(`You'll pilot the ${f.name} in the training sim · or board it at the MECH BAY there`, 'good');
      } else {
        this.simMech = false; store.set(MECH_KEY, '0');
        this.wardSel = b.dataset.id;
        this.ensureChar(b.dataset.id);
      }
      this.renderWardrobe();
    });
    el.querySelector('.sh-outfits').addEventListener('click', (e) => {
      const b = e.target.closest('.sh-card');
      if (!b || !this.wardSel) return;
      this.look(this.wardSel).outfit = b.dataset.id; this.saveLooks();
      this.ensureChar(this.wardSel);
      this.renderWardrobe();
    });
    el.querySelectorAll('.sh-sw').forEach((d) => d.addEventListener('click', (e) => {
      const b = e.target.closest('.sw');
      if (!b || !this.wardSel) return;
      this.look(this.wardSel)[d.dataset.k] = b.dataset.c || null; this.saveLooks();
      if (this.char?.def.id === this.wardSel) applyColours(this.char.vrm, this.look(this.wardSel));
      this.renderWardrobe();
    }));
    el.querySelector('.sh-close').addEventListener('click', () => this.closeWardrobe());
    this.$prompt.addEventListener('click', () => { if (this.near) this.act(this.near.act); });
    this.$btns.addEventListener('click', (e) => { const b = e.target.closest('[data-act]'); if (b) this.act(b.dataset.act); });
    // X leaves the mech (E is the mech's dodge)
    addEventListener('keydown', (e) => { if (e.code === 'KeyX' && !e.repeat && this.mechActive && this.app.mode === 'ship') this.act('leaveMech'); });
  }
  syncButtons() {
    if (!this.$btns) return;
    const inSim = this.area === this.sim;
    this.$btns.querySelector('[data-act="leaveMech"]').hidden = !this.mechActive;
    this.$btns.querySelector('[data-act="deck"]').hidden = !inSim;
    this.$btns.querySelector('[data-act="helm"]').hidden = !this.helm;
    this.$btns.querySelector('[data-act="spar"]').hidden = !this.mechActive || !!this.arena?.fighting;
    this.$help.hidden = this.mechActive;             // the arena HUD shows the mech's controls
    this.$help.textContent = this.mechActive
      ? 'WASD move · Space jump/fly · click attack · wheel swap · gun: right-click aims · E dash · F/right-click block · K awaken · Q ultimate · X leave'
      : this.helm ? 'Drag to look around · E to stand up'
      : this.area === this.sim ? 'click attack · wheel: sword ⇄ pistol · gun: right-click aims · E dash / interact · F/right-click block · K awaken · Q ultimate · L launcher · Space jump, wall kick'
      : 'WASD move · Shift sprint · Space jump (again in the air) · drag to look · E interact';
    if (this.helm || this.mechActive) { this.near = null; this.$prompt.hidden = true; }
  }
  openWardrobe() {
    this.$ward.hidden = false;
    this.wardSel = this.char?.def.id || CHARACTERS[0].id;
    // step onto the pedestal, facing the camera, for a preview beside the panel
    if (this.ctrl && this.area === this.deck) { this.ctrl.spawn(this.pedestal, Math.PI / 2); this.snapCam = true; }
    this.renderWardrobe();
  }
  closeWardrobe() {
    if (this.$ward.hidden) return;
    this.$ward.hidden = true;
    this.camYaw = Math.PI / 2; this.camPitch = 0.22; this.snapCam = true;
  }
  renderWardrobe() {
    const W = this.$ward, mech = this.simMech;
    W.querySelectorAll('.sh-chars .sh-card').forEach((b) => b.classList.toggle('on', mech ? b.dataset.id === 'mech:' + loadFrame() : b.dataset.id === this.wardSel));
    W.querySelector('.sh-look').hidden = mech;
    W.querySelector('.sh-mechnote').hidden = !mech;
    if (mech) return;
    const def = CHARACTERS.find((c) => c.id === this.wardSel) || CHARACTERS[0], look = this.look(def.id);
    const cur = look.outfit || def.outfits[0].id;
    W.querySelector('.sh-outfits').innerHTML = def.outfits.map((o) => `
      <button class="sh-card sm${o.id === cur ? ' on' : ''}" data-id="${o.id}"><img src="/characters/${o.thumb}" alt=""><b>${o.name}</b></button>`).join('');
    for (const d of W.querySelectorAll('.sh-sw')) {
      const v = look[d.dataset.k] || '';
      d.querySelectorAll('.sw').forEach((b) => b.classList.toggle('on', b.dataset.c === v));
    }
  }

  // ---------------- the view out of the windows ----------------
  renderSpace() {
    const lv = this.app.localView, r = this.app.renderer;
    if (lv.mode !== 'base' || !lv.planet) return;
    r.getDrawingBufferSize(_size);
    const w = Math.max(2, Math.round(_size.x * 0.5)), h = Math.max(2, Math.round(_size.y * 0.5));
    if (this.spaceRT.width !== w || this.spaceRT.height !== h) this.spaceRT.setSize(w, h);
    this.windowMat.uniforms.res.value.copy(_size);
    // station frame -> space. The station flies tilted so the planet hangs low in the big windows: the deck's
    // NADIR direction (down, out through the hangar glass and the command deck's front) points at the planet's
    // centre, and the frame's roll about that axis is pinned to the Sun.
    const A = _v.copy(lv.planet.position).normalize();
    const B = _v2.crossVectors(A, Math.abs(A.dot(lv.sunDir)) < 0.95 ? lv.sunDir : _v3.set(0, 0, 1)).normalize();
    const C = _v3.crossVectors(A, B);
    _m.makeBasis(A, B, C).multiply(DECK_FRAME_INV);
    _q.setFromRotationMatrix(_m);
    const sc = this.spaceCam;
    sc.quaternion.copy(_q).multiply(this.camera.quaternion);
    sc.position.copy(A).multiplyScalar(-26);
    sc.fov = this.camera.fov; sc.aspect = this.camera.aspect; sc.updateProjectionMatrix();
    sc.updateMatrixWorld();
    lv.sky.position.copy(sc.position);
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.spaceRT);
    r.render(lv.scene, sc);
    r.setRenderTarget(prev);
    this.globe.rotation.y += 0.004;
  }

  // ---------------- per frame ----------------
  update(dt, input) {
    this.time += dt;
    const I = input.sample(dt);
    if (!this.$ward.hidden) { I.move.x = I.move.y = 0; I.jump = false; I.dodge = 0; I.attack = I.heavy = I.swap = I.rage = I.spin = I.launch = 0; I.attackHold = I.guard = false; }
    // the kit in play (mech, or a character in the sim): the wheel swaps weapons; with the shotgun out the right
    // button looks down the sights instead of blocking, and the mouse is captured to aim
    const kit = this.app.mode !== 'ship' || !this.$ward.hidden ? null : this.mechActive ? this.mech.kit : this.area === this.sim && !this.helm ? this.sword?.kit : null;
    let ads = false;
    if (kit) {
      if (I.wheel) { I.swap = (I.swap || 0) + 1; I.zoom = 1; }
      if (kit.gun) { ads = !!I.rmb; I.guard = !!I.guardKey; }
    }
    input.setAim?.(!!kit?.gun);
    const body = this.mechActive ? this.mech : this.ctrl;
    const adsK = this.gunView.update(dt, !!kit?.gun, ads, { lookX: I.lookX, lookY: I.lookY, kit, on: this.mechActive ? this.mech.aimOn : this.sword?.aimOn,
      speed: body ? Math.hypot(body.vel.x, body.vel.z) / (this.mechActive ? MECH_S * 4 : 4) : 0 }), sens = 1 - adsK * 0.5;
    this.gunView.begin(this.camera);
    this.camYaw -= I.lookX * 0.006 * sens;
    this.camPitch = THREE.MathUtils.clamp(this.camPitch + I.lookY * 0.004 * sens, kit?.gun ? -1.1 : -0.6, 1.2);
    if (this.mechActive) this.mechDist = THREE.MathUtils.clamp(this.mechDist * I.zoom, 10, 45);
    else this.camDist = THREE.MathUtils.clamp(this.camDist * I.zoom, 1.8, 9);
    if (this.wardrobeRing) this.wardrobeRing.scale.setScalar(1 + Math.sin(this.time * 3) * 0.03);

    if (this.area === this.sim) { this.updateDummies(dt); this.simFx.update(dt); }
    if (this.mechActive) { this.updateMech(dt, I, adsK); return; }

    const P = this.ctrl;
    if (!P) {
      this.camera.position.set(0, 2, this.area.spawn.pos.z + 4); this.camera.lookAt(this.area.spawn.pos.x, 1.4, this.area.spawn.pos.z);
      if (this.area === this.deck) { this.app.localView.tickWorld(dt); this.camera.updateMatrixWorld(); this.renderSpace(); }
      return;
    }

    if (this.helm) {
      if (I.dodge) this.setHelm(false);
      this.char.update(dt);
      const dir = _v2.set(Math.sin(this.camYaw) * Math.cos(this.camPitch), Math.sin(this.camPitch), Math.cos(this.camYaw) * Math.cos(this.camPitch));
      this.camera.position.copy(this.helmSeat);
      this.camera.lookAt(_v.copy(this.helmSeat).sub(dir));
    } else {
      // interaction prompt first: E interacts when something is in reach, otherwise it's the dodge
      let near = null;
      if (this.$ward.hidden) for (const it of this.area.interact) if (_v.copy(it.pos).setY(P.pos.y).distanceTo(P.pos) < it.r && Math.abs(P.pos.y - it.pos.y) < 2) near = it;
      if (near !== this.near) {
        this.near = near;
        this.$prompt.hidden = !near;
        if (near) this.$prompt.innerHTML = `<kbd>E</kbd> ${near.text}`;
      }
      if (near && I.dodge) { this.act(near.act); I.dodge = 0; }
      // the katana: drawn in the sim, sheathed on the deck. Its hitstop slows the whole body for a beat
      if (this.sword) this.sword.camYaw = this.camYaw;
      const fighting = this.area === this.sim && this.$ward.hidden;
      if (this.sword) { this.sword.aim = this.gunView.ray(); this.sword.cam = this.camera; this.sword.world = this.simWorld ||= worldOfBoxes(this.sim.boxes); this.sword.onFire = () => this.gunView.fired(); this.sword.onGunHit = (k) => this.gunView.hit(k); this.sword.vm = this.gunView.vm; }
      const pdt = this.sword ? this.sword.update(dt, I, P, this.simTargets, fighting) : dt;
      if (this.sword && this.area === this.sim) this.bots.update(pdt, P, this.sword, fighting);
      P.update(pdt, I, { boxes: this.area.boxes, camYaw: this.camYaw, killY: this.area.killY, spawn: this.area.spawn });
      this.updateMeters(P);
      if (!this.$ward.hidden && this.area === this.deck) {
        // wardrobe preview: face-on, framed to the left of the panel
        this.camYaw = Math.PI / 2; this.camPitch = 0.1;
        const head = _v.copy(P.pos).add(_v2.set(0, P.H * 0.62, 0));
        head.addScaledVector(_v3.set(Math.cos(this.camYaw), 0, -Math.sin(this.camYaw)), innerWidth > 700 ? 0.75 : 0);
        this.chaseCam(dt, head, 3.4, true);
      } else {
        this.chaseCam(dt, _v.copy(P.pos).add(_v2.set(0, P.H * 0.88, 0)), this.camDist, true);
        // gun mode: over the shoulder, and into the eyes while aim is held
        this.gunView.apply(this.camera, _v.copy(P.pos).add(_v2.set(0, P.H * 0.9, 0)), 0.55);
        this.char.root.visible = adsK < 0.6;
      }
      // wall-run camera: tilt the horizon away from the wall, widen the lens with speed
      const wr = P.state === 'wallrun';
      this.camRoll = (this.camRoll || 0) + ((wr ? -0.09 * (P.wallSide || 1) : 0) - (this.camRoll || 0)) * Math.min(1, dt * 6);
      if (Math.abs(this.camRoll) > 1e-3) this.camera.rotateZ(this.camRoll);
      const hs = Math.hypot(P.vel.x, P.vel.z);
      const fovWant = THREE.MathUtils.lerp(this.area === this.sim ? 60 + (wr ? 7 : THREE.MathUtils.clamp((hs - 6.5) * 1.2, 0, 4)) : 60, ADS_FOV, adsK);
      if (Math.abs(this.camera.fov - fovWant) > 0.05) { this.camera.fov += (fovWant - this.camera.fov) * Math.min(1, dt * (adsK > 0 ? 14 : 5)); this.camera.updateProjectionMatrix(); }
      const sk = this.sword?.shake || 0;
      if (sk > 0) { const k = sk * sk * 0.12; this.camera.position.x += (Math.random() - 0.5) * k; this.camera.position.y += (Math.random() - 0.5) * k; }
    }

    const zone = this.area.zoneTitle ? this.area.zoneTitle(P.pos) : this.area.title;
    if (zone !== this.zone) { this.zone = zone; this.$title.textContent = `${this.baseName} · ${zone}`; }
    if (this.area === this.sim) { this.sun.position.set(P.pos.x + 30, 60, P.pos.z - 20); this.sun.target.position.copy(P.pos); }
    else { this.app.localView.tickWorld(dt); this.camera.updateMatrixWorld(); this.renderSpace(); }
  }

  updateMech(dt, I, adsK = 0) {
    const M = this.mech, ctx = this.mechCtx, A = this.arena;
    const fight = A.fighting || A.state === 'down';
    // inside a sparring round: 1 g plating, the holo wall, the projected enemies as the only targets
    ctx.g = fight ? ARENA.G : 9.81;
    ctx.targets = ctx.enemies = fight ? A.targets : this.dummies;
    ctx.bound = fight ? A.R - 1.5 : this.yard.R - 2;
    ctx.camYaw = this.camYaw;
    ctx.world = this.simWorld ||= worldOfBoxes(this.sim.boxes);
    ctx.aim = this.gunView.ray(); ctx.onFire = () => this.gunView.fired(); ctx.onGunHit = (k) => this.gunView.hit(k); M.vm = this.gunView.vm;
    M.fpsCam = adsK > 0.6 ? this.camera : null;
    if (I.arena && !A.fighting && M.alive) A.start();
    for (const d of this.dummies) d.group.visible = d.alive && !fight;
    M.update(dt, I, ctx);
    A.update(dt, dt);
    this.kitHud.update(M.kit);
    this.tutorial.update(A.fighting ? null : M.kit, this.app.hud?.keyboard !== false);
    const wasFighting = this.sparBtnState;
    if (wasFighting !== A.fighting) { this.sparBtnState = A.fighting; this.syncButtons(); }

    // lock-on: swing the camera behind you, facing the locked target (a drag overrides it for a moment)
    if (I.lookX) this.lockYawHold = 1.2;
    this.lockYawHold = Math.max(0, (this.lockYawHold || 0) - dt);
    const L = M.lock && M.lock.alive ? M.lock : null;
    if (L && this.lockYawHold <= 0 && M.alive) {
      const want = Math.atan2(M.pos.x - L.pos.x, M.pos.z - L.pos.z);
      this.camYaw += Math.atan2(Math.sin(want - this.camYaw), Math.cos(want - this.camYaw)) * Math.min(1, dt * 2.2);
    }
    const head = _v.copy(M.pos).add(_v2.set(0, 1.4 * MECH_S, 0));
    if (L) { head.x += (L.pos.x - M.pos.x) * 0.3; head.z += (L.pos.z - M.pos.z) * 0.3; head.y += THREE.MathUtils.clamp(L.pos.y - M.pos.y, -3, 6) * 0.3; }
    this.chaseCam(dt, head, this.mechDist * (fight ? 1.15 : 1), false);
    this.gunView.apply(this.camera, _v2.copy(M.pos).setY(M.pos.y + 1.72 * MECH_S), 2.6);
    M.body.root.visible = adsK < 0.6;
    // impact zoom on big hits, a wider lens while dashing
    this.fovKick = Math.max(0, (this.fovKick || 0) - dt * 3.5);
    const fov = THREE.MathUtils.lerp(60 - 7 * this.fovKick + (M.state === 'dodge' ? 5 : 0), ADS_FOV, adsK);
    if (Math.abs(this.camera.fov - fov) > 0.01) { this.camera.fov += (fov - this.camera.fov) * Math.min(1, dt * 18); this.camera.updateProjectionMatrix(); }
    if (M.shake > 0) { const k = M.shake * M.shake * 0.6; this.camera.position.x += (Math.random() - 0.5) * k; this.camera.position.y += (Math.random() - 0.5) * k; }
    if (this.zone !== 'MECH YARD') { this.zone = 'MECH YARD'; this.$title.textContent = `${this.baseName} · TRAINING SIM · MECH YARD`; }
    this.sun.position.set(M.pos.x + 30, 80, M.pos.z - 20); this.sun.target.position.copy(M.pos);
  }

  updateDummies(dt) {
    for (const d of [...this.dummies, ...this.dojo]) {
      if (!d.alive) {
        if (this.time > d.respawnAt) { d.alive = true; d.hp = d.maxHp; d.group.visible = true; d.group.scale.setScalar(0.01); d.grow = 0; }
        continue;
      }
      if (d.grow !== undefined) { d.grow = Math.min(1, d.grow + dt * 2); d.group.scale.setScalar(Math.max(0.01, d.grow)); if (d.grow >= 1) delete d.grow; }
      if (d.wobble > 0) {
        d.wobble = Math.max(0, d.wobble - dt * 2.5);
        // rock away from the blow and spring back
        const k = Math.sin(this.time * 22) * 0.18 * d.wobble * d.wobble;
        d.group.rotation.x = Math.cos(d.wobbleDir || 0) * k; d.group.rotation.z = -Math.sin(d.wobbleDir || 0) * k;
      }
    }
  }

  // third-person camera around `head`, pulled in when something is between it and the character
  chaseCam(dt, head, distWant, collide) {
    const cp = this.camPitch;
    const want = _v2.set(Math.sin(this.camYaw) * Math.cos(cp), Math.sin(cp), Math.cos(this.camYaw) * Math.cos(cp));
    let dist = distWant;
    if (collide) {
      this.ray.set(head, want); this.ray.far = distWant;
      const hit = this.ray.intersectObjects(this.area.meshes, false)[0];
      if (hit) dist = Math.max(0.2, hit.distance - 0.25);
    }
    const target = want.multiplyScalar(dist).add(head);
    if (!collide) target.y = Math.max(target.y, 1.2);
    if (this.snapCam) { this.camera.position.copy(target); this.snapCam = false; }
    else this.camera.position.lerp(target, 1 - Math.exp(-14 * dt));
    this.camera.lookAt(head);
  }
}
