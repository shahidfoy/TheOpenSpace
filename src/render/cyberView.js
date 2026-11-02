import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { BODY, helioAU } from '../sim/orbits.js';
import { COUNTRIES } from '../data/countries.js';
import { US_STATES } from '../data/usStates.js';
import { groupOrigin, ORIGIN_HUBS } from '../data/ransomwareGroups.js';
import { loadCables, route, cableNet } from './cableNet.js';
import { planetMaterial, bodyQuat } from './planets.js';
import { atmosphereMaterial } from './shaders.js';

// Live cyber-threat globe. Data comes from our own aggregator (/api/threats/feed, a DigitalOcean
// Function that reads ransomware.live, abuse.ch Feodo, SANS ISC and CISA KEV). Everything shown is
// a real report: ransomware leak-site posts (by victim country), the IPs attacking the most sensors
// (by network country), botnet command servers. No invented attack arcs.

export const GLOBE_R = 10;
const D2R = Math.PI / 180;
const FEED = `${import.meta.env.BASE_URL}api/threats/feed`;
export const cyber = { data: null, error: null, loading: false, at: 0, byCountry: {} };

export async function loadThreats(force = false) {
  if (cyber.loading || (!force && cyber.data && Date.now() - cyber.at < 5 * 60 * 1000)) return cyber.data;
  cyber.loading = true;
  try {
    const r = await fetch(FEED, { cache: 'no-store' });
    if (!r.ok) throw new Error(`feed ${r.status}`);
    const d = await r.json();
    if (!d || !Array.isArray(d.ransomware)) throw new Error('feed unavailable');
    cyber.data = d;
    cyber.error = null;
    cyber.at = Date.now();
    cyber.byCountry = summarize(d);
  } catch (e) {
    cyber.error = String(e.message || e);
  } finally {
    cyber.loading = false;
  }
  return cyber.data;
}

// Incidents are grouped by country, and inside the US by state ("US-TX"); "US" holds US incidents
// whose state isn't known.
export const keyOf = (cc, region) => (cc === 'US' && region && US_STATES[region] ? `US-${region}` : cc);
export function placeOf(key) {
  if (!key) return null; // some posts carry no country at all
  if (key.startsWith('US-')) {
    const st = US_STATES[key.slice(3)];
    return st ? [st[0], st[1], `${st[2]}, USA`] : null;
  }
  const c = COUNTRIES[key];
  return c ? [c[0], c[1], key === 'US' ? 'United States' : c[2]] : null;
}
function summarize(d) {
  const by = {};
  const C = (k) => (by[k] = by[k] || { cc: k, ransomware: [], attackers: [], botnets: [] });
  for (const v of d.ransomware) { const k = keyOf(v.country, v.region); if (placeOf(k)) C(k).ransomware.push(v); }
  for (const a of d.attackers) { const k = keyOf(a.country, a.region); if (placeOf(k)) C(k).attackers.push(a); }
  for (const b of d.botnets) { const k = keyOf(b.country, b.region); if (placeOf(k)) C(k).botnets.push(b); }
  return by;
}

// Globe local frame matches the planet textures: +Y north, lon 0 at +X, east toward -Z.
export function latLon(lat, lon, r, out = new THREE.Vector3()) {
  const la = lat * D2R, lo = lon * D2R;
  return out.set(Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo)).multiplyScalar(r);
}

