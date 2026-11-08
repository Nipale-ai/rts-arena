// World editor: paint a map on a 2D canvas, place resources, relic shrines and starts, check fairness, save as rts-map-1 JSON in the arena.
import { $, el, api, COLORS, header } from './common.js';
import { displayName } from '/theme/display-name.mjs'; // served by server/arena.mjs from render/theme/
import { bindThemeFromSearch } from '/theme/page-theme.mjs'; // /editor?theme=dustmoon-v1: the unit and building names of the Place list speak that theme (no ?theme=: classic)
await bindThemeFromSearch(location.search);

const cat = await api('/api/maps/catalog');
const TC = cat.town_center_size;
const CHARS = ['.', 'f', '~', '#'];
const TERRAIN = [
  { v: 0, name: 'Grass', col: '#35553a' }, { v: 1, name: 'Forest', col: '#1b3a28' },
  { v: 2, name: 'Water', col: '#22507f' }, { v: 3, name: 'Cliff', col: '#7b8494' },
];
const NODE_COL = { gold: '#f5c453', stone: '#b4bccb', berries: '#ff6b8b', herd: '#d9a066' };
const NODE_NAME = { gold: 'Gold', stone: 'Stone', berries: 'Berries', herd: 'Herd' };
const SHRINE = cat.shrine, SHRINE_COL = '#b79cff';

// symmetry: list of [mask, transform]. Player k is mapped to player k^mask by the transform (player 0 is the master).
const flipX = (N, x, y, s) => [N - x - s, y];
const flipY = (N, x, y, s) => [x, N - y - s];
const flipXY = (N, x, y, s) => [N - x - s, N - y - s];
const SYMS = {
  none: { label: 'None', np: null, tfs: [] },
  'mirror-x': { label: 'Mirror left / right', np: 2, tfs: [[1, flipX]] },
  'mirror-y': { label: 'Mirror top / bottom', np: 2, tfs: [[1, flipY]] },
  point: { label: 'Rotate 180 degrees', np: 2, tfs: [[1, flipXY]] },
  quad: { label: '4-way mirror', np: 4, tfs: [[1, flipX], [2, flipY], [3, flipXY]] },
};

// ------------------------------------------------------------------ state
const S = { mapType: 'meadow', id: null, name: 'My map', N: 96, T: null, nodes: [], shrines: [], players: [], np: 2, sym: 'point', custom: false, dirty: false, check: null };
let tool = { kind: 'terrain', mode: 'brush', value: 1 };
let brush = 3, nodeAmount = null, itemType = 'worker', itemPlayer = 0, startPlayer = 0;
let undoStack = [], redoStack = [];

const idx = (x, y) => y * S.N + x;
const inb = (x, y) => x >= 0 && y >= 0 && x < S.N && y < S.N;
const copies = (x, y, s) => [[x, y, 0], ...SYMS[S.sym].tfs.map(([m, f]) => { const [a, b] = f(S.N, x, y, s); return [a, b, m]; })];

function snapshot() { return JSON.stringify({ T: Array.from(S.T), nodes: S.nodes, shrines: S.shrines, players: S.players, np: S.np, sym: S.sym, custom: S.custom }); }
function restore(s) { const o = JSON.parse(s); S.T = Uint8Array.from(o.T); S.nodes = o.nodes; S.shrines = o.shrines; S.players = o.players; S.np = o.np; S.sym = o.sym; S.custom = o.custom; syncUi(); }
function pushUndo() { undoStack.push(snapshot()); if (undoStack.length > 60) undoStack.shift(); redoStack = []; }
function changed() { S.dirty = true; draw(true); scheduleCheck(); updateStatus(); }
function undo() { if (!undoStack.length) return; redoStack.push(snapshot()); restore(undoStack.pop()); S.dirty = true; draw(true); scheduleCheck(); }
function redo() { if (!redoStack.length) return; undoStack.push(snapshot()); restore(redoStack.pop()); S.dirty = true; draw(true); scheduleCheck(); }

// ------------------------------------------------------------------ map model
function newMap({ N, np, sym, generated }) {
  S.N = N; S.np = np; S.sym = sym; S.id = null; S.custom = false;
  S.T = new Uint8Array(N * N); S.nodes = []; S.shrines = []; S.players = [];
  if (generated) {
    const m = generated;
    S.T = new Uint8Array(N * N);
    m.terrain.forEach((r, y) => { for (let x = 0; x < N; x++) S.T[y * N + x] = Math.max(0, CHARS.indexOf(r[x])); });
    S.nodes = m.nodes.map((n) => ({ ...n }));
    S.shrines = (m.shrines || []).map((q) => ({ ...q }));
    S.players = m.players.map((p) => ({ tx: p.start.tx, ty: p.start.ty, buildings: null, units: null }));
  } else {
    placeStarts(10, 10, 0, false);
  }
  S.dirty = false;
}

function placeStarts(x, y, k, withUndo = true) {
  if (withUndo) pushUndo();
  x = Math.max(1, Math.min(S.N - TC - 1, x)); y = Math.max(1, Math.min(S.N - TC - 1, y));
  const np = SYMS[S.sym].np || S.np;
  S.np = np;
  while (S.players.length < np) S.players.push({ tx: 0, ty: 0, buildings: null, units: null });
  S.players.length = np;
  const spots = S.sym === 'none' ? [[x, y, k]] : copies(x, y, TC).map(([a, b, m]) => [a, b, k ^ m]);
  if (S.sym === 'none') {
    // fresh map: put the other starts into the far corners so every player has a spot
    if (!S.players.every((p, i) => i === k || p.tx || p.ty)) {
      const corners = [[10, 10], [S.N - TC - 10, S.N - TC - 10], [S.N - TC - 10, 10], [10, S.N - TC - 10]];
      S.players.forEach((p, i) => { if (i !== k && !p.tx && !p.ty) { [p.tx, p.ty] = corners[i]; clearRect(p.tx - 1, p.ty - 1, TC + 2, TC + 2, 0); } });
    }
  }
  for (const [a, b, pk] of spots) {
    if (pk >= np) continue;
    const p = S.players[pk];
    const oldX = p.tx, oldY = p.ty;
    p.tx = a; p.ty = b;
    clearRect(a - 1, b - 1, TC + 2, TC + 2, 0);
    S.nodes = S.nodes.filter((n) => !overlap(n.tx, n.ty, cat.nodes[n.res].size, a, b, TC));
    S.shrines = S.shrines.filter((q) => !overlap(q.tx, q.ty, SHRINE.size, a, b, TC));
    if (p.buildings) { const tcb = p.buildings.find((q) => q.type === 'town_center' && q.tx === oldX && q.ty === oldY); if (tcb) { tcb.tx = a; tcb.ty = b; } else p.buildings.push({ type: 'town_center', tx: a, ty: b }); }
  }
  if (withUndo) changed();
}
const overlap = (ax, ay, sa, bx, by, sb) => ax < bx + sb && bx < ax + sa && ay < by + sb && by < ay + sa;
function clearRect(x, y, w, h, v) { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (inb(i, j)) S.T[idx(i, j)] = v; }

