import { groupOutline } from './mark-hull.mjs';
import { bannerSpec, applyBanner } from './fog-banner.mjs';
import { layoutFaults, spreadLabels, overlayBoxes, LABEL_AVOID, LABEL_AVOID_CLEAN } from './layout-faults.mjs';
// Page side of the frame-exact broadcast renderer (driven by tools/render-broadcast.mjs through window.__bc).
// No clocks, no requestAnimationFrame, no network: every frame is rendered from the state that is pushed in.
window.__BROADCAST = true;
// seeded Math.random: particle effects are identical on every render
let rngState = 0x2545f491;
Math.random = () => { rngState = (Math.imul(rngState ^ (rngState >>> 15), 0x2c1b3c6d) + 0x297a2d39) >>> 0; rngState ^= rngState >>> 13; return (rngState >>> 0) / 4294967296; };
const $ = (q) => document.querySelector(q);
const params = new URLSearchParams(location.search);
const preset = params.get('preset') === 'yt' ? 'yt' : 'x';
document.body.className = `preset-${preset} nospeed`; // videos never show tokens per second (no speed numbers in video or post)

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const num = (n) => (n >= 10000 ? (n / 1000).toFixed(1) + 'k' : String(Math.round(n)));

await import('./app.mjs');
const H = window.__bcHooks;

let init = null, panels = [], cache = {};
const set = (el, key, v, fn) => { if (cache[key] === v) return; cache[key] = v; fn(el, v); };

async function setup(msg, cfg) {
  init = msg;
  H.init(msg);
  H.markerText(false); // the text of the markers goes on the label layer (drawMarks)
  await H.ready; // creator logo atlas, 3D models and textures
  { const r3 = window.__rts, w3 = r3 && r3.world, bad = r3 && (r3.packFailed ? '3D pack: ' + r3.packFailed : w3 && w3.u3Failed ? 'rigged units: ' + w3.u3Failed : w3 && w3.siegeFailed ? 'siege models: ' + w3.siegeFailed : ''); if (bad) throw new Error('3D models did not load (' + bad + '): the video would show the old procedural figures'); } // a frame with them is never rendered: tools/render-broadcast.mjs loads the page again
  rngState = 0x2545f491; // asset loading (async, uuids) must not shift the random sequence of the frames
  const CR = (p) => (p.creator && msg.creators ? msg.creators[p.creator] : null);
  const cardNames = cardNamesOf(msg.players);
  const cls = $('#cls');
  if (cfg.cls) {
    const m = /^(\d+)\s*(.*)$/.exec(cfg.cls);
    cls.style.setProperty('--cs', String(Math.round(Math.max(58, Math.min(118, (118 * 7) / cfg.cls.length)))));
    cls.innerHTML = m ? `${esc(m[1])} <em>${esc(m[2])}</em>` : esc(cfg.cls);
  }
  msg.players.forEach((p, i) => {
    const mu = $(`#mu${i}`);
    mu.style.setProperty('--c', p.color);
    const cr = CR(p);
    mu.classList.toggle('has-av', !!cr);
    if (cr) mu.querySelector('.av').src = cr.logo;
    mu.querySelector('b').textContent = p.name;
    // hardware label: never cut. The model id (it is in the name anyway) is the first thing to go, then the name gets smaller
    const mspan = mu.querySelector('span');
    const mm = document.createElement('span'); mm.className = 'm'; mm.textContent = p.model ? `${p.model} \u00b7 ` : '';
    const hh = document.createElement('span'); hh.className = 'h'; hh.textContent = p.hw || '';
    mspan.replaceChildren(mm, hh);
    const el = $(`#pn${i}`);
    el.style.setProperty('--tc', p.color);
    $(`#card${i}`).style.setProperty('--tc', p.color);
    el.innerHTML = `
      <div class="ph"><img class="av" alt=""><div class="pcol"><div class="pname"></div><div class="rec"></div></div><div class="tier"></div></div>
      <div class="res">
        <div class="r food"><b>0</b><span>food</span></div><div class="r wood"><b>0</b><span>wood</span></div>
        <div class="r stone"><b>0</b><span>stone</span></div><div class="r gold"><b>0</b><span>gold</span></div>
      </div>
      <div class="pop"><span>POP</span><div class="bar"><i></i></div><span class="popn">0/0</span></div>
      <div class="stats"><div>Army<b class="army">0</b></div><div>Workers<b class="wk">0</b></div><div>Kills<b class="kills">0</b></div><div>Score<b class="score">0</b></div></div>
      <div class="kv"><span>think <b class="lat">-</b></span><span><b class="toks">-</b> tok/s</span><span><b class="dec">0</b> decisions</span></div>`;
    el.querySelector('.pname').textContent = cardNames[i];
    if (cr) {
      el.classList.add('has-av');
      el.querySelector('.av').src = cr.logo;
      el.style.setProperty('--cc', cr.primary); el.style.setProperty('--cc2', cr.secondary);
      const rec = el.querySelector('.rec');
      rec.append('recipe by ');
      const b = document.createElement('b'); b.textContent = cr.short || cr.name; rec.append(b);
    }
    panels.push({
      el, tier: el.querySelector('.tier'), res: [...el.querySelectorAll('.r b')], popn: el.querySelector('.popn'), bar: el.querySelector('.bar i'),
      army: el.querySelector('.army'), wk: el.querySelector('.wk'), kills: el.querySelector('.kills'), score: el.querySelector('.score'),
      lat: el.querySelector('.lat'), toks: el.querySelector('.toks'), dec: el.querySelector('.dec'),
    });
  });
  document.body.classList.toggle('story', !!cfg.story);
  fitted = false; // the names are fitted on the first frame, when the tier chips next to them are filled
  if (cfg.footer) { const f = $('#foot'); f.textContent = cfg.footer; f.classList.add('on'); }
  H.resize();
  return { ok: true };
}

