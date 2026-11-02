import * as THREE from 'three';
import { makeSky } from './sky.js';
import { glowSprite, NOISE } from './shaders.js';
import { weather, WEATHER_CREDIT } from './weather.js';
import { makeSkiff, setThrust } from './models.js';
import { bodyQuat, planetTexture } from './planets.js';
import { BODY, helioAU } from '../sim/orbits.js';
import { simNow, emit } from '../sim/state.js';
import { haptic } from '../telegram.js';
import { FutureEarth, FUTURE_CITIES } from './futureEarth.js';

// Atmospheric flight over the real Earth. Terrain heights stream from AWS Terrain Tiles
// (Terrarium encoding: SRTM, GMTED, ETOPO1) and imagery from Sentinel-2 cloudless 2016 by EOX
// (CC BY 4.0). Tiles are Web-Mercator XYZ, laid out in a local azimuthal-equidistant frame around
// a floating origin (x = east, y = up, -z = north, metres). The vertex shader bends the ground
// away from the camera so the horizon curves like the real planet.

const R = 6371000, D2R = Math.PI / 180;
const IMAGERY = (z, x, y) => `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/${z}/${y}/${x}.jpg`;
const TERRAIN = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
export const ATTRIBUTION = `Imagery: Sentinel-2 cloudless 2016 by EOX (CC BY 4.0, modified Copernicus data) · Terrain: AWS Terrain Tiles (SRTM, GMTED, ETOPO1) · ${WEATHER_CREDIT}`;
const SEG = 32; // quads per tile edge (+1 skirt ring)
const K = 2; // tiles each side of the player per level (5 x 5)
const RECENTER = 30000;

export const PLACES = [
  { id: 'singapore', name: 'Singapore', lat: 1.2903, lon: 103.8519 },
  { id: 'fuji', name: 'Mount Fuji, Japan', lat: 35.3606, lon: 138.7274 },
  { id: 'tokyo', name: 'Tokyo, Japan', lat: 35.6812, lon: 139.7671 },
  { id: 'everest', name: 'Mount Everest, Nepal', lat: 27.9881, lon: 86.925 },
  { id: 'dubai', name: 'Dubai, UAE', lat: 25.1972, lon: 55.2744 },
  { id: 'paris', name: 'Paris, France', lat: 48.8584, lon: 2.2945 },
  { id: 'matterhorn', name: 'Matterhorn, Alps', lat: 45.9763, lon: 7.6586 },
  { id: 'reykjavik', name: 'Reykjavík, Iceland', lat: 64.1466, lon: -21.9426 },
  { id: 'nyc', name: 'New York, USA', lat: 40.7484, lon: -73.9857 },
  { id: 'canaveral', name: 'Cape Canaveral, USA', lat: 28.5729, lon: -80.649 },
  { id: 'grandcanyon', name: 'Grand Canyon, USA', lat: 36.0544, lon: -112.1401 },
  { id: 'maunakea', name: 'Mauna Kea, Hawaiʻi', lat: 19.8207, lon: -155.4681 },
  { id: 'rio', name: 'Rio de Janeiro, Brazil', lat: -22.9519, lon: -43.2105 },
  { id: 'kilimanjaro', name: 'Kilimanjaro, Tanzania', lat: -3.0674, lon: 37.3556 },
  { id: 'capetown', name: 'Cape Town, South Africa', lat: -33.9628, lon: 18.4098 },
  { id: 'sydney', name: 'Sydney, Australia', lat: -33.8568, lon: 151.2153 },
];

// ---------------------------------------------------------------- geodesy
const latOfRow = (y, n) => Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) / D2R;
const lonOfCol = (x, n) => (x / n) * 360 - 180;
function tileXY(lat, lon, z) {
  const n = 2 ** z, l = THREE.MathUtils.clamp(lat, -85, 85) * D2R;
  return [((lon + 180) / 360) * n, ((1 - Math.log(Math.tan(l) + 1 / Math.cos(l)) / Math.PI) / 2) * n];
}
// great-circle distance (m) and initial bearing (rad, clockwise from north)
export function gc(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * D2R, p2 = lat2 * D2R, dl = (lon2 - lon1) * D2R;
  const c = Math.acos(THREE.MathUtils.clamp(Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos(dl), -1, 1));
  const b = Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl));
  return { d: c * R, b };
}
// azimuthal-equidistant projection around the origin → scene x (east), z (-north)
function project(o, lat, lon, out) {
  const { d, b } = gc(o.lat, o.lon, lat, lon);
  out.x = d * Math.sin(b);
  out.z = -d * Math.cos(b);
  return out;
}
function unproject(o, x, z) {
  const c = Math.hypot(x, z) / R, th = Math.atan2(x, -z);
  const p0 = o.lat * D2R;
  const p = Math.asin(Math.sin(p0) * Math.cos(c) + Math.cos(p0) * Math.sin(c) * Math.cos(th));
  const l = o.lon * D2R + Math.atan2(Math.sin(th) * Math.sin(c) * Math.cos(p0), Math.cos(c) - Math.sin(p0) * Math.sin(p));
  return { lat: p / D2R, lon: ((l / D2R + 540) % 360) - 180 };
}

