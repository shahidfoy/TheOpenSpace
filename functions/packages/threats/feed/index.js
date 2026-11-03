// Cyber-threat aggregator (DigitalOcean Function, served at /api/threats/feed).
// Browsers can't read most threat feeds directly (no CORS), so this fetches them server-side,
// trims them to what the game shows, and returns one small JSON. The game polls it every ~30 s.
//
// Each source is refreshed on its own clock (its TTL below, set by how often the upstream changes
// and how polite we need to be), cached in the warm instance, and stamped with when it last
// changed. A client that sends ?since=<updated> gets only the sources that changed since then.
//
// Keyless sources (always on):
//   ransomware.live  - victims posted on ransomware leak sites (we keep only group, sector,
//                      country and time: no victim names or ransom notes)
//   blocklist.de     - IPs reported for brute-force / attacks in the last few minutes (live)
//   SANS ISC/DShield - top attacking IPs seen by its sensor network
//   abuse.ch Feodo   - botnet command-and-control servers
//   abuse.ch SSLBL   - TLS certificates newly seen on malware C&C servers
//   OpenPhish        - live phishing sites (host only), placed where they're hosted
//   CISA KEV         - vulnerabilities newly confirmed as exploited in the wild
//   NVD              - CVEs published in the last 12 hours
// Keyed sources switch on when their environment variable is set (never hardcode keys):
//   ABUSECH_KEY             abuse.ch URLhaus + ThreatFox (malware URLs and C2 indicators)
//   OTX_KEY                 AlienVault OTX pulses (campaigns with targeted countries)
//   CLOUDFLARE_RADAR_TOKEN  Cloudflare Radar DDoS origin → target country pairs
//   ABUSEIPDB_KEY           AbuseIPDB blacklist (most-reported IPs, 100% confidence)
//   NVD_API_KEY             optional: higher NVD rate limit

const dns = require('node:dns').promises;

const UA = 'TheOpenSpace/0.2 (game cyber map; contact via github.com/shahidfoy)';
const MIN = 60 * 1000;
// survives Vite's dev reloads of this module (and is just module state in production)
const G = globalThis.__openspaceThreats || (globalThis.__openspaceThreats = { src: {}, geo: new Map(), geoCalls: [], live: new Map(), phish: new Map() });

const env = (k) => {
  const v = (typeof process !== 'undefined' && process.env[k]) || '';
  return v && !v.startsWith('${') ? v.trim() : ''; // an unset App Platform template stays literal
};

async function get(url, opts = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeout || 15000);
  try {
    const r = await fetch(url, { method: opts.method || 'GET', body: opts.body, headers: { 'User-Agent': UA, ...(opts.headers || {}) }, signal: ctl.signal });
    if (!r.ok && r.status !== 206) throw new Error(`${new URL(url).host} -> ${r.status}`);
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

// ---------------------------------------------------------------- IP locations
// ip-api.com's batch endpoint (server-side only), cached per IP for the life of the instance and
// kept under its free limit of 15 batch calls a minute. IPs over budget wait for the next refresh.
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
async function geolocate(ips) {
  const out = {};
  const want = [];
  for (const ip of new Set(ips.filter(Boolean))) {
    if (G.geo.has(ip)) { if (G.geo.get(ip)) out[ip] = G.geo.get(ip); } else if (IPV4.test(ip)) want.push(ip);
  }
  for (let i = 0; i < want.length; i += 100) {
    const now = Date.now();
    G.geoCalls = G.geoCalls.filter((t) => now - t < MIN);
    if (G.geoCalls.length >= 12) break;
    G.geoCalls.push(now);
    const chunk = want.slice(i, i + 100);
    try {
      const list = await get('http://ip-api.com/batch?fields=status,countryCode,region,regionName,city,lat,lon,query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(chunk), timeout: 10000 });
      for (const g of list) {
        G.geo.set(g.query, g.status === 'success' ? g : null);
        if (g.status === 'success') out[g.query] = g;
      }
    } catch { /* fall back to country centroids */ }
  }
  if (G.geo.size > 30000) G.geo.clear();
  return out;
}
// where the machine physically is (an AS registered in one country can host IPs in another)
const placed = (o, g) => (g ? { ...o, country: g.countryCode || o.country, lat: g.lat, lon: g.lon, region: g.countryCode === 'US' ? g.region : g.regionName || null, city: g.city || null } : o);

// hostnames → one IPv4 each (cached; failures cached as null)
async function resolveHosts(hosts, max = 120) {
  const out = {};
  const todo = [];
  for (const h of new Set(hosts.filter(Boolean))) {
    if (IPV4.test(h)) out[h] = h;
    else if (G.geo.has(`dns:${h}`)) { if (G.geo.get(`dns:${h}`)) out[h] = G.geo.get(`dns:${h}`); } else if (todo.length < max) todo.push(h);
  }
  for (let i = 0; i < todo.length; i += 20) {
    await Promise.all(todo.slice(i, i + 20).map(async (h) => {
      try {
        const ip = (await Promise.race([dns.lookup(h, { family: 4 }), new Promise((_, no) => setTimeout(() => no(new Error('dns timeout')), 3000))])).address || null;
        G.geo.set(`dns:${h}`, ip);
        if (ip) out[h] = ip;
      } catch { G.geo.set(`dns:${h}`, null); }
    }));
  }
  return out;
}
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return null; } };
const utc = (s) => (s ? new Date(`${String(s).replace(' UTC', '').replace(' ', 'T')}Z`).toISOString() : null);

