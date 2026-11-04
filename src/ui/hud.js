import { RES, RES_KEYS, BUILDINGS, TECHS, SHIPS, SKIFF, DRIVES, GOALS, MARKET } from '../data/economy.js';
import { BODIES, C_KMS, AU_KM, FIELDS } from '../data/bodies.js';
import { BODY, distKm, orbitTilt } from '../sim/orbits.js';
import * as S from '../sim/state.js';
import { backButton, haptic, notify } from '../telegram.js';
import { PLACES, ATTRIBUTION, gc } from '../render/earthView.js';
import { FUTURE_CITIES } from '../render/futureEarth.js';
import { TUTORIAL, isTouch } from './tutorial.js';
import { cyber, placeOf, CYBER_LAYERS, SOURCE_STYLE, describe, placeName } from '../render/cyberView.js';
import { US_STATES } from '../data/usStates.js';
import { groupOrigin } from '../data/ransomwareGroups.js';
import { COUNTRIES } from '../data/countries.js';
import { CRAFTS } from '../render/models.js';

const VIEW_NAMES = { chase: 'CHASE', free: 'FREE LOOK', cockpit: 'COCKPIT', flyby: 'FLY-BY', overhead: 'OVERHEAD', wide: 'WIDE' };

// Only touch the DOM when the markup actually changed.
function setHtml(el, html) {
  if (el._html !== html) { el._html = html; el.innerHTML = html; }
}

