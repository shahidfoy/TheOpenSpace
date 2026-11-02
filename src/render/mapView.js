import * as THREE from 'three';
import * as S from '../sim/state.js';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { BODIES } from '../data/bodies.js';
import { BODY, mapPos, mapPosAU, helioAU, transitAU, GALACTIC } from '../sim/orbits.js';
import { AU_KM } from '../data/bodies.js';
import { atmosphereMaterial, glowSprite, NOISE } from './shaders.js';
import { planetMaterial, ringMesh, bodyQuat } from './planets.js';
import { makeSky } from './sky.js';
import { makeHauler, makeSeedShip, makeSkiff } from './models.js';
import { CyberGlobe, loadThreats, cyber } from './cyberView.js';

const col = (h, k = 1) => new THREE.Color(h).multiplyScalar(k);
const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), ORIGIN = new THREE.Vector3();
const V = (a) => new THREE.Vector3(...a);
const YEAR = 365.25 * 864e5;
// TRUE SCALE: linear distances and real radii together (1 AU = 40 map units; Earth is 0.0017 wide).
const TRUE_K = 40;
// Drift view, in real time: every body sits where it is right now, and its trail is the real path
// it has carved through the galaxy over the past years as the Sun ploughs on at 230 km/s. Forward motion is drawn at 60 map units per year (Earth's orbit
// is ~100 around), so helices are stretched like the real ones, just less (reality: ~8x more).
const DRIFT_PER_YEAR = 60;

function fmtEta(ms) {
  const s = Math.max(0, ms / 1000);
  if (s < 60) return `${s | 0}s`;
  if (s < 3600) return `${(s / 60) | 0}m ${(s % 60) | 0}s`;
  if (s < 86400) return `${(s / 3600) | 0}h ${((s % 3600) / 60) | 0}m`;
  return `${(s / 86400) | 0}d ${((s % 86400) / 3600) | 0}h`;
}
function label(html, cls) {
  const el = document.createElement('div');
  el.className = cls;
  el.innerHTML = html;
  return new CSS2DObject(el);
}
let dotTex;
function dotTexture() {
  if (dotTex) return dotTex;
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d'), gr = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  gr.addColorStop(0, '#fff'); gr.addColorStop(0.4, 'rgba(255,255,255,0.6)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 32, 32);
  return (dotTex = new THREE.CanvasTexture(c));
}
function line(points, color, opacity) {
  return new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
}

export class MapView {
  constructor(app) {
    this.app = app;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.05, 60000);
    // the real sky in the same ecliptic frame as the map: catalogue stars, constellations, Milky Way
    this.sky = makeSky({ lines: true, names: true, mw: 0.2 });
    this.scene.add(this.sky);
    this.items = {};
    this.time = 0;
    this.view = 'system';
    this.system = new THREE.Group();
    this.scene.add(this.system);

    for (const b of BODIES) {
      const g = new THREE.Group();
      const m = new THREE.Mesh(new THREE.SphereGeometry(b.mapSize, 64, 32), planetMaterial(b));
      g.add(m);
      if (b.kind === 'star') g.add(glowSprite(0xffb060, 7, 1.0));
      if (b.atmo) g.add(new THREE.Mesh(new THREE.SphereGeometry(b.mapSize * 1.06, 24, 12), atmosphereMaterial(b.atmo)));
      if (b.rings) m.add(ringMesh(b.mapSize)); // rings lie in Saturn's real equatorial plane
      const lab = label(`<span class="nm">${b.name}</span><span class="bs"></span>`, 'map-label');
      lab.position.set(0, b.mapSize + 0.5, 0);
      g.add(lab);
      this.system.add(g);
      // drop line to the ecliptic plane shows each orbit's real inclination
      const drop = line([new THREE.Vector3(), new THREE.Vector3()], col(0x9fc8ff, 1), 0.35);
      if (b.kind !== 'star' && !b.parent) this.system.add(drop);
      this.items[b.id] = { body: b, group: g, mesh: m, el: lab.element, baseEl: lab.element.querySelector('.bs'), drop };
    }

    // one layer of orbits / belts / ecliptic grid per distance scale
    this.scaleMode = 'visible';
    // line overlays the player can switch off (remembered between sessions)
    const pref = (k) => { try { return localStorage.getItem(`openspace_${k}`) !== '0'; } catch { return true; } };
    this.show = { constellations: pref('constellations'), orbits: pref('orbits') };
    this.layers = {};
    for (const mode of ['visible', 'true']) {
      const layer = (this.layers[mode] = { group: new THREE.Group(), orbits: {}, belts: [] });
      layer.group.visible = mode === 'visible';
      this.system.add(layer.group);
      this.buildOrbits(mode, layer);
      this.buildBelts(mode, layer);
      this.buildEcliptic(mode, layer);
    }
    this.applyScale();
    this.buildDrift();
    this.buildGalaxy();
    this.buildCosmos();
    // live cyber-threat globe (CYBER tab)
    this.cyber = new CyberGlobe();
    this.scene.add(this.cyber.group);
    this.applyLines();

    this.sel = new THREE.Mesh(new THREE.RingGeometry(1, 1.1, 48), new THREE.MeshBasicMaterial({ color: col(0xffb347, 1.1), side: THREE.DoubleSide, transparent: true, depthWrite: false }));
    this.sel.visible = false;
    this.scene.add(this.sel);
    this.home = new THREE.Mesh(new THREE.RingGeometry(1, 1.06, 48), new THREE.MeshBasicMaterial({ color: col(0x7fd4ff, 1.3), side: THREE.DoubleSide, transparent: true, depthWrite: false }));
    this.scene.add(this.home);

