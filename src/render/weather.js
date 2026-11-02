import * as THREE from 'three';

// Real clouds from NASA GIBS (Global Imagery Browse Services): VIIRS true-colour mosaics from the
// Suomi-NPP and NOAA-20 satellites. No free source offers one instantaneous global cloud picture,
// so today's passes are laid over yesterday's full map: each region shows its latest pass
// (typically < 24 h old) and the map refreshes as new swaths arrive. Clouds are separated from the
// ground by comparing against the cloud-free Earth map, so deserts and ice caps aren't mistaken for
// cloud. Until (or unless) the download works, a static cloud map stands in.

// 1536 x 768 keeps the working buffers ~5 MB each (phones) and halves cleanly down the fill pyramid
const W = 1536, H = 768;
const LAYERS = ['VIIRS_NOAA20_CorrectedReflectance_TrueColor', 'VIIRS_SNPP_CorrectedReflectance_TrueColor'];
const url = (layer, day) => `https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.1.1&LAYERS=${layer}&SRS=EPSG:4326&BBOX=-180,-90,180,90&WIDTH=${W}&HEIGHT=${H}&FORMAT=image/jpeg&TIME=${day}`;
export const WEATHER_CREDIT = 'Clouds: NASA GIBS · VIIRS (Suomi-NPP, NOAA-20)';

const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
const ctx = canvas.getContext('2d', { willReadFrequently: true });
ctx.fillStyle = '#000';
ctx.fillRect(0, 0, W, H);
const tex = new THREE.CanvasTexture(canvas);
tex.colorSpace = THREE.NoColorSpace;
tex.wrapS = THREE.RepeatWrapping;
tex.anisotropy = 4;

export const weather = { texture: tex, live: false, updated: null, source: 'static' };
globalThis.__weather = weather; // inspect from the console: live, updated, coverage

async function bitmap(src) {
  const r = await fetch(src, { mode: 'cors' });
  if (!r.ok) throw new Error(`${r.status}`);
  return createImageBitmap(await r.blob());
}
function pixels(bmp) {
  ctx.drawImage(bmp, 0, 0, W, H);
  return ctx.getImageData(0, 0, W, H).data;
}
const day = (offset) => new Date(Date.now() - offset * 864e5).toISOString().slice(0, 10);
const base = (name) => `${import.meta.env.BASE_URL}planets/${name}.jpg`;

let ground = null, fallback = null;

// Static cloud map first, so the globe never looks bald.
async function init() {
  try {
    fallback = pixels(await bitmap(base('earth_clouds')));
    const out = ctx.createImageData(W, H);
    for (let i = 0; i < W * H * 4; i += 4) { const c = fallback[i]; out.data[i] = out.data[i + 1] = out.data[i + 2] = c; out.data[i + 3] = 255; }
    ctx.putImageData(out, 0, 0);
    tex.needsUpdate = true;
  } catch (e) { console.warn('static clouds unavailable', e); }
}