// ---------------------------------------------------------------- keyless sources

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
    .map((v) => ({ id: `rw:${v.group_name}:${v.discovered}:${(v.post_title || '').length}`, group: v.group_name, country: (v.country || '').toUpperCase() || null, region: (v.country || '').toUpperCase() === 'US' ? usState(`${v.post_title || ''}\n${v.description || ''}`) : null, sector: !v.activity || /^(not found|unknown|n\/a)$/i.test(v.activity) ? 'Unspecified sector' : v.activity, t: v.discovered }));
}

async function botnets() {
  const list = await get('https://feodotracker.abuse.ch/downloads/ipblocklist.json');
  const geo = await geolocate(list.map((b) => b.ip_address));
  return list.map((b) => placed({ id: `c2:${b.ip_address}:${b.port}`, malware: b.malware, country: b.country, status: b.status, as: b.as_name, t: b.last_online || b.first_seen }, geo[b.ip_address]));
}

async function attackers() {
  const top = await get('https://isc.sans.edu/api/sources/attacks/40?json');
  const out = [];
  // AS name and country, a few at a time, politely (cached with the IP's location)
  for (let i = 0; i < top.length; i += 8) {
    const batch = await Promise.all(top.slice(i, i + 8).map(async (s) => {
      const key = `isc:${s.ip}`;
      let info = G.geo.get(key);
      if (!info) {
        try { info = (await get(`https://isc.sans.edu/api/ip/${s.ip}?json`, { timeout: 8000 })).ip || {}; G.geo.set(key, info); } catch { info = {}; }
      }
      return { id: `isc:${s.ip}`, ip: s.ip, attacks: s.attacks, reports: s.count, country: info.ascountry || null, as: info.asname || null, t: s.lastseen };
    }));
    out.push(...batch);
  }
  const geo = await geolocate(out.map((a) => a.ip));
  return out.map((a) => placed(a, geo[a.ip]));
}

// blocklist.de: IPs its members reported in the last N seconds. We keep a rolling hour of them,
// tagged with the service they attacked, and stamp each with when it first showed up here.
const BL_SERVICES = ['ssh', 'mail', 'apache', 'bruteforcelogin'];
async function bruteforce() {
  const now = Date.now();
  const last = G.src.bruteforce?.fetched || 0;
  const win = Math.min(1800, Math.ceil((now - last) / 1000) + 30);
  const seed = !last;
  const fetchList = async (svc) => (await get(`https://api.blocklist.de/getlast.php?time=${win}${svc ? `&service=${svc}` : ''}`, { text: true, timeout: 10000 })).split(/\s+/).filter((x) => IPV4.test(x));
  const [all, ...bySvc] = await Promise.all([fetchList(''), ...BL_SERVICES.map((s) => fetchList(s).catch(() => []))]);
  const svcOf = {};
  BL_SERVICES.forEach((s, i) => { for (const ip of bySvc[i]) svcOf[ip] = svcOf[ip] || s; });
  const fresh = all.filter((ip) => !G.live.has(ip));
  // seed: the last half hour, spread evenly since we only know "within the window"
  fresh.forEach((ip, i) => G.live.set(ip, { id: `bl:${ip}:${now}`, ip, service: svcOf[ip] || 'attack', t: new Date(seed ? now - (win * 1000 * i) / Math.max(1, fresh.length) : now).toISOString() }));
  for (const [ip, v] of G.live) if (now - Date.parse(v.t) > 60 * MIN) G.live.delete(ip);
  const items = [...G.live.values()].sort((a, b) => b.t.localeCompare(a.t)).slice(0, 600);
  const geo = await geolocate(items.map((v) => v.ip));
  return items.map((v) => placed(v, geo[v.ip]));
}

