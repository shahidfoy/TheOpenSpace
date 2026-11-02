import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { BODY, helioAU } from '../sim/orbits.js';
import { COUNTRIES } from '../data/countries.js';
import { US_STATES } from '../data/usStates.js';
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