function toMap() {
  const rows = [];
  for (let y = 0; y < S.N; y++) { let r = ''; for (let x = 0; x < S.N; x++) r += CHARS[S.T[idx(x, y)]]; rows.push(r); }
  return {
    format: 'rts-map-1', name: nameInput.value.trim() || 'Untitled map', size: S.N, terrain: rows,
    nodes: S.nodes.map((n) => ({ res: n.res, tx: n.tx, ty: n.ty, amount: n.amount })),
    ...(S.shrines.length ? { shrines: S.shrines.map((q) => ({ tx: q.tx, ty: q.ty })) } : {}),
    players: S.players.map((p) => ({ start: { tx: p.tx, ty: p.ty }, ...(S.custom && p.buildings ? { buildings: p.buildings } : {}), ...(S.custom && p.units ? { units: p.units } : {}) })),
    symmetry: S.sym === 'none' ? null : S.sym,
    ...(S.mapType && S.mapType !== 'meadow' ? { mapType: S.mapType } : {}),
  };
}
function fromMap(m, id) {
  S.id = id || null; S.N = m.size; S.T = new Uint8Array(S.N * S.N);
  m.terrain.forEach((r, y) => { for (let x = 0; x < S.N; x++) S.T[y * S.N + x] = Math.max(0, CHARS.indexOf(r[x])); });
  S.nodes = (m.nodes || []).map((n) => ({ ...n }));
  S.shrines = (m.shrines || []).map((q) => ({ ...q }));
  S.players = m.players.map((p) => ({ tx: p.start.tx, ty: p.start.ty, buildings: p.buildings || null, units: p.units || null }));
  S.np = S.players.length; S.custom = S.players.some((p) => p.buildings || p.units);
  S.sym = SYMS[m.symmetry] ? m.symmetry : 'none';
  nameInput.value = m.name || 'My map';
  S.mapType = m.mapType || 'meadow'; typeSel.value = S.mapType;
  S.dirty = false; undoStack = []; redoStack = [];
  syncUi(); draw(true); scheduleCheck(true);
}