// Download the newest passes and rebuild the cloud map.
export async function refreshWeather() {
  try {
    if (!ground) ground = pixels(await bitmap(base('earth')));
    // newest first within each day: NOAA-20 then Suomi-NPP
    const load = async (d) => {
      const out = [];
      for (const layer of LAYERS) {
        try { out.push(pixels(await bitmap(url(layer, d)))); } catch (e) { /* that pass isn't published yet */ }
      }
      return out;
    };
    const today = await load(day(0)), prev = await load(day(1));
    if (!today.length && !prev.length) throw new Error('no GIBS imagery');
    const N = W * H;
    // cloud fraction for one pass (-1 = not imaged). Swath edges are trimmed by 3 px: JPEG ringing
    // along the black no-data border otherwise draws thin bright lines.
    const one = (im) => {
      const c = new Float32Array(N).fill(-1), v = new Float32Array(N);
      for (let p = 0, i = 0; p < N; p++, i += 4) v[p] = im[i] + im[i + 1] + im[i + 2] >= 24 ? 1 : 0;
      boxBlur(v, 3);
      for (let p = 0, i = 0; p < N; p++, i += 4) {
        if (v[p] < 0.999) continue;
        // clouds are bright in every channel; compare with the cloud-free ground underneath
        const white = Math.min(im[i], im[i + 1], im[i + 2]) / 255;
        const under = Math.min(ground[i], ground[i + 1], ground[i + 2]) / 255;
        // threshold + curve suppress sun glint on tropical oceans and thin haze
        c[p] = Math.pow(Math.max(0, Math.min(1, (white - under - 0.2) / 0.42)), 1.4);
      }
      return c;
    };
    // merge a higher-priority layer over a lower one, feathering its edges (no hard seams)
    const merge = (hi, lo, r) => {
      const w = new Float32Array(N);
      for (let p = 0; p < N; p++) w[p] = hi[p] >= 0 ? 1 : 0;
      boxBlur(w, r);
      for (let p = 0; p < N; p++) {
        const x = hi[p], y = lo[p];
        lo[p] = x >= 0 && y >= 0 ? y + (x - y) * w[p] : x >= 0 ? x : y;
      }
      return lo;
    };
    // one day's map: NOAA-20 feathered over Suomi-NPP (their passes are ~50 min apart)
    const dayMap = async (imgs) => {
      if (!imgs.length) return new Float32Array(N).fill(-1);
      let acc = one(imgs[imgs.length - 1]);
      for (let k = imgs.length - 2; k >= 0; k--) { await idle(); acc = merge(one(imgs[k]), acc, 16); }
      return acc;
    };
    const cNow = await dayMap(today), cPrev = await dayMap(prev);
    await idle();
    // feather today's swath edges into yesterday's map so the seams don't show
    const w = new Float32Array(N);
    for (let p = 0; p < N; p++) w[p] = cNow[p] >= 0 ? 1 : 0;
    boxBlur(w, 24);
    // and feather any imaged area into the static stand-in where no recent pass exists
    const w2 = new Float32Array(N);
    for (let p = 0; p < N; p++) w2[p] = cNow[p] >= 0 || cPrev[p] >= 0 ? 1 : 0;
    boxBlur(w2, 40);
    // real data, blending today's passes into yesterday's
    const live = new Float32Array(N), valid = new Float32Array(N);
    let covered = 0;
    for (let p = 0; p < N; p++) {
      const x = cNow[p], y = cPrev[p];
      if (x < 0 && y < 0) continue;
      live[p] = x >= 0 && y >= 0 ? y + (x - y) * w[p] : x >= 0 ? x : y;
      valid[p] = 1;
      covered++;
    }
    // sun glint: mirror-like reflection on calm tropical seas is smooth and mid-grey, while real
    // cloud has texture (or is bright overcast). Fade smooth mid-grey areas.
    {
      const m = Float32Array.from(live), m2 = Float32Array.from(live, (x) => x * x);
      boxBlur(m, 4); boxBlur(m2, 4);
      for (let p = 0; p < N; p++) {
        if (!valid[p]) continue;
        const sd = Math.sqrt(Math.max(0, m2[p] - m[p] * m[p])), v = live[p];
        const smooth = 1 - Math.min(1, sd / 0.07), mid = v > 0.12 && v < 0.65 ? 1 : 0;
        // very smooth grey (glint, low-sun pass edges) is unreliable: let the natural fill take over
        if (smooth > 0.6 && mid) { valid[p] = 0; live[p] = 0; covered--; }
        else live[p] = v * (1 - 0.75 * smooth * mid);
      }
      for (let p = 0; p < N; p++) w2[p] = valid[p];
      boxBlur(w2, 40);
      // the map's two edges were imaged ~24 h apart, so the date line is a hard seam: hand a band
      // around it to the natural fill (which is continuous on the sphere)
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const d = Math.min(x, W - 1 - x);
        if (d < 48) { const t = Math.max(0, (d - 4) / 44); w2[y * W + x] *= t * t * (3 - 2 * t); }
      }
    }
    await idle();
    // best guess for the gaps: cloud amount pulled in smoothly from the real data around them,
    // lightly guided by the climatological map, then drawn as natural swirling cloud on the sphere
    const est = pullPush(live, valid);
    await idle();
    const out = ctx.createImageData(W, H), o = out.data;
    const cloud = new Float32Array(N);
    // synthetic detail is computed at half resolution, only where needed (cheap on phones)
    const HW = W >> 1, half = new Float32Array(HW * (H >> 1)).fill(NaN);
    for (let y = 0, p = 0; y < H; y++) {
      const hy = y >> 1, lat = (0.5 - (hy * 2 + 1) / H) * Math.PI, cl = Math.cos(lat), sl = Math.sin(lat);
      for (let x = 0; x < W; x++, p++) {
        const real = live[p], k = w2[p];
        if (k >= 0.999) { cloud[p] = real; continue; }
        const prior = fallback ? fallback[p * 4] / 255 : est[p];
        const e = Math.min(1, est[p] * 0.75 + prior * 0.25);
        const q = hy * HW + (x >> 1);
        if (Number.isNaN(half[q])) {
          const lon = (((x >> 1) * 2 + 1) / W) * Math.PI * 2;
          half[q] = cloudAt(cl * Math.cos(lon), sl, cl * Math.sin(lon), e);
        }
        const synth = half[q];
        cloud[p] = synth + (real - synth) * k;
      }
    }
    soften(cloud); // take the JPEG speckle off the whole map
    for (let p = 0, i = 0; p < N; p++, i += 4) {
      const v = Math.round(Math.min(1, Math.max(0, cloud[p])) * 255);
      o[i] = o[i + 1] = o[i + 2] = v;
      o[i + 3] = 255;
    }
    ctx.putImageData(out, 0, 0);
    tex.needsUpdate = true;
    Object.assign(weather, { live: true, updated: new Date(), source: 'gibs', coverage: covered / N });
  } catch (e) {
    console.warn('live clouds unavailable, using the static map', e);
  }
}

