// God mode panel of the spectator page: gifts, spawn / remove / heal, reveal, events (wolves, treasure, storm), speed.
// Every action is one POST /api/director (same origin + secret token); the server logs it as a player-0 command with its tick,
// so replays show exactly the same. Map tools: pick a tool, then click the map (Esc ends the tool).
import { displayName } from './theme/display-name.mjs';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const RES = ['food', 'wood', 'stone', 'gold'];
const GIVEKEY = { food: 'f', wood: 'w', stone: 's', gold: 'o' };
const TOOLS = {
  spawn: { label: 'Spawn unit', hint: 'Click the map: the unit appears there for the chosen player.' },
  remove: { label: 'Remove unit', hint: 'Click a unit to remove it (no kill is counted).' },
  heal: { label: 'Heal unit', hint: 'Click a unit or building to heal it fully.' },
  wolves: { label: 'Wolves', hint: 'Click near an edge: a wolf pack comes in there (and a mirrored pack opposite on 2 player maps).' },
  treasure: { label: 'Treasure', hint: 'Click the map: a chest appears. The first worker to reach it keeps it.' },
  storm: { label: 'Storm', hint: 'Click the map: storm area, slower movement and gathering for 40 s.' },
};

export class God {
  // h: { pick(clientX, clientY) -> { tile: [x, y], unitId, buildingId } | null, setFog(p), onSpeed(x) }
  constructor(h) {
    this.h = h;
    this.armed = null;
    this.player = 1;
    this.seq = 0;
    this.open = false;
    this.live = true;
    this.el = $('#god');
    this.badge = $('#godbadge');
  }

