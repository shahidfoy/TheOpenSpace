// Builds public/data/borders.json from Natural Earth 1:50m boundaries (public domain).
//   node scripts/build-borders.mjs
// Output: { "<ISO alpha-2>": [ring, ...], "US-<state>": [ring, ...] } where each ring is a flat
// [lat, lon, lat, lon, ...] outline, lightly simplified. The CYBER globe outlines a country (or US
// state) when a report names only that, instead of pinning a made-up point at its centre.
import fs from 'node:fs';

const NE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson';
const MIN_STEP = 0.12; // degrees: drop vertices closer than this to the last one kept
const get = async (f) => (await fetch(`${NE}/${f}`)).json();
const [countries, states] = await Promise.all([get('ne_50m_admin_0_countries.geojson'), get('ne_50m_admin_1_states_provinces.geojson')]);

const out = {};
const rings = (geom) => (geom.type === 'Polygon' ? [geom.coordinates[0]] : geom.coordinates.map((p) => p[0]));
function add(key, geom) {
  if (!key || key === '-99' || !geom) return;
  for (const ring of rings(geom)) {
    const flat = [];
    let pl = null, po = null;
    for (const [lon, lat] of ring) {
      if (pl !== null && Math.hypot(lat - pl, (lon - po) * Math.cos(lat * Math.PI / 180)) < MIN_STEP) continue;
      flat.push(+lat.toFixed(2), +lon.toFixed(2));
      pl = lat; po = lon;
    }
    if (flat.length >= 8) (out[key] ||= []).push(flat); // skip specks (< 4 points)
  }
}
for (const f of countries.features) {
  const p = f.properties;
  // a few countries (France, Norway, ...) carry -99 in ISO_A2 but the code in ISO_A2_EH
  add(p.ISO_A2 !== '-99' ? p.ISO_A2 : p.ISO_A2_EH, f.geometry);
}
for (const f of states.features) {
  const code = f.properties.iso_3166_2 || '';
  if (code.startsWith('US-')) add(code, f.geometry);
}

fs.mkdirSync('public/data', { recursive: true });
const json = JSON.stringify({ source: 'Natural Earth 1:50m (public domain)', borders: out });
fs.writeFileSync('public/data/borders.json', json);
console.log(`borders.json: ${Object.keys(out).length} areas, ${(json.length / 1024).toFixed(0)} KB`);
