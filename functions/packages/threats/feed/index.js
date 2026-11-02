// Cyber-threat aggregator (DigitalOcean Function, served at /api/threats/feed).
// Browsers can't read most threat feeds directly (no CORS), so this fetches them server-side,
// trims them to what the game shows, and returns one small JSON. Results are cached in the warm
// instance for 10 minutes; the response is CDN-cacheable for 5 minutes.
//
// Sources (all public):
//   ransomware.live  - victims posted on ransomware leak sites (we keep only group, sector,
//                      country and time: no victim names or ransom notes)
//   abuse.ch Feodo   - botnet command-and-control servers
//   SANS ISC/DShield - top attacking IPs seen by its sensor network, with the AS country
//   CISA KEV         - vulnerabilities newly confirmed as exploited in the wild

const UA = 'TheOpenSpace/0.1 (game cyber map; contact via github.com/shahidfoy)';
const TTL = 10 * 60 * 1000;
let cache = null;

async function get(url, opts = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeout || 15000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, ...(opts.headers || {}) }, signal: ctl.signal });
    if (!r.ok && r.status !== 206) throw new Error(`${url} -> ${r.status}`);
    return opts.text ? r.text() : r.json();
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- US state detection
// Leak-site posts carry only a country. For US victims we look for the state in the post's own
// title and description: "City, ST" / "ST 12345" patterns (strong) and full state names. Posts
// with no clear state stay unassigned rather than guessed.
const STATES = [["AK","Alaska"],["AL","Alabama"],["AR","Arkansas"],["AZ","Arizona"],["CA","California"],["CO","Colorado"],["CT","Connecticut"],["DC","District of Columbia"],["DE","Delaware"],["FL","Florida"],["GA","Georgia"],["HI","Hawaii"],["IA","Iowa"],["ID","Idaho"],["IL","Illinois"],["IN","Indiana"],["KS","Kansas"],["KY","Kentucky"],["LA","Louisiana"],["MA","Massachusetts"],["MD","Maryland"],["ME","Maine"],["MI","Michigan"],["MN","Minnesota"],["MO","Missouri"],["MS","Mississippi"],["MT","Montana"],["NC","North Carolina"],["ND","North Dakota"],["NE","Nebraska"],["NH","New Hampshire"],["NJ","New Jersey"],["NM","New Mexico"],["NV","Nevada"],["NY","New York"],["OH","Ohio"],["OK","Oklahoma"],["OR","Oregon"],["PA","Pennsylvania"],["PR","Puerto Rico"],["RI","Rhode Island"],["SC","South Carolina"],["SD","South Dakota"],["TN","Tennessee"],["TX","Texas"],["UT","Utah"],["VA","Virginia"],["VT","Vermont"],["WA","Washington"],["WI","Wisconsin"],["WV","West Virginia"],["WY","Wyoming"]];
const CODES = new Set(STATES.map(([c]) => c));
const BY_NAME = [...STATES].sort((a, b) => b[1].length - a[1].length); // "West Virginia" before "Virginia"
function usState(text) {
  if (!text) return null;
  const score = {};
  const add = (c, w) => { score[c] = (score[c] || 0) + w; };
  for (const m of text.matchAll(/,\s*([A-Z]{2})\b(?!\.?[a-z])/g)) if (CODES.has(m[1])) add(m[1], 2);
  for (const m of text.matchAll(/\b([A-Z]{2})\s+\d{5}(?:-\d{4})?\b/g)) if (CODES.has(m[1])) add(m[1], 3);
  let rest = text.replace(/Washington,?\s*D\.?\s*C\.?/gi, () => { add('DC', 2); return ' '; });
  for (const [code, name] of BY_NAME) {
    const re = new RegExp(`\\b${name.replace(/ /g, '\\s+')}\\b`, 'gi');
    rest = rest.replace(re, () => { add(code, 1); return ' '; });
  }
  const best = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : null;
}

