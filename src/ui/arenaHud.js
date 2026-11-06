import * as THREE from 'three';

// Arena overlay for the surface view: frame integrity / thruster bars, wave + score, combo counter with a style
// rank, centre banners (WAVE 2, PARRY, FRAME DOWN), a red damage vignette, and a bracket over every hostile frame
// (bigger on the lock-on target, orange / red while it winds up an attack, pinned to the screen edge when the
// attacker is off screen). Outside a battle it marks the arena and offers START BATTLE once you stand on the grid.
// Every node is created once; per-frame work is transforms and text that only changes when the value does.

const SEGS = 12;
const _p = new THREE.Vector3();
const RANK_COLOR = { D: '#9aa4b0', C: '#7fd0ff', B: '#7dffb0', A: '#ffd84a', S: '#ff9a3a', SS: '#ff5a3a', SSS: '#ff3a8a' };

export class ArenaHud {
  constructor(root) {
    const el = (this.el = document.createElement('div'));
    el.className = 'arena-hud';
    el.innerHTML = `
      <div class="ah-panel">
        <div class="ah-hp">${'<i></i>'.repeat(SEGS)}</div>
        <div class="ah-jet"><i></i></div>
        <div class="ah-stats"><b class="ah-wave"></b><span class="ah-kills"></span><span class="ah-score"></span></div>
      </div>
      <div class="ah-combo"><b></b><span>HITS</span><em></em></div>
      <div class="ah-tags"></div>
      <div class="ah-banner"><b></b><small></small></div>
      <div class="ah-vig"></div>
      <div class="ah-beacon"><i></i><span></span></div>
      <button class="ah-start" data-act="arena"></button>
      <div class="ah-keys"></div>`;
    root.appendChild(el);
    this.q = (s) => el.querySelector(s);
    this.hpSegs = [...el.querySelectorAll('.ah-hp i')];
    this.tags = [];
    this.cache = {};
  }

  set(key, node, html) {
    if (this.cache[key] === html) return;
    this.cache[key] = html;
    node.innerHTML = html;
  }

  tag(i) {
    while (this.tags.length <= i) {
      const t = document.createElement('div');
      t.className = 'ah-tag';
      t.innerHTML = '<i></i><i></i><i></i><i></i><div class="ah-tbar"><u></u></div><s>!</s>';
      this.q('.ah-tags').appendChild(t);
      this.tags.push({ el: t, bar: t.querySelector('u'), cls: '' });
    }
    return this.tags[i];
  }

  hide() { this.el.style.display = 'none'; this.shown = false; }

