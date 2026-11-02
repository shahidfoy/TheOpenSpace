import * as THREE from 'three';
import { J2000 } from '../data/bodies.js';
import { eqToScene } from './sky.js';
import { weather } from './weather.js';

// Real surface maps (public/planets: Solar System Scope CC BY 4.0, NASA/USGS public domain)
// and real orientation: IAU WGCCRE 2015 pole directions (RA/Dec) and prime-meridian angles,
// so every world spins at its true rate and shows its true face for the current moment.
//          α0 (deg)    δ0 (deg)   W0 (deg)  Ẇ (deg/day)       map lon-0 offset
const IAU = {
  sun: [286.13, 63.87, 84.176, 14.1844, 0],
  mercury: [281.0103, 61.4155, 329.5988, 6.1385108, 0],
  venus: [272.76, 67.16, 160.2, -1.4813688, 0],
  earth: [0, 90, 190.147, 360.9856235, 0],
  moon: [269.9949, 66.5392, 38.3213, 13.17635815, 0],
  mars: [317.269, 54.432, 176.049, 350.891982443, 0],
  ceres: [291.418, 66.764, 170.65, 952.1532, 0.5],
  jupiter: [268.056595, 64.495303, 284.95, 870.536, 0],
  europa: [268.08, 64.51, 36.022, 101.3747235, 0.5],
  saturn: [40.589, 83.537, 38.9, 810.7939024, 0],
  titan: [39.4827, 83.4279, 186.5855, 22.5769768, 0.5],
  uranus: [257.311, -15.175, 203.81, -501.1600928, 0],
  neptune: [299.36, 43.46, 249.978, 541.1397757, 0],
  pluto: [132.993, -6.163, 302.695, 56.3625225, 0.5],
};
// shading variant per world
const KIND = { sun: 2, earth: 1, titan: 3, pluto: 4, ceres: 5 };

const _m = new THREE.Matrix4(), P = new THREE.Vector3(), Q = new THREE.Vector3(), E = new THREE.Vector3(), X = new THREE.Vector3(), Z = new THREE.Vector3();

// Inertial equatorial frame of a body in scene (ecliptic) coordinates: node Q, east E, pole P.
export function bodyFrame(id) {
  const [a0, d0] = IAU[id] || IAU.earth;
  const p = eqToScene(a0, d0);
  const q = eqToScene(a0 + 90, 0);
  return { P: p, Q: q, E: new THREE.Vector3().crossVectors(p, q) };
}

// Orientation of a sphere (three.js SphereGeometry: +Y pole, texture centre at +X, east toward -Z).
export function bodyQuat(id, t, out = new THREE.Quaternion()) {
  const iau = IAU[id];
  if (!iau) return out.identity();
  const [a0, d0, W0, Wd] = iau;
  eqToScene(a0, d0, P);
  eqToScene(a0 + 90, 0, Q);
  E.crossVectors(P, Q);
  const W = ((W0 + Wd * ((t - J2000) / 864e5)) % 360) * Math.PI / 180;
  X.copy(Q).multiplyScalar(Math.cos(W)).addScaledVector(E, Math.sin(W)); // longitude 0
  Z.copy(Q).multiplyScalar(Math.sin(W)).addScaledVector(E, -Math.cos(W)); // = -(longitude 90°E)
  return out.setFromRotationMatrix(_m.makeBasis(X, P, Z));
}

// ---------------------------------------------------------------- textures
const loader = new THREE.TextureLoader();
const CACHE = {};
function tex(name, data = false) {
  if (CACHE[name]) return CACHE[name];
  let done;
  const ready = new Promise((r) => (done = r));
  const t = loader.load(`${import.meta.env.BASE_URL}planets/${name}.jpg`, done, undefined, done);
  t.userData.ready = ready;
  t.colorSpace = data ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return (CACHE[name] = t);
}
// Shared surface map (e.g. the 2k Earth map as a fallback under streamed satellite tiles).
export const planetTexture = (name) => tex(name);

// Small maps for the strategic map, preloaded at boot (~300 KB for every world).
export function preloadPlanets(ids) {
  return Promise.all(ids.map((id) => new Promise((res) => {
    const t = loader.load(`${import.meta.env.BASE_URL}planets/${id}_s.jpg`, res, undefined, res);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = THREE.RepeatWrapping;
    CACHE[`${id}_s`] = t;
  })));
}

