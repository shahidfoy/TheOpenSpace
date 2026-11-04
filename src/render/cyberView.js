import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { BODY, helioAU } from '../sim/orbits.js';
import { COUNTRIES } from '../data/countries.js';
import { US_STATES } from '../data/usStates.js';
import { groupOrigin, ORIGIN_HUBS } from '../data/ransomwareGroups.js';
import { loadCables, route, cableNet } from './cableNet.js';
import { planetMaterial, bodyQuat } from './planets.js';
import { atmosphereMaterial } from './shaders.js';
import { SatelliteLayer, SAT_GROUPS } from './satellites.js';
import { HUB_CITIES } from '../data/hubCities.js';

// Live cyber-threat globe. Data comes from our own aggregator (/api/threats/feed, a DigitalOcean
// Function that reads blocklist.de, ransomware.live, SANS ISC, abuse.ch, OpenPhish, CISA KEV, NVD
// and, when their keys are set, URLhaus/ThreatFox, Cloudflare Radar, OTX and AbuseIPDB). Everything
// shown is a real report. The game polls every ~30 s and only receives the sources that changed;
// new reports are played onto the globe one by one over the time they arrived in.

export const GLOBE_R = 10;
const D2R = Math.PI / 180;
const FEED = `${import.meta.env.BASE_URL}api/threats/feed`;
export const cyber = { data: null, error: null, loading: false, at: 0, byCountry: {}, sources: [], poll: 30, rev: 0, liveRev: 0, queue: [], events: [], seen: new Set(), arrived: new Set() };

// How each source looks. globe: 'points' (one dot per report), 'country' (aggregated per country),
// 'arcs' (country pairs) or null (no location: ticker and log only).
export const SOURCE_STYLE = {
  bruteforce: { tag: 'BLOCKLIST.DE', short: 'ATTACKS', css: '#00e5ff', globe: 'points' },
  ransomware: { tag: 'RANSOMWARE.LIVE', short: 'RANSOMWARE', css: '#ff2bd6', globe: 'country' },
  attackers: { tag: 'DSHIELD', short: 'SCANNERS', css: '#ffb347', globe: 'country' },
  botnets: { tag: 'FEODO', short: 'BOTNET C2', css: '#ff2a3a', globe: 'country' },
  phishing: { tag: 'OPENPHISH', short: 'PHISHING', css: '#3fff9a', globe: 'points' },
  malware: { tag: 'URLHAUS · THREATFOX', short: 'MALWARE', css: '#ff8a1a', globe: 'points' },
  abuseipdb: { tag: 'ABUSEIPDB', short: 'ABUSIVE IPS', css: '#ff9ec7', globe: 'points' },
  ddos: { tag: 'CLOUDFLARE RADAR', short: 'DDOS', css: '#ff5a3c', globe: 'arcs' },
  otx: { tag: 'ALIENVAULT OTX', short: 'CAMPAIGNS', css: '#7aa2ff', globe: 'country' },
  c2certs: { tag: 'SSLBL', short: 'C2 CERTS', css: '#b46bff', globe: null },
  exploits: { tag: 'CISA KEV', short: 'EXPLOITED', css: '#ffe14d', globe: null },
  cves: { tag: 'NVD', short: 'NEW CVES', css: '#e8e07a', globe: null },
};
// sources whose change means the aggregated markers and arcs must be rebuilt
const STRUCTURAL = new Set(['ransomware', 'attackers', 'botnets', 'ddos', 'otx']);

export async function loadThreats() {
  if (cyber.loading) return cyber.data;
  cyber.loading = true;
  try {
    const since = cyber.data?.updated;
    const r = await fetch(since ? `${FEED}?since=${encodeURIComponent(since)}` : FEED, { cache: 'no-store' });
    if (!r.ok) throw new Error(`feed ${r.status}`);
    const d = await r.json();
    if (!d || !Array.isArray(d.sources) || typeof d.sources[0] !== 'object') throw new Error('feed unavailable');
    const first = !cyber.data;
    const data = first ? d : { ...cyber.data, updated: d.updated, sources: d.sources };
    const changed = d.sources.filter((s) => Array.isArray(d[s.id])).map((s) => s.id);
    const hour = Date.now() - 3600e3;
    for (const s of d.sources) {
      if (!first && (d.append || []).includes(s.id)) {
        // rolling source: only the new reports came; keep the last hour
        const have = new Set(d[s.id].map((x) => x.id));
        data[s.id] = [...d[s.id], ...(data[s.id] || []).filter((x) => !have.has(x.id) && Date.parse(x.t) > hour)];
      } else data[s.id] = (Array.isArray(d[s.id]) ? d[s.id] : data[s.id]) || [];
    }
    cyber.data = data;
    cyber.sources = d.sources;
    cyber.poll = d.poll || 30;
    enqueue(data, first ? d.sources.map((s) => s.id) : changed, first);
    if (first || changed.some((id) => STRUCTURAL.has(id))) cyber.rev++;
    if (changed.length) cyber.liveRev++;
    cyber.error = null;
    cyber.at = Date.now();
    cyber.byCountry = summarize(data);
  } catch (e) {
    cyber.error = String(e.message || e);
  } finally {
    cyber.loading = false;
  }
  return cyber.data;
}