// ------------------------------------------------------------------ editing actions
function setTile(x, y, v) { for (const [a, b] of copies(x, y, 1)) if (inb(a, b)) S.T[idx(a, b)] = v; }
function stamp(cx, cy, v) {
  const r = brush, lo = -Math.floor(r / 2), hi = lo + r - 1;
  for (let j = lo; j <= hi; j++) for (let i = lo; i <= hi; i++) {
    if (r > 2 && (i + 0.5 + lo) ** 2 + (j + 0.5 + lo) ** 2 > (r / 2 + 0.3) ** 2) continue; // round brush
    if (inb(cx + i, cy + j)) setTile(cx + i, cy + j, v);
  }
}
function line(x0, y0, x1, y1, fn) {
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    fn(x0, y0);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}
function fillArea(x, y, v) {
  const from = S.T[idx(x, y)];
  if (from === v) return;
  const q = [[x, y]];
  const seen = new Uint8Array(S.N * S.N);
  while (q.length) {
    const [a, b] = q.pop();
    if (!inb(a, b) || seen[idx(a, b)] || S.T[idx(a, b)] !== from) continue;
    seen[idx(a, b)] = 1;
    setTile(a, b, v);
    q.push([a + 1, b], [a - 1, b], [a, b + 1], [a, b - 1]);
  }
}
function placeNode(res, x, y) {
  const s = cat.nodes[res].size;
  x -= Math.floor((s - 1) / 2); y -= Math.floor((s - 1) / 2);
  const amount = nodeAmount ?? cat.nodes[res].amount;
  let n = 0;
  for (const [a, b] of copies(x, y, s)) {
    if (a < 0 || b < 0 || a + s > S.N || b + s > S.N) continue;
    if (S.players.some((p) => overlap(a, b, s, p.tx, p.ty, TC))) continue;
    S.nodes = S.nodes.filter((q) => !overlap(q.tx, q.ty, cat.nodes[q.res].size, a, b, s));
    S.shrines = S.shrines.filter((q) => !overlap(q.tx, q.ty, SHRINE.size, a, b, s));
    clearRect(a, b, s, s, 0);
    S.nodes.push({ res, tx: a, ty: b, amount });
    n++;
  }
  return n;
}
// A relic shrine and its mirror copies, on open grass. A spot on the centre of a symmetry is its own copy, so that gives one shrine. All or none: a
// map stays fair, so when a copy does not fit (over the edge, on a start, over the limit of the map format) nothing is placed.
function placeShrine(x, y) {
  const s = SHRINE.size, spots = [];
  for (const [a, b] of copies(x, y, s)) if (!spots.some(([p, q]) => p === a && q === b)) spots.push([a, b]);
  if (spots.some(([a, b]) => a < 0 || b < 0 || a + s > S.N || b + s > S.N || S.players.some((p) => overlap(a, b, s, p.tx, p.ty, TC)))) { toast('No room for a shrine here: edge of the map or a start'); return false; }
  const rest = S.shrines.filter((q) => !spots.some(([a, b]) => overlap(q.tx, q.ty, s, a, b, s)));
  if (rest.length + spots.length > SHRINE.max) { toast(`A map holds at most ${SHRINE.max} relic shrines`); return false; }
  S.shrines = rest;
  for (const [a, b] of spots) {
    S.nodes = S.nodes.filter((q) => !overlap(q.tx, q.ty, cat.nodes[q.res].size, a, b, s));
    clearRect(a, b, s, s, 0);
    S.shrines.push({ tx: a, ty: b });
  }
  return true;
}
function eraseAt(x, y) {
  for (const [a, b, m] of copies(x, y, 1)) {
    S.shrines = S.shrines.filter((q) => !(a >= q.tx && b >= q.ty && a < q.tx + SHRINE.size && b < q.ty + SHRINE.size));
    S.nodes = S.nodes.filter((n) => !(a >= n.tx && b >= n.ty && a < n.tx + cat.nodes[n.res].size && b < n.ty + cat.nodes[n.res].size));
    if (S.custom) for (const p of S.players) {
      p.units = (p.units || []).filter((u) => !(u.tx === a && u.ty === b));
      p.buildings = (p.buildings || []).filter((q) => !(q.type !== 'town_center' && a >= q.tx && b >= q.ty && a < q.tx + cat.buildings[q.type].size && b < q.ty + cat.buildings[q.type].size));
    }
    void m;
  }
}
function placeItem(x, y) {
  if (!S.custom) { toast('Turn on "Custom start" first'); return; }
  const isB = !!cat.buildings[itemType];
  const s = isB ? cat.buildings[itemType].size : 1;
  if (isB && itemType === 'town_center') { toast('The town centre is placed with the Start tool'); return; }
  if (isB) { x -= Math.floor((s - 1) / 2); y -= Math.floor((s - 1) / 2); }
  const list = SYMS[S.sym].tfs.length ? copies(x, y, s).map(([a, b, m]) => [a, b, itemPlayer ^ m]) : [[x, y, itemPlayer]];
  for (const [a, b, k] of list) {
    const p = S.players[k];
    if (!p || a < 0 || b < 0 || a + s > S.N || b + s > S.N) continue;
    if (isB) { p.buildings = p.buildings || []; p.buildings = p.buildings.filter((q) => !overlap(q.tx, q.ty, cat.buildings[q.type].size, a, b, s)); clearRect(a, b, s, s, 0); p.buildings.push({ type: itemType, tx: a, ty: b }); }
    else { p.units = (p.units || []).filter((u) => !(u.tx === a && u.ty === b)); if (S.T[idx(a, b)] === 0) p.units.push({ type: itemType, tx: a, ty: b }); }
  }
}
function setCustom(on) {
  pushUndo();
  S.custom = on;
  if (!on) { for (const p of S.players) { p.buildings = null; p.units = null; } } else {
    const free = (x, y) => inb(x, y) && S.T[idx(x, y)] === 0 && !S.nodes.some((n) => x >= n.tx && y >= n.ty && x < n.tx + cat.nodes[n.res].size && y < n.ty + cat.nodes[n.res].size);
    const spots = (p) => {
      const c = [];
      for (let j = -3; j < TC + 3; j++) for (let i = -3; i < TC + 3; i++) if (!(i >= 0 && i < TC && j >= 0 && j < TC) && free(p.tx + i, p.ty + j)) c.push([i, j, (i - TC / 2 + .5) ** 2 + (j - TC / 2 + .5) ** 2]);
      c.sort((u, v) => u[2] - v[2] || u[1] - v[1] || u[0] - v[0]);
      return c.slice(0, 6).map(([i, j]) => ({ type: 'worker', tx: p.tx + i, ty: p.ty + j }));
    };
    S.players.forEach((p, k) => {
      p.buildings = [{ type: 'town_center', tx: p.tx, ty: p.ty }];
      p.units = SYMS[S.sym].tfs.length && k > 0 ? [] : spots(p);
    });
    if (SYMS[S.sym].tfs.length) { // mirror the master's workers so every player has the mirrored layout
      const m0 = S.players[0].units;
      for (const [mask, f] of SYMS[S.sym].tfs) if (S.players[mask]) S.players[mask].units = m0.map((u) => { const [a, b] = f(S.N, u.tx, u.ty, 1); return { ...u, tx: a, ty: b }; });
    }
  }
  syncUi(); changed();
}
// copy the master region onto the rest of the map (terrain, resources, relic shrines, starts)
function makeSymmetric() {
  const sym = SYMS[S.sym];
  if (!sym.tfs.length) { toast('Pick a symmetry first'); return; }
  pushUndo();
  const N = S.N, half = N / 2;
  const inMaster = (x, y) => (S.sym === 'mirror-x' ? x < half : S.sym === 'mirror-y' ? y < half : S.sym === 'point' ? y < half || (y === half && x < half) : x < half && y < half);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (inMaster(x, y)) for (const [, f] of sym.tfs) { const [a, b] = f(N, x, y, 1); S.T[idx(a, b)] = S.T[idx(x, y)]; }
  const master = S.nodes.filter((n) => inMaster(n.tx + (cat.nodes[n.res].size - 1) / 2, n.ty + (cat.nodes[n.res].size - 1) / 2));
  S.nodes = master.map((n) => ({ ...n }));
  for (const n of master) { const s = cat.nodes[n.res].size; for (const [, f] of sym.tfs) { const [a, b] = f(N, n.tx, n.ty, s); S.nodes.push({ res: n.res, tx: a, ty: b, amount: n.amount }); } }
  const sz = (SHRINE.size - 1) / 2, kept = new Map();
  for (const q of S.shrines) if (inMaster(q.tx + sz, q.ty + sz) || (q.tx + sz === (N - 1) / 2 && q.ty + sz === (N - 1) / 2)) for (const [a, b] of [[q.tx, q.ty], ...sym.tfs.map(([, f]) => f(N, q.tx, q.ty, SHRINE.size))]) kept.set(b * N + a, { tx: a, ty: b });
  S.shrines = [...kept.values()];
  const p0 = S.players[0];
  placeStarts(p0.tx, p0.ty, 0, false);
  if (S.custom) { S.custom = false; setCustomNoUndo(); }
  changed(); toast('Copied the master part onto the rest of the map');
}
function setCustomNoUndo() { const keep = undoStack.length; setCustom(true); undoStack.length = keep; }

// ------------------------------------------------------------------ UI: top bar
const app = $('#app');
const nameInput = el('input', { value: S.name, maxlength: 60, placeholder: 'Map name', oninput: () => { S.dirty = true; updateStatus(); } });
const typeSel = el('select', { title: 'Look, weather and resources of the map. Coast: ships and harbors need a big lake or sea.', onchange: () => { S.mapType = typeSel.value; S.dirty = true; updateStatus(); } }, ['meadow', 'forest', 'desert', 'winter', 'coast'].map((v) => el('option', { value: v }, v)));
const mapPick = el('select', { onchange: async () => { if (!mapPick.value) return; if (S.dirty && !confirm('Discard unsaved changes?')) { mapPick.value = ''; return; } await openMap(mapPick.value); mapPick.value = ''; } });
const bar = el('div', { class: 'topbar' },
  el('label', { class: 'grow' }, 'Map name', nameInput),
  el('label', {}, 'Type ', typeSel),
  el('button', { class: 'btn primary', type: 'button', onclick: () => save() }, 'Save'),
  el('button', { class: 'btn', type: 'button', onclick: () => save(true) }, 'Save as new'),
  el('button', { class: 'btn', type: 'button', onclick: () => newDialog() }, 'New map ...'),
  el('label', {}, 'Open saved map', mapPick),
  el('button', { class: 'btn', type: 'button', onclick: () => undo() }, 'Undo'),
  el('button', { class: 'btn', type: 'button', onclick: () => redo() }, 'Redo'));

