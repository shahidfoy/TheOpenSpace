// Touch: left virtual joystick moves, drag anywhere else on the canvas to steer, hold buttons.
// Desktop: WASD move, mouse-drag / arrows steer, R/F up/down (jetpack on foot), Shift boost/sprint, Space mine.
// Surface mech: Space jump (again in the air = double jump, hold = fly up; Shift in the air = rocket boost).
// Fighting (mech and characters, the Daywalker kit): click / J attack (hold to keep going), R / middle-click swap sword and
// shotgun, E dash, F / right-click hold block (press just before a hit to parry), K / C awakening, Q ultimate, L launcher.
// Arena: Tab switch lock-on, Enter start a battle.
export function createInput(app) {
  const keys = {};
  const joy = { x: 0, y: 0, id: null };
  const held = { up: false, down: false, boost: false, mine: false };
  const look = { x: 0, y: 0 };
  let zoom = 1; // camera distance factor gathered from the wheel / pinch since the last sample
  const out = { move: { x: 0, y: 0 }, lift: 0, lookX: 0, lookY: 0, mine: false, boost: false, zoom: 1, jump: false, slashHold: false, attack: 0, heavy: 0, spin: 0, guard: false, dodge: 0, launch: 0, lockSwitch: 0, arena: 0, swap: 0, rage: 0, attackHold: false };
  const taps = { attack: 0, heavy: 0, spin: 0, dodge: 0, launch: 0, lock: 0, arena: 0, swap: 0, rage: 0 }; // edge-triggered presses since the last sample
  let prevDown = false, prevArc = false, prevDodge = false, prevLaunch = false;

  addEventListener('keydown', (e) => {
    if (e.target.closest?.('input,textarea')) return;
    if (!e.repeat) {
      if (e.code === 'KeyJ') taps.attack++;
      else if (e.code === 'KeyK') taps.heavy++;
      else if (e.code === 'KeyQ') taps.spin++;
      else if (e.code === 'KeyE') taps.dodge++;
      else if (e.code === 'KeyL') taps.launch++;
      else if (e.code === 'KeyR') taps.swap++;
      else if (e.code === 'KeyC') taps.rage++;
      else if (e.code === 'Tab' && (app.mode === 'surface' || app.mode === 'ship')) taps.lock++;
      else if (e.code === 'Enter' && (app.mode === 'surface' || app.mode === 'ship')) taps.arena++;
    }
    if (e.code === 'Tab' && (app.mode === 'surface' || app.mode === 'ship')) e.preventDefault();
    keys[e.code] = true;
    if (e.code === 'Space' && app.mode !== 'map') e.preventDefault();
  });
  addEventListener('keyup', (e) => { keys[e.code] = false; });
  addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

  const canvas = app.renderer.domElement;
  const drags = new Map();
  canvas.addEventListener('pointerdown', (e) => {
    if (app.mode === 'map') return;
    drags.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now(), button: e.button, mouse: e.pointerType === 'mouse', still: true });
    canvas.setPointerCapture?.(e.pointerId);
  });
  const spread = () => { const [a, b] = [...drags.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  canvas.addEventListener('pointermove', (e) => {
    const p = drags.get(e.pointerId);
    if (!p) return;
    if (drags.size === 2) {
      // two fingers: pinch to zoom the camera in and out
      const d0 = spread();
      p.x = e.clientX; p.y = e.clientY;
      const d1 = spread();
      if (d0 > 10 && d1 > 10) zoom *= d0 / d1;
      return;
    }
    look.x += e.clientX - p.x;
    look.y += e.clientY - p.y;
    if (Math.hypot(e.clientX - p.x0, e.clientY - p.y0) > 8) p.still = false;
    p.x = e.clientX; p.y = e.clientY;
  });
  canvas.addEventListener('wheel', (e) => {
    if (app.mode === 'map') return; // the map has its own zoom
    e.preventDefault();
    zoom *= Math.exp(e.deltaY * 0.0012);
  }, { passive: false });
  const end = (e) => drags.delete(e.pointerId);
  canvas.addEventListener('pointerup', (e) => {
    // a quick mouse click (not a drag) on the surface: left = attack, middle = swap weapons (right is held: block)
    const p = drags.get(e.pointerId);
    if (p && e.pointerType === 'mouse' && (app.mode === 'surface' || app.mode === 'ship') && Math.hypot(e.clientX - p.x0, e.clientY - p.y0) < 6 && performance.now() - p.t0 < 350) {
      if (p.button === 1) taps.swap++;
      else if (p.button === 0) taps.attack++;
    }
    end(e);
  });
  canvas.addEventListener('contextmenu', (e) => { if (app.mode === 'surface' || app.mode === 'ship') e.preventDefault(); });
  canvas.addEventListener('auxclick', (e) => { if (app.mode === 'surface' && e.button === 1) e.preventDefault(); });
  canvas.addEventListener('mousedown', (e) => { if (app.mode === 'surface' && e.button === 1) e.preventDefault(); });   // no autoscroll
  canvas.addEventListener('pointercancel', end);

  function bindJoystick(base, knob) {
    // travel = 37% of the stick's on-screen size (it shrinks on small phones)
    let R = 46;
    const set = (e) => {
      const r = base.getBoundingClientRect();
      R = r.width * 0.37;
      let dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
      const l = Math.hypot(dx, dy);
      if (l > R) { dx *= R / l; dy *= R / l; }
      joy.x = dx / R; joy.y = -dy / R;
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
    };
    base.addEventListener('pointerdown', (e) => { joy.id = e.pointerId; base.setPointerCapture(e.pointerId); set(e); });
    base.addEventListener('pointermove', (e) => { if (e.pointerId === joy.id) set(e); });
    const release = (e) => {
      if (e.pointerId !== joy.id) return;
      joy.id = null; joy.x = joy.y = 0;
      knob.style.transform = '';
    };
    base.addEventListener('pointerup', release);
    base.addEventListener('pointercancel', release);
  }

  function bindHold(el, name) {
    const on = (e) => { e.preventDefault(); held[name] = true; el.classList.add('on'); el.setPointerCapture?.(e.pointerId); };
    const off = () => { held[name] = false; el.classList.remove('on'); };
    el.addEventListener('pointerdown', on);
    el.addEventListener('pointerup', off);
    el.addEventListener('pointercancel', off);
    el.addEventListener('lostpointercapture', off);
  }

  function sample(dt) {
    const k = (c) => (keys[c] ? 1 : 0);
    const clamp = (v) => Math.max(-1, Math.min(1, v));
    out.move.x = clamp(joy.x + k('KeyD') - k('KeyA'));
    out.move.y = clamp(joy.y + k('KeyW') - k('KeyS'));
    out.lift = clamp((held.up ? 1 : 0) - (held.down ? 1 : 0) + k('KeyR') + k('KeyE') - k('KeyF') - k('KeyQ'));
    out.lookX = look.x + (k('ArrowRight') - k('ArrowLeft')) * 320 * dt;
    out.lookY = look.y + (k('ArrowDown') - k('ArrowUp')) * 260 * dt;
    look.x = look.y = 0;
    out.zoom = zoom;
    zoom = 1;
    out.mine = held.mine || !!keys.Space;
    out.boost = held.boost || !!keys.ShiftLeft || !!keys.ShiftRight;
    out.jump = held.up || !!keys.Space;
    out.slashHold = held.mine;
    // primary held: J, the attack button, or the left mouse button held still (a drag steers the camera instead)
    let lmb = false;
    const nowT = performance.now();
    for (const d of drags.values()) if (d.mouse && d.button === 0 && d.still && nowT - d.t0 > 240) lmb = true;
    out.attackHold = !!keys.KeyJ || held.mine || lmb;
    out.attack = taps.attack;
    out.heavy = taps.heavy + (held.down && !prevDown ? 1 : 0);
    out.spin = taps.spin + (held.arc && !prevArc ? 1 : 0);
    // block: F, the BLOCK button, or the right mouse button held
    let rmb = false;
    for (const d of drags.values()) if (d.mouse && d.button === 2) rmb = true;
    out.guard = !!held.guard || !!keys.KeyF || rmb;
    out.heavyHold = false;
    out.swap = taps.swap + (held.launch && !prevLaunch ? 1 : 0);
    out.rage = taps.rage;
    out.dodge = taps.dodge + (held.dodge && !prevDodge ? 1 : 0);
    out.launch = taps.launch;
    out.lockSwitch = taps.lock;
    out.arena = taps.arena;
    prevDown = held.down;
    prevArc = held.arc;
    prevDodge = held.dodge;
    prevLaunch = held.launch;
    taps.attack = taps.heavy = taps.spin = taps.dodge = taps.launch = taps.lock = taps.arena = taps.swap = taps.rage = 0;
    return out;
  }

  return { bindJoystick, bindHold, sample };
}
