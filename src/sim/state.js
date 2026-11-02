import { BODY, helioAU, distAU, sunDistAU } from './orbits.js';
import { AU_KM } from '../data/bodies.js';
import { RES, RES_KEYS, BUILDINGS, TECHS, SHIPS, SKIFF, DRIVES, GOALS, MARKET } from '../data/economy.js';

const SAVE_KEY = 'openspace_save_v1';
export const SKIFF_CAP = SKIFF.cargo;

const listeners = new Set();
export const onEvent = (fn) => (listeners.add(fn), () => listeners.delete(fn));
export const emit = (type, data) => listeners.forEach((fn) => fn(type, data));

// ---------- clock: sim time follows real time (scale 1); dev builds can warp ----------
export function simNow(s) {
  const c = s.clock;
  return c.sim + (Date.now() - c.real) * c.scale;
}
export function setTimeScale(s, k) {
  s.clock = { sim: simNow(s), real: Date.now(), scale: k };
}

const emptyStore = () => Object.fromEntries(RES_KEYS.map((k) => [k, 0]));
function mkBase(id, t, buildings) {
  return { id, founded: t, buildings: { ...buildings }, store: emptyStore() };
}

export function newGame() {
  const now = Date.now();
  const s = {
    v: 1, clock: { sim: now, real: now, scale: 1 }, lastTick: now,
    wallet: { credits: 3500, rp: 0 },
    bases: { earth: mkBase('earth', now, { solar: 1 }) },
    techs: {}, ships: [], trips: [], nextId: 1,
    goalIdx: 0, stats: { mined: 0, hauled: 0, trips: 0, voyages: 0 },
    presence: 'earth', won: false, seenIntro: false,
    voyage: null, aboard: false,
  };
  Object.assign(s.bases.earth.store, { metal: 60, silicon: 30, ice: 10 });
  return s;
}

// ---------- queries ----------
export const level = (s, baseId, key) => s.bases[baseId]?.buildings[key] || 0;
export const capOf = (base) => 500 + 600 * (base.buildings.depot || 0);
export function driveTier(s) {
  let t = 1;
  for (const k in s.techs) if (s.techs[k] && TECHS[k].drive) t = Math.max(t, TECHS[k].drive);
  return t;
}
export const drive = (s) => DRIVES[driveTier(s) - 1];
// Fleet speed = drive speed x the slowest hull's factor (heavy ships hold the convoy back).
export function fleetKms(s, types = []) {
  return drive(s).kms * Math.min(SKIFF.speed, ...types.map((k) => SHIPS[k]?.speed ?? 1));
}
// Real-time intercept: the separation the fleet must cover by the time it arrives
// (refined a few passes; the planets keep moving while you fly).
export function travelMs(s, from, to, t, kms = drive(s).kms) {
  let ms = 0;
  for (let i = 0; i < 4; i++) ms = (distAU(helioAU(BODY[from], t + ms), helioAU(BODY[to], t + ms)) * AU_KM / kms) * 1000;
  return Math.max(20000, ms);
}
export const shipKms = (s, type) => fleetKms(s, [type]);
export const fleetCap = (s, escorts = []) => SKIFF_CAP + escorts.reduce((a, id) => a + (SHIPS[s.ships.find((x) => x.id === id)?.type]?.cargo || 0), 0);

export function buildCost(key, lvl) {
  const c = BUILDINGS[key].cost, k = Math.pow(1.6, lvl), o = {};
  for (const r in c) o[r] = Math.ceil(c[r] * k);
  return o;
}

// Outposts spend local stores first, then draw the rest from Halo Station.
export function available(s, res, baseId) {
  if (res === 'credits') return s.wallet.credits;
  if (res === 'rp') return s.wallet.rp;
  let v = s.bases.earth.store[res] || 0;
  if (baseId && baseId !== 'earth' && s.bases[baseId]) v += s.bases[baseId].store[res] || 0;
  return v;
}
export function canAfford(s, cost, baseId) {
  for (const r in cost) if (available(s, r, baseId) < cost[r] - 1e-9) return false;
  return true;
}
function pay(s, cost, baseId) {
  for (const r in cost) {
    let need = cost[r];
    if (r === 'credits') { s.wallet.credits -= need; continue; }
    if (r === 'rp') { s.wallet.rp -= need; continue; }
    if (baseId && baseId !== 'earth' && s.bases[baseId]) {
      const st = s.bases[baseId].store, take = Math.min(st[r], need);
      st[r] -= take; need -= take;
    }
    s.bases.earth.store[r] -= need;
  }
}
function add(base, res, amt) {
  const room = Math.max(0, capOf(base) - base.store[res]);
  const a = Math.min(room, amt);
  base.store[res] += a;
  return a;
}
const droneMult = (s) => (s.techs.automation ? 1.5 : 1) * (s.techs.deepcore ? 2 : 1);