// ------------------------------------------------------------------ UI: tools
const termBtns = TERRAIN.map((t) => el('button', { class: 'tbtn', type: 'button', onclick: () => { tool = { kind: 'terrain', mode: modeSel, value: t.v }; syncUi(); } }, el('i', { class: 'sw', style: `background:${t.col}` }), t.name));
let modeSel = 'brush';
const modeBtns = [['brush', 'Brush'], ['line', 'Line'], ['rect', 'Box'], ['fill', 'Fill']].map(([m, l]) => el('button', { class: 'tbtn', type: 'button', 'data-m': m, onclick: () => { modeSel = m; if (tool.kind === 'terrain') tool.mode = m; else tool = { kind: 'terrain', mode: m, value: 1 }; syncUi(); } }, l));
const brushSel = el('select', { onchange: () => { brush = +brushSel.value; } }, [1, 3, 5, 9, 15].map((b) => el('option', { value: b, ...(b === 3 ? { selected: true } : {}) }, `${b} x ${b} tiles`)));
const nodeBtns = Object.keys(cat.nodes).map((r) => el('button', { class: 'tbtn', type: 'button', 'data-r': r, onclick: () => { tool = { kind: 'node', res: r }; nodeAmountInput.value = ''; nodeAmount = null; nodeAmountInput.placeholder = String(cat.nodes[r].amount); syncUi(); } }, el('i', { class: 'sw', style: `background:${NODE_COL[r]}` }), NODE_NAME[r]));
const nodeAmountInput = el('input', { type: 'number', min: 1, step: 50, placeholder: 'default', oninput: () => { nodeAmount = nodeAmountInput.value ? Math.max(1, +nodeAmountInput.value) : null; } });
const shrineBtn = el('button', { class: 'tbtn', type: 'button', onclick: () => { tool = { kind: 'shrine' }; syncUi(); } }, el('i', { class: 'sw', style: `background:${SHRINE_COL}` }), 'Shrine');
const startBtns = [0, 1, 2, 3].map((k) => el('button', { class: 'tbtn', type: 'button', 'data-p': k, onclick: () => { tool = { kind: 'start' }; startPlayer = k; syncUi(); } }, el('i', { class: 'sw', style: `background:${COLORS[k]}` }), `Player ${k + 1}`));
const symSel = el('select', { onchange: () => setSym(symSel.value) }, Object.entries(SYMS).map(([k, v]) => el('option', { value: k }, v.label)));
const npSel = el('select', { onchange: () => { pushUndo(); S.np = +npSel.value; while (S.players.length < S.np) S.players.push({ tx: 0, ty: 0, buildings: null, units: null }); S.players.length = S.np; const p0 = S.players[0]; placeStarts(p0.tx, p0.ty, 0, false); changed(); syncUi(); } }, [2, 4].map((n) => el('option', { value: n }, `${n} players`)));
const customChk = el('input', { type: 'checkbox', onchange: () => setCustom(customChk.checked) });
const itemSel = el('select', { onchange: () => { itemType = itemSel.value; tool = { kind: 'item' }; syncUi(); } },
  el('optgroup', { label: 'Units' }, cat.units.map((u) => el('option', { value: u }, displayName('unit', u)))),
  el('optgroup', { label: 'Buildings' }, Object.keys(cat.buildings).filter((b) => b !== 'town_center').map((b) => el('option', { value: b }, displayName('building', b)))));
const itemPlayerSel = el('select', { onchange: () => { itemPlayer = +itemPlayerSel.value; } }, [0, 1, 2, 3].map((k) => el('option', { value: k }, `for player ${k + 1}`)));
const itemBtn = el('button', { class: 'tbtn', type: 'button', onclick: () => { tool = { kind: 'item' }; syncUi(); } }, 'Place');
const eraseBtn = el('button', { class: 'tbtn', type: 'button', onclick: () => { tool = { kind: 'erase' }; syncUi(); } }, 'Remove objects');
const toolsCol = el('div', { class: 'panel tools' },
  el('h2', {}, 'Terrain'), el('div', { class: 'tgrid' }, termBtns),
  el('label', {}, 'Draw with'), el('div', { class: 'tgrid c4' }, modeBtns),
  el('label', {}, 'Brush size'), brushSel,
  el('h2', {}, 'Resources'), el('div', { class: 'tgrid' }, nodeBtns),
  el('label', {}, 'Amount (empty = default)'), nodeAmountInput,
  el('h2', {}, 'Objectives'), el('div', { class: 'tgrid' }, shrineBtn),
  el('p', { class: 'hint' }, 'Hold a relic shrine to earn victory points. The first team to reach the target wins.'),
  el('h2', {}, 'Players'), npSel,
  el('label', {}, 'Symmetry'), symSel,
  el('p', { class: 'hint' }, 'Everything you draw is copied, so both sides stay equal. Fair maps are easy this way.'),
  el('button', { class: 'btn small', type: 'button', style: 'margin-top:8px', onclick: () => makeSymmetric() }, 'Copy master part onto the rest'),
  el('label', {}, 'Start positions'), el('div', { class: 'tgrid', id: 'startgrid' }, startBtns),
  el('h2', {}, 'Extras'),
  el('label', { class: 'chk' }, customChk, 'Custom start units and buildings'),
  el('p', { class: 'hint' }, 'Off: every player gets the normal start of the rules preset. On: you decide who starts with what.'),
  el('div', { id: 'itembox' }, el('label', {}, 'Item'), itemSel, el('label', {}, 'Owner'), itemPlayerSel, el('div', { class: 'tgrid', style: 'margin-top:8px' }, itemBtn)),
  el('div', { class: 'tgrid', style: 'margin-top:12px' }, eraseBtn));

