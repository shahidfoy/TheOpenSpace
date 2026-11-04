import * as THREE from 'three';
import { twoline2satrec, propagate, gstime, eciToEcf } from 'satellite.js';

// Live satellite traffic over the CYBER globe. Orbital elements (two-line element sets) come from
// CelesTrak (celestrak.org, CORS-enabled); every satellite is propagated with SGP4 to where it
// really is right now, about once a second, and glides between updates on its own velocity.
// CelesTrak asks clients not to re-download a group more than once every 2 hours, so each group is
// kept in the browser's Cache Storage for that long.

export const SAT_CREDIT = 'Satellites: CelesTrak (SGP4)';
const TTL = 2 * 3600e3;
export const SAT_GROUPS = [
  { id: 'starlink', name: 'Starlink', color: 0x9fd8ff, size: 0.07 },
  { id: 'oneweb', name: 'OneWeb', color: 0x7dffb0, size: 0.08 },
  { id: 'iridium-NEXT', name: 'Iridium', color: 0xc7a6ff, size: 0.09 },
  { id: 'gps-ops', name: 'GPS', color: 0xffc04d, size: 0.16 },
  { id: 'galileo', name: 'Galileo', color: 0xffd98a, size: 0.16 },
  { id: 'glo-ops', name: 'GLONASS', color: 0xff9a4d, size: 0.16 },
  { id: 'geo', name: 'Geostationary', color: 0xff6ad5, size: 0.2 },
  { id: 'stations', name: 'Space stations', color: 0xffffff, size: 0.28 },
];

async function tle(group) {
  const url = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${encodeURIComponent(group)}&FORMAT=tle`;
  let cache = null;
  try { cache = await caches.open('openspace-tle'); } catch { /* no Cache Storage (http, private mode) */ }
  const hit = cache && await cache.match(url);
  if (hit && Date.now() - +(hit.headers.get('x-fetched') || 0) < TTL) return hit.text();
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`celestrak ${r.status}`);
    const text = await r.text();
    if (cache) await cache.put(url, new Response(text, { headers: { 'x-fetched': String(Date.now()) } }));
    return text;
  } catch (e) {
    if (hit) return hit.text(); // stale beats nothing
    throw e;
  }
}

function parse(text, gi) {
  const L = text.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean), out = [];
  for (let i = 0; i + 2 < L.length + 0; i += 3) {
    if (!L[i + 1]?.startsWith('1 ') || !L[i + 2]?.startsWith('2 ')) continue;
    try { out.push({ name: L[i].trim(), rec: twoline2satrec(L[i + 1], L[i + 2]), g: gi }); } catch { /* bad element set */ }
  }
  return out;
}

// Earth-fixed (x to lon 0, y to lon 90°E, z north, km) → the globe's local frame (+Y north,
// lon 0 at +X, east toward -Z), scaled so Earth's radius is R.
const toGlobe = (p, R, out) => out.set(p.x, p.z, -p.y).multiplyScalar(R / 6371);

export class SatelliteLayer {
  constructor(R) {
    this.R = R;
    this.group = new THREE.Group();
    this.sats = [];
    this.counts = {};
    this.ready = false;
    this.acc = 99;
    this.labels = [];
  }

  async load() {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const lists = await Promise.allSettled(SAT_GROUPS.map((g) => tle(g.id)));
      lists.forEach((r, gi) => {
        if (r.status !== 'fulfilled') return;
        const s = parse(r.value, gi);
        // the "stations" group also lists docked modules and visiting craft: keep the stations
        const keep = SAT_GROUPS[gi].id === 'stations' ? s.filter((x) => /ISS \(ZARYA\)|CSS \(TIANHE\)/.test(x.name)) : s;
        this.counts[SAT_GROUPS[gi].name] = keep.length;
        this.sats.push(...keep);
      });
      this.error = lists.every((r) => r.status !== 'fulfilled') ? String(lists[0].reason?.message || lists[0].reason) : null;
      this.build();
    })();
    return this.loading;
  }

  build() {
    const n = this.sats.length;
    if (!n) return;
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n);
    const c = new THREE.Color();
    this.sats.forEach((s, i) => {
      const g = SAT_GROUPS[s.g];
      c.set(g.color).toArray(col, i * 3);
      size[i] = g.size;
      s.p = new THREE.Vector3(); s.v = new THREE.Vector3(); s.ok = false;
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    // round glowing dots; size in world units so near ones read bigger as you zoom in
    this.points = new THREE.Points(geo, new THREE.ShaderMaterial({
      vertexShader: `attribute float aSize; varying vec3 vC; void main(){ vC = color; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = clamp(aSize * 260.0 / -mv.z, 1.5, 9.0); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying vec3 vC; void main(){ float d = length(gl_PointCoord - 0.5); if (d > 0.5) discard; gl_FragColor = vec4(vC * (1.4 - d * 2.0), smoothstep(0.5, 0.15, d)); }`,
      vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.points.frustumCulled = false;
    this.group.add(this.points);
    this.ready = true;
    this.acc = 99;
  }

  // SGP4 for one satellite at `now`, plus its Earth-fixed velocity (per second) for the glide
  propagateOne(s, now) {
    const d0 = new Date(now), d1 = new Date(now + 1000);
    const p0 = propagate(s.rec, d0), p1 = propagate(s.rec, d1);
    if (!p0?.position || !p1?.position) { s.ok = false; return; }
    toGlobe(eciToEcf(p0.position, gstime(d0)), this.R, s.p);
    toGlobe(eciToEcf(p1.position, gstime(d1)), this.R, s.v).sub(s.p);
    s.t0 = now;
    s.ok = true;
  }

  update(dt, now) {
    if (!this.ready || !this.group.visible) return;
    const n = this.sats.length;
    if (!this.primed) { for (const s of this.sats) this.propagateOne(s, now); this.primed = true; this.cursor = 0; }
    // refresh a slice per frame (every satellite about once a second) instead of all at once
    const slice = Math.ceil(n * Math.min(1, dt));
    for (let k = 0; k < slice; k++) { this.propagateOne(this.sats[this.cursor], now); this.cursor = (this.cursor + 1) % n; }
    const p = this.points.geometry.attributes.position;
    for (let i = 0; i < n; i++) {
      const s = this.sats[i];
      if (!s.ok) { p.setXYZ(i, 0, 0, 0); continue; }
      const k = (now - s.t0) / 1000;
      p.setXYZ(i, s.p.x + s.v.x * k, s.p.y + s.v.y * k, s.p.z + s.v.z * k);
    }
    p.needsUpdate = true;
    for (const l of this.labels) {
      const s = l.userData.sat, k = (now - s.t0) / 1000;
      if (s.ok) l.position.set(s.p.x + s.v.x * k, s.p.y + s.v.y * k, s.p.z + s.v.z * k);
    }
  }

  total() { return this.sats.length; }
}