  update(view, keyboard) {
    const info = view.info.arena;
    if (!info) { if (this.shown !== false) this.hide(); return; }
    if (!this.shown) { this.el.style.display = ''; this.shown = true; }
    const P = view.pilot, cam = view.camera, W = innerWidth, H = innerHeight;
    const fight = info.state !== 'idle';
    this.el.classList.toggle('on', fight);

    // ---- panel ----
    if (fight) {
      const hp = Math.max(0, P.hp) / 100;
      const lit = Math.ceil(hp * SEGS - 0.001);
      if (this.cache.hp !== lit) {
        this.cache.hp = lit;
        this.hpSegs.forEach((s, i) => { s.className = i < lit ? (hp < 0.3 ? 'low' : '') : 'off'; });
      }
      this.q('.ah-jet i').style.width = `${P.fuel.toFixed(0)}%`;
      this.set('wave', this.q('.ah-wave'), `WAVE ${info.wave}`);
      this.set('kills', this.q('.ah-kills'), `${info.kills} KILLS`);
      this.set('score', this.q('.ah-score'), `${Math.round(info.score).toLocaleString()} PTS`);
    }

    // ---- combo ----
    const combo = this.q('.ah-combo');
    const showCombo = fight && info.combo >= 2;
    combo.style.opacity = showCombo ? 1 : 0;
    if (showCombo) {
      this.set('combo', combo.querySelector('b'), String(info.combo));
      this.set('rank', combo.querySelector('em'), info.rank);
      combo.style.setProperty('--rk', RANK_COLOR[info.rank] || '#fff');
    }

    // ---- banner ----
    const bn = this.q('.ah-banner');
    if (info.bannerT > 0 && info.banner) {
      this.set('bt', bn.querySelector('b'), info.banner);
      this.set('bs', bn.querySelector('small'), info.sub || '');
      bn.style.opacity = Math.min(1, info.bannerT * 3);
      bn.classList.toggle('bad', info.banner === 'FRAME DOWN');
    } else bn.style.opacity = 0;

    this.q('.ah-vig').style.opacity = Math.min(1, info.flash * 0.9 + (fight && P.hp < 25 ? 0.25 + 0.15 * Math.sin(performance.now() / 160) : 0));

    // ---- enemy brackets ----
    let n = 0;
    if (fight && info.enemies) {
      for (const e of info.enemies) {
        if (!e.alive) continue;
        _p.copy(e.pos); _p.y += e.height + 0.8;
        _p.project(cam);
        const behind = _p.z > 1;
        let x = (_p.x * 0.5 + 0.5) * W, y = (-_p.y * 0.5 + 0.5) * H;
        const tele = e.telegraph;
        const off = behind || x < 0 || x > W || y < 0 || y > H;
        if (off && !tele) continue;                 // only warn about off-screen enemies that are attacking
        if (off) {
          // pin to the edge in the enemy's direction
          if (behind) { x = W - x; y = H - y; }
          const cx = W / 2, cy = H / 2, dx = x - cx, dy = y - cy;
          const k = Math.min((W / 2 - 40) / Math.abs(dx || 1), (H / 2 - 60) / Math.abs(dy || 1));
          x = cx + dx * k; y = cy + dy * k;
        }
        const t = this.tag(n++);
        const cls = `ah-tag${e === info.lock ? ' lock' : ''}${tele === 'red' ? ' red' : tele ? ' warn' : ''}${off ? ' edge' : ''}`;
        if (t.cls !== cls) { t.cls = cls; t.el.className = cls; }
        t.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
        t.bar.style.width = `${Math.max(0, e.hp / e.maxHp * 100).toFixed(0)}%`;
        t.el.style.display = '';
      }
    }
    for (let i = n; i < this.tags.length; i++) this.tags[i].el.style.display = 'none';

    // ---- beacon + start ----
    const st = this.q('.ah-start'), bc = this.q('.ah-beacon');
    const canStart = !fight && info.inside && P.alive;
    st.style.display = canStart ? '' : 'none';
    if (canStart) this.set('start', st, `⚔ START BATTLE${keyboard ? ' <small>ENTER</small>' : ''}<em>${info.best ? `best: wave ${info.best}` : 'waves of hostile frames · credits per wave'}</em>`);
    if (!fight && !info.inside && info.dist < 900) {
      _p.copy(view.arena.center); _p.y += 14;
      _p.project(cam);
      let x = (_p.x * 0.5 + 0.5) * W, y = (-_p.y * 0.5 + 0.5) * H;
      if (_p.z > 1) { x = W - x; y = H * 0.85; }
      x = Math.max(70, Math.min(W - 70, x)); y = Math.max(110, Math.min(H - 170, y));
      bc.style.display = '';
      bc.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      this.set('bd', bc.querySelector('span'), `MECH ARENA · ${Math.round(info.dist - view.arena.R)} m`);
    } else bc.style.display = 'none';

    const keys = this.q('.ah-keys');
    keys.style.display = fight && keyboard ? '' : 'none';
    if (fight && keyboard) this.set('keys', keys, 'J slash · K heavy · L launcher · Q arc · F guard / parry · E dodge · Tab lock · Space jump');
  }
}