// OpenPhish community feed: current phishing URLs. No timestamps, so "t" is when we first saw it.
async function phishing() {
  const now = Date.now();
  const urls = (await get('https://raw.githubusercontent.com/openphish/public_feed/refs/heads/main/feed.txt', { text: true })).split('\n').map((s) => s.trim()).filter(Boolean);
  const seed = !G.phish.size;
  for (const u of urls) {
    const host = hostOf(u);
    if (host && !G.phish.has(host)) G.phish.set(host, { id: `ph:${host}`, host, t: new Date(seed ? now - 30 * MIN : now).toISOString() });
  }
  const current = new Set(urls.map(hostOf));
  for (const h of G.phish.keys()) if (!current.has(h)) G.phish.delete(h);
  const items = [...G.phish.values()].sort((a, b) => b.t.localeCompare(a.t)).slice(0, 300);
  const ips = await resolveHosts(items.map((p) => p.host));
  const geo = await geolocate(Object.values(ips));
  return items.map((p) => placed({ ...p, country: null }, geo[ips[p.host]]));
}

async function exploits() {
  const kev = await get('https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json', { timeout: 20000 });
  return kev.vulnerabilities
    .sort((a, b) => b.dateAdded.localeCompare(a.dateAdded))
    .slice(0, 12)
    .map((v) => ({ id: `kev:${v.cveID}`, cve: v.cveID, vendor: v.vendorProject, product: v.product, name: v.vulnerabilityName, t: v.dateAdded, ransomware: v.knownRansomwareCampaignUse === 'Known' }));
}

async function cves() {
  const end = new Date(), start = new Date(end - 12 * 3600 * 1000);
  const iso = (d) => d.toISOString().replace('Z', '');
  const key = env('NVD_API_KEY');
  const j = await get(`https://services.nvd.nist.gov/rest/json/cves/2.0?resultsPerPage=500&pubStartDate=${iso(start)}&pubEndDate=${iso(end)}`, { headers: key ? { apiKey: key } : {}, timeout: 20000 });
  return (j.vulnerabilities || []).map(({ cve }) => {
    const m = cve.metrics || {};
    const c = (m.cvssMetricV40 || m.cvssMetricV31 || m.cvssMetricV30 || [])[0]?.cvssData;
    const desc = (cve.descriptions || []).find((d) => d.lang === 'en')?.value || '';
    return { id: `nvd:${cve.id}`, cve: cve.id, score: c?.baseScore ?? null, severity: c?.baseSeverity || null, summary: desc.length > 140 ? `${desc.slice(0, 137)}…` : desc, t: `${cve.published}Z` };
  }).sort((a, b) => b.t.localeCompare(a.t)).slice(0, 40);
}

// SSLBL: newest first after a short header, so the first ~40 KB is the last day or two
async function c2certs() {
  const txt = await get('https://sslbl.abuse.ch/blacklist/sslblacklist.csv', { text: true, headers: { Range: 'bytes=0-40000' } });
  const since = Date.now() - 48 * 3600 * 1000;
  return txt.split(/\r?\n/).filter((l) => /^\d{4}-/.test(l)).map((l) => l.split(',')).filter((p) => p.length >= 3)
    .map(([d, sha1, reason]) => ({ id: `ssl:${sha1}`, malware: reason.replace(/ (C&C|malware distribution)$/, ''), reason, t: utc(d) }))
    .filter((c) => Date.parse(c.t) >= since).slice(0, 60);
}

// ---------------------------------------------------------------- keyed sources

