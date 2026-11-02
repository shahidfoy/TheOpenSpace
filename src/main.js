import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import './style.css';
import * as S from './sim/state.js';
import { BODY } from './sim/orbits.js';
import { initTelegram, cloudLoad, cloudSave, cloudWipe, haptic, tg } from './telegram.js';
import { LocalView } from './render/localView.js';
import { MapView } from './render/mapView.js';
import { SurfaceView, SURFACES } from './render/surfaceView.js';
import { EarthView } from './render/earthView.js';
import { loadAssets } from './render/assets.js';
import { setAnisotropy } from './render/materials.js';
import { LensShader, SanitizeShader } from './render/post.js';
import { loadSky } from './render/sky.js';
import { preloadPlanets } from './render/planets.js';
import { BODIES } from './data/bodies.js';
import { createInput } from './ui/input.js';
import { Hud, fmtDur } from './ui/hud.js';

// Quality tiers. ULTRA pushes the device: MSAA, full-res bloom, high DPR, adaptive resolution.
const QUALITY = {
  ultra: { post: true, msaa: 4, maxPR: 2, bloomScale: 0.75, lens: true },
  high: { post: true, msaa: 0, maxPR: 1.5, bloomScale: 0.5, lens: true },
  low: { post: false, msaa: 0, maxPR: 1, bloomScale: 0.5, lens: false },
};

