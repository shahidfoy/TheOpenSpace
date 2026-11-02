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
    .map((v) => ({ group: v.group_name, country: (v.country || '').toUpperCase() || null, sector: !v.activity || /^(not found|unknown|n\/a)$/i.test(v.activity) ? 'Unspecified sector' : v.activity, t: v.discovered }));
}

async function botnets() {
  const list = await get('https://feodotracker.abuse.ch/downloads/ipblocklist.json');
  return list.map((b) => ({ malware: b.malware, country: b.country, status: b.status, as: b.as_name, t: b.last_online || b.first_seen }));
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
  return out;
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
    sources: ['ransomware.live', 'abuse.ch Feodo Tracker', 'SANS Internet Storm Center / DShield', 'CISA Known Exploited Vulnerabilities'],
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