// ---------------------------------------------------------------- tile data (cached, shared)
const CACHE = new Map();
const queue = [];
let inflight = 0;
function tileData(z, x, y) {
  const key = `${z}/${x}/${y}`;
  let t = CACHE.get(key);
  if (!t) {
    t = { z, x, y, key, tex: null, h: null, used: 0, wanted: true };
    CACHE.set(key, t);
    queue.push(t);
  }
  t.used = performance.now();
  return t;
}
async function fetchBitmap(url) {
  const r = await fetch(url, { mode: 'cors' });
  if (!r.ok) throw new Error(r.status);
  return createImageBitmap(await r.blob());
}
const hc = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(256, 256) : Object.assign(document.createElement('canvas'), { width: 256, height: 256 });
const hg = hc.getContext('2d', { willReadFrequently: true });
async function loadTile(t) {
  inflight++;
  const tz = Math.min(t.z, 14); // terrain tiles stop at z15; z14 is plenty
  const img = fetchBitmap(IMAGERY(t.z, t.x, t.y)).then((bmp) => {
    const tex = new THREE.Texture(bmp);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.needsUpdate = true;
    t.tex = tex;
  }).catch(() => {});
  const dem = fetchBitmap(TERRAIN(tz, t.x >> (t.z - tz), t.y >> (t.z - tz))).then((bmp) => {
    hg.drawImage(bmp, 0, 0);
    const d = hg.getImageData(0, 0, 256, 256).data;
    const h = new Float32Array((SEG + 1) * (SEG + 1));
    for (let j = 0; j <= SEG; j++) for (let i = 0; i <= SEG; i++) {
      const px = Math.min(255, Math.round((i / SEG) * 255)), py = Math.min(255, Math.round((j / SEG) * 255));
      const k = (py * 256 + px) * 4;
      h[j * (SEG + 1) + i] = d[k] * 256 + d[k + 1] + d[k + 2] / 256 - 32768;
    }
    t.h = h;
  }).catch(() => {});
  await Promise.all([img, dem]);
  t.loaded = true;
  t.version = (t.version || 0) + 1;
  inflight--;
}
function pump() {
  queue.sort((a, b) => b.prio - a.prio);
  while (inflight < 8 && queue.length) {
    const t = queue.shift();
    if (t.wanted) loadTile(t);
    else CACHE.delete(t.key);
  }
  if (CACHE.size > 420) {
    const old = [...CACHE.values()].filter((t) => !t.wanted && t.loaded).sort((a, b) => a.used - b.used);
    for (const t of old.slice(0, CACHE.size - 380)) { t.tex?.dispose(); CACHE.delete(t.key); }
  }
}