async function boot() {
  initTelegram();
  const params = new URLSearchParams(location.search);
  const bootSub = document.getElementById('boot-sub'), bootBar = document.getElementById('boot-bar');
  const progress = (k, text) => { if (bootBar) bootBar.style.width = `${Math.round(k * 100)}%`; if (text && bootSub) bootSub.textContent = text; };

  const local = S.loadLocal();
  const cloud = await cloudLoad();
  const raw = cloud && (!local || (cloud.savedAt || 0) > (local.savedAt || 0)) ? cloud : local;
  const state = raw ? S.hydrate(raw) : S.newGame();
  const away = raw ? S.catchUp(state) : 0;
  progress(0.1, 'SYNCING ORBITAL ELEMENTS');

  const canvas = document.getElementById('c');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const labels = new CSS2DRenderer({ element: document.getElementById('labels') });

  const savedQ = localStorage.getItem('openspace_quality');
  const app = {
    state, renderer, mode: 'local', dev: params.has('dev'),
    quality: QUALITY[savedQ] ? savedQ : (/Android|iPhone|iPad/i.test(navigator.userAgent) ? 'high' : 'ultra'),
  };
  app.input = createInput(app);

  progress(0.2, 'LOADING HANGAR');
  await Promise.all([loadAssets(15000, (k) => progress(0.2 + k * 0.6)), loadSky(), preloadPlanets(BODIES.map((b) => b.id))]);
  progress(0.85, 'SPOOLING REACTORS');
  setAnisotropy(Math.min(8, renderer.capabilities.getMaxAnisotropy()));

  const env = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  app.localView = new LocalView(app);
  app.mapView = new MapView(app);
  app.surfaceView = new SurfaceView(app);
  app.earthView = new EarthView(app);
  for (const sc of [app.localView.scene, app.mapView.scene, app.surfaceView.scene, app.earthView.scene]) {
    sc.environment = env;
    sc.environmentIntensity = 0.35;
  }
  if (state.voyage && state.aboard) app.localView.setVoyage();
  else { state.aboard = false; app.localView.setBase(state.presence); }

  let composer, renderPass, bloom, lens;
  function makeComposer() {
    composer?.dispose();
    const q = QUALITY[app.quality];
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: q.msaa });
    composer = new EffectComposer(renderer, rt);
    renderPass = new RenderPass(app.localView.scene, app.localView.camera);
    bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.75, 0.55, 0.88);
    lens = new ShaderPass(LensShader);
    composer.addPass(renderPass);
    composer.addPass(new ShaderPass(SanitizeShader));
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
    if (q.lens) composer.addPass(lens);
  }

  // Adaptive resolution: hold ~55+ fps by trading pixel density.
  let pr = 1;
  const perf = { acc: 0, frames: 0, cool: 0 };
  function applySize() {
    const w = innerWidth, h = innerHeight, q = QUALITY[app.quality];
    renderer.setPixelRatio(pr);
    renderer.setSize(w, h, false);
    if (q.post) {
      composer.setPixelRatio(pr);
      composer.setSize(w, h);
      bloom.setSize(w * pr * q.bloomScale, h * pr * q.bloomScale);
      lens.uniforms.uAspect.value = w / h;
    }
    labels.setSize(w, h);
    for (const cam of [app.localView.camera, app.mapView.camera, app.surfaceView.camera, app.earthView.camera]) { cam.aspect = w / h; cam.updateProjectionMatrix(); }
  }
  function resize() {
    pr = Math.min(devicePixelRatio, QUALITY[app.quality].maxPR);
    applySize();
  }
  function adapt(dt) {
    const q = QUALITY[app.quality];
    perf.acc += dt; perf.frames++;
    if (perf.acc < 2 || document.hidden) return;
    const fps = perf.frames / perf.acc;
    perf.acc = 0; perf.frames = 0;
    if (performance.now() < perf.cool) return;
    const max = Math.min(devicePixelRatio, q.maxPR);
    // ignore throttled background frame rates (< 20 fps): that's the browser, not the GPU
    if (fps < 48 && fps > 20 && pr > 0.7) { pr = Math.max(0.7, pr - 0.15); applySize(); perf.cool = performance.now() + 3000; }
    else if (fps > 58 && pr < max) { pr = Math.min(max, pr + 0.1); applySize(); perf.cool = performance.now() + 5000; }
    app.fps = fps;
  }
  addEventListener('resize', resize);
  tg?.onEvent?.('viewportChanged', resize);

  app.setQuality = (q) => {
    app.quality = q;
    try { localStorage.setItem('openspace_quality', q); } catch {}
    app.surfaceView.applyQuality();
    makeComposer();
    resize();
  };

  app.canLand = () => !state.aboard && app.localView.mode === 'base' && !!SURFACES[state.presence];
  // Halo Station: drop into Earth's atmosphere below the station's real ground track
  app.canDescend = () => !state.aboard && app.localView.mode === 'base' && state.presence === 'earth';
  app.setMode = (m) => {
    if (m === 'surface' && !app.canLand()) return;
    if (m === 'earth' && app.mode !== 'earth') {
      if (!app.canDescend()) return;
      if (app.localView.cargoTotal()) app.localView.unload();
      const sp = EarthView.subPoint(app.localView.orbit.r, S.simNow(state));
      app.hud.flash();
      app.earthView.enter(sp.lat, sp.lon);
      app.hud.toast(`Atmospheric entry at ${Math.abs(sp.lat).toFixed(1)}°${sp.lat >= 0 ? 'N' : 'S'} ${Math.abs(sp.lon).toFixed(1)}°${sp.lon >= 0 ? 'E' : 'W'} · pick a destination`, 'good');
    }
    if (app.mode === 'surface' && m !== 'surface' && app.surfaceView.cargoTotal()) app.surfaceView.unload();
    if (m === 'surface' && app.mode !== 'surface') {
      app.hud.flash();
      app.surfaceView.setBase(state.presence);
    }
    app.mode = m;
    document.getElementById('labels').style.display = m === 'map' ? '' : 'none';
    if (m === 'map') app.mapView.focus(state.aboard && state.voyage ? 'fleet' : state.presence, 42);
    app.hud.syncNav();
  };

  app.selectBody = (id) => {
    app.mapView.select(id);
    app.hud.open(`body:${id}`);
  };

  const jump = (fn, text) => {
    app.hud.flash();
    haptic('heavy');
    setTimeout(() => {
      fn();
      app.setMode('local');
      if (text) app.hud.toast(text, 'good');
      app.save();
    }, 350);
  };
  // Neural uplink: your mind jumps to a base. If the fleet is in transit it keeps flying on autopilot.
  app.teleport = (id) => {
    if (!state.bases[id]) return;
    if (app.localView.mode === 'base' && app.localView.cargoTotal()) app.localView.unload();
    if (app.surfaceView.cargoTotal()) app.surfaceView.unload();
    jump(() => {
      state.presence = id;
      state.aboard = false;
      app.localView.setBase(id);
    }, `Neural uplink established · ${BODY[id].base}${state.voyage ? ' · fleet continues on autopilot' : ''}`);
  };
  app.rejoinFleet = () => {
    if (!state.voyage) return;
    if (app.localView.mode === 'base' && app.localView.cargoTotal()) app.localView.unload();
    jump(() => {
      state.aboard = true;
      app.localView.setVoyage();
    }, `Uplinked to your skiff · en route to ${BODY[state.voyage.to].name}`);
  };
  app.startVoyage = (to, escorts) => {
    if (app.localView.mode === 'base' && app.localView.cargoTotal()) app.localView.unload();
    S.startVoyage(state, to, escorts);
  };

  let lastCloud = 0;
  app.save = () => {
    const json = S.saveLocal(state);
    if (Date.now() - lastCloud > 30000) { lastCloud = Date.now(); cloudSave(json); }
  };
  app.resetGame = () => {
    S.wipeLocal();
    cloudWipe();
    app.save = () => {};
    location.reload();
  };

  S.onEvent((type, d) => {
    if (type === 'stationChanged' && d === state.presence && app.localView.mode === 'base') app.localView.rebuildStation();
    if (type === 'voyageStart' && state.aboard) jump(() => app.localView.setVoyage());
    if (type === 'voyageArrived' && d.aboard) jump(() => app.localView.setBase(state.presence));
    if (type === 'voyageArrived' && !d.aboard && app.mode === 'map') app.mapView.follow = d.to;
  });

  makeComposer();
  app.hud = new Hud(app);
  app.setMode('local');
  resize();
  progress(1, 'READY');
  if (!state.seenIntro) app.hud.showIntro();
  else if (away > 60000) app.hud.toast(`Welcome back. ${fmtDur(away)} passed · your drones kept working.`, 'good');

  addEventListener('visibilitychange', () => { if (document.hidden) { lastCloud = 0; app.save(); } });
  addEventListener('pagehide', () => app.save());

  const bootEl = document.getElementById('boot');
  bootEl.classList.add('done');
  setTimeout(() => bootEl.remove(), 700);

  let last = performance.now(), tickAcc = 0, saveAcc = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    tickAcc += dt;
    if (tickAcc >= 0.25) {
      tickAcc = 0;
      const t = S.simNow(state);
      let lt = state.lastTick;
      while (t - lt > 1) {
        const step = Math.min(60000, t - lt);
        lt += step;
        S.tick(state, step / 1000, lt);
      }
      state.lastTick = t;
    }
    saveAcc += dt;
    if (saveAcc > 10) { saveAcc = 0; app.save(); }

    const view = app.mode === 'local' ? app.localView : app.mode === 'surface' ? app.surfaceView : app.mode === 'earth' ? app.earthView : app.mapView;
    if (app.mode === 'map') view.update(dt, S.simNow(state));
    else view.update(dt, app.input);

    const q = QUALITY[app.quality];
    if (q.post) {
      renderPass.scene = view.scene;
      renderPass.camera = view.camera;
      lens.uniforms.uTime.value = now * 0.001 % 100;
      const sun = app.mode === 'local' ? app.localView.info.sun : null;
      lens.uniforms.uSun.value.set(sun ? sun.x / innerWidth : 0.5, sun ? 1 - sun.y / innerHeight : 0.5, sun ? sun.vis : 0);
      composer.render();
    } else renderer.render(view.scene, view.camera);
    if (app.mode === 'map') labels.render(view.scene, view.camera);
    app.hud.frame(dt);
    adapt(dt);
  }
  requestAnimationFrame(frame);
  window.__app = app;
}

boot().catch((e) => {
  console.error(e);
  const b = document.getElementById('boot-sub');
  if (b) b.textContent = `BOOT FAILURE: ${e.message}`;
});