// abuse.ch URLhaus (malware download URLs) + ThreatFox (C2 indicators). Free Auth-Key: auth.abuse.ch
async function malware() {
  const key = env('ABUSECH_KEY');
  const h = { 'Auth-Key': key, 'Content-Type': 'application/json' };
  const [uh, tf] = await Promise.all([
    get('https://urlhaus-api.abuse.ch/v1/urls/recent/limit/200/', { method: 'POST', headers: h }).catch(() => ({})),
    get('https://threatfox-api.abuse.ch/api/v1/', { method: 'POST', headers: h, body: JSON.stringify({ query: 'get_iocs', days: 1 }) }).catch(() => ({})),
  ]);
  if (!uh.urls && !Array.isArray(tf.data)) throw new Error('abuse.ch rejected the key or is down');
  const items = [
    ...(uh.urls || []).map((u) => ({ id: `uh:${u.id}`, feed: 'URLhaus', host: u.host, malware: (u.tags || []).filter((t) => !/^(elf|exe|32-bit|64-bit|arm|mips|sh4|x86|ascii)$/i.test(t))[0] || u.threat || 'malware', kind: 'malware download', status: u.url_status, t: utc(u.date_added) })),
    ...(Array.isArray(tf.data) ? tf.data : []).slice(0, 300).map((x) => ({ id: `tf:${x.id}`, feed: 'ThreatFox', host: x.ioc_type === 'ip:port' ? x.ioc.split(':')[0] : x.ioc_type === 'url' ? hostOf(x.ioc) : x.ioc, malware: x.malware_printable, kind: x.threat_type === 'botnet_cc' ? 'C2 server' : x.threat_type_desc || x.threat_type, t: utc(x.first_seen) })),
  ].filter((x) => x.host && x.t).sort((a, b) => b.t.localeCompare(a.t)).slice(0, 400);
  const ips = await resolveHosts(items.map((x) => x.host), 80);
  const geo = await geolocate(Object.values(ips));
  return items.map((x) => placed({ ...x, country: null }, geo[ips[x.host]]));
}

// AlienVault OTX: recently modified pulses from the feeds the account follows (new accounts follow
// AlienVault's own research by default). Countries come as names; the game maps them.
async function otx() {
  const since = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
  const j = await get(`https://otx.alienvault.com/api/v1/pulses/subscribed?limit=40&modified_since=${since}`, { headers: { 'X-OTX-API-KEY': env('OTX_KEY') } });
  return (j.results || []).map((p) => ({ id: `otx:${p.id}`, name: p.name, adversary: p.adversary || null, malware: (p.malware_families || []).map((m) => m.display_name || m).slice(0, 3), industries: (p.industries || []).slice(0, 3), targets: p.targeted_countries || [], indicators: p.indicator_count || (p.indicators || []).length, t: p.modified || p.created }));
}

// Cloudflare Radar: where DDoS attacks come from and where they land (top country pairs, last day).
// Token: dash.cloudflare.com → My Profile → API Tokens → custom token with Account · Radar · Read.
async function radar() {
  const h = { Authorization: `Bearer ${env('CLOUDFLARE_RADAR_TOKEN')}` };
  const pairs = async (layer) => {
    const j = await get(`https://api.cloudflare.com/client/v4/radar/attacks/${layer}/top/attacks?limit=25&dateRange=1d&format=json`, { headers: h });
    if (!j.success) throw new Error((j.errors || [])[0]?.message || 'radar error');
    return (j.result?.top_0 || []).map((p) => ({ id: `cf:${layer}:${p.originCountryAlpha2}>${p.targetCountryAlpha2}`, layer: layer === 'layer3' ? 'network (L3/4)' : 'application (L7)', from: p.originCountryAlpha2, to: p.targetCountryAlpha2, share: +p.value, t: new Date().toISOString() }));
  };
  const [l3, l7] = await Promise.all([pairs('layer3').catch(() => []), pairs('layer7').catch(() => [])]);
  if (!l3.length && !l7.length) throw new Error('Cloudflare Radar returned nothing (check the token)');
  return [...l3, ...l7].filter((p) => p.from && p.to && p.from !== p.to);
}

// AbuseIPDB: the free tier allows 5 blacklist downloads a day, so this refreshes every 8 hours.
async function abuseipdb() {
  const j = await get('https://api.abuseipdb.com/api/v2/blacklist?confidenceMinimum=100&limit=400', { headers: { Key: env('ABUSEIPDB_KEY'), Accept: 'application/json' } });
  const items = (j.data || []).map((d) => ({ id: `aip:${d.ipAddress}`, ip: d.ipAddress, country: d.countryCode || null, score: d.abuseConfidenceScore, t: d.lastReportedAt }));
  const geo = await geolocate(items.map((x) => x.ip).slice(0, 200));
  return items.map((x) => placed(x, geo[x.ip]));
}