function syncUi() {
  const t = tool;
  termBtns.forEach((b, i) => b.classList.toggle('on', t.kind === 'terrain' && t.value === i));
  modeBtns.forEach((b) => b.classList.toggle('on', t.kind === 'terrain' && t.mode === b.dataset.m));
  nodeBtns.forEach((b) => b.classList.toggle('on', t.kind === 'node' && t.res === b.dataset.r));
  shrineBtn.classList.toggle('on', t.kind === 'shrine');
  startBtns.forEach((b, k) => { b.classList.toggle('on', t.kind === 'start' && (S.sym !== 'none' ? k === 0 : startPlayer === k)); b.style.display = k < S.np && (S.sym === 'none' || k === 0) ? '' : 'none'; if (S.sym !== 'none' && k === 0) b.lastChild.textContent = 'Place starts'; else b.lastChild.textContent = `Player ${k + 1}`; });
  itemBtn.classList.toggle('on', t.kind === 'item');
  eraseBtn.classList.toggle('on', t.kind === 'erase');
  symSel.value = S.sym; npSel.value = String(S.np); npSel.disabled = S.sym !== 'none';
  customChk.checked = S.custom;
  $('#itembox').style.display = S.custom ? '' : 'none';
  [...itemPlayerSel.options].forEach((o, k) => { o.hidden = k >= S.np; });
  if (itemPlayer >= S.np) { itemPlayer = 0; itemPlayerSel.value = '0'; }
  updateStatus();
}
function setSym(k) {
  pushUndo();
  S.sym = k;
  const np = SYMS[k].np;
  if (np && np !== S.np) { S.np = np; }
  if (k !== 'none') { const p0 = S.players[0]; placeStarts(p0.tx, p0.ty, 0, false); } else { S.players.length = S.np; }
  syncUi(); changed();
  if (k !== 'none') toast('Starts mirrored. Use "Copy master part onto the rest" to make the existing drawing symmetric.');
}

// ------------------------------------------------------------------ canvas
const cv = el('canvas', { id: 'cv' });
const ctx = cv.getContext('2d');
const tcv = document.createElement('canvas');
const status = el('div', { class: 'status' });
const center = el('div', { class: 'canvaswrap' }, cv, status);
let scale = 8, hover = null, drag = null, dirtyTerrain = true, raf = 0;

