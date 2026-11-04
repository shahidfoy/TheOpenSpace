import * as THREE from 'three';

// Live weather where you fly over Earth.
//   Local conditions: Open-Meteo (open-meteo.com, no key, CORS) "current" weather on a 5 x 5 grid
//     about 50 km apart around you, refreshed every few minutes and when you fly off the grid.
//     It drives rain and snow, thunderstorms, wind, visibility and how heavy the clouds look.
//   Tropical cyclones: our /api/weather/storms function (GDACS + NOAA NHC), polled every 10 min.
// Everything degrades quietly: with no data the sky is simply fair.

export const LIVE_WEATHER_CREDIT = 'Weather: Open-Meteo · Storms: GDACS, NOAA NHC';
const STORMS = `${import.meta.env.BASE_URL}api/weather/storms`;
const N = 5, STEP = 0.45; // grid points per side, degrees apart
const VARS = 'weather_code,precipitation,rain,showers,snowfall,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m,temperature_2m,visibility';

// R: precipitation (mm/h, x40) · G: frozen fraction · B: thunder · A: cloud cover
const data = new Uint8Array(N * N * 4);
const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
tex.magFilter = tex.minFilter = THREE.LinearFilter;
tex.needsUpdate = true;

export const live = {
  tex,
  box: new THREE.Vector4(0, 0, 1, 1), // lat0, lon0 of grid cell (0,0), step lat, step lon
  grid: null, // [N*N] parsed points, row-major from the south-west corner
  center: null, at: 0, error: null,
  storms: [], stormsAt: 0, stormsError: null,
};
globalThis.__liveWeather = live;

// WMO weather interpretation codes → what's falling and how it reads
export function describe(code) {
  if (code == null) return '';
  if (code >= 95) return code >= 96 ? 'Thunderstorm with hail' : 'Thunderstorm';
  if (code >= 85) return code === 86 ? 'Heavy snow showers' : 'Snow showers';
  if (code >= 80) return code === 82 ? 'Violent rain showers' : code === 81 ? 'Rain showers' : 'Light rain showers';
  if (code >= 77) return 'Snow grains';
  if (code >= 71) return code === 75 ? 'Heavy snow' : code === 73 ? 'Snow' : 'Light snow';
  if (code >= 66) return 'Freezing rain';
  if (code >= 61) return code === 65 ? 'Heavy rain' : code === 63 ? 'Rain' : 'Light rain';
  if (code >= 56) return 'Freezing drizzle';
  if (code >= 51) return 'Drizzle';
  if (code >= 45) return 'Fog';
  if (code >= 3) return 'Overcast';
  if (code === 2) return 'Partly cloudy';
  if (code === 1) return 'Mainly clear';
  return 'Clear sky';
}
const frozen = (c) => (c >= 71 && c <= 77) || c === 85 || c === 86;
const thunder = (c) => c >= 95;

function encode() {
  for (let i = 0; i < N * N; i++) {
    const p = live.grid[i];
    // models report mm in the last hour; showers count as rain
    const mmh = p ? Math.max(p.precipitation || 0, (p.rain || 0) + (p.showers || 0) + (p.snowfall || 0) * 0.7) : 0;
    data[i * 4] = Math.min(255, mmh * 40);
    data[i * 4 + 1] = p && (frozen(p.weather_code) || (p.snowfall || 0) > 0.05) ? 255 : 0;
    data[i * 4 + 2] = p && thunder(p.weather_code) ? 255 : 0;
    data[i * 4 + 3] = p ? Math.min(255, (p.cloud_cover || 0) * 2.55) : 0;
  }
  tex.needsUpdate = true;
}