// Route: a pulse travels along the cables from the reported origin (t = 0) to the victim (t = 1)
// at a constant speed over the globe, with a fixed-length trail.
const ARC_SPEED = 0.35; // radians of the globe per second
const ARC_VERT = /* glsl */ `attribute float aT; varying float vT; void main(){ vT = aT; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const ARC_FRAG = /* glsl */ `uniform float uTime; uniform float uPhase; uniform float uK; uniform float uLen; varying float vT;
void main(){
  float head = fract(uTime * ${ARC_SPEED.toFixed(2)} / uLen + uPhase);
  float d = (head - vT) * uLen; // radians behind the pulse
  float trail = d > 0.0 ? exp(-d * 5.0) : 0.0;
  vec3 c = mix(vec3(1.0, 0.16, 0.24), vec3(1.0, 0.17, 0.84), vT);
  gl_FragColor = vec4(c * (0.18 * uK + 2.6 * trail * (0.5 + 0.5 * uK)), 1.0);
}`;

const COLUMN_VERT = /* glsl */ `varying float vY; void main(){ vY = uv.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const COLUMN_FRAG = /* glsl */ `uniform vec3 uColor; uniform float uTime; uniform float uPhase; varying float vY;
void main(){
  float fade = pow(1.0 - vY, 1.6);
  float scan = 0.7 + 0.3 * sin(vY * 30.0 - uTime * 4.0 + uPhase);
  gl_FragColor = vec4(uColor * fade * scan * 2.2, 1.0);
}`;

function glowTex() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, '#fff'); gr.addColorStop(0.3, 'rgba(255,255,255,0.5)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export class CyberGlobe {
  constructor() {
    this.group = new THREE.Group();
    this.group.visible = false;
    const body = BODY.earth;
    this.globe = new THREE.Mesh(new THREE.SphereGeometry(GLOBE_R, 128, 64), planetMaterial(body, { hi: true }));
    this.group.add(this.globe);
    const atmo = new THREE.Mesh(new THREE.SphereGeometry(GLOBE_R * 1.025, 64, 32), atmosphereMaterial(body.atmo));
    this.atmo = atmo;
    this.group.add(atmo);
    // neon graticule
    const pts = [];
    for (let lat = -60; lat <= 60; lat += 30) for (let lon = 0; lon < 360; lon += 3) pts.push(latLon(lat, lon, GLOBE_R * 1.004), latLon(lat, lon + 3, GLOBE_R * 1.004));
    for (let lon = 0; lon < 360; lon += 30) for (let lat = -84; lat < 84; lat += 3) pts.push(latLon(lat, lon, GLOBE_R * 1.004), latLon(lat + 3, lon, GLOBE_R * 1.004));
    this.grid = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: new THREE.Color(0x00e5ff).multiplyScalar(0.6), transparent: true, opacity: 0.18, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.group.add(this.grid);
    // a scanning ring sweeping pole to pole
    this.scan = new THREE.Mesh(new THREE.TorusGeometry(GLOBE_R * 1.01, 0.025, 6, 160), new THREE.MeshBasicMaterial({ color: new THREE.Color(0x00e5ff).multiplyScalar(2.5), transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.scan.rotation.x = Math.PI / 2;
    this.group.add(this.scan);
    this.markers = new THREE.Group();
    this.group.add(this.markers);
    this.glow = glowTex();
    this.time = 0;
    this.hits = []; // [{pos: Vector3 (local), cc}]
    this.labels = [];
  }

  clear() {
    for (const l of this.labels) l.element.remove();
    this.labels = [];
    this.markers.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); });
    this.group.remove(this.markers);
    this.markers = new THREE.Group();
    this.group.add(this.markers);
    this.hits = [];
  }

  build(data, by) {
    this.clear();
    if (!data) return;
    const up = new THREE.Vector3(0, 1, 0);
    const rnd = (s) => { const x = Math.sin(s * 12.9898) * 43758.5453; return x - Math.floor(x); };
    const cols = [];
    let maxR = 1, maxA = 1;
    for (const cc in by) { maxR = Math.max(maxR, by[cc].ransomware.length); maxA = Math.max(maxA, by[cc].attackers.reduce((s, a) => s + a.attacks, 0)); }
    const recent = Date.now() - 6 * 3600 * 1000;
    for (const cc in by) {
      const c = by[cc], [lat, lon, name] = placeOf(cc);
      const base = latLon(lat, lon, GLOBE_R);
      const n = base.clone().normalize();
      // ransomware: light column per country, height by incident count
      if (c.ransomware.length) {
        const k = c.ransomware.length, fresh = c.ransomware.some((v) => Date.parse(v.t) > recent);
        const h = 0.3 + Math.log2(k + 1) * 0.42;
        const geo = new THREE.CylinderGeometry(0.035 + 0.012 * Math.log2(k + 1), 0.06 + 0.018 * Math.log2(k + 1), h, 10, 1, true);
        geo.translate(0, h / 2, 0);
        const m = new THREE.Mesh(geo, new THREE.ShaderMaterial({
          uniforms: { uColor: { value: new THREE.Color(fresh ? 0xff2bd6 : 0xb04cff) }, uTime: { value: 0 }, uPhase: { value: rnd(lat + lon) * 6 } },
          vertexShader: COLUMN_VERT, fragmentShader: COLUMN_FRAG, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
        }));
        m.position.copy(base);
        m.quaternion.setFromUnitVectors(up, n);
        this.markers.add(m);
        cols.push(m);
        const g = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color: new THREE.Color(0xff2bd6).multiplyScalar(1.6), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
        g.position.copy(base).addScaledVector(n, 0.05);
        g.scale.setScalar(0.5 + 0.18 * Math.log2(k + 1));
        this.markers.add(g);
        if (k >= Math.max(2, maxR * 0.15)) {
          const el = document.createElement('div');
          el.className = 'cyber-label';
          el.innerHTML = `<b>${cc === 'US' ? 'USA · state unknown' : name.replace(', USA', '')}</b>${k} ransomware`;
          const l = new CSS2DObject(el);
          l.position.copy(base).addScaledVector(n, h + 0.25);
          this.markers.add(l);
          this.labels.push(l);
        }
      }
      // attack sources: amber pulsing rings, size by attacks seen
      const att = c.attackers.reduce((s, a) => s + a.attacks, 0);
      if (att) {
        const ring = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 40), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffb347).multiplyScalar(2.2), transparent: true, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
        // at the attackers' real locations when known (e.g. a data-centre city), else the centroid
        const geo = c.attackers.filter((a) => a.lat != null);
        if (geo.length) {
          const p = latLon(geo.reduce((s, a) => s + a.lat, 0) / geo.length, geo.reduce((s, a) => s + a.lon, 0) / geo.length, GLOBE_R);
          ring.position.copy(p).addScaledVector(p.clone().normalize(), 0.03);
          ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), p.clone().normalize());
        } else {
          ring.position.copy(base).addScaledVector(n, 0.03);
          ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
        }
        ring.userData = { pulse: true, s: 0.25 + 0.55 * Math.sqrt(att / maxA), phase: rnd(lon) };
        this.markers.add(ring);
        const dot = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color: new THREE.Color(0xffb347).multiplyScalar(1.4), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
        dot.position.copy(ring.position);
        dot.scale.setScalar(0.35);
        this.markers.add(dot);
      }
      // botnet command servers: red diamonds hovering above the country
      c.botnets.forEach((b, i) => {
        const d = new THREE.Mesh(new THREE.OctahedronGeometry(0.12), new THREE.MeshBasicMaterial({ color: new THREE.Color(b.status === 'online' ? 0xff2a3a : 0x803038).multiplyScalar(b.status === 'online' ? 2.5 : 1) }));
        d.position.copy(base).addScaledVector(n, 0.35 + i * 0.28);
        d.userData.spin = true;
        this.markers.add(d);
      });
      this.hits.push({ pos: base.clone().addScaledVector(n, 0.3), cc });
    }
    this.columns = cols;
    this.buildArcs(data);
  }

  // Reported origin → victim arcs, aggregated per (origin country, victim country/state).
  buildArcs(data) {
    this.arcs = [];
    const pairs = {}, origins = {};
    for (const v of data.ransomware) {
      const o = groupOrigin(v.group);
      if (!o || !COUNTRIES[o.cc]) continue;
      const tk = keyOf(v.country, v.region), tp = placeOf(tk);
      (origins[o.cc] = origins[o.cc] || new Set()).add(v.group);
      if (!tp || tk === o.cc) continue;
      const key = `${o.cc}>${tk}`;
      const p = (pairs[key] = pairs[key] || { cc: o.cc, to: tp, n: 0, groups: new Set() });
      p.n++;
      p.groups.add(v.group);
    }
    const list = Object.values(pairs);
    cyber.routes = [];
    const markers = this.markers;
    loadCables().then(() => {
      if (this.markers !== markers) return; // rebuilt meanwhile
      this.drawCables();
      const maxN = Math.max(1, ...list.map((p) => p.n));
      const rnd = (x) => { const y = Math.sin(x * 78.233) * 43758.5453; return y - Math.floor(y); };
      list.forEach((p, i) => {
        const r = route(ORIGIN_HUBS[p.cc] || COUNTRIES[p.cc], p.to);
        if (!r) return;
        cyber.routes.push({ from: p.cc, to: p.to[2], n: p.n, groups: [...p.groups], km: r.km, stations: r.stations, cables: [...new Set(r.legs.map((l) => l.cable).filter(Boolean))] });
        // follow each leg on the surface, splitting long hops along the great circle
        const pts = [], len = [];
        const a = new THREE.Vector3(), b = new THREE.Vector3();
        for (const leg of r.legs) for (let j = 1; j < leg.pts.length; j++) {
          latLon(leg.pts[j - 1][0], leg.pts[j - 1][1], 1, a);
          latLon(leg.pts[j][0], leg.pts[j][1], 1, b);
          const ang = a.angleTo(b), steps = Math.max(1, Math.ceil(ang / 0.02));
          for (let k = pts.length ? 1 : 0; k <= steps; k++) {
            const t = k / steps;
            const q = ang < 1e-6 ? a.clone() : a.clone().multiplyScalar(Math.sin((1 - t) * ang)).addScaledVector(b, Math.sin(t * ang)).divideScalar(Math.sin(ang)).normalize();
            len.push(pts.length ? len[len.length - 1] + q.angleTo(pts[pts.length - 1]) : 0);
            pts.push(q);
          }
        }
        const total = len[len.length - 1] || 1;
        for (const q of pts) q.multiplyScalar(GLOBE_R * 1.004);
        const ts = new Float32Array(len.map((x) => x / total));
        const geo = new THREE.BufferGeometry().setFromPoints(pts);
        geo.setAttribute('aT', new THREE.BufferAttribute(ts, 1));
        const kk = 0.35 + 0.65 * (p.n / maxN);
        const line = new THREE.Line(geo, new THREE.ShaderMaterial({
          uniforms: { uTime: { value: this.time }, uPhase: { value: rnd(i + 1) }, uK: { value: kk }, uLen: { value: total } },
          vertexShader: ARC_VERT, fragmentShader: ARC_FRAG, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
        }));
        this.markers.add(line);
        const head = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color: new THREE.Color(0xff3cb0).multiplyScalar(1.8), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
        head.scale.setScalar(0.18 + 0.16 * kk);
        this.markers.add(head);
        this.arcs.push({ pts, ts, head, phase: rnd(i + 1), len: total });
      });
      cyber.routes.sort((x, y) => y.n - x.n);
    });
    // reported bases: a red hexagon at the country's main internet hub + label naming the groups
    for (const cc in origins) {
      const [la, lo] = ORIGIN_HUBS[cc] || COUNTRIES[cc], name = COUNTRIES[cc][2];
      const pos = latLon(la, lo, GLOBE_R), n = pos.clone().normalize();
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.5, 6), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff2a3a).multiplyScalar(2.4), transparent: true, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
      ring.position.copy(pos).addScaledVector(n, 0.04);
      ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
      ring.userData = { pulse: true, s: 1.4, phase: 0.5 };
      this.markers.add(ring);
      const el = document.createElement('div');
      el.className = 'cyber-label origin';
      el.innerHTML = `<b>REPORTED BASE · ${name}</b>${[...origins[cc]].join(', ')}`;
      const l = new CSS2DObject(el);
      l.position.copy(pos).addScaledVector(n, 0.9);
      this.markers.add(l);
      this.labels.push(l);
    }
    this.arcStats = { pairs: list.length, attributed: list.reduce((x, p) => x + p.n, 0) };
  }

  // the whole submarine cable network, faint, in each cable's own map colour
  drawCables() {
    if (this.cables) return;
    const net = cableNet(), pos = [], col = [];
    const a = new THREE.Vector3(), b = new THREE.Vector3(), q = new THREE.Vector3(), prev = new THREE.Vector3(), c = new THREE.Color(), tint = new THREE.Color(0x00e5ff);
    for (const [, color, paths] of net.cables) {
      c.set(color).lerp(tint, 0.35);
      for (const p of paths) for (let i = 1; i < p.length; i++) {
        latLon(net.lat(p[i - 1]), net.lon(p[i - 1]), 1, a);
        latLon(net.lat(p[i]), net.lon(p[i]), 1, b);
        const steps = Math.max(1, Math.ceil(a.angleTo(b) / 0.03));
        prev.copy(a);
        for (let k = 1; k <= steps; k++) {
          q.copy(a).lerp(b, k / steps).normalize();
          pos.push(prev.x * GLOBE_R * 1.002, prev.y * GLOBE_R * 1.002, prev.z * GLOBE_R * 1.002, q.x * GLOBE_R * 1.002, q.y * GLOBE_R * 1.002, q.z * GLOBE_R * 1.002);
          col.push(c.r, c.g, c.b, c.r, c.g, c.b);
          prev.copy(q);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    this.cables = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.group.add(this.cables);
  }

  // real day/night: the Sun's direction in Earth-fixed coordinates = globe local frame
  update(dt, t, camera) {
    this.time += dt;
    // CSS labels don't get hidden by the globe: hide those on the far side
    const camDir = camera.position.clone().normalize();
    for (const l of this.labels) l.element.style.visibility = l.position.clone().normalize().dot(camDir) > 0.1 ? 'visible' : 'hidden';
    const p = helioAU(BODY.earth, t);
    const sunW = new THREE.Vector3(-p[0], -p[2], p[1]).normalize();
    const s = sunW.applyQuaternion(bodyQuat('earth', t).invert());
    this.sunDir = s;
    this.globe.material.userData.sunDir.copy(s);
    this.atmo.material.uniforms.uSunDir.value.copy(s);
    const k = (this.time * 0.08) % 1;
    this.scan.position.y = Math.cos(k * Math.PI) * GLOBE_R;
    this.scan.scale.setScalar(Math.max(0.02, Math.sin(k * Math.PI)));
    for (const a of this.arcs || []) {
      const f = (this.time * ARC_SPEED / a.len + a.phase) % 1;
      let lo = 0, hi = a.ts.length - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (a.ts[m] <= f) lo = m; else hi = m; }
      a.head.position.lerpVectors(a.pts[lo], a.pts[hi], (f - a.ts[lo]) / (a.ts[hi] - a.ts[lo] || 1));
    }
    for (const m of this.markers.children) {
      if (m.userData.pulse) {
        const f = (this.time * 0.6 + m.userData.phase) % 1;
        m.scale.setScalar(m.userData.s * (0.3 + f * 1.4));
        m.material.opacity = 1 - f;
      } else if (m.userData.spin) m.rotation.y += dt * 1.5;
      else if (m.material?.uniforms?.uTime) m.material.uniforms.uTime.value = this.time;
    }
  }

  // nearest country marker to a screen point (front-facing only)
  pick(x, y, camera) {
    let best = null, bd = 46;
    const v = new THREE.Vector3(), camDir = camera.position.clone().normalize();
    for (const h of this.hits) {
      if (h.pos.clone().normalize().dot(camDir) < 0.15) continue;
      v.copy(h.pos).project(camera);
      const sx = (v.x * 0.5 + 0.5) * innerWidth, sy = (-v.y * 0.5 + 0.5) * innerHeight;
      const d = Math.hypot(sx - x, sy - y);
      if (d < bd) { bd = d; best = h.cc; }
    }
    return best;
  }

  setLabelsVisible(on) {
    for (const l of this.labels) l.element.style.display = on ? '' : 'none';
  }
}