function sizeCanvas() {
  scale = Math.max(3, Math.floor(1000 / S.N));
  cv.width = S.N * scale; cv.height = S.N * scale;
  tcv.width = S.N; tcv.height = S.N;
  dirtyTerrain = true;
}
function paintTerrain() {
  const img = tcv.getContext('2d').createImageData(S.N, S.N);
  const rgb = TERRAIN.map((t) => [1, 3, 5].map((o) => parseInt(t.col.slice(o, o + 2), 16)));
  for (let y = 0; y < S.N; y++) for (let x = 0; x < S.N; x++) {
    const v = S.T[idx(x, y)], c = rgb[v], j = ((x * 7 + y * 13) % 5) * 2 - (v === 1 ? 0 : 4);
    const o = idx(x, y) * 4;
    img.data[o] = c[0] + j; img.data[o + 1] = c[1] + j; img.data[o + 2] = c[2] + j; img.data[o + 3] = 255;
  }
  tcv.getContext('2d').putImageData(img, 0, 0);
}
function draw(terrain) {
  if (terrain) dirtyTerrain = true;
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; render(); });
}
function render() {
  if (cv.width !== S.N * scale) sizeCanvas();
  if (dirtyTerrain) { paintTerrain(); dirtyTerrain = false; }
  const N = S.N, sc = scale;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tcv, 0, 0, N * sc, N * sc);
  if (sc >= 7) {
    ctx.strokeStyle = 'rgba(255,255,255,.05)'; ctx.lineWidth = 1; ctx.beginPath();
    for (let i = 0; i <= N; i++) { ctx.moveTo(i * sc + .5, 0); ctx.lineTo(i * sc + .5, N * sc); ctx.moveTo(0, i * sc + .5); ctx.lineTo(N * sc, i * sc + .5); }
    ctx.stroke();
  }
  // forest trees (small dots) for a readable look
  ctx.fillStyle = 'rgba(70,150,90,.55)';
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (S.T[idx(x, y)] === 1) { ctx.beginPath(); ctx.arc((x + .5) * sc, (y + .5) * sc, sc * .28, 0, 7); ctx.fill(); }
  // symmetry guides
  ctx.setLineDash([6, 6]); ctx.strokeStyle = 'rgba(77,141,255,.55)'; ctx.lineWidth = 1.5; ctx.beginPath();
  if (['mirror-x', 'quad'].includes(S.sym)) { ctx.moveTo(N * sc / 2, 0); ctx.lineTo(N * sc / 2, N * sc); }
  if (['mirror-y', 'quad'].includes(S.sym)) { ctx.moveTo(0, N * sc / 2); ctx.lineTo(N * sc, N * sc / 2); }
  ctx.stroke(); ctx.setLineDash([]);
  if (S.sym === 'point') { ctx.strokeStyle = 'rgba(77,141,255,.8)'; ctx.beginPath(); ctx.arc(N * sc / 2, N * sc / 2, 7, 0, 7); ctx.moveTo(N * sc / 2 - 12, N * sc / 2); ctx.lineTo(N * sc / 2 + 12, N * sc / 2); ctx.moveTo(N * sc / 2, N * sc / 2 - 12); ctx.lineTo(N * sc / 2, N * sc / 2 + 12); ctx.stroke(); }
  // nodes
  for (const n of S.nodes) {
    const s = cat.nodes[n.res].size, x = n.tx * sc, y = n.ty * sc, w = s * sc;
    ctx.fillStyle = NODE_COL[n.res]; ctx.strokeStyle = 'rgba(0,0,0,.65)'; ctx.lineWidth = 1.5;
    if (n.res === 'berries' || n.res === 'herd') { ctx.beginPath(); ctx.arc(x + w / 2, y + w / 2, w * .42, 0, 7); ctx.fill(); ctx.stroke(); } else { ctx.fillRect(x + 1, y + 1, w - 2, w - 2); ctx.strokeRect(x + 1, y + 1, w - 2, w - 2); }
    if (sc >= 8 && s >= 2) { ctx.fillStyle = 'rgba(0,0,0,.75)'; ctx.font = `700 ${sc * .68}px JetBrains Mono, monospace`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(n.amount >= 1000 ? (n.amount / 1000).toFixed(n.amount % 1000 ? 1 : 0) + 'k' : String(n.amount), x + w / 2, y + w / 2); }
  }
  // relic shrines: a diamond on the 2x2 site
  for (const q of S.shrines) {
    const w = SHRINE.size * sc, cx = q.tx * sc + w / 2, cy = q.ty * sc + w / 2, r = w * .48;
    ctx.fillStyle = SHRINE_COL; ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy); ctx.lineTo(cx, cy + r); ctx.lineTo(cx - r, cy); ctx.closePath(); ctx.fill(); ctx.stroke();
  }
  // players: start squares, pre-placed items
  S.players.forEach((p, k) => {
    const col = COLORS[k];
    for (const b of p.buildings || []) if (b.type !== 'town_center') { const s = cat.buildings[b.type].size; ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.fillStyle = col + '44'; ctx.fillRect(b.tx * sc, b.ty * sc, s * sc, s * sc); ctx.strokeRect(b.tx * sc + 1, b.ty * sc + 1, s * sc - 2, s * sc - 2); ctx.fillStyle = '#fff'; ctx.font = `700 ${Math.max(8, sc)}px Inter, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(b.type[0].toUpperCase(), (b.tx + s / 2) * sc, (b.ty + s / 2) * sc); }
    for (const u of p.units || []) { ctx.fillStyle = col; ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc((u.tx + .5) * sc, (u.ty + .5) * sc, Math.max(2.5, sc * .38), 0, 7); ctx.fill(); ctx.stroke(); if (u.type !== 'worker' && sc >= 6) { ctx.fillStyle = '#000'; ctx.font = `700 ${Math.max(7, sc * .7)}px Inter, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(u.type[0].toUpperCase(), (u.tx + .5) * sc, (u.ty + .5) * sc); } }
    ctx.fillStyle = col + 'cc'; ctx.fillRect(p.tx * sc, p.ty * sc, TC * sc, TC * sc);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.strokeRect(p.tx * sc + 1, p.ty * sc + 1, TC * sc - 2, TC * sc - 2);
    ctx.fillStyle = '#04101f'; ctx.font = `800 ${Math.max(12, TC * sc * .55)}px JetBrains Mono, monospace`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(k + 1), (p.tx + TC / 2) * sc, (p.ty + TC / 2) * sc);
  });
  // ghost
  if (hover) ghost();
  if (drag && (drag.mode === 'rect' || drag.mode === 'line')) {
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
    if (drag.mode === 'rect') { const [x0, y0, x1, y1] = [Math.min(drag.x0, hover.x), Math.min(drag.y0, hover.y), Math.max(drag.x0, hover.x), Math.max(drag.y0, hover.y)]; ctx.strokeRect(x0 * sc, y0 * sc, (x1 - x0 + 1) * sc, (y1 - y0 + 1) * sc); } else { ctx.beginPath(); ctx.moveTo((drag.x0 + .5) * sc, (drag.y0 + .5) * sc); ctx.lineTo((hover.x + .5) * sc, (hover.y + .5) * sc); ctx.stroke(); }
  }
}
function ghost() {
  const sc = scale, { x, y } = hover;
  ctx.lineWidth = 2;
  const box = (a, b, w, h, col) => { ctx.strokeStyle = col; ctx.fillStyle = col.replace('1)', '.18)'); ctx.fillRect(a * sc, b * sc, w * sc, h * sc); ctx.strokeRect(a * sc + 1, b * sc + 1, w * sc - 2, h * sc - 2); };
  const white = 'rgba(255,255,255,1)';
  if (tool.kind === 'terrain' && (tool.mode === 'brush' || tool.mode === 'line')) {
    const lo = -Math.floor(brush / 2);
    for (const [a, b] of copies(x + lo, y + lo, brush)) box(a, b, brush, brush, white);
  } else if (tool.kind === 'node') {
    const s = cat.nodes[tool.res].size, o = Math.floor((s - 1) / 2);
    for (const [a, b] of copies(x - o, y - o, s)) box(a, b, s, s, 'rgba(245,196,83,1)');
  } else if (tool.kind === 'shrine') {
    for (const [a, b] of copies(x, y, SHRINE.size)) box(a, b, SHRINE.size, SHRINE.size, 'rgba(183,156,255,1)');
  } else if (tool.kind === 'start') {
    const px = Math.max(1, Math.min(S.N - TC - 1, x)), py = Math.max(1, Math.min(S.N - TC - 1, y));
    for (const [a, b] of (S.sym === 'none' ? [[px, py]] : copies(px, py, TC))) box(a, b, TC, TC, white);
  } else if (tool.kind === 'item') {
    const isB = !!cat.buildings[itemType], s = isB ? cat.buildings[itemType].size : 1, o = isB ? Math.floor((s - 1) / 2) : 0;
    for (const [a, b] of copies(x - o, y - o, s)) box(a, b, s, s, white);
  } else box(x, y, 1, 1, white);
}
function updateStatus() {
  status.replaceChildren(
    el('span', {}, `${S.N} x ${S.N} tiles`), el('span', {}, `${S.np} players`),
    el('span', {}, `${S.nodes.length} resource nodes`),
    ...(S.shrines.length ? [el('span', {}, `${S.shrines.length} relic shrine${S.shrines.length > 1 ? 's' : ''}`)] : []),
    ...(hover ? [el('span', {}, `tile ${hover.x}, ${hover.y}`)] : []),
    S.dirty ? el('span', { style: 'color:var(--warn)' }, 'unsaved changes') : el('span', {}, S.id ? 'saved' : 'new map'));
}