// New reports are scheduled across the window they arrived in (a source refreshed every 2 min
// spreads its new reports over the next 2 min), oldest first. On the first load the newest few
// replay over ~20 s so the globe comes alive at once; the rest are simply there.
function enqueue(data, ids, first) {
  const now = Date.now(), fresh = [];
  for (const id of ids) {
    const s = cyber.sources.find((x) => x.id === id);
    for (const it of data[id] || []) {
      if (cyber.seen.has(it.id)) continue;
      cyber.seen.add(it.id);
      fresh.push({ src: id, it, win: Math.min(120, Math.max(20, s?.every || 60)) });
    }
  }
  fresh.sort((a, b) => String(a.it.t).localeCompare(String(b.it.t)));
  let play = fresh;
  if (first) {
    const pick = {};
    for (const e of fresh) if ((SOURCE_STYLE[e.src]?.globe === 'points' || e.src === 'ransomware') && whereOf(e.it)) (pick[e.src] = pick[e.src] || []).push(e);
    play = Object.values(pick).flatMap((l) => l.slice(l[0].src === 'bruteforce' ? -12 : -5));
    const replay = new Set(play);
    for (const e of fresh) if (!replay.has(e)) cyber.arrived.add(e.it.id);
    // the ticker starts with the newest few from every source, not just the busiest one
    const per = {};
    for (const e of fresh) if (!replay.has(e)) (per[e.src] = per[e.src] || []).push(e);
    const recent = Object.values(per).flatMap((l) => l.slice(-3));
    recent.sort((a, b) => String(a.it.t).localeCompare(String(b.it.t)));
    for (const e of recent) cyber.events.unshift({ src: e.src, it: e.it, at: now });
  }
  const bySrc = {};
  for (const e of play) (bySrc[e.src] = bySrc[e.src] || []).push(e);
  for (const list of Object.values(bySrc)) list.forEach((e, i) => cyber.queue.push({ ...e, due: now + ((first ? 20 : e.win) * 1000 * (i + 0.5)) / list.length }));
  cyber.queue.sort((a, b) => a.due - b.due);
}

// release reports whose time has come; returns the ones that just arrived
export function drainQueue() {
  const now = Date.now(), out = [];
  while (cyber.queue.length && cyber.queue[0].due <= now) {
    const e = cyber.queue.shift();
    cyber.arrived.add(e.it.id);
    const ev = { src: e.src, it: e.it, at: now, stale: now - e.due > 30000 };
    cyber.events.unshift(ev);
    out.push(ev);
  }
  if (cyber.events.length > 80) cyber.events.length = 80;
  return out;
}

// where a report sits on the globe: its own coordinates, else its country's (or US state's) centroid
export function whereOf(it) {
  if (it.lat != null) return [it.lat, it.lon];
  const p = placeOf(keyOf(it.country, it.region));
  return p ? [p[0], p[1]] : null;
}
const cname = (cc) => (cc && COUNTRIES[cc] ? COUNTRIES[cc][2] : null);
export function placeName(it) {
  const c = it.country === 'US' && it.region && US_STATES[it.region] ? `${US_STATES[it.region][2]}, USA` : cname(it.country);
  return [it.city, c].filter(Boolean).join(', ') || 'location unknown';
}
// one line per report, for the ticker and logs
export function describe(src, it) {
  switch (src) {
    case 'bruteforce': return `${it.service === 'attack' ? 'Attack' : `${it.service.toUpperCase()} attack`} from ${placeName(it)}`;
    case 'ransomware': return `${it.group} posted a victim · ${it.sector} · ${placeName({ country: it.country, region: it.region })}`;
    case 'attackers': return `${it.as || it.ip} scanning ${fmtN(it.attacks)} targets · ${placeName(it)}`;
    case 'botnets': return `${it.malware} C2 ${it.status} · ${placeName(it)}`;
    case 'phishing': return `Phishing site ${it.host} · hosted in ${placeName(it)}`;
    case 'malware': return `${it.malware} ${it.kind} · ${placeName(it)}`;
    case 'abuseipdb': return `${it.ip} reported (${it.score}%) · ${placeName(it)}`;
    case 'ddos': return `DDoS ${cname(it.from) || it.from} → ${cname(it.to) || it.to} · ${it.share.toFixed(1)}% of ${it.layer}`;
    case 'otx': return `${it.name}${it.targets.length ? ` · targets ${it.targets.slice(0, 3).join(', ')}` : ''}`;
    case 'c2certs': return `New ${it.reason} certificate`;
    case 'exploits': return `${it.cve} ${it.vendor} ${it.product} now exploited${it.ransomware ? ' (ransomware)' : ''}`;
    case 'cves': return `${it.cve}${it.score != null ? ` ${it.severity} ${it.score}` : ''} · ${it.summary}`;
    default: return src;
  }
}
const fmtN = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