// ---- names that are never cut: the font shrinks first (a pure function of the text and the layout, no clock) ----
// card name: the model name without the maker's bracket ("Qwen3.8-27B NVFP4+MTP3 (QuartzRT)" -> "Qwen3.8-27B NVFP4+MTP3"; the bracket is in the title bar), unless that would make both names equal
function cardNamesOf(players) {
  const bare = players.map((p) => String(p.name).replace(/\s*\([^)]*\)\s*$/, '').trim() || String(p.name));
  return players.map((p, i) => (bare.every((b, j) => j === i || b !== bare[i]) ? bare[i] : String(p.name)));
}
function fitText(el, minScale) {
  el.style.fontSize = '';
  const base = parseFloat(getComputedStyle(el).fontSize);
  let sc = 1;
  while (el.scrollWidth > el.clientWidth + 1 && sc > minScale) { sc -= 0.04; el.style.fontSize = (base * sc).toFixed(2) + 'px'; }
}
let fitted = false;
// a card name must fit with a pixel to spare: fitText() accepts one pixel of overflow, and even half a pixel draws the ellipsis ("3.06 b...")
function lateFit(el) {
  if (!el) return;
  const textW = () => { const r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect().width; };
  if (textW() <= el.clientWidth - 1) return;
  const key = `${el.clientWidth}|${el.textContent}`;
  if (el.dataset.late === key) return;
  el.dataset.late = key;
  const base = parseFloat(getComputedStyle(el).fontSize);
  let sc = 1;
  while (textW() > el.clientWidth - 1 && sc > 0.7) { sc -= 0.03; el.style.fontSize = (base * sc).toFixed(2) + 'px'; }
}
function fitNames(n) {
  const cls = $('#cls'), clsBase = cls ? parseFloat(getComputedStyle(cls).fontSize) : 0;
  const cut = (i) => { const b = $(`#mu${i} b`); return b.scrollWidth > b.clientWidth + 1; };
  const fitOne = (i) => {
    const mu = $(`#mu${i}`), b = mu.querySelector('b'), m = mu.querySelector('.m');
    m.classList.remove('off');
    b.style.fontSize = '';
    if (b.scrollWidth > b.clientWidth + 1) m.classList.add('off'); // the model id goes first
    fitText(b, 0.72);
    // still too long: the part in brackets goes (the end screen and the post name it), a name is never cut off with dots
    if (b.scrollWidth > b.clientWidth + 1) { b.textContent = String(init.players[i].name).replace(/\s*\([^)]*\)\s*$/, ''); b.style.fontSize = ''; fitText(b, 0.72); }
  };
  for (let i = 0; i < n; i++) fitOne(i);
  // a bracket such as "(Zoe's recipe)" stayed on one name and went from the other: the class label gives way first so that both keep it, else both lose it (a credit on one side only reads as a favour)
  const full = (i) => String(init.players[i].name), kept = (i) => $(`#mu${i} b`).textContent === full(i), allKept = () => Array.from({ length: n }, (_, i) => kept(i)).every(Boolean), someKept = () => Array.from({ length: n }, (_, i) => kept(i)).some(Boolean);
  if (cls && n > 1 && someKept() && !allKept()) {
    for (let sc = 1; sc > 0.7 && !allKept();) {
      sc -= 0.05; cls.style.fontSize = (clsBase * sc).toFixed(2) + 'px';
      for (let i = 0; i < n; i++) { const b = $(`#mu${i} b`); b.textContent = full(i); b.style.fontSize = ''; fitOne(i); }
    }
    if (!allKept()) for (let i = 0; i < n; i++) { const b = $(`#mu${i} b`); b.textContent = full(i).replace(/\s*\([^)]*\)\s*$/, ''); b.style.fontSize = ''; fitText(b, 0.72); }
  }
  // a name still cut: the class label gives way (x preset: "2 SPARKS vs 2 SPARKS" at its smallest size left about 330 px for two names)
  for (let sc = 1; cls && sc > 0.7 && Array.from({ length: n }, (_, i) => cut(i)).some(Boolean);) {
    sc -= 0.05; cls.style.fontSize = (clsBase * sc).toFixed(2) + 'px';
    for (let i = 0; i < n; i++) fitOne(i);
  }
  for (let i = 0; i < n; i++) fitText($(`#pn${i} .pname`), 0.7);
}

