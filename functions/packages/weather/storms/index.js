// Active tropical cyclones worldwide (DigitalOcean Function, served at /api/weather/storms).
// Browsers can't read these feeds directly (no CORS), so this fetches them server-side and returns
// one small JSON the game polls every ~10 minutes.
//
//   GDACS (EU JRC / UN OCHA) - every basin: current position, peak wind, alert level
//   NOAA NHC CurrentStorms   - Atlantic and East/Central Pacific: advisory position, intensity,
//                              motion. Where both list a storm, NHC's fresher advisory wins.

const UA = 'TheOpenSpace/0.2 (game weather; contact via github.com/shahidfoy)';
const TTL = 10 * 60 * 1000;
const G = globalThis.__openspaceStorms || (globalThis.__openspaceStorms = { at: 0, body: null });

async function get(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctl.signal });
    if (!r.ok) throw new Error(`${new URL(url).host} -> ${r.status}`);
    return r.json();
  } finally {
    clearTimeout(timer);
  }
}

// Saffir-Simpson style label from 1-minute sustained wind (km/h)
function category(kmh) {
  if (kmh >= 252) return 'Category 5';
  if (kmh >= 209) return 'Category 4';
  if (kmh >= 178) return 'Category 3';
  if (kmh >= 154) return 'Category 2';
  if (kmh >= 119) return 'Category 1';
  if (kmh >= 63) return 'Tropical storm';
  return 'Tropical depression';
}
// what the storm is called in its basin
function kindAt(lat, lon, kmh) {
  if (kmh < 119) return 'Tropical storm';
  if (lon > 100 && lon < 180 && lat > 0) return 'Typhoon';
  if ((lon > 40 && lon <= 100) || lat < 0) return 'Cyclone';
  return 'Hurricane';
}

async function gdacs() {
  const j = await get('https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=TC');
  return (j.features || [])
    .filter((f) => String(f.properties?.iscurrent) === 'true' && f.geometry?.type === 'Point')
    .map((f) => {
      const p = f.properties, [lon, lat] = f.geometry.coordinates, kmh = Math.round(p.severitydata?.severity || 0);
      const name = String(p.eventname || p.name || '').replace(/-\d+$/, '').replace(/^Tropical Cyclone\s+/i, '');
      return { id: `gdacs-${p.eventid}`, name, lat, lon, kmh, alert: p.alertlevel || null, src: 'GDACS', t: p.todate ? `${p.todate}Z` : null };
    });
}

async function nhc() {
  const j = await get('https://www.nhc.noaa.gov/CurrentStorms.json');
  return (j.activeStorms || []).map((s) => {
    const kmh = Math.round((+s.intensity || 0) * 1.852); // knots
    return {
      id: `nhc-${s.id}`, name: s.name, lat: +s.latitudeNumeric, lon: +s.longitudeNumeric, kmh,
      moveDir: +s.movementDir || null, moveKmh: s.movementSpeed ? Math.round(+s.movementSpeed * 1.609) : null, // mph
      pressure: +s.pressure || null, src: 'NOAA NHC', t: s.lastUpdate || null,
    };
  });
}

async function build() {
  const [g, n] = await Promise.allSettled([gdacs(), nhc()]);
  const errors = [g, n].filter((r) => r.status === 'rejected').map((r) => String(r.reason?.message || r.reason));
  const list = n.status === 'fulfilled' ? [...n.value] : [];
  for (const s of g.status === 'fulfilled' ? g.value : []) {
    // same storm in both feeds: keep NHC's
    if (list.some((x) => x.name.toUpperCase() === s.name.toUpperCase())) continue;
    list.push(s);
  }
  for (const s of list) { s.category = category(s.kmh); s.kind = kindAt(s.lat, s.lon, s.kmh); }
  return { updated: new Date().toISOString(), poll: 600, storms: list, errors };
}

let inflight = null;
async function main() {
  const now = Date.now();
  if (!G.body || now - G.at > TTL) {
    if (!inflight) inflight = build().then((b) => { G.body = b; G.at = Date.now(); }).finally(() => { inflight = null; });
    await inflight.catch(() => {});
  }
  return {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=120', 'Access-Control-Allow-Origin': '*' },
    body: G.body || { updated: null, poll: 600, storms: [], errors: ['unavailable'] },
  };
}

module.exports = { main, build };