// ---------------------------------------------------------------- registry
// ttl: how often we re-read the upstream. key: the env var that switches a source on.
const SOURCES = [
  { id: 'bruteforce', name: 'blocklist.de', what: 'attacks reported in the last minutes', ttl: 2 * MIN, fn: bruteforce, url: 'https://www.blocklist.de', append: true },
  { id: 'ransomware', name: 'ransomware.live', what: 'ransomware leak-site posts', ttl: 10 * MIN, fn: ransomware, url: 'https://www.ransomware.live' },
  { id: 'attackers', name: 'SANS ISC / DShield', what: 'top attack sources on its sensors', ttl: 15 * MIN, fn: attackers, url: 'https://isc.sans.edu' },
  { id: 'botnets', name: 'abuse.ch Feodo Tracker', what: 'botnet C2 servers', ttl: 10 * MIN, fn: botnets, url: 'https://feodotracker.abuse.ch' },
  { id: 'phishing', name: 'OpenPhish', what: 'live phishing sites', ttl: 10 * MIN, fn: phishing, url: 'https://openphish.com' },
  { id: 'c2certs', name: 'abuse.ch SSLBL', what: 'new malware C&C certificates', ttl: 15 * MIN, fn: c2certs, url: 'https://sslbl.abuse.ch' },
  { id: 'exploits', name: 'CISA KEV', what: 'newly exploited vulnerabilities', ttl: 60 * MIN, fn: exploits, url: 'https://www.cisa.gov/known-exploited-vulnerabilities-catalog' },
  { id: 'cves', name: 'NVD', what: 'CVEs published in the last 12 h', ttl: 15 * MIN, fn: cves, url: 'https://nvd.nist.gov' },
  { id: 'malware', name: 'abuse.ch URLhaus + ThreatFox', what: 'malware URLs and C2 indicators', ttl: 5 * MIN, fn: malware, key: 'ABUSECH_KEY', url: 'https://auth.abuse.ch' },
  { id: 'ddos', name: 'Cloudflare Radar', what: 'DDoS origin → target countries', ttl: 15 * MIN, fn: radar, key: 'CLOUDFLARE_RADAR_TOKEN', url: 'https://radar.cloudflare.com' },
  { id: 'otx', name: 'AlienVault OTX', what: 'threat campaigns and their targets', ttl: 15 * MIN, fn: otx, key: 'OTX_KEY', url: 'https://otx.alienvault.com' },
  { id: 'abuseipdb', name: 'AbuseIPDB', what: 'most-reported abusive IPs', ttl: 8 * 60 * MIN, fn: abuseipdb, key: 'ABUSEIPDB_KEY', url: 'https://www.abuseipdb.com' },
];

// refresh one source if stale; on failure keep serving the last good copy and back off a bit
async function refresh(s) {
  const c = (G.src[s.id] = G.src[s.id] || { items: [], changed: 0, fetched: 0, tried: 0, error: null });
  if (s.key && !env(s.key)) return c;
  const now = Date.now();
  if (now - c.fetched < s.ttl || now - c.tried < Math.min(s.ttl, 2 * MIN)) return c;
  c.tried = now;
  try {
    const items = await Promise.race([s.fn(), new Promise((_, no) => setTimeout(() => no(new Error('timed out')), 35000))]);
    const sig = items.map((x) => x.id).join('|');
    if (sig !== c.sig || items.some((x, i) => x.lat !== c.items[i]?.lat)) { c.items = items; c.sig = sig; c.changed = now; }
    c.fetched = now;
    c.error = null;
  } catch (e) {
    c.error = String(e.message || e);
  }
  return c;
}

let inflight = null;
async function build(since = 0) {
  if (!inflight) inflight = Promise.all(SOURCES.map(refresh)).finally(() => { inflight = null; });
  await inflight;
  const body = { updated: new Date().toISOString(), poll: 30, delta: since > 0, sources: [] };
  for (const s of SOURCES) {
    const c = G.src[s.id];
    const on = !s.key || !!env(s.key);
    body.sources.push({ id: s.id, name: s.name, what: s.what, url: s.url, key: s.key || null, on, count: on ? c.items.length : 0, at: c.changed ? new Date(c.changed).toISOString() : null, every: s.ttl / 1000, error: on ? c.error : null });
    // unchanged sources are left out of a delta; the client keeps its copy. Rolling sources
    // (append) send only what's newer than the client's copy and the client ages out the rest.
    if (on && since && c.changed > since && s.append) (body.append = body.append || []).push(s.id), body[s.id] = c.items.filter((x) => Date.parse(x.t) > since);
    else if (on && (!since || c.changed > since)) body[s.id] = c.items;
    else if (!since) body[s.id] = [];
  }
  return body;
}

async function main(args = {}) {
  const since = Date.parse(args.since || '') || 0;
  return {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': since ? 'no-store' : 'public, max-age=20', 'Access-Control-Allow-Origin': '*' },
    body: await build(since),
  };
}

module.exports = { main, build };
