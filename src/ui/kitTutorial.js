import { KIT } from '../render/chars/bladeKit.js';

// The training sim's guided tour of the Daywalker kit (render/chars/bladeKit.js). One ability per step: what it
// does, the keys, and a task that proves it was used, read from the kit's own counters (kit.used). The same steps
// serve the characters and the mech. Finished or skipped, it stays out of the way until restarted.

const DONE_KEY = 'openspace_kit_tutorial';
// [title, what it does, keyboard keys, touch buttons, task, counter, count]
const STEPS = [
  ['ANCESTRAL SWORD', 'Your blade. Keep attacking to chain five slashes; the last one hits hardest.',
    'Hold <kbd>J</kbd> or <kbd>click</kbd>', 'Hold <kbd>ATTACK</kbd>', 'Land the full five-hit chain on a target', 'finisher', 1],
  ['HUNTER\'S SHOTGUN', 'Swap to the shotgun for range and aim with the crosshair. Six shells, strongest up close; it reloads on its own.',
    '<kbd>wheel</kbd> / <kbd>R</kbd> swap · <kbd>click</kbd> fire · hold <kbd>right-click</kbd> to aim', '<kbd>SWAP</kbd> then <kbd>ATTACK</kbd>', 'Hit a target with three blasts', 'gunHit', 3],
  ['DAYWALKER DASH · SWORD', 'Two charges. With the sword out the dash ends in a cleaving strike that slows whatever it cuts.',
    '<kbd>R</kbd> to the sword · <kbd>E</kbd> dash', '<kbd>SWAP</kbd> to the sword · <kbd>DASH</kbd>', 'Dash through a target with the sword', 'dashSword', 1],
  ['DAYWALKER DASH · SHOTGUN', 'With the shotgun out the dash ends in a wide blast that leaves targets wounded: they take more damage for a while.',
    '<kbd>R</kbd> to the shotgun · <kbd>E</kbd> dash', '<kbd>SWAP</kbd> to the shotgun · <kbd>DASH</kbd>', 'Dash with the shotgun out', 'dashGun', 1],
  ['DASH UPWARD', 'Hold jump as you dash and it carries you into the air: onto ledges, or over a fight.',
    'Hold <kbd>Space</kbd> + <kbd>E</kbd>', 'Hold <kbd>▲</kbd> + <kbd>DASH</kbd>', 'Dash upward once', 'dashUp', 1],
  ['SCARLET SHROUD', 'Block with the sword. It takes most of a blow from the front, and every blow it takes brings your dash back sooner. You can still walk.',
    'Hold <kbd>F</kbd> or <kbd>right-click</kbd>', 'Hold <kbd>BLOCK</kbd>', 'Raise the block', 'block', 1],
  ['BLOODLINE AWAKENING', 'A sword stance. Every hit fills the meter and speeds your cuts up, until the chain becomes a whirlwind; hits steal life. Drawing the shotgun drops the stance.',
    '<kbd>K</kbd> or <kbd>C</kbd> to enter · keep attacking', '<kbd>AWAKEN</kbd> · hold <kbd>ATTACK</kbd>', 'Fill the meter until the whirlwind starts', 'whirlCut', 1],
  ['THOUSAND-FOLD SLASH', 'The ultimate, charged by dealing damage. Lay a path on the ground, confirm, and you dash down it; the path is then cut to ribbons while you fight on.',
    '<kbd>Q</kbd> to aim · <kbd>J</kbd> / <kbd>click</kbd> to confirm', '<kbd>ULT</kbd> to aim · <kbd>ATTACK</kbd> to confirm', 'Unleash it across the targets', 'ult', 1],
];

export class KitTutorial {
  constructor(parent) {
    const el = (this.el = document.createElement('div'));
    el.className = 'kit-tut'; el.hidden = true;
    el.innerHTML = `
      <div class="kt-head"><span class="kt-step"></span><b class="kt-title"></b><button class="kt-skip">SKIP STEP</button></div>
      <p class="kt-text"></p>
      <div class="kt-keys"></div>
      <div class="kt-task"><i></i><span></span><em></em></div>
      <div class="kt-dots"></div>`;
    parent.appendChild(el);
    const again = (this.again = document.createElement('button'));
    again.className = 'kit-tut-again'; again.hidden = true; again.textContent = '↻ ABILITY TUTORIAL';
    parent.appendChild(again);
    this.q = (s) => el.querySelector(s);
    this.q('.kt-skip').addEventListener('click', () => this.next());
    again.addEventListener('click', () => this.restart());
    this.q('.kt-dots').innerHTML = STEPS.map(() => '<i></i>').join('');
    let done = false;
    try { done = localStorage.getItem(DONE_KEY) === '1'; } catch { /* private mode */ }
    this.i = done ? STEPS.length : 0;
    this.base = null; this.shown = -2; this.flashT = 0; this.kit = null;
  }
  restart() { this.i = 0; this.base = null; this.shown = -2; try { localStorage.removeItem(DONE_KEY); } catch { /* ignore */ } }
  next() {
    this.i++; this.base = null;
    if (this.i >= STEPS.length) { try { localStorage.setItem(DONE_KEY, '1'); } catch { /* ignore */ } }
  }
  // kit: the BladeKit in play (null hides everything)
  update(kit, keyboard = true) {
    if (!kit) { this.el.hidden = true; this.again.hidden = true; this.kit = null; return; }
    if (kit !== this.kit) { this.kit = kit; this.base = null; }
    const over = this.i >= STEPS.length;
    this.el.hidden = over; this.again.hidden = !over;
    if (over) return;
    const st = STEPS[this.i], [title, text, keys, touch, task, key, need] = st;
    if (!this.base) {
      this.base = { ...kit.used };
      // each step starts with what it needs in hand
      if (key === 'ult') kit.ult = 1;
      if (key.startsWith('dash')) { kit.dashes = KIT.dashN; kit.dashCd = 0; }
    }
    const n = Math.min(need, (kit.used[key] || 0) - (this.base[key] || 0));
    const sig = `${this.i}|${keyboard}`;
    if (this.shown !== sig) {
      this.shown = sig;
      this.q('.kt-step').textContent = `TUTORIAL ${this.i + 1}/${STEPS.length}`;
      this.q('.kt-title').textContent = title;
      this.q('.kt-text').textContent = text;
      this.q('.kt-keys').innerHTML = keyboard ? keys : touch;
      this.q('.kt-task span').textContent = task;
      this.q('.kt-dots').querySelectorAll('i').forEach((d, k) => { d.className = k < this.i ? 'done' : k === this.i ? 'on' : ''; });
      this.el.classList.remove('ok');
      this.lastN = -1;
    }
    if (n !== this.lastN) {
      this.lastN = n;
      this.q('.kt-task em').textContent = need > 1 ? `${n}/${need}` : '';
      if (n >= need) { this.el.classList.add('ok'); this.doneAt = performance.now(); }
    }
    // a beat to read the tick, then on to the next ability
    if (n >= need && performance.now() - this.doneAt > 1100) this.next();
  }
}