function updateHud(s, ui) {
  s.players.forEach((p, i) => {
    const P = panels[i];
    if (!P) return;
    P.el.classList.toggle('dead', !p.alive);
    set(P.tier, `tier${i}`, `${p.tier}/${p.adv}`, (e) => (e.innerHTML = `TIER ${p.tier} ` + [1, 2, 3].map((n) => `<i class="${n <= p.tier ? 'on' : n === p.adv ? 'adv' : ''}"></i>`).join('')));
    ['food', 'wood', 'stone', 'gold'].forEach((r, k) => set(P.res[k], `r${i}${k}`, Math.floor(p.res[r]), (e, v) => (e.textContent = num(v))));
    set(P.popn, `pop${i}`, `${p.pop}/${p.cap}`, (e, v) => (e.textContent = v));
    set(P.bar, `bar${i}`, Math.min(100, Math.round((100 * p.pop) / Math.max(1, p.cap))), (e, v) => (e.style.width = v + '%'));
    set(P.army, `a${i}`, p.army, (e, v) => (e.textContent = num(v)));
    set(P.wk, `w${i}`, p.workers, (e, v) => (e.textContent = v));
    set(P.kills, `k${i}`, p.kills, (e, v) => (e.textContent = v));
    set(P.score, `sc${i}`, p.score, (e, v) => (e.textContent = num(v)));
    const st = ui.stats[i];
    const lat = st && st.latency_ms != null ? (st.latency_ms < 1000 ? Math.round(st.latency_ms) + ' ms' : (st.latency_ms / 1000).toFixed(1) + ' s') : '-';
    set(P.lat, `lat${i}`, lat, (e, v) => (e.textContent = v));
    set(P.toks, `tk${i}`, st && st.tok_s != null ? String(Math.round(st.tok_s)) : '-', (e, v) => (e.textContent = v));
    set(P.dec, `dec${i}`, st ? st.decisions : 0, (e, v) => { e.textContent = v; if (e.nextSibling && e.nextSibling.nodeType === 3) e.nextSibling.nodeValue = v === 1 ? ' decision' : ' decisions'; });
  });
}