// Precise IP locations (region + coordinates) via ip-api.com's batch endpoint (server-side only).
async function geolocate(ips) {
  const out = {};
  const list = [...new Set(ips.filter(Boolean))];
  for (let i = 0; i < list.length; i += 100) {
    try {
      const r = await fetch('http://ip-api.com/batch?fields=status,countryCode,region,regionName,city,lat,lon,query', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA }, body: JSON.stringify(list.slice(i, i + 100)),
      });
      for (const g of await r.json()) if (g.status === 'success') out[g.query] = g;
    } catch { /* fall back to country centroids */ }
  }
  return out;
}
// where the machine physically is (an AS registered in one country can host IPs in another)
const placed = (o, g) => (g ? { ...o, country: g.countryCode || o.country, lat: g.lat, lon: g.lon, region: g.countryCode === 'US' ? g.region : g.regionName || null, city: g.city || null } : o);

// The full victims file is ~20 MB, newest first: read only the first ~1.5 MB and close the array.
async function ransomware() {
  const txt = await get('https://data.ransomware.live/victims.json', { text: true, headers: { Range: 'bytes=0-1500000' }, timeout: 20000 });
  let list;
  try { list = JSON.parse(txt); } catch {
    const end = txt.lastIndexOf('\n    },');
    list = JSON.parse(`${txt.slice(0, end + 6)}]`);
  }
  const since = Date.now() - 72 * 3600 * 1000;
  return list
    .filter((v) => Date.parse(v.discovered) >= since)
    .slice(0, 400)
    .map((v) => ({ group: v.group_name, country: (v.country || '').toUpperCase() || null, region: (v.country || '').toUpperCase() === 'US' ? usState(`${v.post_title || ''}\n${v.description || ''}`) : null, sector: !v.activity || /^(not found|unknown|n\/a)$/i.test(v.activity) ? 'Unspecified sector' : v.activity, t: v.discovered }));
}

async function botnets() {
  const list = await get('https://feodotracker.abuse.ch/downloads/ipblocklist.json');
  const geo = await geolocate(list.map((b) => b.ip_address));
  return list.map((b) => placed({ malware: b.malware, country: b.country, status: b.status, as: b.as_name, t: b.last_online || b.first_seen }, geo[b.ip_address]));
}

async function attackers() {
  const top = await get('https://isc.sans.edu/api/sources/attacks/40?json');
  const out = [];
  // geolocate by AS country (a few at a time, politely)
  for (let i = 0; i < top.length; i += 8) {
    const batch = await Promise.all(top.slice(i, i + 8).map(async (s) => {
      try {
        const info = (await get(`https://isc.sans.edu/api/ip/${s.ip}?json`, { timeout: 8000 })).ip || {};
        return { ip: s.ip, attacks: s.attacks, reports: s.count, country: info.ascountry || null, as: info.asname || null, t: s.lastseen };
      } catch { return null; }
    }));
    out.push(...batch.filter(Boolean));
  }
  const geo = await geolocate(out.map((a) => a.ip));
  return out.map((a) => placed(a, geo[a.ip]));
}

async function exploits() {
  const kev = await get('https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json', { timeout: 20000 });
  return kev.vulnerabilities
    .sort((a, b) => b.dateAdded.localeCompare(a.dateAdded))
    .slice(0, 12)
    .map((v) => ({ cve: v.cveID, vendor: v.vendorProject, product: v.product, name: v.vulnerabilityName, t: v.dateAdded, ransomware: v.knownRansomwareCampaignUse === 'Known' }));
}

async function build() {
  const settle = async (fn) => { try { return await fn(); } catch (e) { return { error: String(e.message || e) }; } };
  const [r, b, a, k] = await Promise.all([settle(ransomware), settle(botnets), settle(attackers), settle(exploits)]);
  const ok = (x) => (Array.isArray(x) ? x : []);
  return {
    updated: new Date().toISOString(),
    ransomware: ok(r), botnets: ok(b), attackers: ok(a), exploits: ok(k),
    errors: Object.fromEntries([['ransomware', r], ['botnets', b], ['attackers', a], ['exploits', k]].filter(([, x]) => !Array.isArray(x)).map(([n, x]) => [n, x.error])),
    sources: ['ransomware.live', 'abuse.ch Feodo Tracker', 'SANS Internet Storm Center / DShield', 'CISA Known Exploited Vulnerabilities', 'ip-api.com (IP locations)'],
  };
}

async function main() {
  if (!cache || Date.now() - cache.at > TTL) cache = { at: Date.now(), data: await build() };
  return {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*' },
    body: cache.data,
  };
}

module.exports = { main, build };
