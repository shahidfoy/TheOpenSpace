import * as THREE from 'three';
import { J2000 } from '../data/bodies.js';
import { eqToScene } from './sky.js';
import { weather } from './weather.js';
import { NOISE } from './shaders.js';
import { SKY_GLSL, CLOUD_H } from './earthSky.js';

// Real surface maps (public/planets: Solar System Scope CC BY 4.0, NASA/USGS public domain)
// and real orientation: IAU WGCCRE 2015 pole directions (RA/Dec) and prime-meridian angles,
// so every world spins at its true rate and shows its true face for the current moment.
// The IAU formulas run on Barycentric Dynamical Time, so the clock is shifted from UTC to TT
// (~69 s — 0.7° of spin for Jupiter). Earth instead uses the Earth Rotation Angle (UT1 ≈ UTC),
// which pins Greenwich to within ~0.0001° of its true place.
//          α0 (deg)   α̇ (/cy)     δ0 (deg)   δ̇ (/cy)     W0 (deg)  Ẇ (deg/day)    map lon-0 offset
const IAU = {
  sun: [286.13, 0, 63.87, 0, 84.176, 14.1844, 0],
  mercury: [281.0103, -0.0328, 61.4155, -0.0049, 329.5988, 6.1385108, 0],
  venus: [272.76, 0, 67.16, 0, 160.2, -1.4813688, 0],
  earth: [0, -0.641, 90, -0.557, 0, 0, 0], // spin from the Earth Rotation Angle (below)
  moon: [269.9949, 0.0031, 66.5392, 0.013, 38.3213, 13.17635815, 0],
  mars: [317.269202, -0.10927547, 54.432516, -0.05827105, 176.049863, 350.891982443297, 0],
  ceres: [291.418, 0, 66.764, 0, 170.65, 952.1532, 0.5],
  jupiter: [268.056595, -0.006499, 64.495303, 0.002413, 284.95, 870.536, 0],
  europa: [268.08, -0.009, 64.51, 0.003, 36.022, 101.3747235, 0.5],
  saturn: [40.589, -0.036, 83.537, -0.004, 38.9, 810.7939024, 0],
  titan: [39.4827, 0, 83.4279, 0, 186.5855, 22.5769768, 0.5],
  uranus: [257.311, 0, -15.175, 0, 203.81, -501.1600928, 0],
  neptune: [299.36, 0, 43.46, 0, 249.978, 541.1397757, 0],
  pluto: [132.993, 0, -6.163, 0, 302.695, 56.3625225, 0.5],
};
const D2R = Math.PI / 180;
const sin = (x) => Math.sin(x * D2R), cos = (x) => Math.cos(x * D2R);
// Periodic terms [Δα, Δδ, ΔW] (deg): the Moon's physical & optical librations of its pole and
// spin, Europa's forced wobble, Neptune's precessing pole.
const PERIODIC = {
  moon(d, T) {
    const E = [0, 125.045 - 0.0529921 * d, 250.089 - 0.1059842 * d, 260.008 + 13.0120009 * d, 176.625 + 13.3407154 * d,
      357.529 + 0.9856003 * d, 311.589 + 26.4057084 * d, 134.963 + 13.064993 * d, 276.617 + 0.3287146 * d,
      34.226 + 1.7484877 * d, 15.134 - 0.1589763 * d, 119.743 + 0.0036096 * d, 239.961 + 0.1643573 * d, 25.053 + 12.9590088 * d];
    return [
      -3.8787 * sin(E[1]) - 0.1204 * sin(E[2]) + 0.07 * sin(E[3]) - 0.0172 * sin(E[4]) + 0.0072 * sin(E[6]) - 0.0052 * sin(E[10]) + 0.0043 * sin(E[13]),
      1.5419 * cos(E[1]) + 0.0239 * cos(E[2]) - 0.0278 * cos(E[3]) + 0.0068 * cos(E[4]) - 0.0029 * cos(E[6]) + 0.0009 * cos(E[7]) + 0.0008 * cos(E[10]) - 0.0009 * cos(E[13]),
      3.561 * sin(E[1]) + 0.1208 * sin(E[2]) - 0.0642 * sin(E[3]) + 0.0158 * sin(E[4]) + 0.0252 * sin(E[5]) - 0.0066 * sin(E[6]) - 0.0047 * sin(E[7])
        - 0.0046 * sin(E[8]) + 0.0028 * sin(E[9]) + 0.0052 * sin(E[10]) + 0.004 * sin(E[11]) + 0.0019 * sin(E[12]) - 0.0044 * sin(E[13]),
    ];
  },
  europa(d, T) {
    const J4 = 355.8 + 1191.3 * T, J5 = 119.9 + 262.1 * T, J6 = 229.8 + 64.3 * T, J7 = 352.25 + 2382.6 * T;
    return [
      1.086 * sin(J4) + 0.06 * sin(J5) + 0.015 * sin(J6) + 0.009 * sin(J7),
      0.468 * cos(J4) + 0.026 * cos(J5) + 0.007 * cos(J6) + 0.002 * cos(J7),
      -0.98 * sin(J4) - 0.054 * sin(J5) - 0.014 * sin(J6) - 0.008 * sin(J7),
    ];
  },
  neptune(d, T) {
    const N = 357.85 + 52.316 * T;
    return [0.7 * sin(N), -0.51 * cos(N), -0.48 * sin(N)];
  },
};
const TT_UTC_MS = 69184;
// Pole RA/Dec and prime-meridian angle W (deg) at real-world time t (ms, UTC).
function orientation(id, t) {
  const [a0, ad, d0, dd, W0, Wd] = IAU[id];
  const d = (t + TT_UTC_MS - J2000) / 864e5, T = d / 36525;
  let a = a0 + ad * T, dec = d0 + dd * T, W = W0 + Wd * d;
  const pt = PERIODIC[id];
  if (pt) { const [da, ddec, dW] = pt(d, T); a += da; dec += ddec; W += dW; }
  // Earth: Greenwich sits at RA ≈ ERA in the J2000 frame; W counts from the node at α + 90°
  if (id === 'earth') W = 360 * (0.779057273264 + 1.00273781191135448 * ((t - J2000) / 864e5)) - 90 - a;
  return [a, dec, W % 360];
}
// shading variant per world
const KIND = { sun: 2, earth: 1, titan: 3, pluto: 4, ceres: 5 };