// OTX names countries in full; match them to our ISO codes
const NAME_CC = Object.fromEntries(Object.entries(COUNTRIES).map(([cc, c]) => [c[2].toLowerCase(), cc]));
Object.assign(NAME_CC, { 'united states of america': 'US', 'russian federation': 'RU', 'korea, republic of': 'KR', "korea, democratic people's republic of": 'KP', 'united kingdom of great britain and northern ireland': 'GB', 'iran, islamic republic of': 'IR', 'viet nam': 'VN', 'taiwan, province of china': 'TW', 'czechia': 'CZ', 'syrian arab republic': 'SY', 'moldova, republic of': 'MD', 'türkiye': 'TR', 'turkey': 'TR' });
export const ccOfName = (n) => (n ? NAME_CC[n.toLowerCase()] || (n.length === 2 && COUNTRIES[n.toUpperCase()] ? n.toUpperCase() : null) : null);

// Incidents are grouped by country, and inside the US by state ("US-TX"); "US" holds US incidents
// whose state isn't known.
export const keyOf = (cc, region) => (cc === 'US' && region && US_STATES[region] ? `US-${region}` : cc);
// Country / US-state outlines (Natural Earth, built by scripts/build-borders.mjs). When a report
// names only a country, the globe lights that country's outline rather than pinning a made-up
// point at its centre.
let borders = null, bordersLoading = null;
export function loadBorders() {
  return (bordersLoading ||= fetch(`${import.meta.env.BASE_URL}data/borders.json`).then((r) => r.json()).then((d) => (borders = d.borders)).catch(() => null));
}
function outlineGeo(key, lift) {
  const rings = borders?.[key];
  if (!rings) return null;
  const pos = [], a = new THREE.Vector3(), b = new THREE.Vector3();
  for (const r of rings) for (let i = 0; i < r.length; i += 2) {
    const j = (i + 2) % r.length;
    latLon(r[i], r[i + 1], GLOBE_R * lift, a);
    latLon(r[j], r[j + 1], GLOBE_R * lift, b);
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}
// Where traffic for a place lands: a US state's centre, else the country's main internet hub
// city, else its centroid.
export function hubOf(key) {
  if (!key) return null;
  if (!key.startsWith('US-') && HUB_CITIES[key]) return HUB_CITIES[key];
  const p = placeOf(key);
  return p ? [p[0], p[1]] : null;
}

export function placeOf(key) {
  if (!key) return null; // some posts carry no country at all
  if (key.startsWith('US-')) {
    const st = US_STATES[key.slice(3)];
    return st ? [st[0], st[1], `${st[2]}, USA`] : null;
  }
  const c = COUNTRIES[key];
  return c ? [c[0], c[1], key === 'US' ? 'United States' : c[2]] : null;
}
const PLACED = ['ransomware', 'attackers', 'botnets', 'bruteforce', 'phishing', 'malware', 'abuseipdb'];
function summarize(d) {
  const by = {};
  const C = (k) => (by[k] = by[k] || { cc: k, ransomware: [], attackers: [], botnets: [], bruteforce: [], phishing: [], malware: [], abuseipdb: [], ddos: [], otx: [] });
  for (const src of PLACED) for (const v of d[src] || []) { const k = keyOf(v.country, v.region); if (placeOf(k)) C(k)[src].push(v); }
  for (const p of d.ddos || []) for (const cc of [p.from, p.to]) if (placeOf(cc)) C(cc).ddos.push(p);
  for (const p of d.otx || []) for (const n of p.targets) { const cc = ccOfName(n); if (cc && placeOf(cc)) C(cc).otx.push(p); }
  return by;
}

// Globe local frame matches the planet textures: +Y north, lon 0 at +X, east toward -Z.
export function latLon(lat, lon, r, out = new THREE.Vector3()) {
  const la = lat * D2R, lo = lon * D2R;
  return out.set(Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo)).multiplyScalar(r);
}

