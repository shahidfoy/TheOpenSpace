// Builds public/data/cables.json from TeleGeography's Submarine Cable Map (CC BY-NC-SA 3.0).
//   node scripts/build-cables.mjs
// Output: a compact network graph the CYBER globe routes incidents through.
//   nodes:    flat [lat, lon, ...] of every cable vertex (snapped to 0.01°)
//   cables:   [name, color, [[nodeIdx, ...], ...]] polylines along real cable paths
//   stations: [nodeIdx, name] cable landing stations
//   land:     [a, b, ...] terrestrial backhaul: each station links to its LAND_K nearest within LAND_KM
//             (fiber between nearby landing towns is not in the dataset; drawn as straight links)
import fs from 'node:fs';

const API = 'https://www.submarinecablemap.com/api/v3';
const LAND_KM = 750, LAND_K = 5;
const get = async (p) => (await fetch(`${API}/${p}`)).json();
const [cables, landings] = await Promise.all([get('cable/cable-geo.json'), get('landing-point/landing-point-geo.json')]);

const nodes = [], index = new Map();
const node = (lon, lat) => {
  const k = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  if (!index.has(k)) { index.set(k, nodes.length / 2); nodes.push(+lat.toFixed(2), +lon.toFixed(2)); }
  return index.get(k);
};
const R = 6371, D2R = Math.PI / 180;
const km = (a, b) => {
  const [la1, lo1, la2, lo2] = [nodes[a * 2], nodes[a * 2 + 1], nodes[b * 2], nodes[b * 2 + 1]].map((x) => x * D2R);
  const h = Math.sin((la2 - la1) / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};

const byName = new Map();
for (const f of cables.features) {
  const { name, color } = f.properties;
  const e = byName.get(name) || byName.set(name, [name, color, []]).get(name);
  for (const line of f.geometry.coordinates) {
    const p = line.map(([lon, lat]) => node(lon, lat)).filter((n, i, a) => i === 0 || n !== a[i - 1]);
    if (p.length > 1) e[2].push(p);
  }
}

// landing stations: snap to the nearest cable vertex within 40 km, else add as their own node
const ends = new Set([...byName.values()].flatMap((c) => c[2].flatMap((p) => [p[0], p[p.length - 1]])));
const stations = [];
for (const f of landings.features) {
  const [lon, lat] = f.geometry.coordinates;
  const s = node(lon, lat);
  let best = -1, bd = 40;
  for (const e of ends) { const d = km(s, e); if (d < bd) { bd = d; best = e; } }
  stations.push([best >= 0 ? best : s, f.properties.name]);
}

// backhaul between stations and cable ends that are close on land
const hubs = [...new Set([...stations.map((s) => s[0]), ...ends])];
const land = [], seen = new Set();
for (const a of hubs) {
  // each hub links to its few nearest neighbours, enough to keep coastlines connected
  const near = hubs.map((b) => [b, km(a, b)]).filter(([b, d]) => b !== a && d > 1 && d < LAND_KM).sort((x, y) => x[1] - y[1]).slice(0, LAND_K);
  for (const [b] of near) { const k = a < b ? `${a},${b}` : `${b},${a}`; if (!seen.has(k)) { seen.add(k); land.push(a, b); } }
}

fs.mkdirSync('public/data', { recursive: true });
const out = { source: 'TeleGeography Submarine Cable Map, CC BY-NC-SA 3.0', nodes, cables: [...byName.values()], stations, land };
fs.writeFileSync('public/data/cables.json', JSON.stringify(out));
console.log(`${byName.size} cables, ${nodes.length / 2} nodes, ${stations.length} stations, ${land.length / 2} land links, ${(fs.statSync('public/data/cables.json').size / 1024).toFixed(0)} KB`);
