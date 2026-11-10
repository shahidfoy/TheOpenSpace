import { KIT } from '../render/chars/bladeKit.js';

// The Daywalker kit's readout (see render/chars/bladeKit.js): the weapon in hand with its shells, and the three
// abilities with their cooldowns and charge. Shared by the training sim (character and mech) and the surface arena.
export class KitHud {
  constructor(parent) {
    const el = (this.el = document.createElement('div'));
    el.className = 'kit-hud'; el.hidden = true;
    el.innerHTML = `
      <div class="kit-chip kit-weapon"><kbd>R</kbd><b></b><span class="kit-shells">${'<i></i>'.repeat(KIT.mag)}</span></div>
      <div class="kit-chip kit-dash"><kbd>E</kbd><b>DASH</b><em></em></div>
      <div class="kit-chip kit-rage"><kbd>K</kbd><b>AWAKEN</b><em></em></div>
      <div class="kit-chip kit-ult"><kbd>Q</kbd><b>ULT</b><em></em></div>`;
    parent.appendChild(el);
    const q = (s) => el.querySelector(s);
    this.$weapon = q('.kit-weapon'); this.$wName = q('.kit-weapon b'); this.$shells = [...el.querySelectorAll('.kit-shells i')];
    this.$dash = q('.kit-dash'); this.$rage = q('.kit-rage'); this.$ult = q('.kit-ult');
    this.last = {};
  }
  set(key, v, fn) { if (this.last[key] !== v) { this.last[key] = v; fn(v); } }
  // fill: 0..1 of the chip's bar; text: the small readout
  chip(key, $c, fill, text, state) {
    this.set(key + 'f', Math.round(fill * 50), () => $c.style.setProperty('--fill', `${Math.round(fill * 100)}%`));
    this.set(key + 't', text, (t) => { $c.querySelector('em').textContent = t; });
    this.set(key + 's', state, (s) => { $c.dataset.state = s; });
  }
  update(K) {
    if (!K) { if (!this.el.hidden) this.el.hidden = true; return; }
    if (this.el.hidden) this.el.hidden = false;
    this.set('w', K.weapon, (w) => { this.$wName.textContent = w === 'gun' ? 'SHOTGUN' : 'SWORD'; this.$weapon.dataset.w = w; });
    const shells = K.reload > 0 ? -1 : K.ammo;
    this.set('a', shells, (n) => {
      this.$weapon.classList.toggle('reload', n < 0);
      this.$shells.forEach((s, i) => s.classList.toggle('on', i < n));
    });
    const sec = (t) => (t > 0.05 ? `${t.toFixed(t < 9.95 ? 1 : 0)}s` : '');
    // dash: its charges, and the next one coming back
    const full = K.dashes >= KIT.dashN;
    this.chip('d', this.$dash, full ? 1 : 1 - K.dashCd / KIT.dashCd, '●'.repeat(K.dashes) + '○'.repeat(KIT.dashN - K.dashes) + (full ? '' : ' ' + sec(K.dashCd)), K.dashes > 0 ? 'ready' : 'cd');
    // awakening: the stance and its meter
    this.chip('r', this.$rage, K.meter, K.stance ? (K.whirl ? 'WHIRL' : `${Math.round(K.meter * 100)}%`) : K.meter > 0.01 ? `${Math.round(K.meter * 100)}%` : '', K.stance ? 'on' : 'ready');
    this.chip('u', this.$ult, K.ult, K.aiming ? 'CONFIRM' : K.ult >= 1 ? '' : `${Math.floor(K.ult * 100)}%`, K.ult >= 1 ? 'ready' : 'cd');
  }
}