  init(init) {
    this.init_ = init;
    this.live = init.mode !== 'replay';
    this.matchId = (/\/watch\/([A-Za-z0-9._-]+)\//.exec(location.pathname) || [])[1] || '';
    const pills = init.players.map((p, i) => `<button class="gp" data-p="${i + 1}" style="--pc:${esc(p.color)}" title="${esc(p.name)} (key ${i + 1})">${esc(['blue', 'orange', 'green', 'purple'][i] || 'P' + (i + 1))}<kbd class="kh">${i + 1}</kbd></button>`).join('');
    const units = init.units.filter((u) => !['wolf', 'caravan'].includes(u) && !(init.navalUnits || ['fishing_boat', 'war_boat', 'transport']).includes(u)).map((u) => `<option value="${esc(u)}">${esc(displayName('unit', u))}</option>`).join('');
    const fogs = init.players.map((p, i) => `<button class="gb" data-fog="${i + 1}" title="Your view only: show what ${esc(p.name)} sees. The AIs are not affected.">fog of ${esc(['blue', 'orange', 'green', 'purple'][i] || 'P' + (i + 1))}${i < 2 ? `<kbd class="kh">${'BN'[i]}</kbd>` : ''}</button>`).join('');
    this.el.innerHTML = `
      <div class="gh"><b>GOD MODE</b><span class="gsub">every click is logged in the replay &middot; this match will not count for rankings</span><kbd>G</kbd></div>
      <div class="gnote" id="gnotelive"></div>
      <div class="grow"><label>Player</label><div class="gpills">${pills}</div></div>
      <div class="grow"><label>Gift</label>${RES.map((r) => `<button class="gb gr ${r}" data-give="${r}" title="+100 ${r} (Shift: +500)"><i></i>+100 ${r}<kbd class="kh">${GIVEKEY[r].toUpperCase()}</kbd></button>`).join('')}</div>
      <div class="grow"><label>Units</label>
        <select id="gunit">${units}</select><input id="gcount" type="number" min="1" max="10" value="1" title="how many">
        <button class="gb tool" data-tool="spawn">Spawn<kbd class="kh">U</kbd></button><button class="gb tool" data-tool="remove">Remove<kbd class="kh">X</kbd></button>
        <button class="gb tool" data-tool="heal">Heal unit<kbd class="kh">H</kbd></button><button class="gb" id="gheal">Heal all<kbd class="kh">&#8679;H</kbd></button></div>
      <div class="grow"><label>Events</label>
        <button class="gb tool ev" data-tool="wolves" title="Shift-click the button: random edge, no map click">Wolves<kbd class="kh">V</kbd></button>
        <button class="gb tool ev" data-tool="treasure" title="Shift-click the button: middle of the map">Treasure<kbd class="kh">T</kbd></button>
        <button class="gb tool ev" data-tool="storm" title="Shift-click the button: middle of the map">Storm<kbd class="kh">R</kbd></button>
        <select id="gtres" title="treasure content"><option value="gold">300 gold</option><option value="food">300 food</option><option value="wood">300 wood</option><option value="stone">300 stone</option><option value="mixed">150 of each</option></select></div>
      ${init.weatherOn || init.mapType ? `<div class="grow"><label>Weather</label>
        ${['clear', 'rain', 'fog', 'snow', 'storm'].map((k) => `<button class="gb" data-wx="${k}" title="${k} for 90 s (Shift: 300 s)">${k}</button>`).join('')}
        <button class="gb" data-caravan="1" title="send out new caravans where none is on the road">Caravan</button></div>` : ''}
      <div class="grow"><label title="Only your picture changes. The AI players still see what they saw.">View <em>(only you)</em></label>
        <button class="gb" data-fog="0">see everything<kbd class="kh">M</kbd></button>${fogs}</div>
      <div class="grow"><label title="The chosen player's AI really gets this map knowledge.">Reveal <em>(the AI sees it)</em></label>
        <button class="gb" id="greveal">reveal map for player<kbd class="kh">Y</kbd></button><button class="gb" id="gunreveal">hide again<kbd class="kh">&#8679;Y</kbd></button></div>
      <div class="grow"><label>Speed</label>${['pause', '1', '2', '4', '8'].map((x) => `<button class="gb gs" data-x="${x}">${x === 'pause' ? 'II<kbd class="kh">P</kbd>' : x + 'x'}</button>`).join('')}<kbd class="kh wide">[ ]</kbd>
        <span class="gsub" title="Live matches are paced by the wall clock; the AIs think in real time, so a faster game gives them less thinking time per game second.">live: the AIs do not think faster</span></div>
      <div class="ghelp">Keys (panel open): 1-4 player &middot; F W S O gifts (&#8679; = +500) &middot; U spawn &middot; X remove &middot; H heal unit &middot; &#8679;H heal all &middot; V wolves &middot; T treasure &middot; R storm (&#8679; = default spot) &middot; Y reveal &middot; M B N view &middot; P pause &middot; <span style="white-space:nowrap">[ ] speed</span> &middot; Esc ends a tool &middot; arrows pan</div>
      <div class="gstatus" id="gstatus">Pick a tool, then click the map. Esc ends the tool.</div>`;
    this.status = $('#gstatus');
    if (!this.live) { this.el.classList.add('replay'); $('#gnotelive').textContent = 'Replay: interventions can only be made in live matches. Fog view and speed still work.'; }
    this.el.addEventListener('click', (e) => this.onClick(e));
    this.selectPlayer(1);
  }

  // hotkeys, only while the panel is open and focus is not in a field; returns true when the key was used
  key(e) {
    if (!this.open || e.ctrlKey || e.metaKey || e.altKey) return false;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const click = (sel) => { const b = this.el.querySelector(sel); if (b) b.click(); return true; };
    const sh = e.shiftKey;
    if (/^[1-4]$/.test(k) && !sh) return click(`.gp[data-p="${k}"]`);
    for (const r of RES) if (k === GIVEKEY[r]) return this.onClick({ target: this.el.querySelector(`[data-give="${r}"]`), shiftKey: sh });
    const ev = { target: null, shiftKey: sh };
    const go = (sel) => { ev.target = this.el.querySelector(sel); return this.onClick(ev) ?? true; };
    switch (k) {
      case 'u': return go('[data-tool="spawn"]');
      case 'x': return go('[data-tool="remove"]');
      case 'h': case 'H': return sh ? go('#gheal') : go('[data-tool="heal"]');
      case 'v': return go('[data-tool="wolves"]');
      case 't': return go('[data-tool="treasure"]');
      case 'r': return go('[data-tool="storm"]');
      case 'y': return sh ? go('#gunreveal') : go('#greveal');
      case 'm': return go('[data-fog="0"]');
      case 'b': return go('[data-fog="1"]');
      case 'n': return this.el.querySelector('[data-fog="2"]') ? go('[data-fog="2"]') : false;
      case 'p': return go('[data-x="pause"]');
      case '[': case ']': { const L = [1, 2, 4, 8], i = L.indexOf(this.speed || 1); this.h.onSpeed(String(L[Math.max(0, Math.min(3, i + (k === ']' ? 1 : -1)))])); return true; }
      default: return false;
    }
  }

  toggle(force) {
    this.open = force === undefined ? !this.open : force;
    this.el.classList.toggle('open', this.open);
    if (!this.open) this.disarm();
  }

  selectPlayer(p) {
    this.player = p;
    for (const b of this.el.querySelectorAll('.gp')) b.classList.toggle('on', +b.dataset.p === p);
  }

  say(text, kind = '') {
    this.status.textContent = text;
    this.status.className = 'gstatus ' + kind;
  }

  arm(tool) {
    this.armed = this.armed === tool ? null : tool;
    for (const b of this.el.querySelectorAll('.tool')) b.classList.toggle('on', b.dataset.tool === this.armed);
    document.body.classList.toggle('godtool', !!this.armed);
    this.say(this.armed ? TOOLS[this.armed].hint + ' Esc ends the tool.' : 'Pick a tool, then click the map. Esc ends the tool.');
  }

  disarm() {
    if (this.armed) this.arm(this.armed);
  }

  async send(body) {
    if (!this.live) { this.say('Replays cannot be changed.', 'err'); return { ok: false }; }
    try {
      const r = await fetch('/api/director' + (this.matchId ? `?m=${encodeURIComponent(this.matchId)}` : ''), {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-God-Token': window.__GOD_TOKEN || '' }, body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({ ok: false, error: 'bad answer' }));
      if (j.ok) this.say('GOD: ' + j.text, 'ok');
      else this.say(`Not done: ${j.message || j.error || r.status}`, 'err');
      return j;
    } catch (err) {
      this.say('Not done: ' + err.message, 'err');
      return { ok: false };
    }
  }

  onClick(e) {
    const b = e.target && e.target.closest && e.target.closest('button');
    if (!b) return;
    if (b.dataset.p) return this.selectPlayer(+b.dataset.p);
    if (b.dataset.wx) return this.send({ action: 'weather', kind: b.dataset.wx, secs: e.shiftKey ? 300 : 90 });
    if (b.dataset.caravan) return this.send({ action: 'caravan' });
    if (b.dataset.give) return this.send({ action: 'give', player: this.player, res: b.dataset.give, amount: e.shiftKey ? 500 : 100 });
    if (b.dataset.fog !== undefined) {
      this.h.setFog(+b.dataset.fog);
      for (const x of this.el.querySelectorAll('[data-fog]')) x.classList.toggle('on', x === b);
      return this.say(+b.dataset.fog ? `Your view only: fog as ${b.textContent.replace('fog of ', '')} sees it. The AIs are not affected.` : 'Your view only: everything visible.');
    }
    if (b.dataset.x) return this.h.onSpeed(b.dataset.x);
    if (b.id === 'gheal') return this.send({ action: 'heal', player: this.player });
    if (b.id === 'greveal') return this.send({ action: 'reveal', player: this.player });
    if (b.id === 'gunreveal') return this.send({ action: 'reveal', player: this.player, on: false });
    if (b.dataset.tool) {
      if (e.shiftKey && b.classList.contains('ev')) return this.fireDefault(b.dataset.tool);
      this.arm(b.dataset.tool);
    }
  }

  tres() {
    const v = $('#gtres').value;
    return v === 'mixed' ? { res: 'mixed', amount: 150 } : { res: v, amount: 300 };
  }

  fireDefault(tool) {
    if (tool === 'wolves') this.send({ action: 'wolves', count: 3 });
    else if (tool === 'treasure') this.send({ action: 'treasure', ...this.tres() });
    else if (tool === 'storm') this.send({ action: 'storm' });
  }

  // called by the page for a click on the map while a tool is armed; hit from pick()
  mapClick(hit) {
    if (!this.armed || !hit) return false;
    const [x, y] = hit.tile;
    switch (this.armed) {
      case 'spawn': this.send({ action: 'spawn', player: this.player, unit: $('#gunit').value, count: Math.max(1, Math.min(10, +$('#gcount').value || 1)), x, y }); break;
      case 'remove': if (hit.unitId) this.send({ action: 'remove', id: hit.unitId }); else this.say('No unit there. Click closer to a unit.', 'err'); break;
      case 'heal': if (hit.unitId || hit.buildingId) this.send({ action: 'heal', id: hit.unitId || hit.buildingId }); else this.say('Nothing to heal there.', 'err'); break;
      case 'wolves': this.send({ action: 'wolves', count: 3, x, y }); break;
      case 'treasure': this.send({ action: 'treasure', ...this.tres(), x, y }); break;
      case 'storm': this.send({ action: 'storm', x, y, r: 9, secs: 40 }); break;
      default: return false;
    }
    return true;
  }

  // per snapshot: permanent badge, feed lines, button states
  update(s, hud) {
    const g = s.god;
    this.speed = s.speed || this.speed;
    this.badge.classList.toggle('on', !!(g && g.on));
    for (const b of this.el.querySelectorAll('.gs')) {
      const x = b.dataset.x;
      b.classList.toggle('on', x === 'pause' ? s.paused : !s.paused && +x === s.speed);
    }
    if (g) {
      const rv = new Set(g.revealed || []);
      const team = this.init_.players[this.player - 1]?.team;
      $('#greveal').classList.toggle('on', rv.has(team));
      for (const f of g.feed) {
        if (f.seq <= this.seq || s.t - f.t > 200) continue;
        hud.pushGod(f, this.init_.players);
      }
      this.seq = Math.max(this.seq, ...g.feed.map((f) => f.seq), 0);
    }
  }
}