// ---------------------------------------------------------------- terrain material
const TERRAIN_VERT = /* glsl */ `
attribute vec2 aMerc; attribute vec2 aGeo; attribute float aWater;
uniform vec3 uCam;
varying vec2 vUv; varying vec2 vMerc; varying vec2 vGeo; varying float vWater; varying vec3 vN; varying vec3 vW; varying float vDist;
void main(){
  vec3 p = position;
  vec2 d = p.xz - uCam.xz;
  float dd = dot(d, d);
  p.y -= dd / (2.0 * 6371000.0); // planetary curvature, relative to the camera
  vUv = uv; vMerc = aMerc; vGeo = aGeo; vWater = aWater; vN = normal; vW = p;
  vDist = sqrt(dd + (p.y - uCam.y) * (p.y - uCam.y));
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;
const TERRAIN_FRAG = /* glsl */ `
uniform sampler2D uMap; uniform sampler2D uGlobal; uniform sampler2D uLights; uniform float uHasMap;
uniform vec4 uHole; uniform vec3 uSun; uniform float uDay; uniform vec3 uCam; uniform vec3 uFog; uniform float uFogK; uniform vec3 uSky;
uniform vec4 uCities[4]; uniform float uTime; uniform sampler2D uClouds;
float gridLine(float x, float s, float w){ float d = abs(fract(x / s + 0.5) - 0.5) * s; return 1.0 - smoothstep(w, w + fwidth(x) * 1.5, d); }
varying vec2 vUv; varying vec2 vMerc; varying vec2 vGeo; varying float vWater; varying vec3 vN; varying vec3 vW; varying float vDist;
void main(){
  if (vMerc.x > uHole.x && vMerc.x < uHole.z && vMerc.y > uHole.y && vMerc.y < uHole.w) discard; // a finer level draws here
  vec3 albedo = uHasMap > 0.5 ? texture2D(uMap, vUv).rgb : texture2D(uGlobal, vec2(fract(vGeo.y / 360.0 + 0.5), 0.5 + vGeo.x / 180.0)).rgb;
  vec3 N = normalize(vN), L = normalize(uSun);
  float ndl = max(dot(N, L), 0.0);
  vec3 col = albedo * (vec3(1.0, 0.96, 0.9) * ndl * 1.25 * uDay + uSky * (0.35 * uDay) + vec3(0.025, 0.03, 0.045));
  // night side: real city lights (NASA Black Marble via the 2k Earth night map)
  vec3 lights = texture2D(uLights, vec2(fract(vGeo.y / 360.0 + 0.5), 0.5 + vGeo.x / 180.0)).rgb;
  col += lights * lights * vec3(1.0, 0.75, 0.45) * (1.0 - uDay) * (1.0 - vWater);
  if (vWater > 0.5) {
    vec3 V = normalize(uCam - vW);
    float sp = pow(max(dot(reflect(-L, vec3(0.0, 1.0, 0.0)), V), 0.0), 120.0);
    float fr = pow(clamp(1.0 - V.y, 0.0, 1.0), 4.0);
    col = mix(col, uSky * (0.4 * uDay + 0.03), fr * 0.6) + vec3(1.0, 0.92, 0.8) * sp * 2.0 * uDay;
  }
  // 2087: neon street grids light up the megacities (brightest at night)
  for (int i = 0; i < 4; i++) {
    vec4 c = uCities[i];
    if (c.w < 0.5) continue;
    vec2 q = vW.xz - c.xy;
    float k = exp(-dot(q, q) / (c.z * c.z * 0.6)) * (1.0 - vWater) * (1.0 - smoothstep(25000.0, 70000.0, vDist));
    if (k < 0.01) continue;
    float minor = max(gridLine(q.x, 160.0, 3.0), gridLine(q.y, 160.0, 3.0));
    float major = max(gridLine(q.x, 800.0, 7.0), gridLine(q.y, 800.0, 7.0));
    float pulse = step(0.93, fract((q.x + q.y) / 1600.0 - uTime * 0.15));
    vec3 neon = vec3(0.0, 0.75, 1.0) * minor * 0.22 + vec3(1.0, 0.15, 0.8) * major * (0.8 + pulse * 2.0);
    col += neon * k * (0.08 + 1.0 * (1.0 - uDay));
  }
  // seen from high up, today's real cloud cover lies over the distant ground
  float cov = texture2D(uClouds, vec2(fract(vGeo.y / 360.0 + 0.5), 0.5 + vGeo.x / 180.0)).r;
  float farC = smoothstep(90000.0, 160000.0, vDist);
  col = mix(col, vec3(0.88) * (max(uSun.y, 0.0) * 0.75 * uDay + 0.16 * uDay + 0.02), cov * farC * 0.92);
  float f = 1.0 - exp(-vDist * uFogK); // aerial perspective
  gl_FragColor = vec4(mix(col, uFog, clamp(f, 0.0, 1.0)), 1.0);
}`;

// ---------------------------------------------------------------- sky
// Cloud deck ~2.2 km up: where real satellite cover says "cloudy", fractal noise fills in the
// shapes; clear skies stay clear. Noise runs in absolute metres so it doesn't jump on recentring.
const CLOUD_VERT = /* glsl */ `
uniform vec3 uCam;
varying vec3 vW; varying float vDist;
void main(){
  vec4 w = modelMatrix * vec4(position, 1.0);
  vec2 d = w.xz - uCam.xz;
  w.y -= dot(d, d) / (2.0 * 6371000.0);
  vW = w.xyz;
  vDist = distance(w.xyz, uCam);
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const CLOUD_FRAG = /* glsl */ `
uniform sampler2D uClouds; uniform vec2 uOrigin; uniform vec2 uOffset; uniform vec3 uSun; uniform float uDay;
uniform vec3 uFog; uniform float uFogK; uniform float uTime;
varying vec3 vW; varying float vDist;
${NOISE}
void main(){
  float lat = uOrigin.x + (-vW.z / 6371000.0) * 57.29578;
  float lon = uOrigin.y + (vW.x / (6371000.0 * cos(uOrigin.x * 0.0174533))) * 57.29578;
  float cov = texture2D(uClouds, vec2(fract(lon / 360.0 + 0.5), 0.5 + lat / 180.0)).r;
  vec2 m = vW.xz + uOffset + vec2(uTime * 12.0, uTime * 3.0); // drifting with the wind
  float n = fbm(vec3(m / 5200.0, 0.0)) * 0.62 + fbm(vec3(m / 1400.0, 3.1)) * 0.28 + noise(vec3(m / 380.0, 7.7)) * 0.1;
  float a = smoothstep(0.66 - 0.5 * cov, 0.84 - 0.5 * cov, n) * smoothstep(0.03, 0.18, cov);
  a *= 1.0 - smoothstep(110000.0, 160000.0, vDist);
  if (a < 0.01) discard;
  float lit = max(uSun.y, 0.0) * 0.72 * uDay + 0.16 * uDay + 0.02;
  // billowy tops: brighter crests, grey-blue hollows
  float shape = smoothstep(0.25, 0.95, n + noise(vec3(m / 900.0, 2.0)) * 0.25);
  vec3 col = mix(vec3(0.55, 0.6, 0.7), vec3(1.0, 0.99, 0.97), shape) * lit;
  col = mix(col, uFog, clamp(1.0 - exp(-vDist * uFogK), 0.0, 1.0));
  gl_FragColor = vec4(col, a * 0.92);
}`;

const SKY_FRAG = /* glsl */ `
uniform vec3 uSun; uniform float uAlt; uniform float uDay; uniform vec3 uGlow;
varying vec3 vP;
void main(){
  vec3 d = normalize(vP), L = normalize(uSun);
  float thin = smoothstep(15000.0, 75000.0, uAlt); // above ~75 km the sky is black
  float el = d.y;
  vec3 zenith = mix(vec3(0.09, 0.26, 0.72), vec3(0.0), thin);
  vec3 horizon = mix(vec3(0.62, 0.76, 0.95), vec3(0.18, 0.35, 0.75), thin);
  float h = pow(1.0 - clamp(el + 0.05, 0.0, 1.0), 3.0);
  vec3 col = mix(zenith, horizon, h);
  float sunEl = L.y;
  float dusk = smoothstep(0.25, 0.0, abs(sunEl)) * (1.0 - thin);
  float toward = pow(max(dot(normalize(vec3(d.x, 0.0, d.z)), normalize(vec3(L.x, 0.0, L.z))), 0.0), 3.0);
  col = mix(col, vec3(1.0, 0.45, 0.18), dusk * h * (0.35 + 0.65 * toward) * 0.85);
  float mie = pow(max(dot(d, L), 0.0), 60.0);
  col += vec3(1.0, 0.85, 0.6) * mie * 0.8 * (1.0 - thin * 0.7);
  col *= uDay;
  float a = uDay * (1.0 - thin * 0.92);
  // neon light pollution hanging over the megacities at night
  float glow = h * (1.0 - uDay) * (1.0 - thin);
  col += uGlow * glow;
  a = max(a, length(uGlow) * glow);
  gl_FragColor = vec4(col, a);
}`;

export class EarthView {
  constructor(app) {
    this.app = app;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, 1, 1, 2e6);
    this.stars = makeSky({ mw: 0.16 });
    this.scene.add(this.stars);
    this.skyDome = new THREE.Mesh(new THREE.SphereGeometry(8500, 48, 24), new THREE.ShaderMaterial({
      uniforms: { uSun: { value: new THREE.Vector3(0, 1, 0) }, uAlt: { value: 0 }, uDay: { value: 1 }, uGlow: { value: new THREE.Color() } },
      vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      // drawn in the opaque pass (before terrain) but still alpha-blended over the stars
      fragmentShader: SKY_FRAG, side: THREE.BackSide, transparent: false, depthWrite: false, depthTest: false,
      blending: THREE.CustomBlending, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    }));
    this.skyDome.renderOrder = -8;
    this.scene.add(this.skyDome);
    this.sunSprite = glowSprite(0xfff2d8, 420, 3);
    this.scene.add(this.sunSprite);
    this.sun = new THREE.DirectionalLight(0xfff4e6, 3);
    this.hemi = new THREE.HemisphereLight(0x8fb6ff, 0x2a2a28, 0.5);
    this.scene.add(this.sun, this.hemi);

    this.skiff = makeSkiff();
    this.scene.add(this.skiff);
    this.plasma = glowSprite(0xff7a30, 16, 2);
    this.plasma.material.opacity = 0;
    this.skiff.add(this.plasma);
    this.plasma.position.set(0, -0.3, 2.6);

    this.cloudDeck = new THREE.Mesh(new THREE.PlaneGeometry(330000, 330000, 120, 120).rotateX(-Math.PI / 2), new THREE.ShaderMaterial({
      uniforms: {
        uClouds: { value: weather.texture }, uCam: { value: new THREE.Vector3() }, uOrigin: { value: new THREE.Vector2() }, uOffset: { value: new THREE.Vector2() },
        uSun: { value: new THREE.Vector3(0, 1, 0) }, uDay: { value: 1 }, uFog: { value: new THREE.Color() }, uFogK: { value: 0 }, uTime: { value: 0 },
      },
      vertexShader: CLOUD_VERT, fragmentShader: CLOUD_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    }));
    this.cloudDeck.frustumCulled = false;
    this.cloudDeck.renderOrder = 3;
    this.scene.add(this.cloudDeck);
    this.terrain = new THREE.Group();
    this.scene.add(this.terrain);
    this.meshes = new Map();
    this.levelMats = [];
    this.globalTex = planetTexture('earth');
    this.lightsTex = planetTexture('earth_night');
    this.future = new FutureEarth(this);
    this.info = { alt: 0, agl: 0, speed: 0, lat: 0, lon: 0, mach: 0, target: null, markers: [], autopilot: false, local: '', sun: { x: 0, y: 0, vis: 0 } };
    this.time = 0;
  }

  // Enter the atmosphere above a real point (from the station's ground track), 100 km up.
  enter(lat, lon, alt = 100000) {
    this.origin = { lat, lon };
    this.pos = new THREE.Vector3(0, alt, 0);
    this.originM = { x: 0, z: 0 };
    this.yaw = 60 * D2R; this.pitch = -0.12; this.speed = 7600;
    this.lookYaw = 0; this.lookPitch = 0;
    this.autopilot = false;
    this.target = this.target || null;
    for (const m of this.meshes.values()) { this.terrain.remove(m); m.geometry.dispose(); }
    this.meshes.clear();
    this.tileAcc = 99;
    this.updateGeo();
  }

  setTarget(id) {
    this.target = PLACES.find((p) => p.id === id) || null;
    if (this.target) emit('toast', { text: `Nav target · ${this.target.name}`, kind: '' });
  }
  setAutopilot(on) {
    this.autopilot = on && !!this.target;
    emit('toast', { text: this.autopilot ? `Autopilot · ${this.target.name}` : 'Manual flight', kind: '' });
  }

  levelMat(i) {
    if (this.levelMats[i]) return this.levelMats[i];
    const u = {
      uCam: { value: new THREE.Vector3() }, uHole: { value: new THREE.Vector4(2, 2, 2, 2) }, uSun: { value: new THREE.Vector3(0, 1, 0) },
      uDay: { value: 1 }, uFog: { value: new THREE.Color() }, uFogK: { value: 0 }, uSky: { value: new THREE.Color() },
      uGlobal: { value: this.globalTex }, uLights: { value: this.lightsTex },
      uCities: { value: [0, 1, 2, 3].map(() => new THREE.Vector4()) }, uTime: { value: 0 }, uClouds: { value: weather.texture },
    };
    return (this.levelMats[i] = u);
  }

  // ---------------- tiles
  buildGeometry(t, ux) {
    const n = 2 ** t.z, N = SEG + 3; // grid incl. a skirt ring
    const pos = new Float32Array(N * N * 3), uv = new Float32Array(N * N * 2), merc = new Float32Array(N * N * 2), geo = new Float32Array(N * N * 2), water = new Float32Array(N * N);
    const tmp = { x: 0, z: 0 };
    const size = (40075016 / n) * Math.cos(latOfRow(t.y + 0.5, n) * D2R);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const ci = THREE.MathUtils.clamp(i - 1, 0, SEG), cj = THREE.MathUtils.clamp(j - 1, 0, SEG);
      const skirt = i === 0 || j === 0 || i === N - 1 || j === N - 1;
      const fx = ux + ci / SEG, fy = t.y + cj / SEG;
      const lat = latOfRow(fy, n), lon = lonOfCol(fx, n);
      project(this.origin, lat, lon, tmp);
      let h = t.h ? t.h[cj * (SEG + 1) + ci] : 0;
      const wet = h <= 0.5;
      h = Math.max(0, h);
      const k = j * N + i;
      pos.set([tmp.x, h - (skirt ? size * 0.03 : 0), tmp.z], k * 3);
      uv.set([ci / SEG, cj / SEG], k * 2);
      merc.set([fx / n, fy / n], k * 2);
      geo.set([lat, lon], k * 2);
      water[k] = wet ? 1 : 0;
    }
    const idx = [];
    for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) {
      const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('aMerc', new THREE.BufferAttribute(merc, 2));
    g.setAttribute('aGeo', new THREE.BufferAttribute(geo, 2));
    g.setAttribute('aWater', new THREE.BufferAttribute(water, 1));
    g.setIndex(idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    g.boundingSphere.radius += size; // curvature is applied in the shader
    return g;
  }

  makeMesh(t, ux, level) {
    const lu = this.levelMat(level);
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...lu, uMap: { value: t.tex }, uHasMap: { value: t.tex ? 1 : 0 } },
      vertexShader: TERRAIN_VERT, fragmentShader: TERRAIN_FRAG,
    });
    const m = new THREE.Mesh(this.buildGeometry(t, ux), mat);
    m.userData = { t, ux, level, version: t.version || 0, origin: this.origin };
    m.frustumCulled = true;
    return m;
  }

  updateTiles() {
    const agl = Math.max(200, this.pos.y - (this.groundHeight() || 0));
    const latC = Math.cos(this.info.lat * D2R);
    const zc = THREE.MathUtils.clamp(Math.floor(Math.log2((40075016 * latC) / (agl * 2.2))), 5, 14);
    const levels = [zc, zc - 2, zc - 4].map((z) => Math.max(1, z));
    const want = new Set();
    for (const t of CACHE.values()) t.wanted = false;
    levels.forEach((z, li) => {
      const n = 2 ** z;
      const [fx, fy] = tileXY(this.info.lat, this.info.lon, z);
      const cx = Math.floor(fx), cy = Math.floor(fy);
      const lu = this.levelMat(li);
      // hole = area the next finer level covers (unwrapped mercator, normalised)
      if (li > 0) {
        const zf = levels[li - 1], nf = 2 ** zf;
        const [ffx, ffy] = tileXY(this.info.lat, this.info.lon, zf);
        lu.uHole.value.set((Math.floor(ffx) - K) / nf, (Math.floor(ffy) - K) / nf, (Math.floor(ffx) + K + 1) / nf, (Math.floor(ffy) + K + 1) / nf);
        if (zf === z) lu.uHole.value.set(2, 2, 2, 2);
      } else lu.uHole.value.set(2, 2, 2, 2);
      for (let dy = -K; dy <= K; dy++) for (let dx = -K; dx <= K; dx++) {
        const y = cy + dy;
        if (y < 0 || y >= n) continue;
        const ux = cx + dx, x = ((ux % n) + n) % n;
        const t = tileData(z, x, y);
        t.wanted = true;
        t.prio = 10 - li * 3 - Math.hypot(dx, dy);
        const key = `${li}|${z}/${ux}/${y}`;
        want.add(key);
        let m = this.meshes.get(key);
        if (m && (m.userData.version !== (t.version || 0) || m.userData.origin !== this.origin)) {
          this.terrain.remove(m); m.geometry.dispose(); m.material.dispose();
          this.meshes.delete(key);
          m = null;
        }
        if (!m) {
          m = this.makeMesh(t, ux, li);
          this.meshes.set(key, m);
          this.terrain.add(m);
        }
      }
    });
    for (const [key, m] of this.meshes) {
      if (want.has(key)) continue;
      this.terrain.remove(m); m.geometry.dispose(); m.material.dispose();
      this.meshes.delete(key);
    }
    this.zc = zc;
    pump();
  }

  // Ground height under (lat, lon) from the finest loaded tile.
  groundHeight(lat = this.info.lat, lon = this.info.lon) {
    for (let z = this.zc || 10; z >= 1; z--) {
      const [fx, fy] = tileXY(lat, lon, z);
      const t = CACHE.get(`${z}/${Math.floor(fx) % 2 ** z}/${Math.floor(fy)}`);
      if (!t?.h) continue;
      const u = (fx % 1) * SEG, v = (fy % 1) * SEG;
      const i = Math.min(SEG - 1, Math.floor(u)), j = Math.min(SEG - 1, Math.floor(v)), a = u - i, b = v - j;
      const H = (ii, jj) => Math.max(0, t.h[jj * (SEG + 1) + ii]);
      return (H(i, j) * (1 - a) + H(i + 1, j) * a) * (1 - b) + (H(i, j + 1) * (1 - a) + H(i + 1, j + 1) * a) * b;
    }
    return null;
  }

  updateGeo() {
    const g = unproject(this.origin, this.pos.x, this.pos.z);
    this.info.lat = g.lat;
    this.info.lon = g.lon;
  }

  // ---------------- real Sun + star field for this place and moment
  updateSky() {
    const t = simNow(this.app.state);
    const qE = bodyQuat('earth', t);
    const qInv = qE.clone().invert();
    const sunW = new THREE.Vector3(...(() => { const p = helioAU(BODY.earth, t); return [-p[0], -p[2], p[1]]; })()).normalize();
    const s = sunW.applyQuaternion(qInv); // Earth-fixed: x = lon 0, y = north pole, -z = lon 90°E
    const la = this.info.lat * D2R, lo = this.info.lon * D2R;
    const U = new THREE.Vector3(Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo));
    const E = new THREE.Vector3(-Math.sin(lo), 0, -Math.cos(lo));
    const Nn = new THREE.Vector3().crossVectors(U, E);
    const toLocal = (v, out) => out.set(v.dot(E), v.dot(U), -v.dot(Nn));
    this.sunDir = toLocal(s, new THREE.Vector3()).normalize();
    // stars: ecliptic scene frame → Earth-fixed → local east/up/-north
    const m = new THREE.Matrix4().makeBasis(E, U, Nn.clone().negate()).transpose();
    const q = new THREE.Quaternion().setFromRotationMatrix(m).multiply(qInv);
    this.stars.quaternion.copy(q);
    // local solar time
    const h = ((t / 3600000 + this.info.lon / 15) % 24 + 24) % 24;
    this.info.local = `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')} local solar time`;
  }

  // ---------------- flight
  vmax(alt) {
    // dense air near the ground; hypersonic corridor above ~30 km; orbital speed at the edge of space
    const k = THREE.MathUtils.smoothstep(alt, 8000, 90000);
    return 280 + Math.pow(k, 1.3) * 7500;
  }

  update(dt, input) {
    this.time += dt;
    const I = input.sample(dt);
    const alt = this.pos.y;
    if (this.autopilot && this.target) this.fly(dt);
    else {
      const turn = THREE.MathUtils.lerp(0.9, 0.08, THREE.MathUtils.smoothstep(this.speed, 300, 6000));
      this.yaw += I.move.x * turn * dt;
      this.pitch = THREE.MathUtils.clamp(this.pitch + I.move.y * 0.9 * dt, -1.2, 1.2);
      const acc = I.boost ? 450 : I.lift > 0 ? 90 : 0;
      this.speed += acc * dt - (I.mine ? 400 * dt : 0);
    }
    this.speed = THREE.MathUtils.clamp(this.speed, 0, this.vmax(alt) * (I.boost ? 1.05 : 1));
    this.lookYaw -= I.lookX * 0.004;
    this.lookPitch = THREE.MathUtils.clamp(this.lookPitch + I.lookY * 0.003, -0.6, 1.0);
    this.lookYaw *= Math.exp(-0.6 * dt);

    const fwd = new THREE.Vector3(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
    this.pos.addScaledVector(fwd, this.speed * dt);
    this.updateGeo();
    const gh = this.groundHeight();
    if (gh !== null && this.pos.y < gh + 25) {
      this.pos.y = gh + 25;
      if (this.pitch < 0) { this.pitch = 0.05; haptic('heavy'); emit('toast', { text: 'Terrain! Pull up', kind: 'bad' }); }
    }
    if (this.pos.y > 140000) { this.pos.y = 140000; this.pitch = Math.min(this.pitch, 0); }

    // floating origin keeps float precision near the camera
    if (Math.hypot(this.pos.x, this.pos.z) > RECENTER) {
      this.origin = { lat: this.info.lat, lon: this.info.lon };
      this.originM.x = (this.originM.x + this.pos.x) % 1e6;
      this.originM.z = (this.originM.z + this.pos.z) % 1e6;
      this.pos.x = 0; this.pos.z = 0;
      this.tileAcc = 99;
    }

    // skiff + plasma sheath on fast descent through thick air
    this.skiff.position.copy(this.pos);
    this.skiff.quaternion.setFromEuler(new THREE.Euler(-this.pitch, Math.PI - this.yaw, -I.move.x * 0.5, 'YXZ'));
    setThrust(this.skiff, 0.15 + (I.lift > 0 || I.boost ? 0.7 : 0.1), this.time);
    const heat = THREE.MathUtils.smoothstep(this.speed, 2500, 7000) * (1 - THREE.MathUtils.smoothstep(this.pos.y, 70000, 95000)) * THREE.MathUtils.smoothstep(this.pos.y, 15000, 35000);
    this.plasma.material.opacity = heat * (0.75 + Math.random() * 0.25);
    this.plasma.scale.setScalar(10 + heat * 16);

    // chase camera
    const camYaw = this.yaw + this.lookYaw;
    const back = new THREE.Vector3(-Math.sin(camYaw), 0, Math.cos(camYaw));
    const desired = this.pos.clone().addScaledVector(back, 16 * Math.cos(this.lookPitch)).add(new THREE.Vector3(0, 4 + 16 * Math.sin(this.lookPitch), 0));
    this.camera.position.lerp(desired, 1 - Math.exp(-6 * dt));
    this.camera.lookAt(this.pos.clone().addScaledVector(fwd, 8));
    const horizon = Math.sqrt(2 * R * Math.max(50, this.pos.y)) * 1.25 + 20000;
    this.camera.near = this.pos.y > 20000 ? 4 : 1;
    this.camera.far = horizon;
    this.camera.updateProjectionMatrix();

    if ((this.skyAcc = (this.skyAcc ?? 99) + dt) > 0.5) { this.skyAcc = 0; this.updateSky(); }
    this.stars.position.copy(this.camera.position);
    this.stars.scale.setScalar((this.camera.far * 0.9) / 9000); // stars sit beyond the farthest terrain
    this.skyDome.position.copy(this.camera.position);
    const L = this.sunDir;
    const day = THREE.MathUtils.smoothstep(L.y, -0.12, 0.06);
    const thin = THREE.MathUtils.smoothstep(this.pos.y, 15000, 75000);
    const su = this.skyDome.material.uniforms;
    su.uSun.value.copy(L); su.uAlt.value = this.pos.y; su.uDay.value = day;
    this.stars.userData.stars.uniforms.uGain.value = 1.3 * (1 - day * (1 - thin) * 0.97);
    this.sun.position.copy(L).multiplyScalar(1000).add(this.pos);
    this.sun.target.position.copy(this.pos);
    this.sun.intensity = 3 * Math.max(0.02, day);
    this.hemi.intensity = 0.15 + 0.45 * day;
    this.sunSprite.position.copy(L).multiplyScalar(8000).add(this.camera.position);
    this.sunSprite.visible = L.y > -0.05;
    const skyCol = new THREE.Color().setRGB(0.42, 0.6, 0.92).lerp(new THREE.Color(0.05, 0.08, 0.2), thin);
    const fog = new THREE.Color().setRGB(0.62, 0.74, 0.9).lerp(new THREE.Color(0.25, 0.42, 0.8), thin).multiplyScalar(Math.max(0.02, day));
    const fogK = (1 / 160000) * Math.exp(-this.pos.y / 9000) + 1 / 4e6;
    // the imagined 2087 layer: megacities, holograms, traffic, elevator, orbital ring
    const tmpP = { x: 0, z: 0 };
    this.future.update(dt, {
      sun: L, day, fog, fogK, places: PLACES,
      dist: (p) => gc(this.info.lat, this.info.lon, p.lat, p.lon).d,
      project: (lat, lon, out) => { project(this.origin, lat, lon, tmpP); return out.set(tmpP.x, 0, tmpP.z); },
    });
    const cityVecs = Object.entries(this.future.cities).slice(0, 4);
    let glow = 0;
    for (const [id, c] of cityVecs) {
      const dd = Math.hypot(c.g.position.x - this.pos.x, c.g.position.z - this.pos.z);
      glow = Math.max(glow, Math.exp(-dd / (FUTURE_CITIES[id].r * 3)));
    }
    su.uGlow.value.setRGB(0.32, 0.06, 0.38).multiplyScalar(glow);
    fog.lerp(new THREE.Color(0.16, 0.04, 0.2), glow * (1 - day) * 0.8);
    for (const lu of this.levelMats) {
      if (!lu) continue;
      lu.uTime.value = this.time;
      for (let i = 0; i < 4; i++) {
        const c = cityVecs[i];
        if (c) lu.uCities.value[i].set(c[1].g.position.x, c[1].g.position.z, FUTURE_CITIES[c[0]].r, 1);
        else lu.uCities.value[i].set(0, 0, 1, 0);
      }
      lu.uCam.value.copy(this.camera.position);
      lu.uSun.value.copy(L);
      lu.uDay.value = day;
      lu.uFog.value.copy(fog);
      lu.uFogK.value = fogK;
      lu.uSky.value.copy(skyCol);
    }

    // cloud deck follows the camera at ~2.2 km (curvature is applied in its shader)
    const cu = this.cloudDeck.material.uniforms;
    this.cloudDeck.position.set(this.camera.position.x, 2200, this.camera.position.z);
    cu.uCam.value.copy(this.camera.position);
    cu.uOrigin.value.set(this.origin.lat, this.origin.lon);
    cu.uOffset.value.set(this.originM.x, this.originM.z);
    cu.uSun.value.copy(L); cu.uDay.value = day; cu.uFog.value.copy(fog); cu.uFogK.value = fogK; cu.uTime.value = this.time;
    if ((this.tileAcc += dt) > 0.25) { this.tileAcc = 0; this.updateTiles(); }
    // swap in imagery that has arrived
    for (const m of this.meshes.values()) {
      const t = m.userData.t;
      if (t.tex && m.material.uniforms.uHasMap.value === 0) { m.material.uniforms.uMap.value = t.tex; m.material.uniforms.uHasMap.value = 1; }
    }

    const agl = this.pos.y - (gh || 0);
    Object.assign(this.info, { alt: this.pos.y, agl, speed: this.speed, mach: this.speed / 340, autopilot: this.autopilot, canOrbit: this.pos.y > 80000 });
    this.updateNav();
  }

  // Autopilot: great-circle course, climb into the hypersonic corridor for long legs, descend on approach.
  fly(dt) {
    const { d, b } = gc(this.info.lat, this.info.lon, this.target.lat, this.target.lon);
    // cruise high where the air is thin, then follow a ~1:7 glide slope down to 1.5 km on arrival
    const cruise = d > 2500e3 ? 85000 : 60000;
    const altT = Math.max(Math.min(cruise, 1500 + d * 0.15), (this.groundHeight() || 0) + 600);
    let dy = b - this.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.yaw += THREE.MathUtils.clamp(dy, -0.5 * dt, 0.5 * dt);
    const vs = THREE.MathUtils.clamp((altT - this.pos.y) * 0.04, -this.speed * 0.35, this.speed * 0.35);
    const pitchT = Math.asin(THREE.MathUtils.clamp(vs / Math.max(50, this.speed), -0.9, 0.9));
    this.pitch += THREE.MathUtils.clamp(pitchT - this.pitch, -0.4 * dt, 0.4 * dt);
    const vT = Math.min(this.vmax(this.pos.y), 160 + d / 25);
    this.speed += THREE.MathUtils.clamp(vT - this.speed, -350 * dt, 250 * dt);
    if (d < 3000) {
      this.autopilot = false;
      emit('toast', { text: `Arrived over ${this.target.name}`, kind: 'good' });
      haptic('medium');
    }
  }

  updateNav() {
    const out = [];
    const W = innerWidth, H = innerHeight, v = new THREE.Vector3(), tmp = { x: 0, z: 0 };
    const add = (p, kind) => {
      const { d } = gc(this.info.lat, this.info.lon, p.lat, p.lon);
      project(this.origin, p.lat, p.lon, tmp);
      const dd = (tmp.x - this.camera.position.x) ** 2 + (tmp.z - this.camera.position.z) ** 2;
      v.set(tmp.x, Math.max(0, this.groundHeight(p.lat, p.lon) ?? 0) - dd / (2 * R), tmp.z).project(this.camera);
      const behind = v.z > 1;
      out.push({ x: (v.x * 0.5 + 0.5) * W, y: (-v.y * 0.5 + 0.5) * H, on: !behind && Math.abs(v.x) < 1 && Math.abs(v.y) < 1, behind, label: p.name, km: d / 1000, kind });
    };
    if (this.target) add(this.target, 'dest');
    for (const p of PLACES) {
      if (p === this.target) continue;
      if (gc(this.info.lat, this.info.lon, p.lat, p.lon).d < 400e3) add(p, 'home');
    }
    this.info.markers = out;
    if (this.target) {
      const { d } = gc(this.info.lat, this.info.lon, this.target.lat, this.target.lon);
      this.info.target = { name: this.target.name, km: d / 1000, eta: d / Math.max(150, this.speed) };
    } else this.info.target = null;
  }

  // Station sub-point → where you enter the atmosphere.
  static subPoint(dirScene, t) {
    const s = dirScene.clone().normalize().applyQuaternion(bodyQuat('earth', t).invert());
    return { lat: Math.asin(THREE.MathUtils.clamp(s.y, -1, 1)) / D2R, lon: Math.atan2(-s.z, s.x) / D2R };
  }
}