// A cable route as points on the surface: follow each leg, splitting long hops along the great
// circle. ts = each point's fraction of the way along.
function routePath(r) {
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
  return { pts, ts: new Float32Array(len.map((x) => x / total)), total };
}
// fallback when no cable route exists: a great-circle arc lifted off the surface
function liftedArc(from, to) {
  const va = latLon(from[0], from[1], 1), vb = latLon(to[0], to[1], 1), ang = va.angleTo(vb);
  if (ang < 1e-3) return null;
  const steps = Math.max(12, Math.ceil(ang / 0.02)), pts = [], ts = [];
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    const q = va.clone().multiplyScalar(Math.sin((1 - t) * ang)).addScaledVector(vb, Math.sin(t * ang)).divideScalar(Math.sin(ang));
    pts.push(q.multiplyScalar(GLOBE_R * (1.005 + Math.sin(Math.PI * t) * ang * 0.09)));
    ts.push(t);
  }
  return { pts, ts: new Float32Array(ts), total: ang };
}

// Route: a pulse travels along the cables from the reported origin (t = 0) to the victim (t = 1)
// at a constant speed over the globe, with a fixed-length trail.
const ARC_SPEED = 0.35; // radians of the globe per second
const ARC_VERT = /* glsl */ `attribute float aT; varying float vT; void main(){ vT = aT; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const ARC_FRAG = /* glsl */ `uniform float uTime; uniform float uPhase; uniform float uK; uniform float uLen; uniform vec3 uC0; uniform vec3 uC1; varying float vT;
void main(){
  float head = fract(uTime * ${ARC_SPEED.toFixed(2)} / uLen + uPhase);
  float d = (head - vT) * uLen; // radians behind the pulse
  float trail = d > 0.0 ? exp(-d * 5.0) : 0.0;
  vec3 c = mix(uC0, uC1, vT);
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

// View layers for the CYBER globe, and the presets the map bar offers.
export const CYBER_LAYERS = ['earth', 'clouds', 'cables', 'routes', 'threats', 'sats', 'labels'];
export const CYBER_PRESETS = {
  all: { earth: 1, clouds: 1, cables: 1, routes: 1, threats: 1, sats: 1, labels: 1 },
  clear: { earth: 1, clouds: 0, cables: 1, routes: 1, threats: 1, sats: 1, labels: 1 },
  cables: { earth: 0, clouds: 0, cables: 1, routes: 0, threats: 0, sats: 0, labels: 0 },
  threats: { earth: 1, clouds: 0, cables: 0, routes: 1, threats: 1, sats: 0, labels: 1 },
};

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
    this.labelsShown = false;
    this.layers = { ...CYBER_PRESETS.all };
    try { Object.assign(this.layers, JSON.parse(localStorage.getItem('openspace_cyber_layers') || '{}')); } catch {}
    // per-source toggles (independent of the view layers and presets); missing = on
    this.src = {};
    try { Object.assign(this.src, JSON.parse(localStorage.getItem('openspace_cyber_sources') || '{}')); } catch {}
    // live reports: one point cloud per source, plus short "strike" flashes as reports arrive
    this.live = new THREE.Group();
    this.group.add(this.live);
    // live satellite traffic (CelesTrak + SGP4), loaded the first time the globe is shown
    this.sats = new SatelliteLayer(GLOBE_R);
    this.group.add(this.sats.group);
    this.clouds = {};
    this.strikes = [];
    this.liveDirty = true;
  }

  setLayer(k, on) {
    this.layers[k] = on ? 1 : 0;
    try { localStorage.setItem('openspace_cyber_layers', JSON.stringify(this.layers)); } catch {}
    this.applyLayers();
  }
  sourceOn(id) { return this.src[id] !== 0; }
  setSource(id, on) {
    this.src[id] = on ? 1 : 0;
    try { localStorage.setItem('openspace_cyber_sources', JSON.stringify(this.src)); } catch {}
    this.applyLayers();
  }
  setPreset(name) {
    Object.assign(this.layers, CYBER_PRESETS[name]);
    this.setLayer('earth', this.layers.earth);
  }
  preset() {
    return Object.keys(CYBER_PRESETS).find((p) => CYBER_LAYERS.every((k) => !CYBER_PRESETS[p][k] === !this.layers[k])) || null;
  }
  applyLayers() {
    const L = this.layers, u = this.globe.material.uniforms;
    u.uDark.value = L.earth ? 0 : 1;
    u.uCloudK.value = L.clouds && L.earth ? 1 : 0;
    this.atmo.visible = !!L.earth;
    if (this.cables) this.cables.visible = !!L.cables;
    if (this.landCables) this.landCables.visible = !!L.cables;
    this.sats.group.visible = L.sats !== 0 && L.sats !== false;
    for (const l of this.sats.labels) l.element.style.display = this.sats.group.visible ? '' : 'none';
    for (const o of this.markers.children) o.visible = !!L[o.userData.layer || 'threats'] && this.sourceOn(o.userData.src);
    for (const o of this.live.children) o.visible = !!L.threats && this.sourceOn(o.userData.src);
    this.setLabelsVisible(this.labelsShown);
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
    const outlines = [], botStack = {};
    for (const cc in by) {
      const c = by[cc], [lat, lon, name] = placeOf(cc);
      const base = latLon(lat, lon, GLOBE_R);
      const n = base.clone().normalize();
      // ransomware: light column per country, height by incident count
      if (c.ransomware.length) {
        const k = c.ransomware.length, fresh = c.ransomware.some((v) => Date.parse(v.t) > recent);
        const h = 0.3 + Math.log2(k + 1) * 0.42;
        // leak sites name only the victim's country (or US state): light its outline, brighter
        // for more incidents, instead of planting a point at its centre
        outlines.push({ key: cc, color: fresh ? 0xff2bd6 : 0xb04cff, k: Math.min(1, 0.35 + 0.2 * Math.log2(k + 1)), src: 'ransomware', lift: 1.0025 });
        if (k >= Math.max(2, maxR * 0.15)) {
          const el = document.createElement('div');
          el.className = 'cyber-label';
          el.innerHTML = `<b>${cc === 'US' ? 'USA · state unknown' : name.replace(', USA', '')}</b><small>${k} ransomware</small>`;
          const l = new CSS2DObject(el);
          l.position.copy(base).addScaledVector(n, 0.35);
          l.userData.src = 'ransomware';
          this.markers.add(l);
          this.labels.push(l);
        }
      }
      // attack sources: amber pulsing rings at the attackers' real cities (clustered to ~100 km),
      // size by attacks seen. Attackers known only by country light its outline instead.
      const located = {};
      let unplaced = 0;
      for (const a of c.attackers) {
        if (a.lat == null) { unplaced += a.attacks; continue; }
        const g = (located[`${Math.round(a.lat)},${Math.round(a.lon)}`] ||= { lat: 0, lon: 0, n: 0, att: 0 });
        g.lat += a.lat; g.lon += a.lon; g.n++; g.att += a.attacks;
      }
      for (const g of Object.values(located)) this.attackRing(latLon(g.lat / g.n, g.lon / g.n, GLOBE_R), g.att, maxA, rnd(g.lon));
      if (unplaced) outlines.push({ key: cc, color: 0xffb347, k: 0.6, src: 'attackers', lift: 1.0035 });
      // botnet command servers: red diamonds over the server's own city (stacked when several
      // share one); servers known only by country hover over its hub and light its outline
      let unknownBot = false;
      c.botnets.forEach((b) => {
        const d = new THREE.Mesh(new THREE.OctahedronGeometry(0.12), new THREE.MeshBasicMaterial({ color: new THREE.Color(b.status === 'online' ? 0xff2a3a : 0x803038).multiplyScalar(b.status === 'online' ? 2.5 : 1) }));
        const at = b.lat != null ? [b.lat, b.lon] : hubOf(cc) || [lat, lon];
        if (b.lat == null) unknownBot = true;
        const sk = `${at[0].toFixed(1)},${at[1].toFixed(1)}`;
        const stack = (botStack[sk] = (botStack[sk] || 0) + 1) - 1;
        const bp = latLon(at[0], at[1], GLOBE_R);
        d.position.copy(bp).addScaledVector(bp.clone().normalize(), 0.3 + stack * 0.24);
        d.userData = { spin: true, src: 'botnets' };
        this.markers.add(d);
      });
      if (unknownBot) outlines.push({ key: cc, color: 0xff2a3a, k: 0.6, src: 'botnets', lift: 1.004 });
      // OTX campaigns: a slow blue square pulse on each targeted country, size by campaign count
      // OTX campaigns name targeted countries: outline them in blue, brighter for more campaigns
      if (c.otx.length) outlines.push({ key: cc, color: 0x7aa2ff, k: Math.min(1, 0.4 + 0.2 * Math.log2(c.otx.length + 1)), src: 'otx', lift: 1.0045 });
    }
    this.columns = cols;
    this.drawOutlines(outlines);
    this.buildArcs(data);
    this.buildDdos(data.ddos || []);
  }

  // Cloudflare Radar DDoS pairs, routed over the submarine cables like the ransomware pulses (the
  // shortest plausible path between the two countries, not a traced one), in orange-red; brightness
  // by the pair's share of attacks. Pairs the cable graph can't connect keep a lifted arc.
  buildDdos(pairs) {
    if (!pairs.length) return;
    const maxS = Math.max(...pairs.map((p) => p.share), 1e-6);
    const c0 = new THREE.Color(1.0, 0.55, 0.1), c1 = new THREE.Color(1.0, 0.12, 0.08);
    const markers = this.markers;
    loadCables().then(() => {
      if (this.markers !== markers) return; // rebuilt meanwhile
      cyber.ddosRoutes = [];
      pairs.forEach((p, i) => {
        const a = hubOf(p.from), b = hubOf(p.to);
        if (!a || !b) return;
        const r = route(ORIGIN_HUBS[p.from] || a, b);
        const path = r ? routePath(r) : liftedArc(a, b);
        if (!path) return;
        if (r) cyber.ddosRoutes.push({ ...p, km: r.km, cables: [...new Set(r.legs.map((l) => l.cable).filter(Boolean))] });
        const k = 0.3 + 0.7 * (p.share / maxS);
        this.addPulse(path, (i * 0.37) % 1, k, c0, c1, 0xff6a2a, 'ddos');
      });
      this.applyLayers();
    });
  }

  // a pulse running along a path, with a glowing head
  addPulse({ pts, ts, total }, phase, k, c0, c1, headColor, src) {
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    geo.setAttribute('aT', new THREE.BufferAttribute(ts, 1));
    const line = new THREE.Line(geo, new THREE.ShaderMaterial({
      uniforms: { uTime: { value: this.time }, uPhase: { value: phase }, uK: { value: k }, uLen: { value: total }, uC0: { value: c0 }, uC1: { value: c1 } },
      vertexShader: ARC_VERT, fragmentShader: ARC_FRAG, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    line.userData = { layer: 'routes', src };
    this.markers.add(line);
    const head = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color: new THREE.Color(headColor).multiplyScalar(1.8), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    head.scale.setScalar(0.18 + 0.16 * k);
    head.userData = { layer: 'routes', src };
    this.markers.add(head);
    this.arcs.push({ pts, ts, head, phase, len: total });
  }

  // Live point clouds (rebuilt when reports arrive) and the pickable country hit list.
  buildLive(data, by) {
    this.liveDirty = false;
    if (!data) return;
    const liveKeys = {};
    for (const id in SOURCE_STYLE) {
      if (SOURCE_STYLE[id].globe !== 'points') continue;
      const items = (data[id] || []).filter((it) => cyber.arrived.has(it.id));
      let cloud = this.clouds[id];
      if (!cloud) {
        cloud = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ map: this.glow, size: 0.32, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
        cloud.userData.src = id;
        this.clouds[id] = cloud;
        this.live.add(cloud);
      }
      // brighter the newer; an hour-old report is a faint ember
      const pos = [], col = [], base = new THREE.Color(SOURCE_STYLE[id].css), v = new THREE.Vector3(), now = Date.now();
      for (const it of items) {
        // a report placed only by country lights that country's outline, not a point at its centre
        if (it.lat == null) { const k = keyOf(it.country, it.region); if (placeOf(k)) (liveKeys[id] ||= new Set()).add(k); continue; }
        const w = whereOf(it);
        if (!w) continue;
        latLon(w[0], w[1], GLOBE_R * 1.006, v);
        pos.push(v.x, v.y, v.z);
        const age = Math.max(0, (now - Date.parse(it.t)) / 3600e3);
        const k = 0.35 + 1.4 * Math.exp(-age * 2);
        col.push(base.r * k, base.g * k, base.b * k);
      }
      cloud.geometry.dispose();
      cloud.geometry = new THREE.BufferGeometry();
      cloud.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      cloud.geometry.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    }
    // outlines for this round's unlocated reports, in each source's colour
    for (const m of this.liveOutlines || []) { this.live.remove(m); m.geometry.dispose(); m.material.dispose(); }
    this.liveOutlines = [];
    if (borders) for (const id in liveKeys) for (const key of liveKeys[id]) {
      const m = this.outlineMesh({ key, color: SOURCE_STYLE[id].css, k: 0.5, src: id, lift: 1.005 });
      if (m) { this.live.add(m); this.liveOutlines.push(m); }
    } else loadBorders().then(() => { this.liveDirty = true; });
    this.hits = [];
    for (const cc in by) {
      const p = placeOf(cc);
      const base = latLon(p[0], p[1], GLOBE_R);
      this.hits.push({ pos: base.addScaledVector(base.clone().normalize(), 0.3), cc });
    }
    this.applyLayers();
  }

  // a report just arrived: a beam and an expanding ring at its location, ~2.5 s
  strike(ev) {
    const w = whereOf(ev.it), st = SOURCE_STYLE[ev.src];
    if (!w || !st?.globe || !this.sourceOn(ev.src) || !this.layers.threats) return;
    // known only by country: flash the country's outline instead of a beam at its centre
    if (ev.it.lat == null && borders) {
      const m = this.outlineMesh({ key: keyOf(ev.it.country, ev.it.region), color: st.css, k: 1, src: ev.src, lift: 1.006 });
      if (m) {
        m.userData.glow = null;
        const g = new THREE.Group();
        g.add(m);
        g.userData.src = ev.src;
        this.live.add(g);
        this.strikes.push({ g, outline: m, age: 0 });
        while (this.strikes.length > 40) this.endStrike(this.strikes.shift());
        return;
      }
    }
    const p = latLon(w[0], w[1], GLOBE_R), n = p.clone().normalize();
    const c = new THREE.Color(st.css);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 32), new THREE.MeshBasicMaterial({ color: c.clone().multiplyScalar(2.6), transparent: true, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
    ring.position.copy(p).addScaledVector(n, 0.04);
    ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    const h = 1.6, beamGeo = new THREE.CylinderGeometry(0.012, 0.05, h, 6, 1, true);
    beamGeo.translate(0, h / 2, 0);
    const beam = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({ color: c.clone().multiplyScalar(3), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    beam.position.copy(p);
    beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
    const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color: c.clone().multiplyScalar(2.5), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    flash.position.copy(p).addScaledVector(n, 0.08);
    const g = new THREE.Group();
    g.add(ring, beam, flash);
    g.userData.src = ev.src;
    this.live.add(g);
    this.strikes.push({ g, ring, beam, flash, age: 0 });
    while (this.strikes.length > 40) this.endStrike(this.strikes.shift());
  }
  endStrike(s) {
    this.live.remove(s.g);
    s.g.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); });
  }

  attackRing(p, att, maxA, phase) {
    const n = p.clone().normalize();
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 40), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffb347).multiplyScalar(2.2), transparent: true, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
    ring.position.copy(p).addScaledVector(n, 0.03);
    ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    ring.userData = { pulse: true, s: 0.2 + 0.5 * Math.sqrt(att / maxA), phase, src: 'attackers' };
    this.markers.add(ring);
    const dot = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color: new THREE.Color(0xffb347).multiplyScalar(1.4), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    dot.position.copy(ring.position);
    dot.scale.setScalar(0.3);
    dot.userData.src = 'attackers';
    this.markers.add(dot);
  }

  // glowing country / state outlines (borders load once, in the background)
  outlineMesh(o) {
    const geo = outlineGeo(o.key, o.lift);
    if (!geo) return null;
    const m = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: new THREE.Color(o.color).multiplyScalar(2.2), transparent: true, opacity: o.k, blending: THREE.AdditiveBlending, depthWrite: false }));
    m.userData = { src: o.src, glow: { base: o.k, phase: (o.key.charCodeAt(0) + (o.key.charCodeAt(1) || 0)) * 0.37 } };
    return m;
  }
  drawOutlines(list) {
    const markers = this.markers;
    loadBorders().then(() => {
      if (this.markers !== markers) return; // rebuilt meanwhile
      for (const o of list) {
        const m = this.outlineMesh(o);
        if (m) { this.markers.add(m); continue; }
        // no outline for this place (a tiny island state): a soft glow at its centre instead
        const pl = placeOf(o.key);
        if (!pl) continue;
        const g = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color: new THREE.Color(o.color).multiplyScalar(1.4), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
        g.position.copy(latLon(pl[0], pl[1], GLOBE_R * 1.01));
        g.scale.setScalar(0.4);
        g.userData.src = o.src;
        this.markers.add(g);
      }
      this.applyLayers();
    });
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
      const p = (pairs[key] = pairs[key] || { cc: o.cc, to: [...(hubOf(tk) || tp), tp[2]], n: 0, groups: new Set() });
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
        const { pts, ts, total } = routePath(r);
        const geo = new THREE.BufferGeometry().setFromPoints(pts);
        geo.setAttribute('aT', new THREE.BufferAttribute(ts, 1));
        const kk = 0.35 + 0.65 * (p.n / maxN);
        const line = new THREE.Line(geo, new THREE.ShaderMaterial({
          uniforms: { uTime: { value: this.time }, uPhase: { value: rnd(i + 1) }, uK: { value: kk }, uLen: { value: total }, uC0: { value: new THREE.Color(1.0, 0.16, 0.24) }, uC1: { value: new THREE.Color(1.0, 0.17, 0.84) } },
          vertexShader: ARC_VERT, fragmentShader: ARC_FRAG, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
        }));
        line.userData = { layer: 'routes', src: 'ransomware' };
        this.markers.add(line);
        const head = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color: new THREE.Color(0xff3cb0).multiplyScalar(1.8), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
        head.scale.setScalar(0.18 + 0.16 * kk);
        head.userData = { layer: 'routes', src: 'ransomware' };
        this.markers.add(head);
        this.arcs.push({ pts, ts, head, phase: rnd(i + 1), len: total });
      });
      cyber.routes.sort((x, y) => y.n - x.n);
      this.applyLayers();
    });
    // reported bases: a red hexagon at the country's main internet hub + label naming the groups
    for (const cc in origins) {
      const [la, lo] = ORIGIN_HUBS[cc] || hubOf(cc), name = COUNTRIES[cc][2];
      const pos = latLon(la, lo, GLOBE_R), n = pos.clone().normalize();
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.5, 6), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff2a3a).multiplyScalar(2.4), transparent: true, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
      ring.position.copy(pos).addScaledVector(n, 0.04);
      ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
      ring.userData = { pulse: true, s: 1.4, phase: 0.5, layer: 'routes', src: 'ransomware' };
      this.markers.add(ring);
      const el = document.createElement('div');
      el.className = 'cyber-label origin';
      el.innerHTML = `<b>REPORTED BASE · ${name}</b><small>${[...origins[cc]].join(', ')}</small>`;
      const l = new CSS2DObject(el);
      l.position.copy(pos).addScaledVector(n, 0.9);
      l.userData = { layer: 'routes', src: 'ransomware' };
      this.markers.add(l);
      this.labels.push(l);
    }
    this.arcStats = { pairs: list.length, attributed: list.reduce((x, p) => x + p.n, 0) };
    this.applyLayers();
  }

  // name the crewed stations so they stand out in the swarm
  labelSats() {
    for (const s of this.sats.sats) {
      if (SAT_GROUPS[s.g].id !== 'stations') continue;
      const el = document.createElement('div');
      el.className = 'cyber-label sat';
      el.innerHTML = `<b>${/ISS/.test(s.name) ? 'ISS' : 'TIANGONG'}</b><small>crewed station · live</small>`;
      const l = new CSS2DObject(el);
      l.userData.sat = s;
      this.sats.group.add(l);
      this.sats.labels.push(l);
    }
    this.applyLayers();
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
    this.cables.visible = !!this.layers.cables;
    this.group.add(this.cables);
    // terrestrial backbones (src/data/landRoutes.js): warm amber, so land and sea fiber read apart
    const lp = [];
    for (const r of net.landRoutes || []) for (let i = 1; i < r.idx.length; i++) {
      latLon(net.lat(r.idx[i - 1]), net.lon(r.idx[i - 1]), 1, a);
      latLon(net.lat(r.idx[i]), net.lon(r.idx[i]), 1, b);
      const steps = Math.max(1, Math.ceil(a.angleTo(b) / 0.02));
      prev.copy(a);
      for (let k = 1; k <= steps; k++) {
        q.copy(a).lerp(b, k / steps).normalize();
        lp.push(prev.x * GLOBE_R * 1.0025, prev.y * GLOBE_R * 1.0025, prev.z * GLOBE_R * 1.0025, q.x * GLOBE_R * 1.0025, q.y * GLOBE_R * 1.0025, q.z * GLOBE_R * 1.0025);
        prev.copy(q);
      }
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
    this.landCables = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: new THREE.Color(0xffb347).multiplyScalar(1.3), transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.landCables.visible = !!this.layers.cables;
    this.group.add(this.landCables);
  }

  // real day/night: the Sun's direction in Earth-fixed coordinates = globe local frame
  update(dt, t, camera) {
    this.time += dt;
    if (!this.sats.loading) this.sats.load().then(() => this.labelSats()).catch(() => {});
    this.sats.update(dt, t);
    // CSS labels don't get hidden by the globe: hide those on the far side
    const camDir = camera.position.clone().normalize();
    for (const l of this.labels) l.element.style.visibility = this.layers.labels && l.position.clone().normalize().dot(camDir) > 0.1 ? 'visible' : 'hidden';
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
      else if (m.userData.glow) m.material.opacity = m.userData.glow.base * (0.7 + 0.3 * Math.sin(this.time * 1.6 + m.userData.glow.phase));
      else if (m.material?.uniforms?.uTime) m.material.uniforms.uTime.value = this.time;
    }
    // live reports: release what's due, flash them in, and refresh the point clouds once a second
    for (const ev of drainQueue()) { if (!ev.stale) this.strike(ev); this.liveDirty = true; }
    if (this.liveDirty && (this.liveAcc = (this.liveAcc || 0) + dt) > 1) { this.liveAcc = 0; this.buildLive(cyber.data, cyber.byCountry); }
    for (let i = this.strikes.length - 1; i >= 0; i--) {
      const s = this.strikes[i], f = (s.age += dt) / 2.5;
      if (f >= 1) { this.endStrike(s); this.strikes.splice(i, 1); continue; }
      if (s.outline) { s.outline.material.opacity = (1 - f) * (0.65 + 0.35 * Math.cos(f * 40)); continue; }
      s.ring.scale.setScalar(0.1 + f * 0.9);
      s.ring.material.opacity = 1 - f;
      s.beam.scale.set(1, Math.min(1, f * 6) * (1 - f), 1);
      s.beam.material.opacity = 1 - f;
      s.flash.scale.setScalar(0.9 * (1 - f) + 0.15);
      s.flash.material.opacity = 1 - f * f;
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
    this.labelsShown = on;
    for (const l of this.labels) l.element.style.display = on ? '' : 'none';
  }
}
