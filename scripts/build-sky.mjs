// Packs real sky data from d3-celestial (BSD-3, Olaf Frohn; star data from the
// Hipparcos / Yale Bright Star catalogues) into compact files the game loads at boot.
//
//   npm pack d3-celestial && tar -xzf d3-celestial-*.tgz
//   node scripts/build-sky.mjs path/to/package/data
//
// public/sky/stars.bin  Int16 x4 per star: RA*150, Dec*300, mag*1000, B-V*1000 (RA/Dec in degrees)
// public/sky/lines.json constellation stick figures [[ra, dec], ...] polylines
// public/sky/names.json brightest named stars [name, ra, dec, mag]
import fs from 'node:fs';
import path from 'node:path';

const src = process.argv[2];
if (!src) throw new Error('usage: node scripts/build-sky.mjs <d3-celestial data dir>');
const out = path.resolve('public/sky');
fs.mkdirSync(out, { recursive: true });
const read = (f) => JSON.parse(fs.readFileSync(path.join(src, f), 'utf8'));

const MAG = 7.5;
const stars = read('stars.8.json').features.filter((f) => f.properties.mag <= MAG);
const buf = new Int16Array(stars.length * 4);
stars.forEach((f, i) => {
  const [ra, dec] = f.geometry.coordinates;
  const bv = parseFloat(f.properties.bv);
  buf.set([Math.round(ra * 150), Math.round(dec * 300), Math.round(f.properties.mag * 1000), Math.round((Number.isFinite(bv) ? bv : 0.6) * 1000)], i * 4);
});
fs.writeFileSync(path.join(out, 'stars.bin'), Buffer.from(buf.buffer));

const r2 = (v) => Math.round(v * 100) / 100;
const lines = read('constellations.lines.json').features.flatMap((f) => f.geometry.coordinates.map((l) => l.map(([a, d]) => [r2(a), r2(d)])));
fs.writeFileSync(path.join(out, 'lines.json'), JSON.stringify(lines));

const names = read('starnames.json');
const named = stars.filter((f) => f.properties.mag < 1.9 && names[f.id]?.name)
  .map((f) => [names[f.id].name, r2(f.geometry.coordinates[0]), r2(f.geometry.coordinates[1]), f.properties.mag]);
fs.writeFileSync(path.join(out, 'names.json'), JSON.stringify(named));

fs.copyFileSync(path.join(src, '..', 'LICENSE'), path.join(out, 'LICENSE-d3-celestial.txt'));
console.log(`${stars.length} stars, ${lines.length} constellation lines, ${named.length} named stars`);
