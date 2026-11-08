import { stripToolMarkup } from './note-text.mjs';
import { displayName } from './theme/display-name.mjs';
// HTML overlay: player panels, clock, speed control, kill feed, minimap, end banner.
const $ = (s) => document.querySelector(s);
const fmtClock = (t) => {
  const s = Math.floor(t / 10);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const num = (n) => (n >= 10000 ? (n / 1000).toFixed(1) + 'k' : String(Math.round(n)));
// tok/s measurement source on the player card: stream (streamed token timing), server (the server's own figure), wall (total latency, a lower bound)
export const srcName = (s) => (!s ? '-' : /^stream/.test(s) ? 'stream' : /^server/.test(s) ? 'server' : /^wall/.test(s) ? 'wall' : String(s));
// invalid orders by cause, only the causes that happened: "resources 2 · target 1"
export const invalidSplit = (by) => (by ? ['resources', 'target', 'args', 'other', 'parse'].filter((k) => by[k] > 0).map((k) => `${k} ${by[k]}`).join(' · ') : '');
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

export class Hud {
  constructor(handlers) {
    this.h = handlers;
    this.cache = {};
    this.feed = $('#feed');
    this.feedItems = [];
    for (const b of document.querySelectorAll('#speed button')) {
      b.addEventListener('click', () => handlers.onSpeed(b.dataset.x));
    }
    const mini = $('#mini');
    const go = (e) => {
      const r = $('#minimap').getBoundingClientRect();
      handlers.onMinimap((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    };
    let down = false;
    mini.addEventListener('pointerdown', (e) => { down = true; go(e); });
    window.addEventListener('pointermove', (e) => { if (down) go(e); });
    window.addEventListener('pointerup', () => { down = false; });
  }

  init(init) {
    this.init_ = init;
    this.players = init.players;
    $('#mode').textContent = init.mode === 'replay' ? 'replay' : 'live';
    $('#seed').textContent = `seed ${init.seed}`;
    this.panels = init.players.map((p, i) => {
      const el = $(`#panel-${i}`) || this.extraPanel(i);
      el.style.setProperty('--tc', p.color);
      const cr = p.creator && init.creators ? init.creators[p.creator] : null; // recipe maker (cosmetic)
      const crHtml = cr ? `<div class="creator" style="--cc:${esc(cr.primary)};--cc2:${esc(cr.secondary)}"><img src="${esc(cr.logo)}" alt=""><span>recipe by <b>${esc(cr.name)}</b></span></div>` : '';
      el.innerHTML = `
        <div class="ph"><div class="pname">${esc(p.name)}</div><div class="tier"></div></div>${crHtml}
        <div class="model">${esc(p.model)}</div><div class="hw">${esc(p.hw)}</div>
        <div class="res">
          <div class="r food"><span><i></i>food</span><b>0</b></div><div class="r wood"><span><i></i>wood</span><b>0</b></div>
          <div class="r stone"><span><i></i>stone</span><b>0</b></div><div class="r gold"><span><i></i>gold</span><b>0</b></div>
        </div>
        <div class="pop"><span>POP</span><div class="bar"><i></i></div><span class="popn">0/0</span></div>
        <div class="stats"><div>Army value<b class="army">0</b></div><div>Workers<b class="wk">0</b></div><div>Kills<b class="kills">0</b></div><div>Score<b class="score">0</b></div></div>
        <div class="last feed4"><div class="fl old"><em>doing</em> -</div></div>
        <div class="kv"><span>think <b class="lat">-</b></span><span>tok/s <b class="toks">-</b></span><span>orders <b class="ord">0</b></span></div>
        <div class="kv2 off"><span>tok/s from <b class="tsrc">-</b></span><span>empty <b class="emp">0</b></span><span>invalid <b class="inv">0</b></span></div><div class="invby off"></div>
        <div class="chips"></div><div class="thought empty">no thought yet</div>`;
      return {
        el, tier: el.querySelector('.tier'), res: [...el.querySelectorAll('.r b')], popn: el.querySelector('.popn'), bar: el.querySelector('.bar i'),
        army: el.querySelector('.army'), wk: el.querySelector('.wk'), kills: el.querySelector('.kills'), score: el.querySelector('.score'),
        last: el.querySelector('.last'), lat: el.querySelector('.lat'), toks: el.querySelector('.toks'), ord: el.querySelector('.ord'), kv2: el.querySelector('.kv2'), tsrc: el.querySelector('.tsrc'), emp: el.querySelector('.emp'), inv: el.querySelector('.inv'), invby: el.querySelector('.invby'), thought: el.querySelector('.thought'), chips: el.querySelector('.chips'),
      };
    });
    this.setTier = (i, tier, adv) => {
      const key = `tier${i}`;
      const v = `${tier}/${adv}`;
      if (this.cache[key] === v) return;
      this.cache[key] = v;
      this.panels[i].tier.innerHTML = `TIER ${tier} ` + [1, 2, 3].map((n) => `<i class="${n <= tier ? 'on' : n === adv ? 'adv' : ''}"></i>`).join('');
    };
  }

  extraPanel(i) {
    const el = document.createElement('section');
    el.className = 'panel' + (i % 2 ? ' right' : '');
    el.id = `panel-${i}`;
    el.style.top = `${14 + 392 * Math.floor(i / 2)}px`;
    $('#hud').appendChild(el);
    return el;
  }

  set(el, key, v, fn) {
    if (this.cache[key] === v) return;
    this.cache[key] = v;
    fn(el, v);
  }

  update(s, names) {
    $('#clock').textContent = fmtClock(s.t);
    this.victory(s.vic);
    for (const b of document.querySelectorAll('#speed button')) {
      const x = b.dataset.x;
      b.classList.toggle('on', x === 'pause' ? s.paused : !s.paused && +x === s.speed);
    }
    s.players.forEach((p, i) => {
      const P = this.panels[i];
      if (!P) return;
      P.el.classList.toggle('dead', !p.alive);
      this.setTier(i, p.tier, p.adv);
      ['food', 'wood', 'stone', 'gold'].forEach((r, k) => this.set(P.res[k], `r${i}${k}`, Math.floor(p.res[r]), (e, v) => (e.textContent = num(v))));
      this.set(P.popn, `pop${i}`, `${p.pop}/${p.cap}`, (e, v) => (e.textContent = v));
      this.set(P.bar, `bar${i}`, Math.min(100, Math.round((100 * p.pop) / Math.max(1, p.cap))), (e, v) => (e.style.width = v + '%'));
      this.set(P.army, `a${i}`, p.army, (e, v) => (e.textContent = num(v)));
      this.set(P.wk, `w${i}`, p.workers, (e, v) => (e.textContent = v));
      this.set(P.kills, `k${i}`, p.kills, (e, v) => (e.textContent = v));
      this.set(P.score, `sc${i}`, p.score, (e, v) => (e.textContent = num(v)));
      const fd = (p.feed && p.feed.length ? p.feed : p.lastCmd ? [{ text: p.lastCmd, age: p.lastCmdAge }] : []).slice(-4);
      const last = fd.length ? fd.map((l, k) => `<div class="fl${k === fd.length - 1 ? ' new' : ''}${l.kind ? ' k-' + esc(l.kind) : ''}">${esc(l.text)}<em>${l.age ?? ''}${l.age != null ? 's' : ''}</em></div>`).join('') : '<div class="fl old"><em>doing</em> -</div>';
      this.set(P.last, `l${i}`, last, (e, v) => (e.innerHTML = v));
      this.set(P.lat, `lat${i}`, p.latency == null ? '-' : p.latency < 10 ? p.latency.toFixed(1) + ' ms' : p.latency < 1000 ? Math.round(p.latency) + ' ms' : (p.latency / 1000).toFixed(1) + ' s', (e, v) => (e.textContent = v));
      this.set(P.toks, `tk${i}`, p.tokS == null ? '-' : p.tokS.toFixed(1), (e, v) => (e.textContent = v));
      this.set(P.ord, `o${i}`, p.cmds, (e, v) => (e.textContent = v));
      // LLM players only: where the tok/s figure comes from, empty replies, invalid orders by cause (a scripted bot has none of these)
      const llm = !!(p.invalidBy || p.tokSrc);
      this.set(P.kv2, `kv2${i}`, llm, (e, v) => e.classList.toggle('off', !v));
      if (llm) {
        this.set(P.tsrc, `ts${i}`, srcName(p.tokSrc), (e, v) => (e.textContent = v));
        this.set(P.emp, `em${i}`, p.empty ?? 0, (e, v) => (e.textContent = v));
        this.set(P.inv, `iv${i}`, p.invalid ?? 0, (e, v) => (e.textContent = v));
        const split = invalidSplit(p.invalidBy);
        this.set(P.invby, `ib${i}`, split, (e, v) => { e.textContent = v; e.classList.toggle('off', !v); });
      }
      const chips = (p.standing || []).join('|');
      this.set(P.chips, `ch${i}`, chips, (e, v) => { e.innerHTML = v ? v.split('|').map((c) => `<span>${esc(c)}</span>`).join('') : ''; });
      const th = stripToolMarkup(p.thought).slice(0, 120);
      this.set(P.thought, `th${i}`, th, (e, v) => { e.textContent = v ? `“${v}”` : 'no thought yet'; e.classList.toggle('empty', !v); });
    });
  }

  // wonder countdowns and shrine victory points (s.vic from the sim, see Game.victoryView)
  victory(v) {
    const el = $('#vic');
    if (!el) return;
    if (!v) { el.style.display = 'none'; return; }
    const tc = (team) => this.players.find((p) => p.team === team) || this.players[team - 1];
    const nmt = (team) => esc(tc(team)?.name || 'Team ' + team);
    let h = '';
    for (const w of v.wonders || []) {
      if (w.secs_left == null) { if (w.built === false) h += `<div class="vbox"><b style="color:${tc(w.team)?.color}">${nmt(w.team)} building a wonder</b></div>`; continue; }
      const f = Math.max(0, Math.min(100, (100 * w.secs_left) / w.total));
      h += `<div class="vbox wond${w.secs_left <= 60 ? ' hot' : ''}" style="--c:${tc(w.team)?.color}"><b>${nmt(w.team)} wonder ${fmtClock(w.secs_left * 10)}</b><div class="vbar"><i style="width:${100 - f}%"></i></div></div>`;
    }
    if (v.points && v.points.length) {
      const teams = [...new Set(this.players.map((p) => p.team))];
      for (const tm of teams) {
        const vp = v.vp[tm - 1] || 0;
        h += `<div class="vbox" style="--c:${tc(tm)?.color}"><b>${nmt(tm)} shrines ${v.points.filter((p) => p.team === tm).length}/${v.points.length}</b>${num(vp)} / ${num(v.target)}<div class="vbar"><i style="width:${Math.min(100, (100 * vp) / v.target)}%"></i></div></div>`;
      }
    }
    el.style.display = h ? 'flex' : 'none';
    if (this.cache.vic !== h) { this.cache.vic = h; el.innerHTML = h; }
  }

  push(text, color, big, god = false) {
    const d = document.createElement('div');
    d.className = 'fi' + (big ? ' big' : '') + (god ? ' god' : '');
    d.style.setProperty('--c', color);
    d.innerHTML = text;
    this.feed.appendChild(d);
    this.feedItems.push({ d, born: performance.now(), life: god ? 2.2 : 1 });
    // an intervention of the spectator stays longer and is the last line to be pushed out
    while (this.feed.children.length > 8) ([...this.feed.children].find((c) => !c.classList.contains('god')) || this.feed.firstChild).remove();
  }

  // God mode: one intervention of the spectator as a feed line, e.g. "GOD: +100 food to blue"
  pushGod(f, players) {
    const col = f.p && players[f.p - 1] ? players[f.p - 1].color : '#f5c453';
    this.push(`<i class="gtag">GOD</i> ${esc(f.text)}`, col, false, true);
  }

  tickFeed() {
    const now = performance.now();
    for (const it of this.feedItems) if (now - it.born > 9000 * it.life) it.d.classList.add('old');
    this.feedItems = this.feedItems.filter((it) => {
      if (now - it.born > 10000 * it.life) { it.d.remove(); return false; }
      return true;
    });
  }

  events(s) {
    const col = (p) => this.players[p - 1]?.color || '#fff';
    const nm = (p) => esc(this.players[p - 1]?.name || 'P' + p);
    const agg = new Map();
    for (const d of s.dead) {
      const [kind, owner, type] = d;
      if (kind === 2) {
        this.push(`<b>${nm(owner)}</b> lost ${displayName('building', type)}`, col(owner), true);
      } else {
        const k = owner + ':' + type;
        agg.set(k, (agg.get(k) || 0) + 1);
      }
    }
    for (const [k, n] of agg) {
      const [owner, type] = k.split(':');
      this.push(`<b>${nm(+owner)}</b> lost ${n > 1 ? n + 'x ' : ''}${displayName('unit', type)}`, col(+owner), false);
    }
    for (const e of s.ev) {
      if (e.k === 'ann') {
        const t = this.players.find((p) => p.team === e.team) || this.players[e.p - 1];
        const c = t?.color || '#fff', n = esc(t?.name || 'Team ' + e.team);
        const m = { sudden_death: 'SUDDEN DEATH — nothing can be built any more, every building is crumbling', wonder_started: `<b>${n}</b> finished a WONDER: ${fmtClock((e.secs || 0) * 10)} to win`, wonder_warning: `<b>${n}</b> wonder: 1 minute left`, wonder_destroyed: `<b>${n}</b> wonder destroyed`, wonder_completed: `<b>${n}</b> WONDER COMPLETE`, control_point_captured: `<b>${n}</b> took a relic shrine`, control_victory: `<b>${n}</b> reached the shrine target` }[e.a];
        if (m) { this.push(m, e.a === 'sudden_death' ? '#ff5a3c' : c, true); if (e.a === 'sudden_death') { const cl = $('#clock'); cl.style.color = '#ff5a3c'; cl.title = 'sudden death'; } }
      } else if (e.k === 'tier') this.push(`<b>${nm(e.p)}</b> reached tier ${e.tier}`, col(e.p), true);
      else if (e.k === 'built' && /^(town_center|barracks|archery_range|stables|siege_workshop|blacksmith|tower|castle|market)$/.test(e.b)) this.push(`<b>${nm(e.p)}</b> built ${displayName('building', e.b)}`, col(e.p), false);
    }
  }

  over(o) {
    const b = $('#banner');
    const w = this.players.find((p) => p.team === o.winnerTeam);
    const cr = w && w.creator && this.init_.creators ? this.init_.creators[w.creator] : null;
    const sc = (id) => o.players?.find((p) => p.id === id)?.score;
    b.style.display = 'block';
    b.style.pointerEvents = 'auto';
    b.style.setProperty('--tc', w ? w.color : '#4d8dff');
    b.innerHTML = `<div class="endtag">MATCH FINISHED</div>${cr ? `<img class="wlogo" src="${esc(cr.logo)}" alt="" style="border-color:${esc(cr.primary)}">` : ''}<h1>${w ? esc(w.name) + ' wins' : 'Draw'}</h1>${cr ? `<div class="wby">recipe by ${esc(cr.name)}</div>` : ''}<p>${esc(o.reason)} &middot; ${fmtClock(o.seconds * 10)}</p>${this.players.length === 2 && sc(1) != null ? `<p class="endscore">score ${num(sc(1))} : ${num(sc(2))}</p>` : ''}<div class="endnext"><a class="endbtn" id="nextlive" href="/">Lobby</a><span id="nextnote"></span></div>`;
    $('#clock').classList.add('done');
    this.findNext();
  }

  // Looks for another live match (arena only: /api/matches). Same series (explicit rec.series, else same class and seed) first;
  // only a match of the same series is opened automatically, after 10 s. Otherwise the button points to any live match or the lobby.
  async findNext() {
    const btn = $('#nextlive'), note = $('#nextnote');
    try {
      const me = (/\/watch\/(?:r-)?([A-Za-z0-9._-]+)\//.exec(location.pathname) || [])[1];
      const list = await (await fetch('/api/matches', { cache: 'no-store' })).json();
      const running = list.filter((m) => m.status === 'running' && m.id !== me);
      const cur = list.find((m) => m.id === me);
      const key = (m) => m.series || `${m.class || ''}|${m.seed}`;
      const same = cur ? running.filter((m) => key(m) === key(cur)) : [];
      const next = same[0] || running[0];
      if (!next) { note.textContent = 'no other match is live right now'; return; }
      btn.textContent = 'Next live match';
      btn.href = next.watch_url;
      if (same[0]) {
        let n = 10;
        const tick = () => {
          note.textContent = `opening in ${n}s`;
          if (n-- <= 0) location.href = next.watch_url; else this.nextTimer = setTimeout(tick, 1000);
        };
        tick();
        btn.addEventListener('click', () => clearTimeout(this.nextTimer));
      } else note.textContent = `${next.name || 'another match'} is running`;
    } catch { /* plain spectator server: no match list */ }
  }
}