// ---------- formatting ----------
export function fmt(n) {
  n = +n || 0;
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e4) return (n / 1e3).toFixed(1) + 'k';
  if (a >= 100) return Math.floor(n).toString();
  if (a >= 10) return n.toFixed(1);
  return n.toFixed(2).replace(/\.?0+$/, '') || '0';
}
export function fmtDur(ms) {
  const s = Math.max(0, ms / 1000);
  if (s < 60) return `${s.toFixed(0)}s`;
  if (s < 3600) return `${(s / 60) | 0}m ${(s % 60) | 0}s`;
  if (s < 86400) return `${(s / 3600) | 0}h ${((s % 3600) / 60) | 0}m`;
  return `${(s / 86400) | 0}d ${((s % 86400) / 3600) | 0}h`;
}
// feed text (pulse names, hostnames, group names) goes into innerHTML
const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtKm = (km) => (km < 1e6 ? `${fmt(km)} km` : `${(km / 1e6).toFixed(1)}M km`) + (km > AU_KM * 0.05 ? ` · ${(km / AU_KM).toFixed(2)} AU` : '');
const fmtDist = (m) => (m < 1000 ? `${m.toFixed(0)} m` : `${(m / 1000).toFixed(1)} km`);
const resIcon = (r) => (r === 'credits' ? '<b class="ic cr">₡</b>' : r === 'rp' ? '<b class="ic rp">◆</b>' : `<b class="ic" style="--c:${RES[r].color}">${RES[r].short}</b>`);
const kindName = { star: 'Star', planet: 'Planet', moon: 'Moon', dwarf: 'Dwarf planet' };
const TARGET_KIND = { junk: 'DERELICT HARDWARE', rocks: 'ASTEROID', ice: 'ICE BODY', canister: 'PAYLOAD CANISTER' };
const ago = (t) => {
  const m = Math.max(0, (Date.now() - Date.parse(t)) / 60000);
  return m < 1 ? `${Math.round(m * 60)} s ago` : m < 60 ? `${Math.round(m)} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const pct = (k) => `${Math.max(0, Math.min(100, k * 100)).toFixed(1)}%`;

const ICONS = {
  pilot: '<svg viewBox="0 0 24 24"><path d="M12 3 5 19l7-3.5 7 3.5z"/><path d="M12 3v12.5" fill="none"/></svg>',
  map: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="2.2"/><ellipse cx="12" cy="12" rx="9.5" ry="4" fill="none" transform="rotate(-14 12 12)"/><circle cx="20.5" cy="9.6" r="1.3"/></svg>',
  base: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" fill="none"/><rect x="10.5" y="3.5" width="3" height="17"/><path d="M3.5 12h17" fill="none"/></svg>',
  tech: '<svg viewBox="0 0 24 24"><path d="M9 3h6M10 3v6L4.5 19.5h15L14 9V3" fill="none"/><path d="M7.5 15h9" fill="none"/></svg>',
  fleet: '<svg viewBox="0 0 24 24"><path d="M3 9h10l3-3v12l-3-3H3z" fill="none"/><path d="M16 12h5" fill="none"/></svg>',
  market: '<svg viewBox="0 0 24 24"><path d="M4 18 9 12l4 3 7-9" fill="none"/><path d="M15 6h5v5" fill="none"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.2" fill="none"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" fill="none"/></svg>',
};

// Map legend: a title, a one-line summary (shown collapsed on phones) and the full detail.
const legend = (title, sum, body) => `<button class="lg-head" data-act="mapInfo" aria-label="Toggle map details"><b>${title}</b><span class="lg-sum">${sum}</span><i class="chev"></i></button><div class="lg-body">${body}</div>`;

const TEMPLATE = `
<div class="top">
  <div class="top-row">
    <button class="loc" id="loc" data-open="base"></button>
    <div class="wallet"><span class="pill">${resIcon('credits')}<b id="w-cr">0</b></span><span class="pill">${resIcon('rp')}<b id="w-rp">0</b></span>
      <button class="icon-btn help" data-act="help" aria-label="How to play">?</button>
      <button class="icon-btn" data-open="settings" aria-label="Settings">${ICONS.gear}</button></div>
  </div>
  <div class="res-row" id="res-row"></div>
  <div class="voyage" id="voyage"></div>
  <button class="goal" id="goal" data-open="goals"></button>
  <div class="mapbar" id="mapbar">
    <div class="seg"><button data-act="mapView" data-arg="system">SYSTEM</button><button data-act="mapView" data-arg="drift">DRIFT</button><button data-act="mapView" data-arg="galaxy">GALAXY</button><button data-act="mapView" data-arg="cosmos">COSMOS</button><button data-act="mapView" data-arg="cyber">CYBER</button></div>
    <div class="seg opt" id="line-seg"><button data-act="mapLines" data-arg="constellations">CONSTELLATIONS</button><button data-act="mapLines" data-arg="orbits">ORBITS</button></div>
    <div class="seg opt" id="scale-seg"><button data-act="mapScale" data-arg="visible">ILLUSTRATIVE</button><button data-act="mapScale" data-arg="true">TRUE SCALE</button></div>
    <div class="seg cy-seg opt" id="cy-preset"><button data-act="cyPreset" data-arg="all">ALL</button><button data-act="cyPreset" data-arg="clear">NO CLOUDS</button><button data-act="cyPreset" data-arg="cables">CABLES ONLY</button><button data-act="cyPreset" data-arg="threats">THREATS ONLY</button></div>
    <div class="seg cy-seg opt" id="cy-layers">${CYBER_LAYERS.map((k) => `<button data-act="cyLayer" data-arg="${k}">${k.toUpperCase()}</button>`).join('')}</div>
    <div class="seg cy-seg opt" id="cy-sources"></div>
    <div class="legend" id="legend"></div>
  </div>
</div>
<div class="pilot-hud" id="pilot-hud">
  <svg class="reticle" viewBox="0 0 100 100"><circle cx="50" cy="50" r="30"/><path d="M50 14v8M50 78v8M14 50h8M78 50h8"/><circle cx="50" cy="50" r="1.6" class="dot"/></svg>
  <div class="bracket" id="bracket"><i></i><i></i><i></i><i></i><div class="b-lab" id="b-lab"></div></div>
  <div class="markers" id="markers"></div>
  <div class="gauge cargo-g"><svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="27" class="trk"/><circle cx="32" cy="32" r="27" class="val" id="cargo-arc"/></svg>
    <div class="g-txt"><b id="cargo-n">0</b><small id="cargo-l">/30 t</small></div><span class="g-cap" id="cargo-cap">HOLD</span></div>
  <div class="readout" id="spd"></div>
  <div class="dockline" id="dock"></div>
  <div class="zone" id="zone"></div>
  <div class="fuel" id="fuel"><span id="grav"></span><div class="bar"><i id="fuel-b"></i></div></div>
  <button class="land" id="land" data-act="land"></button>
  <button class="craft-swap" id="craft-swap" data-act="craft"></button>
  <button class="cam-view" id="cam-view" data-act="camView"></button>
  <div class="earthnav" id="earthnav"></div>
  <div class="attrib" id="attrib"></div>
</div>
<div class="controls" id="controls">
  <div class="joy" id="joy"><div class="knob" id="knob"></div></div>
  <div class="btns">
    <button class="hold up" data-hold="up"><svg viewBox="0 0 24 24"><path d="M5 15l7-7 7 7" fill="none"/></svg></button>
    <button class="hold" data-hold="down" hidden></button>
    <button class="hold boost" data-hold="boost">BOOST</button>
    <button class="hold mine" data-hold="mine"><span>MINE</span></button>
  </div>
  <div class="hint" id="hint"></div>
</div>
<nav class="nav" id="nav">
  <button data-mode="local">${ICONS.pilot}<span>PILOT</span></button>
  <button data-mode="map">${ICONS.map}<span>MAP</span></button>
  <button data-open="base">${ICONS.base}<span>BASE</span></button>
  <button data-open="tech">${ICONS.tech}<span>TECH</span></button>
  <button data-open="fleet">${ICONS.fleet}<span>FLEET</span></button>
  <button data-open="market">${ICONS.market}<span>MARKET</span></button>
</nav>
<section class="sheet" id="sheet">
  <div class="grip"></div>
  <header><div><small id="sheet-kicker"></small><h2 id="sheet-title"></h2></div><button class="x" data-close>✕</button></header>
  <div class="sheet-body" id="sheet-body"></div>
</section>
<div class="toasts" id="toasts"></div>
<div class="overlay" id="overlay"></div>
<div class="fade" id="fade"></div>
`;

export class Hud {
  constructor(app) {
    this.app = app;
    const root = (this.root = document.getElementById('ui'));
    root.innerHTML = TEMPLATE;
    this.$ = (id) => document.getElementById(id);
    this.panel = null;
    this.acc = 1;
    this.sheetAcc = 0;
    this.escortSel = null;
    this.markerEls = [];

    app.input.bindJoystick(this.$('joy'), this.$('knob'));
    root.querySelectorAll('[data-hold]').forEach((el) => app.input.bindHold(el, el.dataset.hold));

    root.addEventListener('click', (e) => {
      const t = e.target.closest('[data-open],[data-mode],[data-close],[data-act]');
      if (!t) return;
      haptic('light');
      if (t.dataset.mode) { this.close(); t.dataset.mode === 'local' ? app.resumePilot() : app.setMode(t.dataset.mode); }
      else if (t.dataset.open) this.panel === t.dataset.open ? this.close() : this.open(t.dataset.open);
      else if (t.dataset.close !== undefined) this.close();
      else this.act(t.dataset.act, t.dataset.arg, t.dataset.arg2);
    });

    // B: board your ship / step out on EVA · C: cycle camera views
    addEventListener('keydown', (e) => {
      if (e.repeat || this.panel || e.target.closest?.('input,textarea')) return;
      if (e.code === 'KeyB') this.act('craft');
      else if (e.code === 'KeyC') this.act('camView');
    });

    S.onEvent((type, d) => {
      if (type === 'toast') this.toast(d.text, d.kind);
      else if (type === 'changed') this.dirty = true;
      else if (type === 'win') this.showWin();
    });
  }

  // ---------- actions from panels ----------
  act(a, arg, arg2) {
    const s = this.app.state;
    switch (a) {
      case 'build': S.build(s, s.presence, arg); break;
      case 'research': S.research(s, arg); break;
      case 'ship': S.buildShip(s, arg); break;
      case 'pickLaunch': this.open(`launch:${arg}`); return;
      case 'launch': S.launch(s, +arg, arg2); notify('success'); this.open('fleet'); return;
      case 'sell': S.sell(s, arg, arg2 === 'all' ? 1e9 : +arg2); break;
      case 'buy': S.buy(s, arg, +arg2); break;
      case 'teleport': this.close(); this.app.teleport(arg); return;
      case 'rejoin': this.close(); this.app.rejoinFleet(); return;
      case 'findFleet': this.close(); this.app.mapView.focus('fleet', this.app.mapView.mode() === 'true' ? 0.05 : 14); this.syncNav(); return;
      case 'launchTo': {
        const ship = S.dockedAt(s, s.presence).find((x) => x.type === arg2) || s.ships.find((x) => x.status === 'docked' && x.type === arg2);
        if (ship) { S.launch(s, ship.id, arg); notify('success'); }
        break;
      }
      case 'escort': {
        const id = +arg;
        this.escortSel.has(id) ? this.escortSel.delete(id) : this.escortSel.add(id);
        break;
      }
      case 'voyage': this.close(); notify('success'); this.app.startVoyage(arg, [...this.escortSel]); return;
      case 'mapView': this.close(); this.app.mapView.setView(arg); this.syncNav(); return;
      case 'cyberPlace': this.open(`cyber:${arg}`); return;
      case 'mapScale': this.app.mapView.setScale(arg); this.syncNav(); return;
      case 'cyPreset': this.app.mapView.cyber.setPreset(arg); this.syncNav(); return;
      case 'cySource': {
        const c = this.app.mapView.cyber, src = cyber.sources.find((x) => x.id === arg);
        if (!src?.on) { this.open('cyber:sources'); return; }
        c.setSource(arg, !c.sourceOn(arg)); this.syncNav(); return;
      }
      case 'cyLayer': { const c = this.app.mapView.cyber; c.setLayer(arg, !c.layers[arg]); this.syncNav(); return; }
      case 'mapInfo': this.mapInfoOpen = !this.mapInfoOpen; this.$('mapbar').classList.toggle('open', this.mapInfoOpen); return;
      case 'mapLines': this.app.mapView.toggleLines(arg); this.syncNav(); return;
      case 'land': this.app.setMode(this.app.mode === 'surface' ? 'local' : 'surface'); return;
      case 'descend': this.app.setMode('earth'); return;
      case 'toOrbit': this.app.hud.flash(); this.app.setMode('local'); this.toast('Back in orbit · Eden', 'good'); return;
      case 'earthTarget': this.app.earthView.setTarget(arg); this.close(); return;
      case 'autopilot': this.app.earthView.setAutopilot(!this.app.earthView.autopilot); return;
      case 'quality': this.app.setQuality(arg); break;
      case 'camView': {
        const v = this.app.mode === 'earth' ? this.app.earthView : this.app.mode === 'local' ? this.app.localView : null;
        if (!v) return;
        const name = v.cycleView();
        const voyage = this.app.mode === 'local' && this.app.localView.mode === 'voyage';
        const tips = {
          chase: 'Chase camera', free: 'Free look · drag to orbit, scroll or pinch to zoom',
          cockpit: this.app.mode === 'earth' ? "Pilot's eye · drag to look around" : "Pilot's eye",
          flyby: 'Fly-by camera · watch yourself streak past', overhead: 'Overhead · scroll or pinch to zoom',
          wide: voyage ? 'Wide shot · the whole convoy' : 'Wide shot · the station and you',
        };
        this.toast(`${VIEW_NAMES[name]} · ${tips[name]}`, '');
        this.syncView();
        return;
      }
      case 'craft': {
        const lv = this.app.localView, st = lv.swapState();
        if (!st || this.app.mode !== 'local') return;
        if (!st.ok) {
          this.toast(st.board ? `Fly to your ship to board · ${fmtDist(st.dist)} to go (follow the YOUR SHIP marker)` : `Come within docking range of the station to step out · ${fmtDist(st.dist)}`, '');
          return;
        }
        const k = s.craft === 'skiff' ? 'frame' : 'skiff';
        this.app.setCraft(k);
        this.swapReady = true; // you step out right beside the ship: no "in reach" toast for that
        this.syncCraft();
        haptic('medium');
        const voyage = lv.mode === 'voyage';
        this.toast(k === 'skiff' ? `Aboard the ${CRAFTS.skiff}${voyage ? ' · flying with the convoy' : ' · cleared to depart'}`
          : `EVA in the ${CRAFTS.frame} · your ship is holding ${voyage ? 'formation' : 'at the berth'} · fly back and tap BOARD (B)`, 'good');
        return;
      }
      case 'scale': S.setTimeScale(s, +arg); this.toast(`Time warp ×${arg}`); break;
      case 'reset':
        if (confirm('Erase your save and start over?')) this.app.resetGame();
        return;
      case 'start': s.seenIntro = true; this.app.save(); this.showTutorial(0); return;
      case 'help': this.close(); this.showTutorial(0); return;
      case 'tutNext': this.tutStep < TUTORIAL.length - 1 ? this.showTutorial(this.tutStep + 1) : this.endTutorial(); return;
      case 'tutBack': this.showTutorial(Math.max(0, this.tutStep - 1)); return;
      case 'tutGo': this.showTutorial(+arg); return;
      case 'tutDevice': this.tutDevice = arg; this.showTutorial(this.tutStep); return;
      case 'tutEnd': this.endTutorial(); return;
      case 'closeWin': this.$('overlay').classList.remove('show'); return;
    }
    this.renderSheet();
  }

  open(panel) {
    if (panel.startsWith('body:') && this.panel !== panel) this.escortSel = null;
    this.panel = panel;
    this.$('sheet').classList.add('open');
    this.renderSheet(true);
    backButton(true, () => this.close());
    this.root.classList.add('sheet-open');
    this.syncNav();
  }
  close() {
    this.panel = null;
    this.$('sheet').classList.remove('open');
    this.root.classList.remove('sheet-open');
    backButton(false);
    if (this.app.mapView) this.app.mapView.select(null);
    this.syncNav();
  }
  // Camera view chip: which view you're in, tap (or C) for the next one.
  syncView() {
    const el = this.$('cam-view'), m = this.app.mode;
    const v = m === 'earth' ? this.app.earthView : m === 'local' ? this.app.localView : null;
    el.hidden = !v;
    if (v) setHtml(el, `<small>CAMERA</small>◎ ${VIEW_NAMES[v.view]}${isTouch() ? '' : ' <kbd>C</kbd>'}`);
  }

  // Always visible while flying: it says whether you can get in or out right now, and if not, how
  // far you have to go. Bright and pulsing when the swap is available.
  syncCraft() {
    const el = this.$('craft-swap'), lv = this.app.localView, st = lv.swapState();
    const show = this.app.mode === 'local' && !!st;
    el.hidden = !show;
    if (!show) { this.swapReady = false; return; }
    const voyage = lv.mode === 'voyage', key = isTouch() ? '' : '<kbd>B</kbd>';
    const html = st.board
      ? (st.ok ? `<small>YOUR SHIP · IN REACH</small>▲ BOARD SHIP ${key}` : `<small>YOUR SHIP · ${fmtDist(st.dist)}</small>FLY TO SHIP TO BOARD`)
      : (st.ok ? `<small>${voyage ? 'SHIP HOLDS FORMATION' : 'DOCKING RANGE'}</small>⬢ EXIT SHIP · EVA ${key}` : `<small>STATION · ${fmtDist(st.dist)}</small>EVA AT THE STATION`);
    setHtml(el, html);
    el.classList.toggle('ready', st.ok);
    // say so once when the ship comes within reach
    if (st.board && st.ok && !this.swapReady) this.toast(`Your ship is in reach · tap BOARD SHIP${key ? ' or press B' : ''}`, 'good');
    this.swapReady = st.ok;
  }
  syncNav() {
    this.syncCraft();
    const mode = this.app.mode === 'map' ? 'map' : 'local'; // PILOT covers orbit, surface and Earth flight
    this.root.querySelectorAll('#nav button').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode ? b.dataset.mode === mode && !this.panel : b.dataset.open === this.panel);
    });
    const voyage = this.app.mode === 'local' && this.app.localView.mode === 'voyage';
    this.root.classList.toggle('mode-pilot', this.app.mode !== 'map');
    this.root.classList.toggle('mode-surface', this.app.mode === 'surface');
    this.root.classList.toggle('mode-map', this.app.mode === 'map');
    this.root.classList.toggle('mode-voyage', voyage);
    const earth = this.app.mode === 'earth';
    this.root.classList.toggle('mode-earth', earth);
    const surf = this.app.mode === 'surface';
    this.root.querySelector('.hold.mine span').textContent = earth ? 'BRAKE' : surf ? 'DRILL' : voyage ? 'SALVAGE' : 'MINE';
    this.root.querySelector('.hold.boost').textContent = surf ? 'SPRINT' : 'BOOST';
    this.$('attrib').textContent = earth ? ATTRIBUTION : '';
    this.$('hint').textContent = earth
      ? 'Stick: turn and climb · ▲ throttle · BOOST burn · BRAKE · drag to look'
      : surf
      ? 'Stick to walk · drag to look · ▲ jetpack · hold DRILL at glowing deposits'
      : voyage ? 'Fleet on autopilot · fly around your convoy · real space is empty between worlds'
        : 'Drag to steer · stick to fly · hold MINE on salvage and rock';
    const v = this.app.mapView?.view || 'system';
    const sm = this.app.mapView?.scaleMode || 'visible';
    this.root.querySelectorAll('.mapbar .seg button').forEach((b) => b.classList.toggle('on', b.dataset.act === 'mapScale' ? b.dataset.arg === sm : b.dataset.arg === v));
    this.$('scale-seg').style.display = v === 'system' ? '' : 'none';
    this.$('line-seg').style.display = v === 'system' || v === 'drift' ? '' : 'none';
    const sh = this.app.mapView?.show || {};
    this.root.querySelectorAll('#line-seg button').forEach((b) => b.classList.toggle('on', !!sh[b.dataset.arg]));
    const cy = this.app.mapView?.cyber;
    this.$('cy-preset').style.display = this.$('cy-layers').style.display = this.$('cy-sources').style.display = v === 'cyber' ? '' : 'none';
    if (cy) {
      const p = cy.preset();
      this.root.querySelectorAll('#cy-preset button').forEach((b) => b.classList.toggle('on', b.dataset.arg === p));
      this.root.querySelectorAll('#cy-layers button').forEach((b) => b.classList.toggle('on', !!cy.layers[b.dataset.arg]));
      // one toggle per source; sources waiting for an API key show dimmed and open the sources panel
      const html = cyber.sources.map((x) => `<button data-act="cySource" data-arg="${x.id}" class="${x.on ? '' : 'nokey'}" style="--sc:${SOURCE_STYLE[x.id]?.css || '#fff'}" title="${x.name}: ${x.what}${x.on ? '' : ` (needs ${x.key})`}">${SOURCE_STYLE[x.id]?.short || x.id.toUpperCase()}</button>`).join('');
      if (this.cySrcHtml !== html) this.$('cy-sources').innerHTML = this.cySrcHtml = html;
      this.root.querySelectorAll('#cy-sources button:not(.nokey)').forEach((b) => b.classList.toggle('on', cy.sourceOn(b.dataset.arg)));
    }
    this.$('mapbar').classList.toggle('open', !!this.mapInfoOpen);
    this.$('legend').innerHTML = v === 'drift'
      ? legend('THE SUN LEADS · REAL TIME', 'Every world where it is right now', 'Every world is where it is right now. The trails are the real corkscrews they carved over recent years as the Sun hauls everything toward Cygnus at 230 km/s (helix pitch ~8x compressed). <span id="drift-km"></span>')
      : v === 'galaxy' ? legend('THE MILKY WAY AS MAPPED TODAY', 'Disc, bulge and halo · drag to tilt', 'Thin but not flat: a ~1,000 ly thin disc inside a thicker one, a warped and flaring edge, a peanut-shaped bulge 10,000 ly tall and a halo of globular clusters. The Sun bobs through the disc every ~65 million years (bob drawn 5x taller). Drag to tilt.')
        : v === 'cyber' ? this.cyberLegend()
        : v === 'cosmos' ? legend('THE OBSERVABLE UNIVERSE', 'Real directions · log-scale distances', 'Real directions and distances (log scale): the Local Group, Virgo Cluster, the Great Attractor, Shapley Supercluster, out to the cosmic microwave background 46.5 billion ly away. Faint filaments are illustrative.')
          : sm === 'true' ? legend('TRUE SCALE · REAL SIZES, REAL DISTANCES', 'Nothing exaggerated · 1 AU = 40 units', 'Nothing exaggerated: 1 AU = 40 units. The Sun is 1.39 million km across, yet Earth is a speck 0.0017 wide 40 units away. Tap a world to zoom down to it; pinch out to feel the emptiness.')
          : legend('REAL ORBITS, REAL SKY', 'Real orbits · 25,700 real stars', 'Planets on their real inclined orbits (drop lines to the ecliptic). The background is the real sky: 25,700 catalogue stars at true positions and colours, constellations and the Milky Way.');
  }

  toast(text, kind = '') {
    const box = this.$('toasts');
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = text;
    box.appendChild(el);
    while (box.children.length > 3) box.firstChild.remove();
    setTimeout(() => el.classList.add('out'), 3200);
    setTimeout(() => el.remove(), 3700);
  }

  flash() {
    const f = this.$('fade');
    f.classList.remove('go');
    void f.offsetWidth;
    f.classList.add('go');
  }

  // ---------- per-frame ----------
  frame(dt) {
    const s = this.app.state;
    this.acc += dt;
    this.sheetAcc += dt;
    if (this.acc > 0.25) {
      this.acc = 0;
      this.updateTop();
      if (this.app.mode === 'map') this.updateDriftCounter();
      const voyage = this.app.mode === 'local' && this.app.localView.mode === 'voyage';
      if (voyage !== this.root.classList.contains('mode-voyage')) this.syncNav();
    }
    if (this.panel && (this.sheetAcc > 1 || this.dirty)) this.renderSheet();
    if (this.app.mode === 'map' && this.app.mapView.view === 'cyber' && (this.cyAcc = (this.cyAcc || 0) + dt) > 2) { this.cyAcc = 0; this.$('legend').innerHTML = this.cyberLegend(); }
    this.syncView();
    if (this.app.mode === 'earth') this.updateEarth();
    else if (this.app.mode !== 'map') this.updatePilot();
    if (s.won && !this.winShown) this.showWin();
  }

  updateDriftCounter() {
    const el = document.getElementById('drift-km'), mv = this.app.mapView;
    if (!el || mv.view !== 'drift') return;
    const sec = (S.simNow(this.app.state) - mv.driftT0) / 1000;
    el.innerHTML = `<br><em class="live">Since you opened this view the Sun has carried you ${fmt(sec * 230)} km.</em>`;
  }

  updateTop() {
    const s = this.app.state, base = s.bases[s.presence], body = BODY[s.presence];
    const aboard = this.app.localView.mode === 'voyage' && this.app.mode !== 'map' && !!s.voyage;
    this.$('w-cr').textContent = fmt(s.wallet.credits);
    this.$('w-rp').textContent = fmt(s.wallet.rp);
    const cap = S.capOf(base), rates = base._rates || {};
    this.$('res-row').innerHTML = RES_KEYS.filter((r) => base.store[r] >= 0.5 || rates[r] || ['ore', 'metal', 'silicon', 'ice'].includes(r))
      .map((r) => `<span class="chip ${base.store[r] >= cap - 0.5 ? 'full' : ''}" style="--c:${RES[r].color}"><i></i><em>${RES[r].short}</em><b>${fmt(base.store[r])}</b>${rates[r] ? `<small class="${rates[r] < 0 ? 'neg' : ''}">${rates[r] > 0 ? '+' : ''}${fmt(rates[r])}</small>` : ''}</span>`)
      .join('');
    const p = base._power || { f: 1, prod: 0, use: 0 };
    const pk = p.use ? Math.min(1, p.prod / p.use) : 1;
    this.$('loc').innerHTML = aboard
      ? `<span class="loc-k">IN TRANSIT</span><span class="loc-n">${BODY[s.voyage.from].name} → ${BODY[s.voyage.to].name}</span><span class="loc-s">uplink base · ${body.base}</span>`
      : `<span class="loc-k">${kindName[body.kind].toUpperCase()} · ${body.name.toUpperCase()}</span><span class="loc-n">${body.base}</span><span class="loc-s ${p.f < 1 ? 'low' : ''}"><span class="pbar"><i style="width:${pct(pk)}"></i></span>${fmt(p.prod)}/${fmt(p.use)} MW${p.f < 1 ? ' · BROWNOUT' : ''}</span>`;
    const g = GOALS[s.goalIdx];
    this.$('goal').innerHTML = g ? `<span class="g-k">OBJECTIVE ${s.goalIdx + 1}/${GOALS.length}</span><span class="g-t">${g.title}</span><span class="g-x">${g.text}</span>` : '<span class="g-k">ALL OBJECTIVES COMPLETE</span><span class="g-t">The solar system is yours</span>';
    this.updateVoyageBanner();
  }

  updateVoyageBanner() {
    const s = this.app.state, v = s.voyage, el = this.$('voyage');
    if (!v) { el.classList.remove('show'); return; }
    const t = S.simNow(s), k = (t - v.depart) / (v.arrive - v.depart);
    const aboard = s.aboard;
    const lv = this.app.localView;
    el.classList.add('show');
    // the skeleton (with its buttons) is only rebuilt when it changes; rebuilding a button
    // between pointer-down and pointer-up swallows the click. Live numbers are patched in.
    const map = this.app.mode === 'map';
    setHtml(el, `<div class="v-h"><span class="v-k">◆ AUTOPILOT</span><span class="v-r">${BODY[v.from].name} → <b>${BODY[v.to].name}</b></span><span class="v-eta"></span></div>
      <div class="v-bar"><i></i></div>
      <div class="v-f"><span>${fmt(v.kms)} km/s</span><span>${v.escorts.length ? `${v.escorts.length + 1} ships` : 'solo'}</span>
      ${map ? '<button class="btn sm ghost" data-act="findFleet">◆ LOCATE</button>' : ''}${aboard ? '<span class="v-z"></span>' : '<button class="btn sm" data-act="rejoin">REJOIN FLEET</button>'}</div>`);
    el.querySelector('.v-eta').textContent = fmtDur(v.arrive - t);
    el.querySelector('.v-bar i').style.width = pct(k);
    const z = el.querySelector('.v-z');
    if (z) z.textContent = lv.mode === 'voyage' ? lv.info.zone : '';
  }

  updatePilot() {
    const surf = this.app.mode === 'surface';
    const lv = this.app.localView;
    const info = (surf ? this.app.surfaceView : lv).info;
    this.syncCraft();
    const tgt = info.target;
    const br = this.$('bracket');
    if (tgt && !surf && tgt.on) {
      br.style.display = 'block';
      br.style.transform = `translate(${tgt.x}px, ${tgt.y}px)`;
      br.style.setProperty('--sz', `${tgt.size}px`);
      this.$('b-lab').innerHTML = `<span style="color:${RES[tgt.res].color}">${RES[tgt.res].name.toUpperCase()}</span><em>${TARGET_KIND[tgt.kind] || ''} · ${tgt.dist.toFixed(0)} m</em><div class="bar"><i style="width:${pct(tgt.hp)}"></i></div>`;
    } else if (tgt && surf) {
      br.style.display = 'block';
      br.style.transform = `translate(${innerWidth / 2}px, ${innerHeight * 0.46}px)`;
      br.style.setProperty('--sz', '70px');
      this.$('b-lab').innerHTML = `<span style="color:${RES[tgt.res].color}">${RES[tgt.res].name.toUpperCase()} DEPOSIT</span><em>${tgt.dist.toFixed(0)} m</em><div class="bar"><i style="width:${pct(tgt.hp)}"></i></div>`;
    } else br.style.display = 'none';

    this.updateMarkers(surf ? [] : info.markers || []);

    const capK = info.cargo / info.cap;
    const arc = this.$('cargo-arc');
    arc.style.strokeDasharray = `${(capK * 169.6).toFixed(1)} 170`;
    arc.classList.toggle('full', capK >= 1);
    this.$('cargo-n').textContent = info.cargo;
    this.$('cargo-l').textContent = `/${info.cap} t`;
    this.$('cargo-cap').textContent = surf ? 'HOPPER' : info.voyage ? 'FLEET HOLD' : 'HOLD';
    const range = info.dockRange || 18;
    this.$('dock').textContent = info.voyage ? (info.tether > 0.85 ? 'AUTOPILOT TETHER · RETURNING' : '') : info.cargo ? (info.dock < range ? 'UNLOADING…' : `${surf ? 'PAD' : 'DOCK'} ${fmtDist(info.dock)}`) : '';
    this.$('spd').innerHTML = surf
      ? `<b>${(info.speed * 3.6).toFixed(0)}</b><small>KM/H</small><span>ALT ${info.alt.toFixed(1)} m</span>`
      : `<b>${(info.speed * 3.6).toFixed(0)}</b><small>KM/H REL</small>${info.voyage ? `<span>${fmt(this.app.state.voyage?.kms || 0)} km/s cruise</span>` : ''}`;
    this.$('zone').textContent = !surf && !info.voyage ? info.zone : '';
    if (surf) {
      this.$('grav').textContent = `JET ${info.fuel.toFixed(0)}% · g ${info.g} m/s²`;
      this.$('fuel-b').style.width = `${info.fuel}%`;
    }
    const land = this.$('land');
    const can = this.app.canLand(), desc = this.app.canDescend();
    land.style.display = can || surf || desc ? '' : 'none';
    land.dataset.act = desc && !surf ? 'descend' : 'land';
    land.disabled = false;
    if (desc && !surf) land.textContent = '⬇ DESCEND TO EARTH';
    else if (can || surf) land.textContent = surf ? '⬆ RETURN TO ORBIT' : `⬇ DEPLOY MECH · ${BODY[this.app.state.presence].name.toUpperCase()}`;
  }

  // Atmospheric flight over Earth
  updateEarth() {
    const e = this.app.earthView, info = e.info;
    this.$('bracket').style.display = 'none';
    this.updateMarkers(info.markers);
    const altTxt = info.alt >= 10000 ? `${(info.alt / 1000).toFixed(1)} km` : `${Math.round(info.alt).toLocaleString()} m`;
    this.$('spd').innerHTML = `<b>${Math.round(info.speed * 3.6).toLocaleString()}</b><small>KM/H · MACH ${info.mach.toFixed(1)}</small><span>ALT ${altTxt} · AGL ${Math.max(0, info.agl / 1000).toFixed(1)} km</span>`;
    const la = info.lat, lo = info.lon;
    this.$('zone').textContent = `${Math.abs(la).toFixed(3)}°${la >= 0 ? 'N' : 'S'} ${Math.abs(lo).toFixed(3)}°${lo >= 0 ? 'E' : 'W'} · ${info.local}`;
    const t = info.target;
    // text and buttons are separate boxes, each only rewritten when it changes (this runs every
    // frame; rebuilding a button between pointer-down and pointer-up swallows the click)
    const nav = this.$('earthnav');
    if (!nav.firstChild) nav.innerHTML = '<div class="en-t"></div><div class="en-b"></div>';
    setHtml(nav.firstChild, t ? `<span>NAV</span><b>${t.name}</b><em>${fmt(t.km)} km · ETA ${fmtDur(t.eta * 1000)}</em>` : '<span>NAV</span><b>No destination</b><em>pick one under DESTINATIONS</em>');
    setHtml(nav.lastChild, `<button class="btn sm ${t ? 'ghost' : ''}" data-open="earthnav">DESTINATIONS</button>${t ? `<button class="btn sm ${info.autopilot ? '' : 'ghost'}" data-act="autopilot">${info.autopilot ? 'AUTOPILOT ON' : 'AUTOPILOT'}</button>` : ''}`);
    const land = this.$('land');
    land.style.display = '';
    land.dataset.act = info.canOrbit ? 'toOrbit' : '';
    land.disabled = !info.canOrbit;
    land.textContent = info.canOrbit ? '⬆ RETURN TO ORBIT' : '▲ CLIMB ABOVE 80 KM TO REACH ORBIT';
  }

  pEarthNav() {
    const e = this.app.earthView, { lat, lon } = e.info;
    const rows = PLACES.map((p) => {
      const { d } = gc(lat, lon, p.lat, p.lon);
      // hypersonic leg at ~7 km/s plus ~12 min climbing out and descending
      const eta = d > 300e3 ? d / 7000 + 720 : d / 250;
      return { p, d, eta };
    }).sort((a, b) => a.d - b.d).map(({ p, d, eta }) => `<div class="row"><span>${p.name}<small>${FUTURE_CITIES[p.id] ? `<em class="fut">${FUTURE_CITIES[p.id].title}</em> · ` : ''}${Math.abs(p.lat).toFixed(2)}°${p.lat >= 0 ? 'N' : 'S'} ${Math.abs(p.lon).toFixed(2)}°${p.lon >= 0 ? 'E' : 'W'}</small></span><span>${fmt(d / 1000)} km</span><b>${fmtDur(eta * 1000)}</b>
      <button class="btn sm" data-act="earthTarget" data-arg="${p.id}">SET</button></div>`).join('');
    return { title: 'Destinations', kicker: 'Real places · real distances', html: `<p class="note">Set a target, then fly there yourself or tap AUTOPILOT. Long legs climb into the hypersonic corridor (~7 km/s at 60–90 km) and descend on approach, so Singapore → Mount Fuji (5,200 km) takes about 25 minutes in real time.</p><div class="table launch">${rows}</div>` };
  }

  // ---------- live cyber threats ----------
  cyberLegend() {
    const d = cyber.data;
    if (!d) return cyber.error
      ? legend('CYBER THREAT FEED OFFLINE', 'Feed unreachable', `Couldn't reach the threat feed (${cyber.error}). It runs as the "api" function of the deployed app.`)
      : legend('CONNECTING TO THREAT FEEDS…', 'Loading live data', 'Ransomware leak sites, botnet trackers and sensor networks.');
    const keys = Object.keys(cyber.byCountry);
    const countries = new Set(keys.map((k) => k.slice(0, 2))).size, states = keys.filter((k) => k.startsWith('US-')).length;
    const online = d.botnets.filter((b) => b.status === 'online').length;
    const on = cyber.sources.filter((s) => s.on), cy = this.app.mapView.cyber;
    const ev = cyber.events.filter((e) => cy.sourceOn(e.src)).slice(0, 6);
    const tick = (e) => `<span class="cy-ev"><i style="--sc:${SOURCE_STYLE[e.src].css}">${SOURCE_STYLE[e.src].tag}</i>${esc(describe(e.src, e.it))}<small>${ago(e.it.t && !/^\d{4}-\d{2}-\d{2}$/.test(e.it.t) ? e.it.t : new Date(e.at).toISOString())}</small></span>`;
    const live = (d.bruteforce || []).filter((v) => Date.now() - Date.parse(v.t) < 10 * 60000).length;
    // where attacking machines are right now (IP location, not who operates them)
    const orig = {};
    for (const src of ['bruteforce', 'attackers', 'malware', 'abuseipdb']) if (cy.sourceOn(src)) for (const v of d[src] || []) if (v.country) orig[v.country] = (orig[v.country] || 0) + 1;
    const topOrig = Object.entries(orig).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([c, n]) => `${esc(COUNTRIES[c]?.[2] || c)} ${n}`).join(' · ');
    return legend(`LIVE · ${on.length} SOURCES · ${ago(d.updated)}`, ev[0] ? `<span class="cy-ev one">${tick(ev[0])}</span>` : `<span class="cy-k"><i class="m"></i>${d.ransomware.length} ransomware · ${countries} countries</span>`,
      `<div class="cy-ticker">${ev.map(tick).join('') || '<span class="cy-ev">Waiting for the next report…</span>'}</div><span class="cy-k"><i class="l"></i>${live} attacks reported in the last 10 min</span>${topOrig ? `<span class="cy-k">top attack origins (machines): ${topOrig}</span>` : ''}<span class="cy-k"><i class="m"></i>${d.ransomware.length} ransomware incidents (72 h)</span><span class="cy-k"><i class="o"></i>${d.ransomware.filter((v) => groupOrigin(v.group)).length} with a reported origin (cable routes)</span><span class="cy-k"><i class="c"></i>submarine cables (TeleGeography)</span><span class="cy-k"><i class="a"></i>${d.attackers.length} top attack sources</span><span class="cy-k"><i class="r"></i>${online} botnet servers online</span><span class="cy-k">${countries} countries · ${states} US states · tap a marker</span><button class="btn sm" data-open="cyber">INCIDENT LOG</button> <button class="btn sm ghost" data-open="cyber:sources">SOURCES</button>`);
  }

  // every feed, whether it's on, how fresh it is, and the API key that would switch it on
  pCyberSources() {
    const why = {
      malware: 'Free key from auth.abuse.ch (sign in with GitHub/Google/X). Brings back URLhaus malware-download URLs and ThreatFox C2 indicators, both updated every few minutes: the richest live feed missing today.',
      ddos: 'Free Cloudflare API token with Account · Radar · Read. Adds real DDoS origin → target country pairs from Cloudflare\'s network, drawn as arcs.',
      otx: 'Free AlienVault OTX account key (Settings → API key). Adds named campaigns, malware families and the countries and industries they target.',
      abuseipdb: 'Free AbuseIPDB key. Adds its most-reported IPs (100% confidence). The free tier allows 5 downloads a day, so it refreshes every 8 hours.',
    };
    const rows = cyber.sources.map((s) => `<div class="row"><span><i class="cy-dot" style="--sc:${SOURCE_STYLE[s.id]?.css || '#fff'}"></i>${esc(s.name)}<small>${esc(s.what)} · ${s.on ? `${s.count} now · refreshed every ${s.every >= 3600 ? `${s.every / 3600} h` : `${Math.round(s.every / 60)} min`}${s.at ? ` · changed ${ago(s.at)}` : ''}${s.error ? ` · <span class="bad">last try failed: ${esc(s.error)}</span>` : ''}` : `off · set <b>${s.key}</b>`}</small>${!s.on && why[s.id] ? `<small>${why[s.id]}</small>` : ''}</span><b class="${s.on ? '' : 'bad'}">${s.on ? 'LIVE' : 'NEEDS KEY'}</b></div>`).join('');
    return {
      title: 'Threat sources', kicker: `${cyber.sources.filter((s) => s.on).length} of ${cyber.sources.length} live`,
      html: `<div class="table">${rows}</div><p class="note">Keys live only on the server: set them as encrypted environment variables on the DigitalOcean "api" component (or in an untracked .env.local for the dev server). Once a key is set there and listed in functions/project.yml, its source switches on by itself. Tap a source's button on the map bar to show or hide it.</p>`,
    };
  }

  pCyber(cc) {
    const d = cyber.data;
    if (!d) return { title: 'Cyber threats', kicker: 'Live feed', html: `<p class="note">${cyber.error ? `Feed unavailable: ${cyber.error}` : 'Loading…'}</p>` };
    if (cc === 'sources') return this.pCyberSources();
    const flag = (c) => (c && COUNTRIES[c] ? COUNTRIES[c][2] : 'Unknown');
    // reports from the other live sources, newest first, one line each with the source's tag
    const liveRows = (src, list, n = 15) => list.slice().sort((a, b) => String(b.t).localeCompare(String(a.t))).slice(0, n).map((it) => `<div class="row"><span><i class="cy-dot" style="--sc:${SOURCE_STYLE[src].css}"></i>${esc(describe(src, it))}<small>${SOURCE_STYLE[src].tag}</small></span><b>${ago(it.t)}</b></div>`).join('');
    const LIVE_SECTIONS = [['bruteforce', 'Live attacks', 'reported in the last hour'], ['phishing', 'Phishing sites hosted here', 'OpenPhish'], ['malware', 'Malware URLs and C2', 'URLhaus · ThreatFox'], ['abuseipdb', 'Most-reported IPs', 'AbuseIPDB'], ['ddos', 'DDoS', 'Cloudflare Radar, last 24 h'], ['otx', 'Campaigns targeting here', 'AlienVault OTX']];
    // where an item is: "Texas, USA" for located US incidents, else the country
    const where = (x) => (x.country === 'US' && x.region && US_STATES[x.region] ? `${US_STATES[x.region][2]}, USA` : flag(x.country));
    const from = (g) => { const o = groupOrigin(g); return o ? ` · from ${flag(o.cc)} (reported)` : ''; };
    const rRow = (v) => `<div class="row"><span>${v.sector}<small>${v.group}${from(v.group)} → ${where(v)}</small></span><b>${ago(v.t)}</b></div>`;
    const aRow = (a) => `<div class="row"><span>${a.as || a.ip}<small>${a.ip}${a.city ? ` · ${a.city}` : ''}</small></span><b>${fmt(a.attacks)} targets</b></div>`;
    if (cc === 'US') {
      // the whole US, broken down by state
      const states = Object.entries(cyber.byCountry).filter(([k]) => k.startsWith('US-'));
      const all = (f) => Object.entries(cyber.byCountry).filter(([k]) => k === 'US' || k.startsWith('US-')).flatMap(([, c]) => c[f]);
      const rows = states.map(([k, c]) => ({ k, name: US_STATES[k.slice(3)][2], r: c.ransomware.length, a: c.attackers.length, b: c.botnets.length }))
        .sort((x, y) => y.r - x.r || y.a - x.a)
        .map((x) => `<div class="row tap" data-act="cyberPlace" data-arg="${x.k}"><span>${x.name}<small>${[x.r && `${x.r} ransomware`, x.a && `${x.a} attack sources`, x.b && `${x.b} botnet`].filter(Boolean).join(' · ')}</small></span><b>›</b></div>`).join('');
      const unknown = (cyber.byCountry.US || { ransomware: [] }).ransomware;
      return {
        title: 'United States', kicker: `Cyber activity by state · ${all('ransomware').length} ransomware in 72 h`,
        html: `<h3>By state <small>tap for details</small></h3><div class="table">${rows || '<p class="note">No located incidents yet.</p>'}</div>
          ${unknown.length ? `<h3>State unknown <small>${unknown.length} posts give no location</small></h3><div class="table">${unknown.slice(0, 25).map(rRow).join('')}</div>` : ''}
          <p class="note">Ransomware states are read from each leak-site post's own text (city/state names, "City, ST", ZIP codes); posts without one stay unassigned. Attack sources and botnet servers are placed by IP location.</p>`,
      };
    }
    if (cc) {
      const c = cyber.byCountry[cc] || { ransomware: [], attackers: [], botnets: [] };
      const state = cc.startsWith('US-');
      return {
        title: state ? US_STATES[cc.slice(3)][2] : flag(cc), kicker: state ? 'United States · cyber activity · live' : 'Cyber activity · live feed',
        html: `${state ? '<button class="btn sm ghost" data-act="cyberPlace" data-arg="US">‹ ALL US STATES</button>' : ''}${c.ransomware.length ? `<h3>Ransomware incidents <small>last 72 h</small></h3><div class="table">${c.ransomware.slice(0, 25).map(rRow).join('')}</div>` : ''}
          ${c.attackers.length ? `<h3>Attack sources <small>machines here hitting sensors</small></h3><div class="table">${c.attackers.map(aRow).join('')}</div>` : ''}
          ${c.botnets.length ? `<h3>Botnet command servers</h3><div class="table">${c.botnets.map((b) => `<div class="row"><span>${b.malware}<small>${b.as || ''}${b.city ? ` · ${b.city}` : ''}</small></span><b class="${b.status === 'online' ? 'bad' : ''}">${b.status}</b></div>`).join('')}</div>` : ''}
          ${LIVE_SECTIONS.map(([src, h, sub]) => ((c[src] || []).length ? `<h3>${h} <small>${(c[src] || []).length} · ${sub}</small></h3><div class="table">${liveRows(src, c[src])}</div>` : '')).join('')}
          <p class="note">Reported by public trackers; victims are shown by sector only. Phishing sites are named by host only and are not links.</p>`,
      };
    }
    // global log
    const groups = {}, sectors = {}, places = {}, states = {};
    for (const v of d.ransomware) {
      groups[v.group] = (groups[v.group] || 0) + 1; sectors[v.sector] = (sectors[v.sector] || 0) + 1;
      if (v.country) places[v.country] = (places[v.country] || 0) + 1;
      if (v.country === 'US' && v.region && US_STATES[v.region]) states[v.region] = (states[v.region] || 0) + 1;
    }
    const top = (o, n, f = (k) => k) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, c]) => `<span class="cost">${f(k)} <b>${c}</b></span>`).join('');
    return {
      title: 'Cyber threat log', kicker: `Live · updated ${ago(d.updated)}`,
      html: `<div class="cy-stats"><div><b>${d.ransomware.length}</b><span>ransomware posts · 72 h</span></div><div><b>${d.attackers.length}</b><span>top attack sources</span></div><div><b>${d.botnets.filter((b) => b.status === 'online').length}</b><span>botnet C2 online</span></div><div><b>${d.exploits.length}</b><span>new exploited CVEs</span></div><div><b>${(d.bruteforce || []).length}</b><span>attacks reported · 1 h</span></div><div><b>${(d.phishing || []).length}</b><span>live phishing sites</span></div></div>
        <h3>Live feed <small>newest first · <button class="btn sm ghost" data-open="cyber:sources">${cyber.sources.filter((x) => x.on).length} SOURCES</button></small></h3><div class="table">${cyber.events.slice(0, 30).map((e) => `<div class="row"><span><i class="cy-dot" style="--sc:${SOURCE_STYLE[e.src].css}"></i>${esc(describe(e.src, e.it))}<small>${SOURCE_STYLE[e.src].tag}</small></span><b>${ago(new Date(e.at).toISOString())}</b></div>`).join('') || '<p class="note">Waiting for the first reports…</p>'}</div>
        <h3>Most active ransomware groups</h3><div class="costs">${top(groups, 8)}</div>
        <h3>Most targeted</h3><div class="costs">${top(places, 8, flag)}</div>${Object.keys(states).length ? `<h3>Most targeted US states <small><button class="btn sm ghost" data-act="cyberPlace" data-arg="US">ALL STATES</button></small></h3><div class="costs">${top(states, 10, (k) => US_STATES[k][2])}</div>` : ''}<div class="costs" style="margin-top:4px">${top(sectors, 6)}</div>
        <h3>Reported origins <small>routed on the globe</small></h3><div class="costs">${(() => { const o = {}; let unk = 0; for (const v of d.ransomware) { const g = groupOrigin(v.group); if (g) o[g.cc] = (o[g.cc] || 0) + 1; else unk++; } return top(o, 6, flag) + `<span class="cost">origin unknown <b>${unk}</b></span>`; })()}</div>
        ${(cyber.routes || []).length ? `<h3>Paths through the cables <small>shortest route over the real network</small></h3><div class="table">${cyber.routes.slice(0, 8).map((r) => `<div class="row"><span>${flag(r.from)} → ${r.to}<small>${r.cables.slice(0, 4).join(' · ')}${r.cables.length > 4 ? ` +${r.cables.length - 4} more` : ''}</small></span><b>${fmt(r.km)} km</b></div>`).join('')}</div>` : ''}
        ${(cyber.ddosRoutes || []).length ? `<h3>DDoS paths <small>Cloudflare Radar · shortest route over the cables</small></h3><div class="table">${cyber.ddosRoutes.slice().sort((x, y) => y.share - x.share).slice(0, 8).map((r) => `<div class="row"><span>${flag(r.from)} → ${flag(r.to)}<small>${r.share.toFixed(1)}% of ${r.layer} attacks · ${esc(r.cables.slice(0, 3).join(' · '))}${r.cables.length > 3 ? ` +${r.cables.length - 3} more` : ''}</small></span><b>${fmt(r.km)} km</b></div>`).join('')}</div>` : ''}
        <p class="note">Why most arcs start in Russia: arcs only exist for ransomware groups with solid public attribution, and most attributed groups are Russian-speaking. Where attacking machines actually sit (cyan, amber and green dots) is far more spread out; see "top attack origins" in the legend. Cloudflare Radar, once its key is set, adds measured DDoS origin → target arcs.</p>
        <p class="note">Pulses run from a group's publicly reported base to its victims, only for groups with solid public attribution (government actions or major research). That reporting is about where operators are believed to be, not proof or state sponsorship; most groups stay "origin unknown". Each path follows real submarine cables (TeleGeography's Submarine Cable Map) from the origin's main internet hub, with straight links standing in for land fibre between landing stations. It is the shortest plausible path over the network, not a traced one: actual routes aren't public and attackers usually relay through VPNs and proxies elsewhere.</p>
        <h3>Latest ransomware incidents</h3><div class="table">${d.ransomware.slice(0, 30).map(rRow).join('')}</div>
        <h3>Newly exploited vulnerabilities <small>CISA KEV</small></h3><div class="table">${d.exploits.map((x) => `<div class="row"><span>${x.vendor} ${x.product}<small>${x.cve}${x.ransomware ? ' · used by ransomware' : ''}</small></span><b>${x.t}</b></div>`).join('')}</div>
        <h3>Top attack sources <small>SANS ISC sensors</small></h3><div class="table">${d.attackers.slice(0, 15).map((a) => `<div class="row"><span>${where(a)}<small>${a.as || ''} · ${a.ip}${a.city ? ` · ${a.city}` : ''}</small></span><b>${fmt(a.attacks)} targets</b></div>`).join('')}</div>
        ${(d.cves || []).length ? `<h3>Just-published CVEs <small>NVD · last 12 h</small></h3><div class="table">${d.cves.slice(0, 12).map((x) => `<div class="row"><span>${x.cve}${x.score != null ? ` · ${x.severity} ${x.score}` : ''}<small>${esc(x.summary)}</small></span><b>${ago(x.t)}</b></div>`).join('')}</div>` : ''}
        ${(d.c2certs || []).length ? `<h3>New malware C&amp;C certificates <small>abuse.ch SSLBL · 48 h</small></h3><div class="costs">${(() => { const m = {}; for (const c of d.c2certs) m[c.malware] = (m[c.malware] || 0) + 1; return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, n]) => `<span class="cost">${esc(k)} <b>${n}</b></span>`).join(''); })()}</div>` : ''}
        <p class="note">Sources: ${cyber.sources.filter((x) => x.on).map((x) => x.name).join(' · ')} · ip-api.com (IP locations). Victim organisations are not named; only sector and country are shown. Everything here is a public report, not live packet traffic.</p>`,
    };
  }

  updateMarkers(list) {
    const box = this.$('markers');
    while (this.markerEls.length < list.length) {
      const el = document.createElement('div');
      el.className = 'mk';
      el.innerHTML = '<i></i><span></span>';
      box.appendChild(el);
      this.markerEls.push(el);
    }
    const W = innerWidth, H = innerHeight, pad = 34;
    this.markerEls.forEach((el, i) => {
      const m = list[i];
      if (!m) { el.style.display = 'none'; return; }
      el.style.display = '';
      let x = m.x, y = m.y, edge = !m.on;
      if (edge) {
        // clamp off-screen markers to the screen edge, pointing toward the object
        let dx = x - W / 2, dy = y - H / 2;
        if (m.behind) { dx = -dx; dy = -dy; }
        const k = Math.min((W / 2 - pad) / Math.abs(dx || 1e-3), (H / 2 - pad * 3) / Math.abs(dy || 1e-3));
        x = W / 2 + dx * k; y = H / 2 + dy * k;
        el.style.setProperty('--rot', `${Math.atan2(dy, dx)}rad`);
      }
      el.className = `mk ${m.kind}${edge ? ' edge' : ''}`;
      el.style.transform = `translate(${x}px, ${y}px)`;
      el.querySelector('span').textContent = `${m.label.toUpperCase()} · ${m.km ? fmtKm(m.km) : fmtDist(m.dist)}`;
    });
  }

  // ---------- sheets ----------
  renderSheet(scrollTop) {
    this.sheetAcc = 0;
    this.dirty = false;
    if (!this.panel) return;
    const [name, arg] = this.panel.split(':');
    const body = this.$('sheet-body');
    const keep = body.scrollTop;
    const fn = { base: this.pBase, tech: this.pTech, fleet: this.pFleet, market: this.pMarket, body: this.pBody, launch: this.pLaunch, goals: this.pGoals, settings: this.pSettings, earthnav: this.pEarthNav, cyber: this.pCyber }[name];
    const { title, kicker = '', html } = fn.call(this, arg);
    this.$('sheet-title').textContent = title;
    this.$('sheet-kicker').textContent = kicker;
    body.innerHTML = html;
    body.scrollTop = scrollTop ? 0 : keep;
  }

  costHtml(cost, baseId) {
    const s = this.app.state;
    return Object.entries(cost).map(([r, v]) => `<span class="cost ${S.available(s, r, baseId) + 1e-9 >= v ? '' : 'bad'}">${resIcon(r)}${fmt(v)}</span>`).join('');
  }

  pBase() {
    const s = this.app.state, id = s.presence, base = s.bases[id], body = BODY[id];
    const p = base._power || { prod: 0, use: 0, f: 1, solarF: 1, au: 1 };
    const cap = S.capOf(base), rates = base._rates || {};
    const store = RES_KEYS.map((r) => `<div class="cell ${base.store[r] >= cap - 0.5 ? 'full' : ''}" style="--c:${RES[r].color}"><span>${RES[r].name}</span><b>${fmt(base.store[r])}</b><div class="mini"><i style="width:${pct(base.store[r] / cap)}"></i></div>${rates[r] ? `<em class="${rates[r] < 0 ? 'neg' : ''}">${rates[r] > 0 ? '+' : ''}${fmt(rates[r])}/min</em>` : '<em>idle</em>'}</div>`).join('');
    const cards = Object.keys(BUILDINGS).filter((k) => S.buildingAllowed(k, id)).map((k) => {
      const B = BUILDINGS[k], lvl = base.buildings[k] || 0, c = S.canBuild(s, id, k);
      let extra = '';
      if (k === 'solar') extra = `${fmt(B.power * p.solarF)} MW per array here (${(p.solarF * 100).toFixed(0)}% of Earth sunlight)`;
      if (k === 'drones') extra = Object.entries(body.drones).map(([r, v]) => `${RES[r].short} ${fmt(v)}/min`).join(' · ') + ' per level';
      const cost = c.cost || S.buildCost(k, lvl);
      return `<div class="card ${lvl ? 'owned' : ''}">
        <div class="card-h"><span class="tag">${B.tag}</span><b>${B.name}</b><span class="lv">${lvl ? `LV ${lvl}` : ''}</span></div>
        <p>${B.desc}${extra ? `<br><small>${extra}</small>` : ''}${B.power ? `<br><small>${B.power > 0 ? '+' : ''}${B.power} MW per level</small>` : ''}</p>
        <div class="card-f">${c.why === 'Max level' ? '' : `<div class="costs">${this.costHtml(cost, id)}</div>`}
          <button class="btn" data-act="build" data-arg="${k}" ${c.ok ? '' : 'disabled'}>${c.ok ? (lvl ? 'UPGRADE' : 'BUILD') : c.why}</button></div>
      </div>`;
    }).join('');
    const f = FIELDS[id];
    return {
      title: body.base, kicker: `${kindName[body.kind]} ${body.name} · ${p.au.toFixed(2)} AU`,
      html: `<div class="power ${p.f < 1 ? 'low' : ''}"><div class="pw-h"><span>POWER GRID</span><b>${fmt(p.prod)} / ${fmt(p.use)} MW</b></div><div class="bar"><i style="width:${pct(p.use ? p.prod / p.use : 1)}"></i></div>${p.f < 1 ? `<small>Brownout · production at ${(p.f * 100).toFixed(0)}%</small>` : ''}</div>
        <div class="field"><span>ORBITAL FIELD</span><b>${f.name}</b><div class="costs">${Object.keys(f.res).map((r) => `<span class="cost">${resIcon(r)}</span>`).join('')}</div></div>
        <h3>Stores <small>cap ${fmt(cap)} t each</small></h3><div class="store-grid">${store}</div>
        ${id !== 'earth' ? '<p class="note">Builds here use local stores first, then draw the rest from Eden.</p>' : ''}
        <h3>Modules</h3>${cards}`,
    };
  }

  pTech() {
    const s = this.app.state, d = S.drive(s), t = S.simNow(s);
    const samples = ['moon', 'mars', 'ceres', 'jupiter', 'neptune', 'sun'].map((id) => {
      const km = distKm('earth', id, t);
      return `<div class="row"><span>${BODY[id].name}</span><span>${fmtKm(km)}</span><b>${fmtDur(S.travelMs(s, 'earth', id, t))}</b></div>`;
    }).join('');
    const cards = Object.entries(TECHS).map(([k, T]) => {
      const c = S.canResearch(s, k), done = !!s.techs[k];
      const drv = T.drive ? `<br><small>Drive tier ${T.drive}: ${fmt(DRIVES[T.drive - 1].kms)} km/s · ${((DRIVES[T.drive - 1].kms / C_KMS) * 100).toPrecision(2)}% c</small>` : '';
      return `<div class="card ${done ? 'owned' : c.locked ? 'locked' : ''}">
        <div class="card-h"><span class="tag ${T.drive ? 'drv' : ''}">${T.drive ? 'DRV' : 'SCI'}</span><b>${T.name}</b><span class="lv">${done ? '✓' : ''}</span></div>
        <p>${T.desc}${drv}</p>
        ${done ? '' : `<div class="card-f"><div class="costs">${this.costHtml({ rp: T.rp, ...T.cost }, 'earth')}</div>
        <button class="btn" data-act="research" data-arg="${k}" ${c.ok ? '' : 'disabled'}>${c.ok ? 'RESEARCH' : c.why}</button></div>`}
      </div>`;
    }).join('');
    const ladder = DRIVES.map((x) => `<i class="${x.tier <= d.tier ? 'on' : ''}" title="${x.name}"></i>`).join('');
    return {
      title: 'Research', kicker: 'Propulsion & science',
      html: `<div class="drive"><div class="dl">CURRENT DRIVE · TIER ${d.tier}/6</div><div class="dn">${d.name}</div>
        <div class="dv"><b>${fmt(d.kms)}</b> km/s · ${((d.kms / C_KMS) * 100).toPrecision(2)}% of light speed</div>
        <div class="ladder">${ladder}</div>
        <div class="lightbar"><i style="width:${Math.max(1, (d.kms / C_KMS) * 100)}%"></i><span>c</span></div></div>
        <h3>Travel times from Earth, right now</h3><div class="table">${samples}</div>
        <p class="note">Planets move on their real inclined orbits, so distances change day to day. Ships fly real intercept courses in real time and keep flying while you're offline.</p>
        <h3>Technologies</h3>${cards}`,
    };
  }

  pFleet() {
    const s = this.app.state, t = S.simNow(s), yard = S.level(s, 'earth', 'shipyard');
    const v = s.voyage;
    const voyage = v ? `<div class="vcard"><div class="v-h"><span class="v-k">◆ YOUR FLEET</span><span class="v-r">${BODY[v.from].name} → <b>${BODY[v.to].name}</b></span></div>
        <div class="v-bar"><i style="width:${pct((t - v.depart) / (v.arrive - v.depart))}"></i></div>
        <div class="v-f"><span>ETA ${fmtDur(v.arrive - t)}</span><span>${fmt(v.kms)} km/s</span><span>hold ${fmt(Object.values(v.cargo).reduce((a, b) => a + b, 0))}/${S.fleetCap(s, v.escorts)} t</span></div>
        ${s.aboard ? '' : '<button class="btn big" data-act="rejoin">REJOIN FLEET · UPLINK TO SKIFF</button>'}</div>` : '';
    const build = Object.entries(SHIPS).map(([k, sh]) => `<div class="card">
      <div class="card-h"><span class="tag">${k === 'seed' ? 'SED' : 'HAU'}</span><b>${sh.name}</b><span class="lv">${Math.round(sh.speed * 100)}% SPD</span></div><p>${sh.desc}</p>
      <div class="card-f"><div class="costs">${this.costHtml(sh.cost, 'earth')}</div>
      <button class="btn" data-act="ship" data-arg="${k}" ${yard && S.canAfford(s, sh.cost, 'earth') ? '' : 'disabled'}>${yard ? 'BUILD' : 'NEED SHIPYARD'}</button></div></div>`).join('');
    const ships = s.ships.map((sh) => {
      const tr = s.trips.find((x) => x.shipId === sh.id);
      if (tr) {
        const k = Math.min(1, (t - tr.depart) / (tr.arrive - tr.depart));
        return `<div class="ship"><b>${SHIPS[sh.type].name} #${sh.id}</b><span>${tr.type === 'return' ? 'Returning from' : 'En route to'} ${BODY[tr.type === 'return' ? tr.from : tr.to].name}</span>
          <div class="bar"><i style="width:${pct(k)}"></i></div><small>ETA ${fmtDur(tr.arrive - t)}</small></div>`;
      }
      if (sh.status === 'fleet') return `<div class="ship fleet"><b>${SHIPS[sh.type].name} #${sh.id}</b><span>Flying in your convoy</span></div>`;
      return `<div class="ship"><b>${SHIPS[sh.type].name} #${sh.id}</b><span>Docked at ${BODY[sh.at || 'earth'].base}</span>
        <button class="btn sm" data-act="pickLaunch" data-arg="${sh.id}">SEND</button></div>`;
    }).join('') || '<p class="note">No ships yet. Build an Orbital Shipyard at Eden, then build ships here.</p>';
    return {
      title: 'Fleet', kicker: `${S.drive(s).name} · ${fmt(S.drive(s).kms)} km/s`,
      html: `${voyage}<p class="note">To fly with your ships, open MAP, pick a world and tap AUTOPILOT FLEET. The convoy cruises at the speed of its slowest hull.</p>
        <h3>Ships</h3>${ships}<h3>Shipyard</h3>${build}`,
    };
  }

  pLaunch(shipId) {
    const s = this.app.state, ship = s.ships.find((x) => x.id === +shipId), t = S.simNow(s);
    if (!ship) return { title: 'Send', html: '' };
    const from = ship.at || 'earth';
    const targets = BODIES.filter((b) => b.id !== from && (ship.type === 'seed' ? !s.bases[b.id] : !!s.bases[b.id] && b.id !== 'earth'));
    const rows = targets.map((b) => {
      const km = distKm(from, b.id, t);
      return `<div class="row"><span>${b.name}<small>${b.base}</small></span><span>${fmtKm(km)}</span><b>${fmtDur(S.travelMs(s, from, b.id, t, S.shipKms(s, ship.type)))}</b>
        <button class="btn sm" data-act="launch" data-arg="${ship.id}" data-arg2="${b.id}">GO</button></div>`;
    }).join('') || '<p class="note">No valid destinations.</p>';
    return { title: `Send ${SHIPS[ship.type].name}`, kicker: `Unmanned · from ${BODY[from].base}`, html: `<p class="note">${ship.type === 'seed' ? 'Pick a world without a base. The ship is consumed to found the outpost.' : 'Pick an outpost to collect cargo from. The hauler returns to Eden automatically.'}</p><div class="table launch">${rows}</div>` };
  }

  pMarket() {
    const s = this.app.state, st = s.bases.earth.store;
    const rows = RES_KEYS.map((r) => `<div class="mrow" style="--c:${RES[r].color}"><i class="sw"></i><span class="nm">${RES[r].name}<small>have ${fmt(st[r])} t · sells ₡${RES[r].value}/t</small></span>
      <button class="btn sm ghost" data-act="sell" data-arg="${r}" data-arg2="10" ${st[r] >= 1 ? '' : 'disabled'}>SELL 10</button>
      <button class="btn sm" data-act="sell" data-arg="${r}" data-arg2="all" ${st[r] >= 1 ? '' : 'disabled'}>ALL</button>
      ${MARKET.buy[r] ? `<button class="btn sm buy" data-act="buy" data-arg="${r}" data-arg2="10">BUY 10 · ₡${MARKET.buy[r] * 10}</button>` : ''}</div>`).join('');
    return { title: 'Earth Market', kicker: 'Eden exchange', html: `<p class="note">Earth sells only what it can launch: metal, silicon and water, at a steep price per tonne. Everything else has to come from space.</p>${rows}` };
  }

  pBody(id) {
    const s = this.app.state, b = BODY[id], t = S.simNow(s), base = s.bases[id];
    const here = s.presence;
    const km = id === here ? 0 : distKm(here, id, t);
    const docked = S.dockedAt(s, here);
    if (!this.escortSel) this.escortSel = new Set(docked.map((x) => x.id));
    for (const sid of [...this.escortSel]) if (!docked.some((x) => x.id === sid)) this.escortSel.delete(sid);
    const escorts = [...this.escortSel];
    const types = escorts.map((sid) => s.ships.find((x) => x.id === sid).type);
    const kms = S.fleetKms(s, types);
    const inbound = s.trips.filter((tr) => tr.to === id);
    let actions = '';
    if (base && here !== id) actions += `<button class="btn big ghost" data-act="teleport" data-arg="${id}">NEURAL UPLINK · INSTANT</button>`;
    if (id !== here) {
      const cv = S.canVoyage(s, id, escorts);
      const picks = docked.map((x) => `<button class="esc ${this.escortSel.has(x.id) ? 'on' : ''}" data-act="escort" data-arg="${x.id}">${x.type === 'seed' ? 'SEED' : 'HAULER'} #${x.id}<small>${Math.round(SHIPS[x.type].speed * 100)}% · ${SHIPS[x.type].cargo ? `+${SHIPS[x.type].cargo} t` : 'founds base'}</small></button>`).join('');
      actions += `<div class="plan"><div class="plan-h"><span>AUTOPILOT FLEET</span><b>${fmtDur(S.travelMs(s, here, id, t, kms))}</b></div>
        <div class="escorts"><span class="esc lead">KESTREL SKIFF<small>you · ${SKIFF.cargo} t</small></span>${picks}</div>
        <div class="plan-f">${fmt(kms)} km/s convoy · hold ${S.fleetCap(s, escorts)} t · from ${BODY[here].name}</div>
        <button class="btn big" data-act="voyage" data-arg="${id}" ${cv.ok ? '' : 'disabled'}>${cv.ok ? `ENGAGE AUTOPILOT → ${b.name.toUpperCase()}` : cv.why}</button></div>`;
    } else actions += `<div class="note">${s.aboard ? 'Your fleet is bound here.' : 'You are here.'}</div>`;
    const seedEarth = s.ships.find((x) => x.type === 'seed' && x.status === 'docked');
    const haul = s.ships.find((x) => x.type === 'hauler' && x.status === 'docked' && (x.at || 'earth') !== id);
    if (!base && id !== 'earth' && seedEarth) actions += `<button class="btn big alt" data-act="launchTo" data-arg="${id}" data-arg2="seed">SEND SEED SHIP UNMANNED · ${fmtDur(S.travelMs(s, seedEarth.at || 'earth', id, t, S.shipKms(s, 'seed')))}</button>`;
    if (base && id !== 'earth' && haul) actions += `<button class="btn big alt" data-act="launchTo" data-arg="${id}" data-arg2="hauler">SEND HAULER · ${fmtDur(S.travelMs(s, 'earth', id, t, S.shipKms(s, 'hauler')) * 2)} round trip</button>`;
    const res = Object.entries(b.drones).map(([r, v]) => `<span class="cost">${resIcon(r)}${fmt(v)}/min</span>`).join('') || '<span class="note">Unmineable · but the power is immense.</span>';
    const f = FIELDS[id], tilt = orbitTilt(id, t);
    return {
      title: b.name, kicker: `${kindName[b.kind]} · radius ${fmt(b.radiusKm)} km${tilt >= 0.05 ? ` · orbit tilted ${tilt.toFixed(1)}°` : ''}`,
      html: `${base ? `<div class="sub ok">◉ ${b.base}</div>` : ''}<p>${b.desc}</p>
        ${id !== here ? `<div class="table"><div class="row"><span>Distance from ${BODY[here].name}</span><b>${fmtKm(km)}</b></div>
        <div class="row"><span>Light-time</span><b>${fmtDur((km / C_KMS) * 1000)}</b></div></div>` : ''}
        <h3>Orbital field</h3><div class="field"><b>${f.name}</b><div class="costs">${Object.keys(f.res).map((r) => `<span class="cost">${resIcon(r)}</span>`).join('') || '<span class="note">nothing to collect</span>'}</div></div>
        <h3>Drone yield per level</h3><div class="costs">${res}</div>
        ${inbound.map((tr) => `<div class="note">Inbound ${tr.type === 'found' ? 'Seed Ship' : 'Hauler'} · ETA ${fmtDur(tr.arrive - t)}</div>`).join('')}
        <div class="actions">${actions}</div>`,
    };
  }

  pGoals() {
    const s = this.app.state;
    return {
      title: 'Objectives', kicker: `${s.goalIdx}/${GOALS.length} complete`,
      html: GOALS.map((g, i) => `<div class="goal-row ${i < s.goalIdx ? 'done' : i === s.goalIdx ? 'cur' : ''}"><b>${i < s.goalIdx ? '✓' : i + 1}</b><div><strong>${g.title}</strong><p>${g.text}</p></div>${g.reward ? `<span>₡${fmt(g.reward)}</span>` : ''}</div>`).join(''),
    };
  }

  pSettings() {
    const q = this.app.quality, c = this.app.state.craft;
    const dev = this.app.dev ? `<h3>Dev time warp</h3><div class="costs">${[1, 60, 600, 3600].map((k) => `<button class="btn sm" data-act="scale" data-arg="${k}">×${k}</button>`).join('')}</div>` : '';
    return {
      title: 'Settings', kicker: 'System',
      html: `<h3>Craft</h3><p class="note">Now flying the <b>${CRAFTS[c] || CRAFTS.frame}</b>. On EVA, fly the exosuit to your ship (follow the amber YOUR SHIP marker) and tap BOARD SHIP or press B when it lights up. In the ${CRAFTS.skiff}, tap EXIT SHIP (B) to step out: at a station within docking range, and anywhere during a fleet voyage, where the ship holds formation until you return. Both share the same hold and drive. On the surface you always walk in the loader mech.</p>
        <h3>Graphics</h3><div class="seg wide">${['ultra', 'high', 'low'].map((k) => `<button class="${q === k ? 'on' : ''}" data-act="quality" data-arg="${k}">${k.toUpperCase()}</button>`).join('')}</div>
        <p class="note">ULTRA: 4x MSAA, high-DPI, lens effects, sharp shadows. HIGH: bloom and lens effects. LOW: no post-processing, for older phones. Resolution adapts automatically to hold a smooth frame rate${this.app.fps ? ` (now ${this.app.fps.toFixed(0)} fps)` : ''}.</p>${dev}
        <h3>How to play</h3><button class="btn big ghost" data-act="help">OPEN THE TUTORIAL</button>
        <h3>Save</h3><p class="note">Progress saves automatically, and to Telegram Cloud when played inside Telegram.</p>
        <button class="btn danger" data-act="reset">RESET GAME</button>
        <h3>About</h3><p class="note">Planet positions use real inclined orbital elements, so every distance and travel time is computed from where the planets really are right now. Planet maps: Solar System Scope (CC BY 4.0) and NASA/USGS/JPL. Star catalogue: Hipparcos/BSC via d3-celestial. Prototype v0.3.</p>`,
    };
  }

  showIntro() {
    const o = this.$('overlay');
    o.innerHTML = `<div class="card-lg"><div class="kicker">YEAR 2087 · LOW EARTH ORBIT · 400 KM</div><h1>THE OPEN<br>SPACE</h1>
      <p>You run a one-skiff salvage outfit out of <b>Eden</b>. Low orbit is a junkyard of dead satellites and spent rocket stages. That scrap is your first fortune.</p>
      <p>Build robot swarms, found outposts, and fly your fleet across the real solar system in <b>real time</b>. Push your drives from 15 km/s to the <b>speed of light</b>: at c, the Sun is 8.3 minutes away.</p>
      <button class="btn big" data-act="start">ENGAGE</button></div>`;
    o.classList.add('show');
  }

  // ---------- tutorial: one card per system, controls for touch or keyboard + mouse ----------
  showTutorial(step) {
    this.tutStep = step;
    this.tutDevice = this.tutDevice || (isTouch() ? 'mobile' : 'desktop');
    const T = TUTORIAL[step], dev = this.tutDevice;
    const rows = T[dev].map(([inp, what]) => {
      const keyboard = inp.startsWith('k:'), label = inp.slice(2);
      const chips = keyboard ? label.replace(/\[([^\]]+)\]/g, '<kbd>$1</kbd>') : `<span class="gest">${label}</span>`;
      return `<div class="tut-row"><div class="tut-in">${chips}</div><div class="tut-do">${what}</div></div>`;
    }).join('');
    const dots = TUTORIAL.map((_, i) => `<button class="tut-dot ${i === step ? 'on' : i < step ? 'done' : ''}" data-act="tutGo" data-arg="${i}" aria-label="Step ${i + 1}"></button>`).join('');
    const o = this.$('overlay');
    o.innerHTML = `<div class="card-lg tut">
      <div class="tut-top"><div class="kicker">HOW TO PLAY · ${step + 1}/${TUTORIAL.length} · ${T.kicker}</div><button class="tut-skip" data-act="tutEnd">SKIP</button></div>
      <h1>${T.title}</h1>
      <p>${T.body}</p>
      <div class="seg wide tut-dev"><button class="${dev === 'mobile' ? 'on' : ''}" data-act="tutDevice" data-arg="mobile">MOBILE · TOUCH</button><button class="${dev === 'desktop' ? 'on' : ''}" data-act="tutDevice" data-arg="desktop">DESKTOP · KEYBOARD</button></div>
      <div class="tut-rows">${rows}</div>
      <div class="tut-dots">${dots}</div>
      <div class="tut-nav">${step ? '<button class="btn ghost" data-act="tutBack">BACK</button>' : '<span></span>'}<button class="btn" data-act="tutNext">${step === TUTORIAL.length - 1 ? "LET'S GO" : 'NEXT'}</button></div>
    </div>`;
    o.classList.add('show');
    if (!this.tutKeys) {
      // desktop: ← / → or Enter to page through, Esc to close
      this.tutKeys = (e) => {
        if (this.tutStep == null || !this.$('overlay').classList.contains('show')) return;
        if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); this.act('tutNext'); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); this.act('tutBack'); }
        else if (e.key === 'Escape') this.act('tutEnd');
      };
      addEventListener('keydown', this.tutKeys);
    }
  }
  endTutorial() {
    this.tutStep = null;
    this.$('overlay').classList.remove('show');
    this.app.state.seenTutorial = true;
    this.app.save();
  }

  showWin() {
    this.winShown = true;
    const s = this.app.state;
    const o = this.$('overlay');
    o.innerHTML = `<div class="card-lg win"><div class="kicker">c = 299,792 km/s</div><h1>LIGHT<br>SPEED</h1>
      <p>Your economy spans ${Object.keys(s.bases).length} worlds. The Sun is now 8 minutes away, Neptune 4 hours.</p>
      <p>Next: interstellar ambitions, rival syndicates and sky pirates. Keep building.</p>
      <button class="btn big" data-act="closeWin">CONTINUE</button></div>`;
    o.classList.add('show');
  }
}