const idle = () => new Promise((r) => setTimeout(r, 0)); // let frames render between heavy steps

// Pull-push fill: average real values down a pyramid, then pull them back up (bilinear) into every
// pixel that had no data, so gaps get a smooth estimate from their surroundings at every scale.
function pullPush(val, wgt) {
  const levels = [{ w: W, h: H, v: Float32Array.from(val, (x, i) => x * wgt[i]), a: Float32Array.from(wgt) }];
  while (levels.at(-1).w > 8) {
    const L = levels.at(-1), w = L.w >> 1, h = L.h >> 1, v = new Float32Array(w * h), a = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let sv = 0, sa = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const q = (y * 2 + dy) * L.w + x * 2 + dx;
        sv += L.v[q]; sa += L.a[q];
      }
      v[y * w + x] = sv; a[y * w + x] = sa;
    }
    levels.push({ w, h, v, a });
  }
  // coarsest level: plain average where anything exists
  let top = levels.at(-1), est = new Float32Array(top.w * top.h);
  for (let q = 0; q < est.length; q++) est[q] = top.a[q] > 0 ? top.v[q] / top.a[q] : 0.35;
  for (let l = levels.length - 2; l >= 0; l--) {
    const L = levels[l], P = levels[l + 1], next = new Float32Array(L.w * L.h);
    for (let y = 0; y < L.h; y++) for (let x = 0; x < L.w; x++) {
      // bilinear sample of the coarser estimate (x wraps around the date line)
      const fx = (x + 0.5) / 2 - 0.5, fy = Math.min(P.h - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
      const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
      const X0 = (x0 + P.w) % P.w, X1 = (x0 + 1) % P.w, Y1 = Math.min(P.h - 1, y0 + 1);
      const up = (est[y0 * P.w + X0] * (1 - tx) + est[y0 * P.w + X1] * tx) * (1 - ty) + (est[Y1 * P.w + X0] * (1 - tx) + est[Y1 * P.w + X1] * tx) * ty;
      const q = y * L.w + x, cap = 4 ** l; // samples this cell could hold
      const k = Math.min(1, L.a[q] / cap);
      next[q] = L.a[q] > 0 ? (L.v[q] / L.a[q]) * k + up * (1 - k) : up;
    }
    est = next;
  }
  return est;
}