const _m = new THREE.Matrix4(), P = new THREE.Vector3(), Q = new THREE.Vector3(), E = new THREE.Vector3(), X = new THREE.Vector3(), Z = new THREE.Vector3();

// Inertial equatorial frame of a body in scene (ecliptic) coordinates: node Q, east E, pole P.
export function bodyFrame(id, t = Date.now()) {
  const [a0, d0] = orientation(IAU[id] ? id : 'earth', t);
  const p = eqToScene(a0, d0);
  const q = eqToScene(a0 + 90, 0);
  return { P: p, Q: q, E: new THREE.Vector3().crossVectors(p, q) };
}

// Orientation of a sphere (three.js SphereGeometry: +Y pole, texture centre at +X, east toward -Z).
export function bodyQuat(id, t, out = new THREE.Quaternion()) {
  if (!IAU[id]) return out.identity();
  const [a0, d0, Wd] = orientation(id, t);
  eqToScene(a0, d0, P);
  eqToScene(a0 + 90, 0, Q);
  E.crossVectors(P, Q);
  const W = Wd * D2R;
  X.copy(Q).multiplyScalar(Math.cos(W)).addScaledVector(E, Math.sin(W)); // longitude 0
  Z.copy(Q).multiplyScalar(Math.sin(W)).addScaledVector(E, -Math.cos(W)); // = -(longitude 90°E)
  return out.setFromRotationMatrix(_m.makeBasis(X, P, Z));
}

