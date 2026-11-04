// The real submarine cable network (TeleGeography Submarine Cable Map, built by
// scripts/build-cables.mjs) plus the major terrestrial fiber corridors (src/data/landRoutes.js),
// and a router that finds the shortest path between two places over them: overland backbone to
// a landing station, cable to cable across the sea, backbone again on the far side.
// It is a plausible physical path, not a traced one: real internet routes aren't public.
import { LAND_ROUTES } from '../data/landRoutes.js';
const D2R = Math.PI / 180;
const BACKBONE_LINK_KM = 450; // a corridor city links to landing stations this close
const LAND_COST = 1.6, HOP_COST = 400; // prefer cables, and few long-haul cables over many short hops
const HUB_LINKS = 4; // a city connects to its nearest few landing stations

let net = null, loading = null;

export function loadCables() {
  if (net) return Promise.resolve(net);
  return (loading ||= fetch(`${import.meta.env.BASE_URL}data/cables.json`).then((r) => r.json()).then((d) => (net = build(d))));
}
export const cableNet = () => net;

const km = (la1, lo1, la2, lo2) => {
  const h = Math.sin((la2 - la1) * D2R / 2) ** 2 + Math.cos(la1 * D2R) * Math.cos(la2 * D2R) * Math.sin((lo2 - lo1) * D2R / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
};

function build(d) {
  // terrestrial corridors become nodes and edges of the same graph, each a named pseudo-cable
  // (no sea paths of its own; drawn separately as land fiber)
  d = { ...d, nodes: [...d.nodes], cables: [...d.cables] };
  const landRoutes = [];
  for (const [name, pts] of LAND_ROUTES) {
    const c = d.cables.length;
    d.cables.push([name, '#ffb347', [], true]);
    const idx = pts.map(([la, lo]) => { d.nodes.push(la, lo); return d.nodes.length / 2 - 1; });
    landRoutes.push({ name, c, idx });
  }
  const N = d.nodes.length / 2;
  const lat = (i) => d.nodes[i * 2], lon = (i) => d.nodes[i * 2 + 1];
  const adj = Array.from({ length: N }, () => []); // [to, cost, cable index or -1 for land]
  const link = (a, b, c, mul, add = 0) => { const w = km(lat(a), lon(a), lat(b), lon(b)) * mul + add; adj[a].push(b, w, c); adj[b].push(a, w, c); };
  d.cables.forEach(([, , paths], c) => { for (const p of paths) for (let i = 1; i < p.length; i++) link(p[i - 1], p[i], c, 1); });
  for (let i = 0; i < d.land.length; i += 2) link(d.land[i], d.land[i + 1], -1, LAND_COST, HOP_COST);
  const stationName = new Map(d.stations.map(([i, n]) => [i, n]));
  const stationHubs = [...new Set(d.stations.map((s) => s[0]))];
  // land fiber costs like sea fiber; a corridor city reaches nearby landing stations by backhaul,
  // and cities shared by two corridors (same coordinates) are joined
  const seen = new Map();
  for (const r of landRoutes) {
    for (let i = 1; i < r.idx.length; i++) link(r.idx[i - 1], r.idx[i], r.c, 1);
    for (const n of r.idx) {
      const k = `${lat(n)},${lon(n)}`;
      if (seen.has(k)) link(seen.get(k), n, r.c, 1); else seen.set(k, n);
      for (const h of stationHubs) {
        const dk = km(lat(n), lon(n), lat(h), lon(h));
        if (dk < BACKBONE_LINK_KM) link(n, h, -1, LAND_COST, HOP_COST * 0.5);
      }
    }
  }
  const hubs = [...stationHubs, ...landRoutes.flatMap((r) => r.idx)];
  return { ...d, N, lat, lon, adj, stationName, hubs, landRoutes };
}

// nearest few landing stations to a point, with their land cost
function nearHubs(la, lo) {
  return net.hubs.map((h) => [h, km(la, lo, net.lat(h), net.lon(h)) * LAND_COST]).sort((a, b) => a[1] - b[1]).slice(0, HUB_LINKS);
}

// Dijkstra from a point to a point. Returns legs [{cable: name | null, pts: [[lat, lon], ...]}]
// with consecutive hops on the same cable merged, plus the stations it passes.
export function route(from, to) {
  if (!net) return null;
  const { N, adj } = net;
  const dist = new Float64Array(N).fill(Infinity), prev = new Int32Array(N).fill(-2), via = new Int32Array(N).fill(-1);
  const heap = [];
  const push = (n, d) => { heap.push([d, n]); let i = heap.length - 1; while (i) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = i * 2 + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } }
    return top;
  };
  for (const [h, w] of nearHubs(from[0], from[1])) if (w < dist[h]) { dist[h] = w; prev[h] = -1; push(h, w); }
  const exits = new Map(nearHubs(to[0], to[1]));
  let best = Infinity, end = -1;
  while (heap.length) {
    const [d, n] = pop();
    if (d > dist[n]) continue;
    if (d >= best) break;
    if (exits.has(n) && d + exits.get(n) < best) { best = d + exits.get(n); end = n; }
    const a = adj[n];
    for (let i = 0; i < a.length; i += 3) {
      const m = a[i], nd = d + a[i + 1];
      if (nd < dist[m]) { dist[m] = nd; prev[m] = n; via[m] = a[i + 2]; push(m, nd); }
    }
  }
  if (end < 0) return null;
  const chain = [];
  for (let n = end; n >= 0; n = prev[n]) chain.unshift(n);
  const legs = [{ cable: null, pts: [from] }];
  const stations = [];
  for (let i = 0; i < chain.length; i++) {
    const n = chain[i], c = i ? via[n] : -1, p = [net.lat(n), net.lon(n)];
    const name = c >= 0 ? net.cables[c][0] : null;
    let leg = legs[legs.length - 1];
    if (leg.cable !== name) legs.push((leg = { cable: name, pts: [leg.pts[leg.pts.length - 1]] }));
    leg.pts.push(p);
    const s = net.stationName.get(n);
    if (s && stations[stations.length - 1] !== s) stations.push(s);
  }
  legs[legs.length - 1].cable === null ? legs[legs.length - 1].pts.push(to) : legs.push({ cable: null, pts: [legs[legs.length - 1].pts.at(-1), to] });
  const out = legs.filter((l) => l.pts.length > 1);
  let total = 0;
  for (const l of out) for (let i = 1; i < l.pts.length; i++) total += km(...l.pts[i - 1], ...l.pts[i]);
  return { legs: out, stations, km: Math.round(total) };
}