function updateOverlay(ui) {
  $('#clock').textContent = ui.clock;
  const badge = $('#badge');
  badge.classList.toggle('normal', !ui.badge.on);
  badge.classList.toggle('slow', !!ui.badge.slow);
  badge.classList.toggle('hold', !!ui.badge.hold);
  badge.querySelector('b').textContent = ui.badge.label;
  $('#godbadge').classList.toggle('on', !!ui.god);
  [0, 1].forEach((i) => {
    const el = $(`#card${i}`);
    const c = ui.cards.find((x) => x.p === i + 1);
    if (!c) { el.style.opacity = 0; return; }
    const pl = init.players[i];
    el.querySelector('.who').textContent = `${pl.name} ${c.kind === 'thought' ? 'thinks' : 'orders'}`;
    const t = el.querySelector('.txt');
    t.textContent = c.kind === 'thought' ? `“${c.text}”` : c.text;
    t.classList.toggle('orders', c.kind !== 'thought');
    el.querySelector('.meta').textContent = c.meta;
    el.style.opacity = c.a;
    el.style.transform = `translateY(${((1 - c.a) * 14).toFixed(1)}px)`;
  });
  const tk = $('#ticker');
  // the ticker is the headline for the big events (the feed lists all of them); the YouTube layout puts it where the decision panel sits
  if (ui.ticker && ui.ticker.imp >= 4) {
    const pl = init.players[ui.ticker.p - 1];
    tk.style.setProperty('--c', pl ? pl.color : '#4d8dff');
    tk.querySelector('span').textContent = ui.ticker.text;
    tk.style.opacity = ui.ticker.a;
  } else tk.style.opacity = 0;
  updateFeed(ui);
  updateMoment(ui);
  updateStory(ui);
  updateCaps(ui);
  updateEnd(ui);
  const bn = $('#banner');
  if (ui.banner) {
    const pl = init.players[ui.banner.p - 1];
    const cr = pl && pl.creator && init.creators ? init.creators[pl.creator] : null;
    bn.style.setProperty('--tc', pl ? pl.color : '#4d8dff');
    bn.classList.toggle('cloth', !!cr);
    if (cr) { // winner banner: the creator's flag with the logo
      const lum = (h) => { const v = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
      bn.style.setProperty('--cc', cr.primary); bn.style.setProperty('--cc2', cr.secondary);
      bn.style.setProperty('--ct', lum(cr.primary) > 0.45 ? '#0a0e14' : '#ffffff');
      bn.querySelector('img').src = cr.logo;
      bn.querySelector('.win').textContent = ui.banner.title.endsWith(' wins') ? 'WINNER' : '';
      bn.querySelector('h1').textContent = pl.name;
      bn.querySelector('.by').textContent = `recipe by ${cr.name}`;
    } else {
      bn.querySelector('h1').textContent = ui.banner.title;
      bn.querySelector('.by').textContent = '';
    }
    bn.querySelector('p').textContent = ui.banner.sub;
    bn.style.opacity = ui.banner.a;
    bn.style.transform = cr ? `translateX(-50%) translateY(${((1 - ui.banner.a) * -40).toFixed(1)}px)` : 'translateX(-50%)';
  } else bn.style.opacity = 0;
}

// how far the winner banner is in (0..1); 0 for other banners and when none shows
const endA = (ui) => (ui.end ? ui.end.a : 0);
function winnerBanner(ui) { return ui.banner && String(ui.banner.title).endsWith(' wins') ? ui.banner.a : 0; }

// ---- action feed: fixed pool of lines, newest at the bottom ----
function updateFeed(ui) {
  const box = $('#feed');
  while (box.children.length < 5) { const d = document.createElement('div'); d.className = 'fl'; d.innerHTML = '<b></b><span></span>'; box.append(d); }
  const items = ui.feed || [];
  // 4:5: the winner banner (top ~200 px) lands on the first feed line, so the feed leaves with the banner (16:9 keeps its feed in the bottom corner)
  box.style.opacity = preset === 'x' ? String(+(1 - winnerBanner(ui)).toFixed(3)) : '';
  [...box.children].forEach((el, i) => {
    const it = i >= 5 - items.length ? items[i - (5 - items.length)] : null; // newest at the bottom
    if (!it) { el.style.display = 'none'; return; }
    const pl = it.p ? init.players[it.p - 1] : null;
    el.style.display = 'flex';
    el.style.setProperty('--c', pl ? pl.color : '#4d8dff');
    el.children[0].textContent = it.tag;
    el.children[1].textContent = it.text;
    el.style.opacity = it.a;
  });
}

// ---- small decision card (the model's note, word for word) and the casters' captions ----
function updateMoment(ui) {
  const el = $('#mom');
  const m = ui.moment;
  if (!m || !m.card.thought || m.story) { el.style.opacity = 0; el.style.display = 'none'; return; }
  el.style.display = '';
  const pl = init.players[m.p - 1];
  el.style.setProperty('--tc', pl ? pl.color : '#4d8dff');
  el.querySelector('.who').textContent = `${m.card.who} decides`;
  el.querySelector('.q').textContent = `\u201c${m.card.thought}\u201d`;
  el.style.opacity = +(m.a * m.thought_a).toFixed(3);
}
function updateCaps(ui) {
  const box = $('#caps');
  const list = ui.captions || [];
  while (box.children.length < 2) { const d = document.createElement('div'); d.className = 'cap'; d.innerHTML = '<div class="cw"><b></b><span></span></div><p></p>'; box.append(d); }
  [...box.children].forEach((el, i) => {
    const c = list[i - (2 - list.length)] || null; // newest at the bottom
    if (i < 2 - list.length || !c) { el.style.display = 'none'; return; }
    el.style.display = '';
    el.classList.toggle('leaving', !!c.leaving);
    el.style.setProperty('--c', c.color);
    el.querySelector('b').textContent = c.name.toUpperCase();
    el.querySelector('span').textContent = c.role;
    el.querySelector('p').textContent = c.text;
    el.style.opacity = c.a;
  });
}

// ---- story cut: chapters bar, strategy cards, split view of the decisions, tier race table ----
const el = (tag, cls, text) => { const d = document.createElement(tag); if (cls) d.className = cls; if (text != null) d.textContent = text; return d; };
function updateStory(ui) {
  const S = ui.story;
  const bar = $('#tlbar'), tag = $('#tag');
  if (!S) { bar.style.display = 'none'; tag.style.opacity = 0; $('#sc0').style.opacity = 0; $('#sc1').style.opacity = 0; $('#split').style.display = 'none'; return; }
  // chapters bar: one segment per chapter, the played part filled
  const key = S.bar.items.map((i) => i.t + i.w).join('|');
  bar.style.display = S.bar.items.length ? 'flex' : 'none';
  if (bar.dataset.key !== key) {
    bar.dataset.key = key;
    bar.replaceChildren(...S.bar.items.map((i) => { const d = el('div', 'seg'); d.style.flex = `${i.w} 1 0`; d.append(el('i'), el('span', null, i.t)); return d; }));
  }
  let acc = 0;
  [...bar.children].forEach((d, i) => {
    const w = S.bar.items[i].w, f = Math.max(0, Math.min(1, (S.bar.p - acc) / Math.max(1e-6, w)));
    acc += w;
    d.firstChild.style.transform = `scaleX(${f.toFixed(4)})`;
    // a chapter name is never cut: the full name if it fits, else its last word, else its last word in small print, else nothing
    if (bar.dataset.fit !== key && (!document.fonts || document.fonts.status === 'loaded')) { const s = d.lastChild, full = S.bar.items[i].t; for (const t of [full, full.split(' ').pop(), full.split(' ').pop() + '\u0000', '']) { const small = t.endsWith('\u0000'); s.textContent = small ? t.slice(0, -1) : t; s.style.fontSize = small ? '8px' : ''; s.style.letterSpacing = small ? '0' : ''; if (s.scrollWidth <= d.clientWidth) break; } if (i === bar.children.length - 1) bar.dataset.fit = key; }
    d.classList.toggle('cur', i === S.bar.cur);
  });
  tag.textContent = S.tag || '';
  tag.style.opacity = S.tag ? 1 : 0;
  // strategy cards
  [0, 1].forEach((i) => {
    const c = $(`#sc${i}`), d = S.cards && S.cards[i];
    if (!d) { c.style.opacity = 0; return; }
    const pl = init.players[i];
    c.style.setProperty('--tc', pl.color);
    const k = JSON.stringify([d.tier, d.plan && d.plan.t, d.orders && d.orders.t, d.army && d.army.t]);
    if (c.dataset.key !== k) {
      c.dataset.key = k;
      const head = el('div', 'sh'); head.append(el('b', null, d.name), el('span', null, `TIER ${d.tier}`));
      const rows = [head];
      rows.push(d.plan ? row('PLAN', `\u201c${d.plan.text}\u201d`, d.plan.at, 'q') : row('PLAN', 'no note written, orders only', '', 'none'));
      if (d.orders) rows.push(row('ORDERS', d.orders.text, d.orders.at, 'o'));
      if (d.army) rows.push(row('ARMY', d.army.text, d.army.at, 'a'));
      c.replaceChildren(...rows);
    }
    c.style.setProperty('--fl', d.flash);
    c.style.opacity = d.a;
  });
  // split view
  const sp = $('#split');
  document.body.classList.toggle('split-on', !!(S.split && S.split.a > 0)); // CSS .story.preset-x.split-on #feed: the kill feed gives way to the split card
  if (!S.split || S.split.a <= 0) { sp.style.display = 'none'; return; }
  const X = S.split, sk = JSON.stringify([X.kind, X.clock, X.cols.map((c) => c.n), X.rows.length]);
  sp.style.display = 'flex';
  if (sp.dataset.key !== sk) {
    sp.dataset.key = sk;
    sp.className = X.kind === 'compare' ? 'cmp' : X.cols.length > 1 ? 'two' : 'one';
    const title = el('div', 'st'); title.append(el('b', null, X.title), el('span', null, X.clock));
    if (X.kind === 'compare') {
      const t = el('div', 'tbl');
      const hd = el('div', 'tr th'); hd.append(el('span'), ...X.names.map((n, i) => { const s = el('span', null, n); s.style.color = init.players[i].color; return s; }));
      t.append(hd);
      for (const r of X.rows) { const tr = el('div', /^(ARMY|BUILT)$/.test(r.label) ? 'tr txt' : 'tr'); tr.append(el('span', 'l', r.label), ...r.vals.map((v) => el('span', 'v', v))); t.append(tr); }
      sp.replaceChildren(title, t);
    } else {
      const cols = el('div', 'cols');
      for (const c of X.cols) {
        const d = el('div', 'col'); d.style.setProperty('--tc', init.players[c.p - 1].color);
        d.append(el('div', 'ch', `${c.name} \u00b7 decision ${c.n} \u00b7 ${c.at}`));
        for (const s of c.saw) d.append(row('SAW', s, '', 's'));
        d.append(c.note ? row('NOTE', `\u201c${c.note}\u201d`, '', 'q') : row('NOTE', 'none: this model wrote no note', '', 'none'));
        d.append(row('ORDERED', c.ordered || 'nothing', '', 'o'));
        if (c.meta) d.append(el('div', 'cm', c.meta));
        cols.append(d);
      }
      sp.replaceChildren(title, cols);
    }
  }
  sp.style.opacity = X.a;
}
function row(label, text, at, cls) {
  const r = el('div', `rw ${cls || ''}`);
  r.append(el('i', null, label), el('p', null, String(text).replace(/\//g, '/\u200b'))); // a break may fall after a slash ("sword/archer/cavalry"), not in the middle of a word
  if (at) r.append(el('em', null, at));
  return r;
}

// ---- end screen ----
function updateEnd(ui) {
  const el = $('#end');
  const e = ui.end;
  // 16:9: the table sits in the middle of the picture; the two player cards (their numbers are in the table) fade out while it shows
  // The winner banner (wide, 16:9) sits across the left card as well, so the cards leave with the banner and stay away until the end.
  const winB = winnerBanner(ui);
  const hide = e ? 1 : winB;
  panels.forEach((P) => { P.el.style.opacity = preset === 'yt' && hide > 0 ? String(((P.el.classList.contains('dead') ? 0.55 : 1) * (1 - hide)).toFixed(3)) : ''; });
  if (!e) { el.style.opacity = 0; return; }
  if (el.dataset.built !== '1') {
    el.dataset.built = '1';
    const win = e.winner ? init.players[e.winner - 1] : null;
    el.style.setProperty('--tc', win ? win.color : '#e6ebf2');
    el.querySelector('h1').textContent = win ? e.players[e.winner - 1].name : 'Draw';
    el.querySelector('.ew').textContent = win ? 'WINNER' : 'NO WINNER';
    el.querySelector('.es').textContent = `${e.reason} \u00b7 game time ${e.time}`;
    const ps = el.querySelectorAll('.epl');
    [0, 1].forEach((i) => {
      const P = e.players[i], pl = init.players[i];
      if (!P || !pl) return;
      ps[i].style.setProperty('--c', pl.color);
      ps[i].querySelector('b').textContent = P.name;
      ps[i].querySelector('span').textContent = preset === 'x' ? P.hw || '' : [P.model, P.hw].filter(Boolean).join(' \u00b7 '); // 4:5: the model id is in the name, the hardware is never cut
      const cr = pl.creator && init.creators ? init.creators[pl.creator] : null;
      if (cr) {
        const dot = ps[i].querySelector('i'); dot.className = 'av'; dot.style.backgroundImage = `url("${cr.logo}")`;
        let rc = ps[i].querySelector('em'); if (!rc) { rc = document.createElement('em'); ps[i].append(rc); }
        rc.textContent = `recipe by ${cr.short || cr.name}`;
      }
    });
    const box = el.querySelector('.erows');
    box.replaceChildren(...e.rows.filter((r) => r.key !== 'tok_s').map((r) => { // no speed numbers in videos
      const d = document.createElement('div');
      d.className = 'er';
      const mx = Math.max(1, ...r.raw.map((x) => (typeof x === 'number' ? x : 0)));
      const cell = (i) => {
        const v = document.createElement('div');
        v.className = 'v' + (i ? ' rt' : '') + (r.lead === i ? ' lead' : '');
        v.style.setProperty('--c', init.players[i].color);
        v.append(r.vals[i]);
        const bar = document.createElement('i');
        bar.style.transform = `scaleX(${typeof r.raw[i] === 'number' ? Math.max(0.02, r.raw[i] / mx).toFixed(3) : 0})`;
        v.append(bar);
        return v;
      };
      const l = document.createElement('div'); l.className = 'l'; l.textContent = r.label;
      d.append(cell(0), l, cell(1));
      return d;
    }));
  }
  el.style.opacity = e.a;
  el.style.transform = `translateY(${((1 - e.a) * 20).toFixed(1)}px)`;
}

// ---- story "show what is said" layer: tag chip, comparison bars, what a model saw (inset); the highlights are drawn after the 3D frame ----
let insetKey = null;
function updateShow(ui) {
  const sh = ui.show, tag = $('#showtag'), vs = $('#versus'), ins = $('#inset'), ban = $('#fogban');
  if (!sh) { tag.style.opacity = 0; vs.style.opacity = 0; ins.style.display = 'none'; $('#marks').style.display = 'none'; applyBanner(ban, null); return; }
  const col = (o) => (o && init.players[o - 1] ? init.players[o - 1].color : '#f5c453');
  const free = 1 - endA(ui); // the end card stands alone: nothing of the show stays around it
  // fog of war view: the banner says whose eyes these are and what the shades mean; it stays up while the view runs and changes side in one piece (tools/story-show.mjs `view`)
  const spec = bannerSpec(sh.view, (p) => (init.players[p - 1] ? init.players[p - 1].color : '#9aa6b8'));
  applyBanner(ban, spec && free > 0 ? { ...spec, a: +(spec.a * free).toFixed(3) } : null);
  const banner = !!spec && free > 0;
  if (banner) { // the plan cards and the headline give way (the banner sits where they stand), the strip with the clock stays
    for (const id of ['#sc0', '#sc1']) { const e = $(id); e.style.opacity = (e.style.opacity === '' ? 1 : +e.style.opacity) * (1 - Math.min(1, 4 * spec.a)); } // gone before the banner is a quarter in
    $('#ticker').style.opacity = 0;
  }
  // the chip of a fog view only repeats the banner; a different chip (a scout's find) stays and moves under it
  const chip = sh.tag && !(banner && sh.tag.viewOnly);
  tag.classList.toggle('under', banner);
  if (chip) { tag.textContent = sh.tag.text; tag.style.setProperty('--tc', col(sh.tag.p)); tag.style.opacity = sh.a * free; } else tag.style.opacity = 0;
  if (sh.versus) {
    const k = JSON.stringify(sh.versus);
    if (vs.dataset.key !== k) {
      vs.dataset.key = k;
      const mx = Math.max(1, ...sh.versus.rows.map((r) => r.val));
      vs.replaceChildren(el('div', 'vt', sh.versus.title), ...sh.versus.rows.map((r) => {
        const d = el('div', 'vr'); d.style.setProperty('--c', col(r.o));
        const b = el('div', 'vb'), i = el('i'); i.style.transform = `scaleX(${Math.max(0.02, r.val / mx).toFixed(3)})`; b.append(i);
        d.append(el('div', 'vn', r.name), b, el('div', 'vv', r.label)); return d;
      }));
    }
    vs.classList.toggle('low', sh.versus.pos === 'low');
    vs.style.opacity = sh.a * free;
  } else vs.style.opacity = 0;
  // the whole map stays clean: plan cards, decision view and feed step aside while it shows
  if (sh.clean) for (const id of ['#sc0', '#sc1', '#split', '#feed']) { const e = $(id); e.style.opacity = (e.style.opacity === '' ? 1 : +e.style.opacity) * (1 - sh.a); }
  // what a model saw (the small map at the left) lies where the feed runs: the feed steps aside before the map is a quarter in
  if (INSET_ON && sh.inset) { const e = $('#feed'); e.style.opacity = (e.style.opacity === '' ? 1 : +e.style.opacity) * (1 - Math.min(1, 4 * sh.a)); }
  if (INSET_ON && sh.inset) {
    const I = sh.inset;
    ins.style.display = 'block'; ins.style.opacity = sh.a; ins.classList.toggle('shift', !!(ui.story && ui.story.split && ui.story.split.a > 0)); ins.style.setProperty('--tc', col(I.p));
    if (insetKey !== I.key) {
      insetKey = I.key;
      ins.querySelector('.it').textContent = `WHAT ${init.players[I.p - 1].name.replace(/^.*\(([^)]*)\)\s*$/, '$1').toUpperCase()} SAW WHEN IT DECIDED  ${clockOfTick(I.tick)}`;
      ins.querySelector('.ib').textContent = `${I.n} enemy ${I.n === 1 ? 'unit' : 'units'} in view${I.workers ? `, ${I.workers} of them ${I.workers === 1 ? 'a worker' : 'workers'}` : ''}`;
      const cv = ins.querySelector('canvas'), cx = cv.getContext('2d'), S = I.size, [bx, bz, bs] = I.box, px = cv.width / bs;
      const raw = atob(I.fog);
      cx.fillStyle = '#05080c'; cx.fillRect(0, 0, cv.width, cv.height);
      for (let i = 0; i < raw.length; i++) { const v = raw.charCodeAt(i); if (!v) continue; const x = i % S, z = Math.floor(i / S); if (x < bx - 1 || z < bz - 1 || x > bx + bs || z > bz + bs) continue; cx.fillStyle = v === 2 ? '#476b43' : '#1f3027'; cx.fillRect((x - bx) * px, (z - bz) * px, px + 0.6, px + 0.6); }
      const dot = (x, z, r, c) => { cx.fillStyle = c; cx.beginPath(); cx.arc((x - bx) * px, (z - bz) * px, r, 0, 7); cx.fill(); };
      for (const u of I.own) dot(u[0], u[1], 4, col(I.p));
      for (const u of I.enemy) { dot(u[0], u[1], u[2] ? 7 : 6, col(3 - I.p)); if (u[2]) { cx.strokeStyle = '#fff'; cx.lineWidth = 2.5; cx.beginPath(); cx.arc((u[0] - bx) * px, (u[1] - bz) * px, 10, 0, 7); cx.stroke(); } }
    }
  } else ins.style.display = 'none';
}
const INSET_ON = new URLSearchParams(location.search).get('inset') === '1'; // A1 (05.11.): the small map "WHAT ... SAW WHEN IT DECIDED" is off unless the page gets inset=1
const clockOfTick = (t) => { const s = Math.floor(t / 10); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
function drawMarks(ui) {
  const cv = $('#marks'), sh = ui.show || { marks: [], labels: [], a: 0 }, pills = H.markerLabels();
  if (!sh.marks.length && !sh.labels.length && !pills.length) { cv.style.display = 'none'; return; }
  const r = $('#view').getBoundingClientRect();
  if (cv.width !== Math.round(r.width) || cv.height !== Math.round(r.height)) { cv.width = Math.round(r.width); cv.height = Math.round(r.height); }
  cv.style.display = 'block';
  cv.style.opacity = String(+((1 - winnerBanner(ui)) * (1 - endA(ui))).toFixed(3)); // the moment of the winner stays clean: rings and labels leave as the banner comes in
  const cx = cv.getContext('2d'), W = cv.width, Hh = cv.height;
  cx.clearRect(0, 0, W, Hh);
  const col = (o) => (o && init.players[o - 1] ? init.players[o - 1].color : '#f5c453');
  // fog of war view: the frame of the map and every ring wear the colour of the side whose eyes these are (never the yellow of a plain highlight): each line says whose it is
  const fogSide = sh.view && sh.view.a > 0 ? sh.view : null;
  const ringCol = (o) => (fogSide ? col(o) : '#ffe066');
  const edge = sh.clean && init.size ? [[0, 0], [init.size, 0], [init.size, init.size], [0, init.size]] : [];
  const pts = edge.map(([x, z]) => ({ x, z }));
  for (const m of sh.marks) { const rr = m.k === 'b' ? (m.r || 3) * 1.05 : 0.9; pts.push({ x: m.x, z: m.z }, { x: m.x + rr, z: m.z }); }
  for (const l of [...sh.labels, ...pills]) pts.push({ x: l.x, z: l.z, h: l.h || 3 });
  const P = H.project(pts);
  cx.globalAlpha = sh.a;
  let i = edge.length;
  // the whole map: what lies beyond its edge is backdrop for low views only, a dark ground hides it
  if (edge.length && P.slice(0, edge.length).every((p) => p[2] <= 1)) {
    const poly = () => P.slice(0, edge.length).forEach(([px, py], k) => (k ? cx.lineTo(px * W, py * Hh) : cx.moveTo(px * W, py * Hh)));
    cx.beginPath(); cx.rect(0, 0, W, Hh); poly(); cx.closePath();
    cx.fillStyle = '#0a0e14'; cx.fill('evenodd');
    cx.beginPath(); poly(); cx.closePath();
    cx.lineWidth = 3; cx.strokeStyle = fogSide ? col(fogSide.p) : 'rgba(77,141,255,0.7)'; cx.globalAlpha = fogSide ? sh.a * 0.85 : sh.a; cx.stroke(); cx.globalAlpha = sh.a;
  }
  // the units of one side: one outline around the group, a ring each only for a few (tools: render/mark-hull.mjs)
  const onScreen = (a) => !(a[2] > 1 || a[0] < -0.1 || a[0] > 1.1 || a[1] < -0.1 || a[1] > 1.1);
  const groups = new Map();
  for (const m of sh.marks) {
    const a = P[i++], b = P[i++];
    if (!onScreen(a)) continue;
    if (m.k === 'u') { if (!groups.has(m.o)) groups.set(m.o, []); groups.get(m.o).push({ a, b }); continue; }
    // a building: a clean ring on the ground around it, no fill (the building stays visible)
    const rx = Math.max(11, Math.hypot((b[0] - a[0]) * W, (b[1] - a[1]) * Hh)), ry = rx * 0.5;
    cx.beginPath(); cx.ellipse(a[0] * W, a[1] * Hh, rx, ry, 0, 0, 7);
    cx.lineWidth = 7; cx.strokeStyle = '#000'; cx.globalAlpha = sh.a * 0.6; cx.stroke(); cx.globalAlpha = sh.a;
    cx.lineWidth = fogSide ? 5 : 3.5; cx.strokeStyle = ringCol(m.o); cx.stroke();
  }
  for (const [o, us] of groups) {
    const hull = groupOutline(us.map((u) => [u.a[0] * W, u.a[1] * Hh]));
    cx.beginPath();
    if (hull) {
      const n = hull.length, mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], s0 = mid(hull[n - 1], hull[0]);
      cx.moveTo(s0[0], s0[1]);
      for (let k = 0; k < n; k++) { const e = mid(hull[k], hull[(k + 1) % n]); cx.quadraticCurveTo(hull[k][0], hull[k][1], e[0], e[1]); }
      cx.closePath();
    } else for (const u of us) {
      const rx = Math.max(11, Math.hypot((u.b[0] - u.a[0]) * W, (u.b[1] - u.a[1]) * Hh));
      cx.moveTo(u.a[0] * W + rx, u.a[1] * Hh); cx.ellipse(u.a[0] * W, u.a[1] * Hh, rx, rx * 0.5, 0, 0, 7);
    }
    cx.fillStyle = col(o) + '26'; cx.fill();
    cx.lineWidth = 6; cx.strokeStyle = '#000'; cx.globalAlpha = sh.a * 0.6; cx.stroke(); cx.globalAlpha = sh.a;
    cx.lineWidth = fogSide ? 4.5 : 3; cx.strokeStyle = ringCol(o); cx.stroke();
  }
  cx.font = '800 26px "JetBrains Mono", Menlo, monospace'; cx.textBaseline = 'middle';
  const boxes = [];
  const boxOf = (l, alpha) => {
    const a = P[i++];
    if (a[2] > 1 || a[0] < 0 || a[0] > 1 || a[1] < 0 || a[1] > 1) return null;
    const tw = cx.measureText(l.text).width;
    return { x: Math.max(8, Math.min(W - tw - 32, a[0] * W - tw / 2 - 12)), y: Math.max(40, a[1] * Hh - 26) - 20, w: tw + 24, h: 40, l, alpha };
  };
  for (const l of sh.labels) { const b = boxOf(l, sh.a); if (b) boxes.push(b); }
  for (const l of pills) { // a group that already carries its own label needs no second one on top: the arrow tells what it does
    const b = boxOf(l, l.a);
    if (b && !boxes.some((q) => q.l.o === l.o && b.x < q.x + q.w && q.x < b.x + b.w && b.y < q.y + q.h && q.y < b.y + b.h)) boxes.push(b);
  }
  // a label never lies on a speech bubble (NDC of the picture -> pixels of this canvas)
  const bubbles = ((window.__rts && window.__rts.bubbleBoxes) || []).map((n) => ({ x: ((n.x0 + 1) / 2) * W, y: ((1 - n.y1) / 2) * Hh, w: ((n.x1 - n.x0) / 2) * W, h: ((n.y1 - n.y0) / 2) * Hh }));
  for (const b of spreadLabels(boxes, 4, [...overlayBoxes(document, r, sh.clean ? LABEL_AVOID_CLEAN : LABEL_AVOID), ...bubbles])) {
    if (b.blocked) continue;
    cx.globalAlpha = b.alpha;
    cx.fillStyle = 'rgba(10,14,20,0.92)'; cx.strokeStyle = col(b.l.o); cx.lineWidth = 3;
    cx.beginPath(); cx.roundRect(b.x, b.y, b.w, b.h, 10); cx.fill(); cx.stroke();
    cx.fillStyle = '#fff'; cx.fillText(b.l.text, b.x + 12, b.y + 21);
  }
  cx.globalAlpha = 1;
}

window.__bc = {
  setup,
  faults: () => layoutFaults(document),
  // f: { snaps: [snapshot, ...] (ingested in order), alpha, animT, dt, cam, ui }
  frame(f) {
    for (const s of f.snaps) H.snap(s);
    updateHud(H.current, f.ui);
    if (!fitted) { fitted = true; fitNames(panels.length); }
    for (let i = 0; i < panels.length; i++) lateFit($(`#pn${i} .pname`)); // also in the very first frame (it is the thumbnail)
    updateOverlay(f.ui);
    updateShow(f.ui);
    if (f.fog && f.fog.data) H.fog(f.fog.data);
    H.fogView(f.fog ? f.fog.p : 0, f.fog ? f.fog.a : 0);
    H.marksView(!!(f.ui.show && f.ui.show.clean) || winnerBanner(f.ui) > 0 || !!f.ui.end);
    $('#mom').classList.toggle('nofog', !(f.fog && f.fog.a > 0)); // the chip on a decision card tells what the picture shows
    H.render(f.alpha, f.animT, f.dt, f.cam);
    drawMarks(f.ui);
    return true;
  },
};
window.__bcReady = true;