// 3D value noise on the unit sphere (no stretching toward the poles).
const PERM = new Uint8Array(512);
{
  let s = 1337;
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) { s = (s * 16807) % 2147483647; const j = s % (i + 1); [p[i], p[j]] = [p[j], p[i]]; }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
}
const VAL = Float32Array.from({ length: 256 }, (_, i) => PERM[i] / 255);
function vnoise(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz);
  const X = xi & 255, Y = yi & 255, Z = zi & 255;
  const h = (a, b, c) => VAL[PERM[PERM[PERM[a] + b] + c] & 255];
  const l = (a, b, t) => a + (b - a) * t;
  return l(l(l(h(X, Y, Z), h(X + 1, Y, Z), u), l(h(X, Y + 1, Z), h(X + 1, Y + 1, Z), u), v),
    l(l(h(X, Y, Z + 1), h(X + 1, Y, Z + 1), u), l(h(X, Y + 1, Z + 1), h(X + 1, Y + 1, Z + 1), u), v), w);
}
function fbm(x, y, z, oct) {
  let s = 0, a = 0.5, t = 0;
  for (let i = 0; i < oct; i++) { s += vnoise(x, y, z) * a; t += a; x *= 2.03; y *= 2.03; z *= 2.03; a *= 0.5; }
  return s / t;
}
// Natural-looking cloud at a point on the unit sphere with expected cover e (0..1): domain-warped
// fractal noise (swirls and streets), thresholded so the area covered matches e.
function cloudAt(x, y, z, e) {
  if (e < 0.02) return 0;
  const S = 14;
  const wx = fbm(x * 3 + 5.2, y * 3, z * 3, 3), wy = fbm(x * 3, y * 3 + 9.1, z * 3, 3);
  const n = fbm(x * S + wx * 2.2, y * S * 1.4 + wy * 2.2, z * S, 5);
  const t = 1 - e;
  return Math.min(1, Math.max(0, (n - (t * 0.62 + 0.2)) / 0.13 + 0.5)) * Math.min(1, e * 5);
}

// Light 3x3 smoothing (x wraps).
function soften(a) {
  const t = Float32Array.from(a);
  for (let y = 1; y < H - 1; y++) for (let x = 0; x < W; x++) {
    const xl = (x + W - 1) % W, xr = (x + 1) % W;
    const r0 = (y - 1) * W, r1 = y * W, r2 = (y + 1) * W;
    a[r1 + x] = (t[r1 + x] * 4 + t[r1 + xl] + t[r1 + xr] + t[r0 + x] + t[r2 + x]) / 8;
  }
}

// Separable box blur (running sums), in place; horizontal wraps around the date line.
function boxBlur(a, r) {
  const t = new Float32Array(a.length), k = 1 / (2 * r + 1);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    let s = 0;
    for (let x = -r; x <= r; x++) s += a[row + ((x + W) % W)];
    for (let x = 0; x < W; x++) {
      t[row + x] = s * k;
      s += a[row + ((x + r + 1) % W)] - a[row + ((x - r + W) % W)];
    }
  }
  for (let x = 0; x < W; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += t[Math.min(H - 1, Math.max(0, y)) * W + x];
    for (let y = 0; y < H; y++) {
      a[y * W + x] = s * k;
      s += t[Math.min(H - 1, y + r + 1) * W + x] - t[Math.max(0, y - r) * W + x];
    }
  }
}

// Start in the background after boot; refresh every 30 minutes as new satellite swaths land.
export function startWeather() {
  init().then(() => refreshWeather());
  setInterval(refreshWeather, 30 * 60 * 1000);
}