let busy = false;
export async function pollLocal(lat, lon) {
  const now = Date.now();
  const moved = live.center ? Math.hypot(lat - live.center.lat, (lon - live.center.lon) * Math.cos(lat * Math.PI / 180)) : Infinity;
  if (busy || (moved < STEP * 1.2 && now - live.at < 5 * 60e3) || now - (live.tried || 0) < 20e3) return;
  busy = true;
  live.tried = now;
  try {
    const lat0 = Math.round(lat / STEP) * STEP - STEP * 2, lon0 = Math.round(lon / STEP) * STEP - STEP * 2;
    const lats = [], lons = [];
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      lats.push(Math.max(-89.9, Math.min(89.9, lat0 + j * STEP)).toFixed(3));
      lons.push((((lon0 + i * STEP + 540) % 360) - 180).toFixed(3));
    }
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lats.join(',')}&longitude=${lons.join(',')}&current=${VARS}&wind_speed_unit=ms`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`open-meteo ${r.status}`);
    const j = await r.json();
    live.grid = (Array.isArray(j) ? j : [j]).map((x) => {
      const c = x.current;
      if (!c) return null;
      // "current" amounts cover the last `interval` seconds (15 min): turn them into rates per hour
      const k = 3600 / (c.interval || 3600);
      for (const key of ['precipitation', 'rain', 'showers', 'snowfall']) c[key] = (c[key] || 0) * k;
      return c;
    });
    live.box.set(lat0, lon0, STEP, STEP);
    live.center = { lat: lat0 + STEP * 2, lon: lon0 + STEP * 2 };
    live.at = Date.now();
    live.error = null;
    encode();
  } catch (e) {
    live.error = String(e.message || e);
  } finally {
    busy = false;
  }
}

export async function pollStorms() {
  const now = Date.now();
  if (now - live.stormsAt < 10 * 60e3 || now - (live.stormsTried || 0) < 60e3) return;
  live.stormsTried = now;
  try {
    const r = await fetch(STORMS, { cache: 'no-store' });
    if (!r.ok) throw new Error(`storms ${r.status}`);
    const j = await r.json();
    live.storms = (j.storms || []).filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon));
    live.stormsAt = Date.now();
    live.stormsError = null;
  } catch (e) {
    live.stormsError = String(e.message || e);
  }
}

// Conditions at a point, interpolated across the grid (null until the first download).
export function sampleLocal(lat, lon) {
  if (!live.grid) return null;
  const b = live.box;
  const fx = THREE.MathUtils.clamp((lon - b.y) / b.w, 0, N - 1), fy = THREE.MathUtils.clamp((lat - b.x) / b.z, 0, N - 1);
  const i = Math.min(N - 2, Math.floor(fx)), j = Math.min(N - 2, Math.floor(fy)), u = fx - i, v = fy - j;
  const at = (ii, jj) => live.grid[jj * N + ii];
  const P = [at(i, j), at(i + 1, j), at(i, j + 1), at(i + 1, j + 1)];
  if (P.some((p) => !p)) return null;
  const w = [(1 - u) * (1 - v), u * (1 - v), (1 - u) * v, u * v];
  const mix = (k) => P.reduce((a, p, n) => a + (p[k] || 0) * w[n], 0);
  // wind as a vector so directions average properly (meteorological: where it blows FROM)
  let wx = 0, wy = 0;
  P.forEach((p, n) => { const a = (p.wind_direction_10m || 0) * Math.PI / 180; wx += Math.sin(a) * p.wind_speed_10m * w[n]; wy += Math.cos(a) * p.wind_speed_10m * w[n]; });
  const near = P[w.indexOf(Math.max(...w))]; // categorical things come from the nearest point
  const mmh = Math.max(mix('precipitation'), mix('rain') + mix('showers') + mix('snowfall') * 0.7);
  return {
    code: near.weather_code, text: describe(near.weather_code),
    mmh, snow: frozen(near.weather_code) || mix('snowfall') > 0.05,
    thunder: P.some((p, n) => thunder(p.weather_code) && w[n] > 0.15),
    temp: mix('temperature_2m'), cloud: mix('cloud_cover'),
    wind: Math.hypot(wx, wy), windFrom: ((Math.atan2(wx, wy) * 180 / Math.PI) + 360) % 360, gust: mix('wind_gusts_10m'),
    vis: mix('visibility'),
  };
}

export const compass = (deg) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];