// ---------- simulation step (dt seconds, t = sim ms at end of step) ----------
export function tick(s, dt, t) {
  const mult = droneMult(s), refMult = s.techs.refining ? 2 : 1;
  for (const id in s.bases) {
    const base = s.bases[id], L = base.buildings, st = base.store, body = BODY[id];
    const au = sunDistAU(id, t), solarF = Math.min(150, 1 / (au * au));
    let prod = (L.solar || 0) * BUILDINGS.solar.power * solarF;
    let reactorF = 1;
    if (L.reactor) {
      const need = L.reactor * 0.2 * dt / 60;
      reactorF = Math.min(1, st.he3 / need);
      st.he3 -= need * reactorF;
      prod += L.reactor * BUILDINGS.reactor.power * reactorF;
    }
    let use = 0;
    for (const k in L) if (BUILDINGS[k].power < 0) use -= BUILDINGS[k].power * L[k];
    const f = use > 0 ? Math.min(1, prod / use) : 1;
    const m = (dt / 60) * f;
    const rates = {};
    const rate = (r, v) => (rates[r] = (rates[r] || 0) + v);
    if (L.drones) for (const r in body.drones) {
      const v = body.drones[r] * L.drones * mult;
      add(base, r, v * m); rate(r, v * f);
    }
    if (L.refinery) {
      const cap = 6 * L.refinery * refMult;
      const used = Math.min(st.ore, cap * m);
      st.ore -= used; add(base, 'metal', used * 0.5);
      rate('ore', -cap * f); rate('metal', cap * 0.5 * f);
    }
    if (L.lab) { s.wallet.rp += 5 * L.lab * m; rate('rp', 5 * L.lab * f); }
    if (L.forge) { const v = 0.06 * L.forge; add(base, 'antimatter', v * m); rate('antimatter', v * f); }
    if (L.reactor) rate('he3', -0.2 * L.reactor * reactorF);
    base._power = { prod, use, f, solarF, au };
    base._rates = rates;
  }
  if (s.voyage && s.voyage.arrive <= t) resolveVoyage(s);
  for (let guard = 0; guard < 100; guard++) {
    const i = s.trips.findIndex((tr) => tr.arrive <= t);
    if (i < 0) break;
    resolveTrip(s, s.trips.splice(i, 1)[0]);
  }
  checkGoals(s);
}

const sumCargo = (c) => Object.values(c).reduce((a, b) => a + b, 0);

function resolveTrip(s, tr) {
  const ship = s.ships.find((x) => x.id === tr.shipId);
  const body = BODY[tr.to];
  if (tr.type === 'found') {
    s.ships = s.ships.filter((x) => x !== ship);
    if (!s.bases[tr.to]) {
      s.bases[tr.to] = mkBase(tr.to, tr.arrive, tr.to === 'sun' ? { solar: 1 } : { solar: 1, drones: 1 });
      emit('toast', { text: `${body.base} established at ${body.name}!`, kind: 'good' });
    } else s.bases[tr.to].buildings.solar++;
  } else if (tr.type === 'collect') {
    const base = s.bases[tr.to], cargo = {};
    let room = SHIPS.hauler.cargo;
    if (base) {
      for (const r of [...RES_KEYS].sort((a, b) => RES[b].value - RES[a].value)) {
        const take = Math.min(room, Math.floor(base.store[r]));
        if (take > 0) { cargo[r] = take; base.store[r] -= take; room -= take; }
      }
    }
    s.trips.push({
      id: s.nextId++, shipId: tr.shipId, type: 'return', from: tr.to, to: 'earth',
      depart: tr.arrive, arrive: tr.arrive + travelMs(s, tr.to, 'earth', tr.arrive, shipKms(s, 'hauler')), cargo,
    });
    emit('toast', { text: `Hauler loaded ${sumCargo(cargo)} t at ${body.base}. Returning home.` });
  } else if (tr.type === 'return') {
    // Delivered cargo always lands, even past the depot cap (production just stops filling it).
    let n = 0;
    for (const r in tr.cargo) { s.bases.earth.store[r] += tr.cargo[r]; n += tr.cargo[r]; }
    s.stats.hauled += n;
    if (ship) { ship.status = 'docked'; ship.at = 'earth'; }
    emit('toast', { text: `Hauler docked at Halo Station with ${Math.round(n)} t.`, kind: 'good' });
  }
  emit('changed');
  emit('stationChanged', tr.to);
}

