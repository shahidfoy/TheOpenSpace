// Touch: left virtual joystick moves, drag anywhere else on the canvas to steer, hold buttons.
// Desktop: WASD move, mouse-drag / arrows steer, R/F up/down (jetpack on foot), Shift boost/sprint, Space mine/drill.
export function createInput(app) {
  const keys = {};
  const joy = { x: 0, y: 0, id: null };
  const held = { up: false, down: false, boost: false, mine: false };
  const look = { x: 0, y: 0 };
  const out = { move: { x: 0, y: 0 }, lift: 0, lookX: 0, lookY: 0, mine: false, boost: false };

  addEventListener('keydown', (e) => {
    if (e.target.closest?.('input,textarea')) return;
    keys[e.code] = true;
    if (e.code === 'Space' && app.mode !== 'map') e.preventDefault();
  });
  addEventListener('keyup', (e) => { keys[e.code] = false; });
  addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

  const canvas = app.renderer.domElement;
  const drags = new Map();
  canvas.addEventListener('pointerdown', (e) => {
    if (app.mode === 'map') return;
    drags.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.setPointerCapture?.(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = drags.get(e.pointerId);
    if (!p) return;
    look.x += e.clientX - p.x;
    look.y += e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
  });
  const end = (e) => drags.delete(e.pointerId);
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  function bindJoystick(base, knob) {
    const R = 46;
    const set = (e) => {
      const r = base.getBoundingClientRect();
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
    out.mine = held.mine || !!keys.Space;
    out.boost = held.boost || !!keys.ShiftLeft || !!keys.ShiftRight;
    return out;
  }

  return { bindJoystick, bindHold, sample };
}