const VERT = /* glsl */ `
varying vec2 vUv; varying vec3 vN; varying vec3 vW;
void main(){
  vUv = uv;
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const FRAG = /* glsl */ `
uniform sampler2D uMap; uniform sampler2D uNight; uniform sampler2D uClouds; uniform sampler2D uSpec;
uniform int uKind; uniform vec3 uSunDir; uniform vec3 uAtmo; uniform float uAtmoK; uniform float uLight; uniform float uLon0;
varying vec2 vUv; varying vec3 vN; varying vec3 vW;
void main(){
  vec2 uv = vec2(vUv.x + uLon0, vUv.y); // textures wrap (RepeatWrapping); fract() here caused a mipmap seam line
  vec3 N = normalize(vN), L = normalize(uSunDir), V = normalize(cameraPosition - vW);
  vec3 col = texture2D(uMap, uv).rgb;
  float mu = clamp(dot(N, V), 0.0, 1.0);
  if (uKind == 2) { gl_FragColor = vec4(col * (0.3 + 0.7 * pow(mu, 0.55)) * 3.2, 1.0); return; } // limb-darkened Sun
  float ndl = dot(N, L);
  float diff = clamp(ndl * 1.04 + 0.02, 0.0, 1.0);
  if (uKind == 3) { float l = dot(col, vec3(0.333)); col = mix(vec3(0.6, 0.4, 0.16) * (0.75 + 0.4 * l), vec3(0.86, 0.58, 0.26), 0.6); } // Titan's orange haze hides the surface
  if (uKind == 4) { float l = dot(col, vec3(0.333)); col = mix(vec3(0.4, 0.34, 0.29), col, smoothstep(0.02, 0.08, l)); } // Pluto's unimaged south
  if (uKind == 5) { col = mix(col, vec3(0.3, 0.31, 0.33), smoothstep(0.8, 0.94, abs(uv.y - 0.5) * 2.0)); } // Ceres' noisy poles
  vec3 o = col * diff * uLight;
  if (uKind == 1) {
    float cl = texture2D(uClouds, uv).r;
    float ocean = texture2D(uSpec, uv).r;
    vec3 H = normalize(L + V + vec3(1e-4)); // never normalize a zero vector (L = -V)
    float sp = pow(max(dot(N, H), 0.0), 70.0) * ocean * (1.0 - cl) * step(0.0, ndl);
    o = mix(col, vec3(1.0), cl * 0.9) * diff * uLight + vec3(1.0, 0.93, 0.8) * sp * 0.9;
    o *= mix(vec3(1.0), vec3(1.0, 0.7, 0.45), smoothstep(0.28, 0.0, ndl) * 0.55);
    vec3 lights = texture2D(uNight, uv).rgb;
    o += lights * lights * smoothstep(0.06, -0.18, ndl) * (1.0 - cl * 0.85) * vec3(1.6, 1.25, 0.8);
  }
  float rim = pow(1.0 - mu, 2.6);
  o += uAtmo * rim * uAtmoK * smoothstep(-0.25, 0.45, ndl);
  gl_FragColor = vec4(o, 1.0);
}`;

const BLACK = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
BLACK.needsUpdate = true;

// hi: load the 2k map (local views); otherwise the small map-view texture.
export function planetMaterial(body, { hi = false, light = 1 } = {}) {
  const id = body.id, iau = IAU[id];
  const small = CACHE[`${id}_s`] || tex(`${id}_s`);
  const u = {
    uMap: { value: small }, uNight: { value: BLACK }, uClouds: { value: BLACK }, uSpec: { value: BLACK },
    uKind: { value: KIND[id] || 0 }, uSunDir: { value: new THREE.Vector3(1, 0, 0) },
    uAtmo: { value: new THREE.Color(body.atmo || 0x000000) }, uAtmoK: { value: body.atmo ? (id === 'earth' ? 0.9 : 0.5) : 0 },
    uLight: { value: 1.25 * light }, uLon0: { value: iau ? iau[4] : 0 },
  };
  if (hi) {
    const big = tex(id);
    // keep showing the small map until the 2k one arrives
    big.userData.ready.then(() => { if (big.image) u.uMap.value = big; });
  }
  if (id === 'earth') {
    u.uNight.value = tex('earth_night');
    u.uClouds.value = weather.texture; // live satellite clouds (NASA GIBS), static map until loaded
    u.uSpec.value = tex('earth_spec', true);
  }
  const m = new THREE.ShaderMaterial({ uniforms: u, vertexShader: VERT, fragmentShader: FRAG });
  m.userData.sunDir = u.uSunDir.value;
  return m;
}

// Saturn's rings from the radial colour/opacity profile, with the planet's shadow across them.
const RING_FRAG = /* glsl */ `
uniform sampler2D uRing; uniform float uIn; uniform float uOut; uniform vec3 uSunDir; uniform vec3 uCenter; uniform float uR;
varying vec3 vL; varying vec3 vW; varying vec3 vN;
void main(){
  float t = (length(vL.xz) - uIn) / (uOut - uIn);
  if (t < 0.0 || t > 1.0) discard;
  vec4 c = texture2D(uRing, vec2(t, 0.5));
  vec3 L = normalize(uSunDir), oc = vW - uCenter;
  float b = dot(oc, L), cc = dot(oc, oc) - uR * uR;
  float shadow = (b < 0.0 && b * b - cc > 0.0) ? 0.08 : 1.0;
  float lit = abs(dot(normalize(vN), L)) * 0.7 + 0.3;
  gl_FragColor = vec4(c.rgb * 1.15 * lit * shadow, c.a * 0.95);
}`;
export function ringMesh(R) {
  const inner = R * 1.239, outer = R * 2.27;
  const geo = new THREE.RingGeometry(inner, outer, 160, 1);
  geo.rotateX(-Math.PI / 2); // equatorial plane = sphere's local XZ
  const ringTex = loader.load(`${import.meta.env.BASE_URL}planets/saturn_ring.png`);
  ringTex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.ShaderMaterial({
    uniforms: { uRing: { value: ringTex }, uIn: { value: inner }, uOut: { value: outer }, uSunDir: { value: new THREE.Vector3(1, 0, 0) }, uCenter: { value: new THREE.Vector3() }, uR: { value: R } },
    vertexShader: 'varying vec3 vL; varying vec3 vW; varying vec3 vN; void main(){ vL = position; vN = normalize(mat3(modelMatrix) * vec3(0.0, 1.0, 0.0)); vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: RING_FRAG, transparent: true, side: THREE.DoubleSide, depthWrite: false,
  });
  const m = new THREE.Mesh(geo, mat);
  m.onBeforeRender = () => {
    m.parent.getWorldPosition(mat.uniforms.uCenter.value);
    const s = new THREE.Vector3();
    m.parent.getWorldScale(s);
    mat.uniforms.uR.value = R * s.x;
  };
  m.userData.sunDir = mat.uniforms.uSunDir.value;
  return m;
}