function resolveVoyage(s) {
  const v = s.voyage, body = BODY[v.to];
  s.voyage = null;
  const escorts = s.ships.filter((x) => v.escorts.includes(x.id));
  let founded = false;
  if (!s.bases[v.to]) {
    const seed = escorts.find((x) => x.type === 'seed');
    if (seed) {
      s.ships = s.ships.filter((x) => x !== seed);
      s.bases[v.to] = mkBase(v.to, v.arrive, v.to === 'sun' ? { solar: 1 } : { solar: 1, drones: 1 });
      founded = true;
    }
  }
  for (const x of escorts) if (s.ships.includes(x)) { x.status = 'docked'; x.at = v.to; }
  const base = s.bases[v.to];
  let n = 0;
  if (base) for (const r in v.cargo) { base.store[r] += v.cargo[r]; n += v.cargo[r]; }
  s.stats.voyages = (s.stats.voyages || 0) + 1;
  s.stats.mined += n;
  const wasAboard = s.aboard;
  if (base && wasAboard) s.presence = v.to;
  s.aboard = false;
  emit('toast', { text: founded ? `Fleet arrived · ${body.base} established at ${body.name}!` : `Fleet arrived at ${body.name}${n ? ` · unloaded ${Math.round(n)} t` : ''}`, kind: 'good' });
  emit('voyageArrived', { to: v.to, aboard: wasAboard });
  emit('changed');
  emit('stationChanged', v.to);
}

function checkGoals(s) {
  while (s.goalIdx < GOALS.length && GOALS[s.goalIdx].check(s)) {
    const g = GOALS[s.goalIdx];
    s.wallet.credits += g.reward;
    s.goalIdx++;
    emit('toast', { text: `OBJECTIVE COMPLETE · ${g.title}${g.reward ? ` · +₡${g.reward}` : ''}`, kind: 'goal' });
    emit('changed');
  }
}

// ---------- actions ----------
export function canBuild(s, baseId, key) {
  const B = BUILDINGS[key], lvl = level(s, baseId, key);
  if (B.tech && !s.techs[B.tech]) return { ok: false, why: `Needs ${TECHS[B.tech].name}` };
  if (B.max && lvl >= B.max) return { ok: false, why: 'Max level' };
  const cost = buildCost(key, lvl);
  if (!canAfford(s, cost, baseId)) return { ok: false, why: 'Need resources', cost };
  return { ok: true, cost };
}
export const buildingAllowed = (key, baseId) => {
  const B = BUILDINGS[key];
  return !(B.only && !B.only.includes(baseId)) && !(B.notAt && B.notAt.includes(baseId));
};

export function build(s, baseId, key) {
  const c = canBuild(s, baseId, key);
  if (!c.ok) return emit('toast', { text: c.why, kind: 'bad' });
  pay(s, c.cost, baseId);
  const L = s.bases[baseId].buildings;
  L[key] = (L[key] || 0) + 1;
  emit('toast', { text: `${BUILDINGS[key].name} ${L[key] > 1 ? `upgraded to Lv ${L[key]}` : 'online'}`, kind: 'good' });
  emit('stationChanged', baseId);
  emit('changed');
  checkGoals(s);
}

export function canResearch(s, key) {
  const T = TECHS[key];
  if (s.techs[key]) return { ok: false, why: 'Researched' };
  const missing = (T.req || []).filter((r) => !s.techs[r]);
  if (missing.length) return { ok: false, why: `Needs ${missing.map((r) => TECHS[r].name).join(', ')}`, locked: true };
  if (!canAfford(s, { rp: T.rp, ...T.cost }, 'earth')) return { ok: false, why: 'Need resources' };
  return { ok: true };
}
export function research(s, key) {
  const c = canResearch(s, key);
  if (!c.ok) return emit('toast', { text: c.why, kind: 'bad' });
  const T = TECHS[key];
  pay(s, { rp: T.rp, ...T.cost }, 'earth');
  s.techs[key] = true;
  emit('toast', { text: `BREAKTHROUGH · ${T.name}`, kind: 'goal' });
  if (T.win) { s.won = true; emit('win'); }
  emit('changed');
  checkGoals(s);
}

export function buildShip(s, type) {
  if (!level(s, 'earth', 'shipyard')) return emit('toast', { text: 'Build an Orbital Shipyard first', kind: 'bad' });
  const cost = SHIPS[type].cost;
  if (!canAfford(s, cost, 'earth')) return emit('toast', { text: 'Need resources', kind: 'bad' });
  pay(s, cost, 'earth');
  s.ships.push({ id: s.nextId++, type, status: 'docked', at: 'earth' });
  emit('toast', { text: `${SHIPS[type].name} rolled out of the yards`, kind: 'good' });
  emit('stationChanged', 'earth');
  emit('changed');
}