    this.trips = new Map();
    this.target = new THREE.Vector3();
    this.dist = 42;
    this.az = 0.5;
    this.elev = 0.75;
    this.follow = 'earth';
    this.selected = null;
    this.bindInput(app.renderer.domElement);
  }

  // ---------------- system view ----------------
  // Distance from the Sun (AU) → map units for each scale.
  rOf(au, mode) {
    return mode === 'true' ? au * TRUE_K : 16 * Math.sqrt(au);
  }
  auToMap(p, out, mode = this.mode()) {
    return mode === 'true' ? out.set(p[0] * TRUE_K, p[2] * TRUE_K, -p[1] * TRUE_K) : mapPosAU(p, out);
  }
  posFor(id, t, out, mode = this.mode()) {
    if (mode !== 'true') return mapPos(id, t, out);
    return this.auToMap(helioAU(BODY[id], t), out, 'true');
  }
  // the scale in force right now (drift / galaxy views always use the illustrative layout)
  mode() {
    return this.view === 'system' ? this.scaleMode : 'visible';
  }
  radiusOf(id) {
    const it = this.items[id];
    return it.body.mapSize * it.group.scale.x;
  }

  // Constellation figures (+ bright-star names) and solar-system lines (orbits, ecliptic grid,
  // drop lines, drift trails) can be toggled independently.
  toggleLines(kind) {
    this.show[kind] = !this.show[kind];
    try { localStorage.setItem(`openspace_${kind}`, this.show[kind] ? '1' : '0'); } catch {}
    this.applyLines();
  }
  applyLines() {
    const sky = this.sky.userData;
    if (sky.lines) sky.lines.visible = this.show.constellations;
    if (sky.names) sky.names.visible = this.show.constellations;
    for (const k in this.layers) {
      const l = this.layers[k];
      for (const id in l.orbits) l.orbits[id].visible = this.show.orbits;
      if (l.grid) l.grid.visible = this.show.orbits;
    }
    for (const id in this.trails) this.trails[id].visible = this.show.orbits;
  }

  setScale(mode) {
    this.scaleMode = mode;
    this.applyScale();
    const f = this.follow && this.items[this.follow] ? this.follow : this.app.state.presence;
    this.follow = f;
    this.dist = mode === 'true' ? Math.max(0.004, this.trueRadius(f) * 14) : 42;
  }
  trueRadius(id) {
    return (BODY[id].radiusKm / AU_KM) * TRUE_K;
  }
  applyScale() {
    const mode = this.mode();
    for (const k in this.layers) this.layers[k].group.visible = k === mode && this.view === 'system';
    for (const id in this.items) {
      const it = this.items[id];
      it.group.scale.setScalar(mode === 'true' ? this.trueRadius(id) / it.body.mapSize : 1);
      it.orbit = this.layers[mode].orbits[id];
    }
  }

  buildOrbits(mode, layer) {
    const t0 = Date.now(), p0 = new THREE.Vector3();
    for (const b of BODIES) {
      if (b.kind === 'star') continue;
      const pts = [], n = b.parent ? 96 : 256;
      for (let i = 0; i <= n; i++) {
        const t = t0 + (i / n) * b.period * 864e5;
        const p = this.posFor(b.id, t, new THREE.Vector3(), mode);
        if (b.parent) p.sub(this.posFor(b.parent, t, p0, mode));
        pts.push(p);
      }
      const l = line(pts, col(0x7fd4ff, 0.9), 0.28);
      layer.orbits[b.id] = l;
      this.items[b.id].moonOrbit = !!b.parent;
      layer.group.add(l);
    }
  }

  buildBelts(mode, layer) {
    // belt objects scatter in inclination too (main belt ±~15°, Kuiper belt up to ~30°)
    const make = (n, r0, r1, incl, color, size) => {
      const pos = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const r = this.rOf(r0 + Math.random() * (r1 - r0), mode), a = Math.random() * Math.PI * 2;
        const inc = (Math.random() - 0.5) * 2 * incl * (Math.random() < 0.7 ? 0.4 : 1), node = Math.random() * Math.PI * 2;
        pos.set([Math.cos(a) * r, Math.sin(inc) * Math.sin(a - node) * r, Math.sin(a) * r], i * 3);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const pts = new THREE.Points(geo, new THREE.PointsMaterial({ color, size: mode === 'true' ? size * 0.6 : size, sizeAttenuation: mode !== 'true', transparent: true, opacity: 0.7, depthWrite: false }));
      layer.belts.push(pts);
      layer.group.add(pts);
    };
    make(2600, 2.1, 3.3, 0.26, col(0xb09070, 0.8), mode === 'true' ? 2 : 0.12);
    make(1800, 30, 50, 0.5, col(0x7090c0, 0.8), mode === 'true' ? 2 : 0.2);
  }

  buildEcliptic(mode, layer) {
    const g = new THREE.Group();
    const mat = new THREE.LineBasicMaterial({ color: col(0x7fd4ff, 0.6), transparent: true, opacity: 0.07, depthWrite: false });
    for (const au of [1, 5, 10, 20, 30, 40]) {
      const r = this.rOf(au, mode), pts = [];
      for (let i = 0; i <= 128; i++) { const a = (i / 128) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r)); }
      g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
      if (au >= 5 || mode === 'true') {
        const l = label(`${au} AU`, 'grid-label');
        l.position.set(r, 0, 0);
        g.add(l);
      }
    }
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2, R = this.rOf(40, mode);
      g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(Math.cos(a) * R, 0, Math.sin(a) * R)]), mat));
    }
    layer.grid = g;
    layer.group.add(g);
  }

  // ---------------- drift view: helical paths through the galaxy ----------------
  buildDrift() {
    const g = new THREE.Group();
    g.visible = false;
    this.drift = g;
    this.trails = {};
    for (const b of BODIES) {
      if (b.parent) continue;
      const n = b.kind === 'star' ? 2 : 220;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      const l = new THREE.Line(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending }));
      g.add(l);
      this.trails[b.id] = l;
    }
    const apex = V(GALACTIC.apex).normalize(), gc = V(GALACTIC.center).normalize();
    const lead = new THREE.Group();
    g.add(lead);
    this.driftLead = lead;
    const arrow = (dir, len, color, html) => {
      lead.add(new THREE.ArrowHelper(dir, new THREE.Vector3(), len, color, 4, 2));
      const l = label(html, 'gal-label');
      l.position.copy(dir).multiplyScalar(len + 4);
      lead.add(l);
    };
    arrow(apex, 70, 0x7fd4ff, `<b>SOLAR APEX · CYGNUS</b>${GALACTIC.speedKms} km/s around the galaxy`);
    arrow(gc, 60, 0xffb347, '<b>SGR A* · GALACTIC CENTRE</b>26,000 light-years');
    // galactic plane disc (the ecliptic is tilted ~60° to it)
    const disc = new THREE.Mesh(new THREE.RingGeometry(10, 150, 96, 1), new THREE.MeshBasicMaterial({ color: col(0xffb347, 1), transparent: true, opacity: 0.006, side: THREE.DoubleSide, depthWrite: false }));
    disc.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), V(GALACTIC.north).normalize());
    lead.add(disc);
    const gl = label('<b>GALACTIC PLANE</b>ecliptic tilted 60.2°', 'gal-label dim');
    gl.position.copy(V(GALACTIC.center).normalize().cross(V(GALACTIC.north)).normalize().multiplyScalar(-110));
    lead.add(gl);
    this.scene.add(g);
  }

  // Sun's displacement along its galactic path at time-lapse time td (relative to the start).
  driftOffset(td, out) {
    return out.copy(V(GALACTIC.apex)).normalize().multiplyScalar(DRIFT_PER_YEAR * (td - this.driftT0) / YEAR);
  }

  updateDrift(td) {
    const p = new THREE.Vector3(), o = new THREE.Vector3(), c = new THREE.Color();
    for (const id in this.trails) {
      const b = BODY[id], l = this.trails[id];
      const pos = l.geometry.attributes.position, cols = l.geometry.attributes.color;
      const n = pos.count;
      const span = b.kind === 'star' ? 8 * YEAR : Math.min(8 * YEAR, 2.6 * b.period * 864e5);
      c.set(b.kind === 'star' ? 0xffc46b : b.look.a);
      for (let i = 0; i < n; i++) {
        const tt = td - (i / (n - 1)) * span;
        mapPos(id, tt, p).add(this.driftOffset(tt, o));
        pos.setXYZ(i, p.x, p.y, p.z);
        const f = Math.pow(1 - i / n, 1.5);
        cols.setXYZ(i, c.r * f, c.g * f, c.b * f);
      }
      pos.needsUpdate = cols.needsUpdate = true;
      l.geometry.computeBoundingSphere();
    }
  }

  // ---------------- galaxy view: the Milky Way as mapped today ----------------
  // 1 unit = 1,000 light-years. Galactic frame: Sun at (0, 0, 26.1), Sgr A* at the origin,
  // +Y = north galactic pole, rotation toward -X (l = 90°). Arms are trailing log spirals
  // (pitch ~16°) fitted so Perseus passes ~6 kly outside the Sun and Sagittarius–Carina ~5 kly inside.
  buildGalaxy() {
    const g = new THREE.Group();
    g.visible = false;
    this.galaxy = g;
    const SUN = new THREE.Vector3(0, 0, GALACTIC.radiusLy / 1000);
    const ex = new THREE.Vector3(0, 0, -1), ey = new THREE.Vector3(-1, 0, 0), ez = new THREE.Vector3(0, 1, 0);
    this.galFrame = { SUN, ex, ey, ez };
    const K = Math.tan(16 * Math.PI / 180);
    const ARMS = [
      { name: 'PERSEUS ARM', th0: 122, w: 1.6, major: true },
      { name: 'SCUTUM–CENTAURUS ARM', th0: 302, w: 1.6, major: true },
      { name: 'SAGITTARIUS–CARINA ARM', th0: 38, w: 1.1 },
      { name: 'NORMA–OUTER ARM', th0: 218, w: 1.1 },
    ];
    // angle (x→z) of an arm at radius r; rotation is toward +angle, so the angle falls outward (trailing arms)
    const armAt = (arm, r) => arm.th0 * Math.PI / 180 - Math.log(r / 4.5) / K;
    // The disc is thin but not flat: ~300 ly scale height in the thin disc, a ~900 ly thick disc,
    // flaring toward the edge, an S-shaped warp (up toward l = 90°, down toward l = 270°), a
    // boxy/peanut bulge ~10,000 ly tall around the bar, and a round stellar halo.
    const warp = (r, ang) => (r > 16 ? 0.012 * Math.pow(r - 16, 1.6) * Math.sin(ang - Math.PI / 2) : 0);
    const flare = (r) => 1 + Math.max(0, r - 20) / 18;
    const n = 40000, pos = new Float32Array(n * 3), cols = new Float32Array(n * 3);
    const c = new THREE.Color(), gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
    const barDir = new THREE.Vector3(-0.454, 0, 0.891), barSide = new THREE.Vector3(barDir.z, 0, -barDir.x);
    const p = new THREE.Vector3();
    const disc = (r, ang, h) => p.set(Math.cos(ang) * r, warp(r, ang) + gauss() * h * flare(r), Math.sin(ang) * r);
    for (let i = 0; i < n; i++) {
      const u = Math.random();
      if (u < 0.15) {
        // bar + boxy/peanut bulge: stars climb out of the plane in an X toward the bar ends
        const along = gauss() * 8, side = gauss() * 2.4;
        p.copy(barDir).multiplyScalar(along).addScaledVector(barSide, side);
        const lobe = Math.random() < 0.5 ? (Math.random() < 0.5 ? 1 : -1) * (0.42 * Math.abs(along) + gauss() * 0.6) : gauss() * 1.4;
        p.y = lobe * Math.max(0.15, 1 - Math.abs(along) / 18);
        c.setHSL(0.09, 0.65, 0.5 + Math.random() * 0.3);
      } else if (u < 0.69) {
        const arm = ARMS[i % ARMS.length];
        const r = 6 + Math.pow(Math.random(), 0.9) * 46;
        const ang = armAt(arm, r) + gauss() * (arm.w / r) * 2.2;
        disc(r + gauss() * arm.w, ang, 0.3);
        const young = Math.random() < (arm.major ? 0.45 : 0.3);
        c.setHSL(young ? 0.6 : 0.11, young ? 0.55 : 0.3, 0.45 + Math.random() * 0.35);
        if (Math.random() < 0.03) c.setHSL(0.95, 0.8, 0.6); // HII star-forming regions
      } else if (u < 0.85) {
        // thin disc between the arms (scale length ~10 kly)
        disc(-Math.log(1 - Math.random() * 0.99) * 10 + 2, Math.random() * Math.PI * 2, 0.3);
        c.setHSL(0.1, 0.2, 0.3 + Math.random() * 0.25);
      } else if (u < 0.96) {
        // thick disc: older, redder, ~3x the height, shorter scale length
        disc(-Math.log(1 - Math.random() * 0.98) * 7 + 2, Math.random() * Math.PI * 2, 0.95);
        c.setHSL(0.07, 0.35, 0.28 + Math.random() * 0.2);
      } else {
        // stellar halo: roughly spherical, slightly flattened, density falling steeply outward
        p.randomDirection().multiplyScalar(4 + Math.pow(Math.random(), 2.2) * 75);
        p.y *= 0.75;
        c.setHSL(0.1, 0.3, 0.35 + Math.random() * 0.2);
      }
      pos.set([p.x, p.y, p.z], i * 3);
      cols.set([c.r, c.g, c.b], i * 3);
    }
    // Orion Spur: the short local arm the Sun sits in
    for (let i = 0; i < 500; i++) {
      const k = Math.random() * 2 - 1, ang = Math.PI / 2 + 0.2 * k;
      disc(26.1 + k * 3.5, ang, 0.25);
      p.x += gauss() * 0.7; p.z += gauss() * 0.7;
      const j = (i * 67) % n;
      pos.set([p.x, p.y, p.z], j * 3);
      c.setHSL(0.58, 0.45, 0.45);
      cols.set([c.r, c.g, c.b], j * 3);
    }
    // ~150 globular clusters in the halo, concentrated toward the centre
    const gpos = [];
    for (let i = 0; i < 150; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(1.5 + Math.pow(Math.random(), 1.8) * 55);
      gpos.push(v);
    }
    const GLOB = [['OMEGA CENTAURI', 309.1, 15.0, 17.3], ['47 TUCANAE', 305.9, -44.9, 14.7], ['M13 · HERCULES', 59.0, 40.9, 22.2], ['M22', 9.9, -7.6, 10.6], ['M4', 351.0, 16.0, 7.2]];
    for (const [, l, bb, kly] of GLOB) gpos.push(this.galPoint(l, bb, kly));
    const gg = new THREE.BufferGeometry().setFromPoints(gpos);
    g.add(new THREE.Points(gg, new THREE.PointsMaterial({ color: col(0xffe0b0, 1.6), size: 0.9, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending, map: dotTexture() })));
    this.globulars = GLOB;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    g.add(new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.32, vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending, map: dotTexture() })));
    g.add(glowSprite(0xffc88a, 22, 1.0));
    const lab = (html, at, cls = 'gal-label') => { const l = label(html, cls); l.position.copy(at); g.add(l); };
    lab('<b>SGR A*</b>4.3 million suns', new THREE.Vector3(0, 2.5, 0));
    lab('<b>BAR + PEANUT BULGE</b>27,000 ly long · ~10,000 ly tall', barDir.clone().multiplyScalar(-11).setY(5), 'gal-label dim');
    lab('<b>DISC WARP</b>edge bends ~3,000 ly up', new THREE.Vector3(-46, 4.5, 0), 'gal-label dim');
    lab('<b>…AND DOWN</b>on the far side', new THREE.Vector3(46, -4.5, 0), 'gal-label dim');
    lab('<b>STELLAR HALO</b>old stars + ~150 globular clusters', new THREE.Vector3(0, 34, 0), 'gal-label dim');
    for (const [name, l, bb, kly] of this.globulars) lab(`<b>${name}</b>`, this.galPoint(l, bb, kly).add(new THREE.Vector3(0, 1.2, 0)), 'gal-label tiny');
    for (const arm of ARMS) {
      const r = arm.major ? 40 : 34, a = armAt(arm, r);
      lab(`<b>${arm.name}</b>`, new THREE.Vector3(Math.cos(a) * r, 1.5, Math.sin(a) * r), 'gal-label dim');
    }
    const orbit = [];
    // the Sun bobs through the disc: ±~300 ly, ~3.5 times per lap; today ~65 ly above and rising (drawn 5x taller)
    const BOB = 0.3 * 5, phase = Math.asin(0.065 / 0.3) - 3.5 * Math.PI / 2;
    for (let i = 0; i <= 480; i++) { const ang = (i / 480) * Math.PI * 2; orbit.push(new THREE.Vector3(Math.cos(ang) * SUN.z, BOB * Math.sin(3.5 * ang + phase), Math.sin(ang) * SUN.z)); }
    g.add(line(orbit, col(0x7fd4ff, 1.2), 0.3));
    this.sunMarker = new THREE.Group();
    this.sunMarker.position.copy(SUN).setY(0.065 * 5);
    this.sunMarker.add(glowSprite(0xffe2a0, 2.2, 2.5));
    const tilt = new THREE.Mesh(new THREE.RingGeometry(1.0, 1.12, 48), new THREE.MeshBasicMaterial({ color: col(0x7fd4ff, 2.5), side: THREE.DoubleSide, transparent: true, depthWrite: false }));
    tilt.rotation.x = -Math.PI / 2 + 60.2 * Math.PI / 180;
    this.sunMarker.add(tilt);
    const you = label('<b>THE SUN · ORION SPUR</b>26,000 ly out · 65 ly above the plane, rising', 'gal-label here');
    you.position.set(0, 2.4, 0);
    this.sunMarker.add(you);
    g.add(this.sunMarker);
    // satellite galaxies at their real positions (galactic l, b, distance)
    for (const [name, l, b, kly, size] of [['LARGE MAGELLANIC CLOUD', 280.5, -32.9, 163, 5], ['SMALL MAGELLANIC CLOUD', 302.8, -44.3, 200, 3], ['SAGITTARIUS DWARF', 5.6, -14.2, 70, 3]]) {
      const at = this.galPoint(l, b, kly);
      const s = glowSprite(0xbfc8ff, size * 2, 1.1);
      s.position.copy(at);
      g.add(s);
      lab(`<b>${name}</b>${kly},000 ly`, at.clone().add(new THREE.Vector3(0, size + 1, 0)), 'gal-label dim');
    }
    this.scene.add(g);
  }

  galPoint(lDeg, bDeg, dist, out = new THREE.Vector3()) {
    const { SUN, ex, ey, ez } = this.galFrame, l = lDeg * Math.PI / 180, b = bDeg * Math.PI / 180;
    return out.copy(SUN).addScaledVector(ex, Math.cos(b) * Math.cos(l) * dist).addScaledVector(ey, Math.cos(b) * Math.sin(l) * dist).addScaledVector(ez, Math.sin(b) * dist);
  }

  // ---------------- cosmos view: the observable universe, log scale ----------------
  // Radius = 18 x log10(distance / 10,000 ly); directions are real (galactic l, b).
  buildCosmos() {
    const g = new THREE.Group();
    g.visible = false;
    this.cosmos = g;
    const { ex, ey, ez } = this.galFrame;
    const rOf = (ly) => Math.max(0, 18 * Math.log10(ly / 1e4));
    const dir = (lDeg, bDeg) => {
      const l = lDeg * Math.PI / 180, b = bDeg * Math.PI / 180;
      return new THREE.Vector3().addScaledVector(ex, Math.cos(b) * Math.cos(l)).addScaledVector(ey, Math.cos(b) * Math.sin(l)).addScaledVector(ez, Math.sin(b));
    };
    g.add(glowSprite(0xffd9a8, 6, 1.4));
    const mw = label('<b>MILKY WAY</b>you are here', 'gal-label here');
    mw.position.set(0, 3, 0);
    g.add(mw);
    const OBJ = [
      ['LMC', 280.5, -32.9, 1.63e5, 0xbfc8ff, 2], ['SMC', 302.8, -44.3, 2.0e5, 0xbfc8ff, 1.4],
      ['ANDROMEDA · M31', 121.2, -21.6, 2.54e6, 0xffe0c0, 4], ['TRIANGULUM · M33', 133.6, -31.3, 2.73e6, 0xcfe0ff, 2.2],
      ['NGC 6822', 25.3, -18.4, 1.6e6, 0xbfc8ff, 1.2], ['IC 1613', 129.7, -60.6, 2.4e6, 0xbfc8ff, 1.2],
      ['CENTAURUS A', 309.5, 19.4, 1.2e7, 0xffe0c0, 2.4], ['M81', 142.1, 40.9, 1.18e7, 0xffe0c0, 2.2],
      ['VIRGO CLUSTER', 283.8, 74.5, 5.35e7, 0xffd0a0, 6], ['GREAT ATTRACTOR', 325.3, -7.3, 2.2e8, 0xff9a6a, 7],
      ['COMA CLUSTER', 58.1, 88.0, 3.2e8, 0xffd0a0, 6], ['PERSEUS–PISCES', 150, -13, 2.5e8, 0xffd0a0, 6],
      ['SHAPLEY SUPERCLUSTER', 312, 31, 6.5e8, 0xff9a6a, 9], ['SLOAN GREAT WALL', 195, 70, 1.0e9, 0xff9a6a, 8],
    ];
    const fmtLy = (ly) => (ly >= 1e9 ? `${(ly / 1e9).toFixed(1)} billion ly` : ly >= 1e6 ? `${(ly / 1e6).toFixed(ly < 1e7 ? 2 : 0)} million ly` : `${Math.round(ly / 1e3)},000 ly`);
    for (const [name, l, b, ly, color, size] of OBJ) {
      const at = dir(l, b).multiplyScalar(rOf(ly));
      const s = glowSprite(color, size, 1.4);
      s.position.copy(at);
      g.add(s);
      const lb = label(`<b>${name}</b>${fmtLy(ly)}`, 'gal-label dim');
      lb.position.copy(at).add(new THREE.Vector3(0, size * 0.6 + 1, 0));
      g.add(lb);
    }
    // large-scale structure: filaments between random nodes (illustrative, not a survey)
    const nodes = Array.from({ length: 70 }, () => new THREE.Vector3().randomDirection().multiplyScalar(rOf(Math.pow(10, 7.3 + Math.random() * 2.9))));
    const pts = [];
    for (const a of nodes) {
      const near = nodes.filter((b) => b !== a).sort((q, w) => q.distanceTo(a) - w.distanceTo(a)).slice(0, 2);
      for (const b of near) for (let i = 0; i < 70; i++) pts.push(a.clone().lerp(b, Math.random()).add(new THREE.Vector3().randomDirection().multiplyScalar(Math.random() * 2.2)));
      for (let i = 0; i < 40; i++) pts.push(a.clone().add(new THREE.Vector3().randomDirection().multiplyScalar(Math.random() * 3)));
    }
    g.add(new THREE.Points(new THREE.BufferGeometry().setFromPoints(pts), new THREE.PointsMaterial({ color: col(0x9fb4ff, 0.8), size: 0.35, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending, map: dotTexture() })));
    // distance shells
    for (const [ly, text] of [[1e6, '1 million ly'], [1e7, '10 million ly'], [1e8, '100 million ly'], [1e9, '1 billion ly'], [1e10, '10 billion ly']]) {
      const r = rOf(ly), ring = [];
      for (let i = 0; i <= 128; i++) { const a = (i / 128) * Math.PI * 2; ring.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r)); }
      g.add(line(ring, col(0x7fd4ff, 1), 0.12));
      const lb = label(text, 'grid-label');
      lb.position.set(r, 0, 0);
      g.add(lb);
    }
    // the cosmic microwave background: the edge of what we can see
    const edge = rOf(4.65e10);
    const cmb = new THREE.Mesh(new THREE.SphereGeometry(edge, 64, 32), new THREE.ShaderMaterial({
      vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `varying vec3 vP; ${NOISE}
        void main(){ vec3 d = normalize(vP); float n = fbm(d * 9.0) - 0.5 + (fbm(d * 26.0) - 0.5) * 0.5;
          vec3 c = mix(vec3(0.1, 0.25, 0.9), vec3(1.0, 0.45, 0.1), smoothstep(-0.25, 0.25, n));
          gl_FragColor = vec4(c * 0.045, 1.0); }`,
      side: THREE.BackSide, depthWrite: false, transparent: true, blending: THREE.AdditiveBlending,
    }));
    cmb.renderOrder = -5;
    g.add(cmb);
    const el = label('<b>COSMIC MICROWAVE BACKGROUND</b>edge of the observable universe · 46.5 billion ly · light from 13.8 billion years ago', 'gal-label');
    el.position.set(0, edge * 0.72, edge * 0.69);
    g.add(el);
    this.scene.add(g);
  }

  // fetch the threat feed (cached 5 min) and rebuild the globe markers when it changes
  async refreshCyber(force) {
    const before = cyber.at;
    await loadThreats(force);
    if (cyber.at !== before || !this.cyberBuilt) {
      this.cyber.build(cyber.data, cyber.byCountry);
      this.cyber.setLabelsVisible(this.view === 'cyber');
      this.cyberBuilt = true;
    }
    this.app.hud?.syncNav();
  }

  setView(v) {
    this.view = v;
    const far = v === 'galaxy' || v === 'cosmos' || v === 'cyber';
    this.cyber.group.visible = v === 'cyber';
    this.cyber.setLabelsVisible(v === 'cyber');
    this.system.visible = !far;
    this.sky.visible = !far;
    this.cosmos.visible = v === 'cosmos';
    this.applyScale();
    this.drift.visible = v === 'drift';
    this.galaxy.visible = v === 'galaxy';
    for (const [, m] of this.trips) m.g.visible = v === 'system';
    this.driftAcc = 99;
    if (v === 'cyber') { this.follow = null; this.target.set(0, 0, 0); this.dist = 34; this.elev = 0.35; this.cyberAim = true; this.refreshCyber(true); }
    else if (v === 'galaxy') { this.follow = null; this.target.set(0, 0, 6); this.dist = 115; this.elev = 0.32; this.az = 0.6; }
    else if (v === 'cosmos') { this.follow = null; this.target.set(0, 0, 0); this.dist = 420; this.elev = 0.45; }
    else if (v === 'drift') {
      // camera rides alongside the Sun, which leads; the planets' helices stream out behind it
      this.follow = 'drift';
      this.driftT0 = this.driftT = S.simNow(this.app.state);
      this.driftAcc = 99;
      this.dist = 330; this.elev = 0.05; this.az = 2.3;
    }
    else { this.follow = this.app.state.presence; this.dist = 42; this.elev = 0.75; }
  }

  // ---------------- input ----------------
  bindInput(canvas) {
    const pts = new Map();
    let down = null, pinch = 0, two = null;
    const active = () => this.app.mode === 'map';
    // two-finger gesture state: finger angle + midpoint, plus how much twist/tilt has built up before it engages
    const twoState = () => {
      const [a, b] = [...pts.values()];
      return { ang: Math.atan2(b.y - a.y, b.x - a.x), my: (a.y + b.y) / 2, twist: 0, tilt: 0, rot: false, lean: false };
    };
    canvas.addEventListener('pointerdown', (e) => {
      if (!active()) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 1) down = { x: e.clientX, y: e.clientY, moved: 0, btn: e.button };
      if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); down = null; two = twoState(); }
    });
    canvas.addEventListener('pointermove', (e) => {
      const p = pts.get(e.pointerId);
      if (!p || !active()) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (pts.size === 1) {
        if (down) down.moved += Math.abs(dx) + Math.abs(dy);
        // one finger orbits in drift/galaxy views (there's nothing to pan to); right-drag orbits in system view
        if ((down && down.btn === 2) || this.view !== 'system') { this.az -= dx * 0.006; this.elev = THREE.MathUtils.clamp(this.elev + dy * 0.004, -1.4, 1.5); }
        else this.pan(dx, dy);
      } else if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch > 0) this.zoom(pinch / d);
        pinch = d;
        // twist two fingers to rotate the map, drag them up/down together to tilt it (touch has no right-drag).
        // Each engages past a small threshold so a plain pinch doesn't wobble the view.
        if (two) {
          const ang = Math.atan2(b.y - a.y, b.x - a.x), my = (a.y + b.y) / 2;
          let da = ang - two.ang;
          if (da > Math.PI) da -= Math.PI * 2; else if (da < -Math.PI) da += Math.PI * 2;
          const dmy = my - two.my;
          two.ang = ang; two.my = my;
          if (!two.rot) { two.twist += da; if (Math.abs(two.twist) > 0.12) { two.rot = true; da = two.twist; } }
          if (two.rot) this.az += da;
          if (!two.lean) { two.tilt += dmy; if (Math.abs(two.tilt) > 18 && !two.rot) { two.lean = true; } }
          if (two.lean) this.elev = THREE.MathUtils.clamp(this.elev + dmy * 0.004, -1.4, 1.5);
        }
      }
    });
    const up = (e) => {
      if (pts.has(e.pointerId) && pts.size === 1 && down && down.moved < 10 && active() && this.view === 'system') {
        const id = this.pick(e.clientX, e.clientY);
        if (id) this.app.selectBody(id);
      } else if (pts.has(e.pointerId) && pts.size === 1 && down && down.moved < 10 && active() && this.view === 'cyber') {
        const cc = this.cyber.pick(e.clientX, e.clientY, this.camera);
        if (cc) this.app.hud.open(`cyber:${cc}`);
      }
      pts.delete(e.pointerId);
      if (pts.size < 2) { pinch = 0; two = null; }
    };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('wheel', (e) => { if (active()) { e.preventDefault(); this.zoom(Math.exp(e.deltaY * 0.0012)); } }, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  zoom(k) {
    const tru = this.mode() === 'true';
    const max = { galaxy: 420, cosmos: 800, drift: 700, cyber: 90 }[this.view] || (tru ? 4000 : 320);
    const min = this.view === 'cyber' ? 13 : this.view === 'galaxy' || this.view === 'cosmos' ? 6 : tru ? 0.0006 : 2.5;
    this.dist = THREE.MathUtils.clamp(this.dist * k, min, max);
  }

  pan(dx, dy) {
    const k = (2 * Math.tan((this.camera.fov * Math.PI) / 360) * this.dist) / innerHeight;
    const fwd = tmpA.set(-Math.sin(this.az), 0, -Math.cos(this.az));
    const right = tmpB.set(Math.cos(this.az), 0, -Math.sin(this.az));
    this.target.addScaledVector(right, -dx * k).addScaledVector(fwd, (dy * k) / Math.max(0.3, Math.sin(this.elev)));
    this.follow = null;
  }

  focus(id, dist) {
    if (this.view !== 'system') this.setView('system');
    this.follow = id;
    if (dist) this.dist = dist;
  }

  pick(x, y) {
    let best = null, bd = 44;
    const v = new THREE.Vector3();
    for (const id in this.items) {
      const it = this.items[id];
      it.group.getWorldPosition(v).project(this.camera);
      if (v.z > 1) continue;
      const sx = (v.x * 0.5 + 0.5) * innerWidth, sy = (-v.y * 0.5 + 0.5) * innerHeight;
      const d = Math.hypot(sx - x, sy - y) - (id === 'sun' ? 20 : 0);
      if (d < bd) { bd = d; best = id; }
    }
    return best;
  }

  select(id) {
    this.selected = id;
    if (id) this.follow = id;
    if (id && this.mode() === 'true') this.dist = Math.max(0.002, this.trueRadius(id) * 14);
  }

  update(dt, t) {
    this.time += dt;
    const s = this.app.state;
    const drift = this.view === 'drift';
    if (drift) this.driftT = t; // the game clock: real time
    const tv = drift ? this.driftT : t;
    const lead = drift ? this.driftOffset(tv, new THREE.Vector3()) : null;
    for (const id in this.items) {
      const it = this.items[id];
      this.posFor(id, tv, it.group.position);
      if (lead) it.group.position.add(lead);
      bodyQuat(id, tv, it.mesh.quaternion); // real pole direction and spin angle right now
      const u = it.mesh.material.uniforms;
      if (id !== 'sun') {
        u.uSunDir.value.copy(it.group.position).sub(lead || ORIGIN).negate().normalize();
        it.group.traverse((c) => c !== it.mesh && c.material?.uniforms?.uSunDir?.value.copy(u.uSunDir.value));
      }
      if (it.moonOrbit) it.orbit.position.copy(this.items[it.body.parent].group.position);
      const dp = it.drop.geometry.attributes.position;
      dp.setXYZ(0, it.group.position.x, it.group.position.y, it.group.position.z);
      dp.setXYZ(1, it.group.position.x, 0, it.group.position.z);
      dp.needsUpdate = true;
      it.drop.visible = this.view === 'system' && this.show.orbits && Math.abs(it.group.position.y) > 0.05;
      const hasBase = !!s.bases[id];
      it.el.classList.toggle('has-base', hasBase);
      it.el.classList.toggle('here', s.presence === id);
      it.baseEl.textContent = hasBase ? `◉ ${it.body.base}` : '';
      if (it.orbit) it.orbit.material.opacity = hasBase ? 0.6 : it.moonOrbit ? 0.2 : 0.28;
      it.el.style.display = this.view === 'galaxy' || this.view === 'cosmos' || (it.body.parent && (this.dist > 70 || this.view === 'drift') && !hasBase) ? 'none' : '';
    }

    // trails only change visibly over hours; rebuild twice a second
    if (drift && (this.driftAcc = (this.driftAcc || 0) + dt) > 0.5) {
      this.driftAcc = 0;
      this.updateDrift(tv);
    }
    if (drift) {
      this.driftLead.position.copy(lead);
    }
    if (this.view === 'cyber') {
      this.cyber.update(dt, t, this.camera);
      if (this.cyberAim) {
        // open on the sunlit side (it moves with the real time of day)
        const s = this.cyber.sunDir;
        this.az = Math.atan2(s.x, s.z);
        this.elev = THREE.MathUtils.clamp(Math.asin(s.y) + 0.25, -0.6, 0.9);
        this.cyberAim = false;
      }
      if ((this.cyberAcc = (this.cyberAcc || 0) + dt) > 300) { this.cyberAcc = 0; this.refreshCyber(); }
    }
    this.updateTrips(t);
    this.updateFleet(t);

    if (this.follow) {
      const p = this.follow === 'drift' ? this.items.sun.group.position.clone().addScaledVector(V(GALACTIC.apex).normalize(), -DRIFT_PER_YEAR * 1.6)
        : this.follow === 'fleet' && this.fleet ? this.fleet.holder.position : this.items[this.follow]?.group.position;
      // the drifting Sun moves ~20 units/s in the time-lapse, so lock on rather than ease
      if (p) this.follow === 'drift' ? this.target.copy(p) : this.target.lerp(p, 1 - Math.exp(-8 * dt));
    }
    const ce = Math.cos(this.elev), se = Math.sin(this.elev);
    this.camera.position.set(
      this.target.x + this.dist * ce * Math.sin(this.az),
      this.target.y + this.dist * se,
      this.target.z + this.dist * ce * Math.cos(this.az),
    );
    this.camera.lookAt(this.target);
    const near = THREE.MathUtils.clamp(this.dist * 0.002, 1e-6, 0.05);
    if (Math.abs(near - this.camera.near) > near * 0.2) { this.camera.near = near; this.camera.updateProjectionMatrix(); }
    this.sky.position.copy(this.camera.position);

    const ring = (mesh, id, k) => {
      const it = this.items[id];
      mesh.position.copy(it.group.position);
      mesh.quaternion.copy(this.camera.quaternion);
      mesh.scale.setScalar(Math.max(this.radiusOf(id) * k, this.dist * 0.018));
    };
    this.sel.visible = !!this.selected && this.view === 'system';
    if (this.selected) ring(this.sel, this.selected, 1.8 + Math.sin(this.time * 4) * 0.08);
    this.home.visible = this.view === 'system';
    ring(this.home, s.presence, 2.2);
  }

  makeMarker(ship, color, scale) {
    const g = new THREE.Group();
    ship.scale.setScalar(scale);
    const holder = new THREE.Group();
    holder.add(ship);
    holder.add(glowSprite(color, 1.6, 2));
    const path = line([new THREE.Vector3(), new THREE.Vector3()], col(color, 2), 0.5);
    const lab = label('', 'trip-label');
    lab.position.set(0, 0.8, 0);
    holder.add(lab);
    g.add(holder, path);
    this.scene.add(g);
    return { g, holder, line: path, el: lab.element };
  }

  placeMarker(m, from, to, depart, arrive, t, text) {
    this.auToMap(transitAU(from, to, depart, arrive, t), m.holder.position);
    const dest = this.auToMap(transitAU(from, to, depart, arrive, arrive), tmpB);
    m.holder.lookAt(dest);
    m.holder.scale.setScalar(this.mode() === 'true' ? this.dist * 0.02 : Math.max(1, this.dist * 0.02));
    const p = m.line.geometry.attributes.position;
    p.setXYZ(0, m.holder.position.x, m.holder.position.y, m.holder.position.z);
    p.setXYZ(1, dest.x, dest.y, dest.z);
    p.needsUpdate = true;
    m.line.geometry.computeBoundingSphere();
    m.el.textContent = text;
    m.g.visible = this.view === 'system';
  }

  updateTrips(t) {
    const s = this.app.state, live = new Set();
    for (const tr of s.trips) {
      live.add(tr.id);
      let m = this.trips.get(tr.id);
      if (!m) {
        m = this.makeMarker(tr.type === 'found' ? makeSeedShip() : makeHauler(), tr.type === 'found' ? 0x7fd4ff : 0xffb347, tr.type === 'found' ? 0.09 : 0.06);
        this.trips.set(tr.id, m);
      }
      const kind = tr.type === 'found' ? 'SEED' : tr.type === 'return' ? 'HAUL ⟲' : 'HAUL';
      this.placeMarker(m, tr.from, tr.to, tr.depart, tr.arrive, t, `${kind} → ${BODY[tr.to].name} · ${fmtEta(tr.arrive - t)}`);
    }
    for (const [id, m] of this.trips) {
      if (live.has(id)) continue;
      m.holder.traverse((o) => { if (o.isCSS2DObject) o.element.remove(); });
      this.scene.remove(m.g);
      this.trips.delete(id);
    }
  }

  updateFleet(t) {
    const v = this.app.state.voyage;
    if (!v) {
      if (this.fleet) {
        this.fleet.holder.traverse((o) => { if (o.isCSS2DObject) o.element.remove(); });
        this.scene.remove(this.fleet.g);
        this.fleet = null;
      }
      return;
    }
    if (!this.fleet) {
      this.fleet = this.makeMarker(makeSkiff(), 0x7fd4ff, 0.16);
      this.fleet.el.classList.add('fleet');
    }
    this.placeMarker(this.fleet, v.from, v.to, v.depart, v.arrive, t, `◆ FLEET → ${BODY[v.to].name} · ${fmtEta(v.arrive - t)}`);
  }
}