// ---------------------------------------------------------------- textures
const loader = new THREE.TextureLoader();
const CACHE = {};
let ANISO = 4;
function tex(name, data = false) {
  if (CACHE[name]) return CACHE[name];
  let done;
  const ready = new Promise((r) => (done = r));
  const t = loader.load(`${import.meta.env.BASE_URL}planets/${name}.jpg`, done, undefined, done);
  t.userData.ready = ready;
  t.colorSpace = data ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.anisotropy = ANISO;
  return (CACHE[name] = t);
}
// Sharper maps at grazing angles (the Earth close-up sees most of its surface obliquely).
export function setPlanetAnisotropy(n) {
  ANISO = n;
  for (const t of [...Object.values(CACHE), weather.texture]) {
    t.anisotropy = n;
    if (t.image) t.needsUpdate = true;
  }
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
uniform vec3 uSunDir;
varying vec2 vUv; varying vec3 vN; varying vec3 vW; varying vec3 vObj; varying vec3 vLo;
void main(){
  vUv = uv;
  vObj = position;
  vLo = vec3(dot(uSunDir, modelMatrix[0].xyz), dot(uSunDir, modelMatrix[1].xyz), dot(uSunDir, modelMatrix[2].xyz)); // Sun in object space
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const FRAG = /* glsl */ `
uniform sampler2D uMap; uniform sampler2D uNight; uniform sampler2D uClouds; uniform sampler2D uSpec;
uniform int uKind; uniform vec3 uSunDir; uniform vec3 uAtmo; uniform float uAtmoK; uniform float uLight; uniform float uLon0;
uniform float uCloudK; uniform float uDark; // Earth only: cloud opacity, and a dark "hologram" globe (CYBER view)
uniform float uReal; uniform float uQ; // Earth close-up (PILOT): clouds and air drawn by separate shells (earthSky.js); detail level
varying vec2 vUv; varying vec3 vN; varying vec3 vW; varying vec3 vObj; varying vec3 vLo;
${SKY_GLSL}
${NOISE}
vec2 sphUv(vec3 p){ return vec2(atan(p.z, -p.x) / (2.0 * PI), 1.0 - acos(clamp(p.y, -1.0, 1.0)) / PI); } // three.js SphereGeometry uv
// Earth seen up close: reddened sunlight through the air, cloud shadows offset along the Sun,
// ocean glint, sub-texel land detail and city lights on the night side only.
vec3 earthReal(vec2 uv, vec3 col, vec3 N, vec3 L, vec3 V){
  vec3 P = normalize(vObj), Lo = normalize(vLo);
  float ndl = dot(N, L);
  float ocean = texture2D(uSpec, uv).r;
  float pxl = length(fwidth(vObj)) / length(vObj);
  if (uQ > 0.5) {
    float k = smoothstep(2e-3, 5e-4, pxl) * (1.0 - ocean);
    float n = noise(P * 900.0) * 0.55 + noise(P * 2400.0) * 0.45;
    if (uQ > 1.5) n = n * 0.7 + noise(P * 6500.0) * 0.3;
    col *= 1.0 + (n - 0.5) * 0.45 * k;
  }
  // where the Sun's ray from this point crosses the cloud deck
  float cs = dot(P, Lo);
  vec3 S = normalize(P + (Lo - P * cs) * (${CLOUD_H.toFixed(4)} / max(cs, 0.15)));
  vec2 d = sphUv(S) - sphUv(P);
  d.x -= floor(d.x + 0.5);
  float shade = texture2D(uClouds, uv + d, 1.5).r * uCloudK;
  float cl = texture2D(uClouds, uv).r * uCloudK;
  vec3 sun = sunTrans(ndl) * uLight * (1.0 - 0.8 * shade);
  vec3 sky = vec3(0.07, 0.11, 0.2) * uLight * smoothstep(-0.12, 0.3, ndl) * (1.0 - 0.4 * shade); // skylight, fading through twilight
  vec3 o = col * (sun * max(ndl, 0.0) + sky);
  // ocean: GGX glint from the Sun (a sharp core in a wind-roughened sheen)
  vec3 H = normalize(L + V + vec3(1e-4));
  float nh = max(dot(N, H), 0.0), nv = max(dot(N, V), 0.05);
  float F = 0.02 + 0.98 * pow(1.0 - max(dot(H, V), 0.0), 5.0);
  float a1 = 0.012, a2 = 0.09;
  float d1 = nh * nh * (a1 - 1.0) + 1.0, d2 = nh * nh * (a2 - 1.0) + 1.0;
  float D = 0.35 * a1 / (PI * d1 * d1) + 0.65 * a2 / (PI * d2 * d2);
  o += sun * ocean * D * F / (4.0 * nv) * max(ndl, 0.0);
  // city lights: night side only, dimmed under cloud
  vec3 lights = texture2D(uNight, uv).rgb;
  if (uQ > 0.5) { // break the soft 2k glow into clusters of towns and street grids
    float k = smoothstep(4e-3, 1e-3, pxl);
    float s = noise(P * 800.0) * 0.55 + noise(P * 2200.0) * 0.45;
    lights *= mix(1.0, 0.15 + 2.2 * smoothstep(0.42, 0.78, s), k);
  }
  o += pow(lights, vec3(1.7)) * smoothstep(0.03, -0.14, ndl) * (1.0 - cl * 0.75) * vec3(3.2, 2.4, 1.4);
  return o;
}
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
  if (uKind == 1 && uReal > 0.5) { gl_FragColor = vec4(earthReal(uv, col, N, L, V), 1.0); return; }
  if (uKind == 1) {
    float cl = texture2D(uClouds, uv).r * uCloudK;
    float ocean = texture2D(uSpec, uv).r;
    vec3 H = normalize(L + V + vec3(1e-4)); // never normalize a zero vector (L = -V)
    float sp = pow(max(dot(N, H), 0.0), 70.0) * ocean * (1.0 - cl) * step(0.0, ndl);
    o = mix(col, vec3(1.0), cl * 0.9) * diff * uLight + vec3(1.0, 0.93, 0.8) * sp * 0.9;
    o *= mix(vec3(1.0), vec3(1.0, 0.7, 0.45), smoothstep(0.28, 0.0, ndl) * 0.55);
    vec3 lights = texture2D(uNight, uv).rgb;
    o += lights * lights * smoothstep(0.06, -0.18, ndl) * (1.0 - cl * 0.85) * vec3(1.6, 1.25, 0.8);
    if (uDark > 0.0) {
      // land as dark slate, oceans near black, a cyan rim; cities still faintly lit
      vec3 holo = mix(vec3(0.05, 0.1, 0.15), vec3(0.008, 0.016, 0.03), ocean) + vec3(0.0, 0.22, 0.3) * pow(1.0 - mu, 4.0) + lights * 0.12;
      gl_FragColor = vec4(mix(o, holo, uDark), 1.0);
      return;
    }
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
    uLight: { value: 1.25 * light }, uLon0: { value: iau ? iau[6] : 0 }, uCloudK: { value: 1 }, uDark: { value: 0 },
    uReal: { value: 0 }, uQ: { value: 2 },
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