function tileAt(e) {
  const r = cv.getBoundingClientRect();
  const x = Math.floor(((e.clientX - r.left) / r.width) * S.N), y = Math.floor(((e.clientY - r.top) / r.height) * S.N);
  return { x: Math.max(0, Math.min(S.N - 1, x)), y: Math.max(0, Math.min(S.N - 1, y)) };
}
cv.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  cv.setPointerCapture(e.pointerId);
  const { x, y } = tileAt(e);
  hover = { x, y };
  if (tool.kind === 'terrain') {
    pushUndo();
    if (tool.mode === 'fill') { fillArea(x, y, tool.value); changed(); return; }
    drag = { mode: tool.mode, x0: x, y0: y, lx: x, ly: y };
    if (tool.mode === 'brush') { stamp(x, y, tool.value); changed(); }
  } else if (tool.kind === 'node') { pushUndo(); placeNode(tool.res, x, y); changed(); drag = { mode: 'multi', last: `${x},${y}` }; }
  else if (tool.kind === 'shrine') { pushUndo(); if (placeShrine(x, y)) changed(); else undoStack.pop(); }
  else if (tool.kind === 'start') { placeStarts(x, y, S.sym === 'none' ? startPlayer : 0); syncUi(); }
  else if (tool.kind === 'item') { pushUndo(); placeItem(x, y); changed(); drag = { mode: 'multi', last: `${x},${y}` }; }
  else if (tool.kind === 'erase') { pushUndo(); eraseAt(x, y); changed(); drag = { mode: 'erase' }; }
});
cv.addEventListener('pointermove', (e) => {
  const { x, y } = tileAt(e);
  hover = { x, y };
  if (drag?.mode === 'brush') { line(drag.lx, drag.ly, x, y, (a, b) => stamp(a, b, tool.value)); drag.lx = x; drag.ly = y; S.dirty = true; draw(true); scheduleCheck(); }
  else if (drag?.mode === 'erase') { eraseAt(x, y); S.dirty = true; draw(true); scheduleCheck(); }
  else if (drag?.mode === 'multi' && drag.last !== `${x},${y}` && tool.kind === 'item' && !cat.buildings[itemType]) { drag.last = `${x},${y}`; placeItem(x, y); S.dirty = true; draw(true); scheduleCheck(); }
  updateStatus();
  draw();
});
const endDrag = () => {
  if (!drag) return;
  if (drag.mode === 'rect' && hover) { for (let j = Math.min(drag.y0, hover.y); j <= Math.max(drag.y0, hover.y); j++) for (let i = Math.min(drag.x0, hover.x); i <= Math.max(drag.x0, hover.x); i++) setTile(i, j, tool.value); changed(); }
  if (drag.mode === 'line' && hover) { line(drag.x0, drag.y0, hover.x, hover.y, (a, b) => stamp(a, b, tool.value)); changed(); }
  drag = null; draw(true);
};
cv.addEventListener('pointerup', endDrag);
cv.addEventListener('pointercancel', endDrag);
cv.addEventListener('pointerleave', () => { hover = null; draw(); updateStatus(); });
window.addEventListener('keydown', (e) => {
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
});
window.addEventListener('beforeunload', (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });

// ------------------------------------------------------------------ right column: check + saved maps + actions
const checkBox = el('div', { class: 'panel' });
const mapsBox = el('div', { class: 'maplist' });
const actions = el('div', { class: 'panel' },
  el('h2', {}, 'Try it'),
  el('div', { class: 'grid' },
    el('button', { class: 'btn primary', type: 'button', onclick: () => tryMap('setup') }, 'Play on this map'),
    el('button', { class: 'btn', type: 'button', onclick: () => tryMap('bots') }, 'Quick test with bots (3D view)')),
  el('p', { class: 'hint' }, 'Play opens the new match page with this map selected. The quick test starts bots on the map and shows it in the 3D spectator.'));
const side = el('div', { class: 'col side' }, actions, checkBox, el('div', { class: 'panel' }, el('h2', {}, 'Saved maps'), mapsBox));

let checkTimer = 0, checkSeq = 0;
function scheduleCheck(now) { clearTimeout(checkTimer); checkTimer = setTimeout(runCheck, now ? 0 : 500); }
async function runCheck() {
  const seq = ++checkSeq;
  try {
    const r = await api('/api/maps/validate', { map: toMap() });
    if (seq !== checkSeq) return;
    S.check = r;
    if (r.symmetry && S.sym === 'none' && !S.dirty) { /* leave the chosen tool symmetry alone */ }
    renderCheck(r);
  } catch (e) { checkBox.replaceChildren(el('div', { class: 'err' }, e.message)); }
}
function renderCheck(r) {
  const lvl = r.fairness?.level;
  const nice = { perfect: 'Perfectly symmetric', good: 'Fair', uneven: 'Slightly uneven', unfair: 'Unfair', unknown: '' };
  const symName = { point: 'rotates 180 degrees', 'mirror-x': 'mirrored left / right', 'mirror-y': 'mirrored top / bottom', quad: 'mirrored 4 ways' };
  const head = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center' },
    el('span', { class: 'pill ' + (r.ok ? 'ok' : 'bad') }, r.ok ? 'Playable' : 'Problems'),
    lvl && lvl !== 'unknown' ? el('span', { class: 'pill ' + lvl }, nice[lvl]) : null,
    r.symmetry ? el('span', { class: 'dim mono', style: 'font-size:12px' }, `exact symmetry: ${symName[r.symmetry]}`) : null);
  const msgs = el('ul', { class: 'msgs' }, r.errors.map((m) => el('li', { class: 'e' }, m)), r.warnings.map((m) => el('li', {}, m)),
    r.ok && !r.warnings.length ? el('li', { class: 'g' }, 'Every start can reach every other start, resources are balanced.') : null);
  let table = null;
  if (r.fairness?.metrics?.length) {
    table = el('table', { class: 'fair' }, el('tr', {}, el('th', {}, 'Per start'), r.starts.map((s) => el('th', { style: `color:${COLORS[s.player - 1]}` }, `P${s.player}`)), el('th', {}, 'match')),
      r.fairness.metrics.map((m) => el('tr', {}, el('td', {}, m.label), m.values.map((v) => el('td', {}, v == null ? '-' : v + (m.kind === 'distance' ? '' : ''))), el('td', { class: m.ratio < 0.75 ? 'vlow' : m.ratio < 0.9 ? 'low' : '' }, Math.round(m.ratio * 100) + ' %'))));
  }
  checkBox.replaceChildren(el('h2', {}, 'Check'), head, msgs, table, table ? el('p', { class: 'hint' }, 'Amounts: resources nearest to each start. Walk: tiles to the closest one. 100 % = identical.') : null);
}
async function refreshMaps() {
  const { maps } = await api('/api/maps');
  mapPick.replaceChildren(el('option', { value: '' }, maps.length ? '- choose -' : 'no saved maps'), maps.map((m) => el('option', { value: m.id }, m.name)));
  mapsBox.replaceChildren(...(maps.length ? maps.map((m) => el('div', { class: 'mrow' },
    el('b', {}, m.name), el('div', { class: 'm' }, `${m.size}x${m.size} | ${m.players} players${m.symmetry ? ' | ' + m.symmetry : ''}`),
    el('div', { class: 'a' },
      el('button', { class: 'btn small', type: 'button', onclick: async () => { if (S.dirty && !confirm('Discard unsaved changes?')) return; await openMap(m.id); } }, 'Open'),
      el('button', { class: 'btn small danger', type: 'button', onclick: async () => { if (!confirm(`Delete "${m.name}"? The file is moved to data/_alt-maps.`)) return; await api('/api/maps/' + m.id, undefined, 'DELETE'); if (S.id === m.id) S.id = null; refreshMaps(); updateStatus(); } }, 'Delete')))) : [el('div', { class: 'dim', style: 'font-size:13px' }, 'Nothing saved yet.')]));
}
async function openMap(id) {
  try { const r = await api('/api/maps/' + id); fromMap(r.map, r.id); history.replaceState(null, '', '?map=' + r.id); toast('Opened ' + (r.map.name || id)); } catch (e) { toast(e.message); }
}
async function save(asNew) {
  const r = await api('/api/maps', { map: toMap(), id: asNew ? undefined : S.id || undefined }).catch((e) => { toast(e.message); return null; });
  if (!r) return null;
  S.id = r.id; S.dirty = false; history.replaceState(null, '', '?map=' + r.id);
  S.check = r.check; renderCheck(r.check); updateStatus(); refreshMaps();
  toast(r.check.ok ? `Saved as ${r.id}` : 'Saved, but the map has problems (see Check)');
  return r;
}
async function tryMap(how) {
  if (S.check && !S.check.ok) { toast('Fix the problems first: ' + S.check.errors[0]); return; }
  const r = await save();
  if (!r) return;
  if (how === 'setup') { location.href = '/new?map=' + r.id; return; }
  try {
    const bots = ['rush', 'boom', 'turtle', 'boom'];
    const m = await api('/api/matches', { name: 'Test: ' + toMap().name, seed: 1, map: { type: 'custom', id: r.id }, rules: { speed: 2 }, players: Array.from({ length: S.np }, (_, i) => ({ type: 'bot', bot: bots[i], team: i + 1 })) });
    location.href = m.watch_url;
  } catch (e) { toast(e.message); }
}