export function launch(s, shipId, target) {
  const ship = s.ships.find((x) => x.id === shipId);
  const from = ship?.at || 'earth';
  if (!ship || ship.status !== 'docked' || target === from) return;
  if (ship.type === 'seed' && s.bases[target]) return emit('toast', { text: 'Already have a base there', kind: 'bad' });
  if (ship.type === 'hauler' && !s.bases[target]) return emit('toast', { text: 'No base there to collect from', kind: 'bad' });
  if (ship.type === 'hauler' && target === 'earth') return emit('toast', { text: 'Haulers deliver to Halo Station · pick an outpost', kind: 'bad' });
  const t = simNow(s);
  s.trips.push({
    id: s.nextId++, shipId, type: ship.type === 'seed' ? 'found' : 'collect',
    from, to: target, depart: t, arrive: t + travelMs(s, from, target, t, shipKms(s, ship.type)),
  });
  ship.status = 'transit';
  s.stats.trips++;
  emit('toast', { text: `${SHIPS[ship.type].name} launched to ${BODY[target].name}`, kind: 'good' });
  emit('stationChanged', from);
  emit('changed');
  checkGoals(s);
}

// ---------- fleet autopilot: you ride along in third person ----------
export const dockedAt = (s, baseId) => s.ships.filter((x) => x.status === 'docked' && (x.at || 'earth') === baseId);
export function canVoyage(s, to, escorts = []) {
  if (s.voyage) return { ok: false, why: 'Fleet already in transit' };
  if (to === s.presence) return { ok: false, why: 'You are here' };
  const types = escorts.map((id) => s.ships.find((x) => x.id === id)?.type);
  if (!s.bases[to] && !types.includes('seed')) return { ok: false, why: 'Needs an outpost there or a Seed Ship in the fleet' };
  return { ok: true };
}
export function startVoyage(s, to, escorts = []) {
  const c = canVoyage(s, to, escorts);
  if (!c.ok) return emit('toast', { text: c.why, kind: 'bad' });
  const t = simNow(s), types = escorts.map((id) => s.ships.find((x) => x.id === id).type);
  const kms = fleetKms(s, types);
  s.voyage = { from: s.presence, to, depart: t, arrive: t + travelMs(s, s.presence, to, t, kms), escorts: [...escorts], kms, cargo: {} };
  for (const id of escorts) s.ships.find((x) => x.id === id).status = 'fleet';
  s.aboard = true;
  emit('toast', { text: `Autopilot engaged · ${BODY[to].name}`, kind: 'good' });
  emit('voyageStart');
  emit('stationChanged', s.presence);
  emit('changed');
}

export function sell(s, res, qty) {
  const st = s.bases.earth.store, q = Math.min(qty, Math.floor(st[res]));
  if (q <= 0) return;
  st[res] -= q;
  s.wallet.credits += q * RES[res].value;
  emit('changed');
}
export function buy(s, res, qty) {
  const price = MARKET.buy[res], home = s.bases.earth;
  if (!price) return;
  const q = Math.min(qty, Math.floor(capOf(home) - home.store[res]), Math.floor(s.wallet.credits / price));
  if (q <= 0) return emit('toast', { text: 'Not enough credits or storage', kind: 'bad' });
  home.store[res] += q;
  s.wallet.credits -= q * price;
  emit('changed');
}

export function deposit(s, baseId, cargo) {
  const base = s.bases[baseId];
  let n = 0;
  for (const r in cargo) n += add(base, r, cargo[r]);
  s.stats.mined += n;
  emit('changed');
  checkGoals(s);
  return n;
}

// ---------- persistence ----------
export const serialize = (s) => JSON.stringify(s, (k, v) => (k.startsWith('_') ? undefined : v));
export function saveLocal(s) {
  s.savedAt = Date.now();
  const json = serialize(s);
  try { localStorage.setItem(SAVE_KEY, json); } catch {}
  return json;
}
export function loadLocal() {
  try { const j = localStorage.getItem(SAVE_KEY); return j ? JSON.parse(j) : null; } catch { return null; }
}
export function wipeLocal() {
  try { localStorage.removeItem(SAVE_KEY); } catch {}
}
export function hydrate(raw) {
  const s = Object.assign(newGame(), raw);
  for (const id in s.bases) s.bases[id].store = Object.assign(emptyStore(), s.bases[id].store);
  for (const sh of s.ships) sh.at = sh.at || 'earth';
  s.stats = { voyages: 0, ...s.stats };
  const now = Date.now();
  // Time spent offline always passes at 1x.
  s.clock = { sim: s.clock.sim + (now - s.clock.real), real: now, scale: 1 };
  return s;
}
// Simulate time spent offline in 60 s steps (capped at 14 days).
export function catchUp(s) {
  const t = simNow(s), start = s.lastTick;
  let last = start, steps = 0;
  while (t - last > 1 && steps < 20160) {
    const dt = Math.min(60000, t - last);
    last += dt;
    tick(s, dt / 1000, last);
    steps++;
  }
  s.lastTick = t;
  return t - start;
}