// ------------------------------------------------------------------ new map dialog
function newDialog(first) {
  const size = el('select', {}, cat.sizes.map((s) => el('option', { value: s, ...(s === 96 ? { selected: true } : {}) }, `${s} x ${s} tiles`)));
  const np = el('select', {}, [2, 4].map((n) => el('option', { value: n }, `${n} players`)));
  const sym = el('select', {}, Object.entries(SYMS).map(([k, v]) => el('option', { value: k }, v.label)));
  sym.value = 'point';
  const from = el('select', {}, el('option', { value: 'empty' }, 'Empty grass'), el('option', { value: 'gen' }, 'Generated from a seed (96 or 128 tiles)'));
  const seed = el('input', { type: 'number', value: Math.floor(Math.random() * 99999), min: 0 });
  const treasure = el('input', { type: 'checkbox' }), shrines = el('input', { type: 'checkbox' });
  const err = el('div', { class: 'err' });
  const sync = () => { const forced = SYMS[sym.value].np; if (forced) np.value = String(forced); np.disabled = !!forced; seedRow.style.display = treasureRow.style.display = shrineRow.style.display = from.value === 'gen' ? '' : 'none'; if (from.value === 'gen' && sym.value !== 'quad' && np.value === '2' && !['point'].includes(sym.value)) sym.value = 'point'; };
  const seedRow = el('label', {}, 'Seed', seed), treasureRow = el('label', { class: 'chk' }, treasure, 'Treasure in the middle (2 players)'), shrineRow = el('label', { class: 'chk' }, shrines, 'Relic shrines');
  const go = async () => {
    err.textContent = '';
    let N = +size.value, generated = null;
    try {
      if (from.value === 'gen') {
        if (![96, 128].includes(N)) N = 96;
        const g = await api('/api/maps/generate', { seed: +seed.value, players: +np.value, size: N, treasure: treasure.checked && +np.value === 2, shrines: shrines.checked });
        generated = g.map;
        if (+np.value === 4) sym.value = 'quad'; else if (!['point', 'mirror-x', 'mirror-y'].includes(sym.value)) sym.value = 'point';
        nameInput.value = g.map.name;
      } else nameInput.value = 'My map';
      newMap({ N, np: +np.value, sym: sym.value, generated });
      undoStack = []; redoStack = [];
      history.replaceState(null, '', location.pathname);
      modal.remove(); sizeCanvas(); syncUi(); draw(true); scheduleCheck(true);
    } catch (e) { err.textContent = e.message; }
  };
  from.addEventListener('change', sync); sym.addEventListener('change', sync);
  const modal = el('div', { class: 'modal' }, el('div', { class: 'box' },
    el('h3', {}, 'New map'),
    el('label', {}, 'Start from', from), seedRow, treasureRow, shrineRow,
    el('label', {}, 'Size', size), el('label', {}, 'Symmetry', sym), el('label', {}, 'Players', np),
    el('p', { class: 'hint' }, 'A symmetric map is fair by construction. Pick "None" if you want to draw something uneven on purpose.'),
    err,
    el('div', { style: 'display:flex;gap:8px;justify-content:flex-end' },
      first ? null : el('button', { class: 'btn', type: 'button', onclick: () => modal.remove() }, 'Cancel'),
      el('button', { class: 'btn primary', type: 'button', onclick: go }, 'Create'))));
  if (!first && S.dirty && !confirm('Discard unsaved changes?')) return;
  sync();
  document.body.append(modal);
}

let toastEl = null, toastT = 0;
function toast(msg) { toastEl?.remove(); toastEl = el('div', { class: 'toast' }, msg); document.body.append(toastEl); clearTimeout(toastT); toastT = setTimeout(() => toastEl?.remove(), 4000); }

// ------------------------------------------------------------------ boot
app.append(header(), el('h1', {}, 'World editor'), el('p', { class: 'sub' }, 'Paint the land, place gold and trees, set the start positions. The check tells you if the map is playable and fair.'), bar, el('div', { class: 'ed' }, toolsCol, center, side));
const q = new URLSearchParams(location.search).get('map');
newMap({ N: 96, np: 2, sym: 'point' });
sizeCanvas(); syncUi();
await refreshMaps();
if (q) await openMap(q);
else { // a starting point that is already a playable, fair map
  try { const g = await api('/api/maps/generate', { seed: 7, players: 2, size: 96, treasure: true }); newMap({ N: 96, np: 2, sym: 'point', generated: g.map }); nameInput.value = 'My map'; sizeCanvas(); syncUi(); draw(true); scheduleCheck(true); } catch { draw(true); }
}
window.__editor = { S, toMap, fromMap, setTool: (t) => { tool = t; syncUi(); }, setSym, tileAt, draw };
