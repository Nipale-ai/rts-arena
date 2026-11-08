// shared helpers for the lobby and the setup page (no framework, no dependencies)
export const $ = (s, r = document) => r.querySelector(s);
export const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'value') e.value = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
};
export async function api(path, body, method) {
  const r = await fetch(path, body === undefined && !method ? undefined : { method: method || 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
// create a match (the call the setup page makes: POST /api/matches, see createMatch in server/arena.mjs) and open its watch page
export async function startMatch(body) {
  const m = await api('/api/matches', body);
  location.href = m.watch_url;
  return m;
}
// the lobby's demo: two built-in bots, random seed, the fast rules at 4x so the first fight is about a minute away; no model needed
export const demoMatchBody = (random = Math.random) => ({
  name: 'Demo: Rush vs Boom', seed: Math.floor(random() * 99999), map: { type: 'standard' }, rules: { preset: 'fast', speed: 4 },
  players: [{ type: 'bot', team: 1, bot: 'rush' }, { type: 'bot', team: 2, bot: 'boom' }],
});
export const mmss = (s) => (s == null ? '-' : `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.round(s % 60)).padStart(2, '0')}`);
export const COLORS = ['#4d8dff', '#ff7a45', '#3ddc97', '#c77dff'];
export function header(active) {
  return el('header', { class: 'top' },
    el('a', { class: 'brand', href: '/' }, 'RTS ', el('b', {}, 'Arena')),
    el('nav', {},
      el('a', { class: 'btn small', href: '/' }, 'Lobby'),
      el('a', { class: 'btn small', href: '/editor/' }, 'World editor'),
      el('a', { class: 'btn small', href: '/settings' }, 'Settings'),
      el('a', { class: 'btn small', href: '/check' }, 'Check setup'),
      el('a', { class: 'btn small primary', href: '/new' }, '+ New match')));
}

// small top-down picture of a map (terrain + resources + starts) for pickers
export function drawMapThumb(canvas, m, px = 160) {
  const N = m.size, sc = px / N;
  canvas.width = canvas.height = px;
  const c = canvas.getContext('2d');
  const col = { '.': '#35553a', f: '#1b3a28', '~': '#22507f', '#': '#7b8494' };
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { c.fillStyle = col[m.terrain[y][x]] || '#000'; c.fillRect(x * sc, y * sc, sc + 0.5, sc + 0.5); }
  const nc = { gold: '#f5c453', stone: '#b4bccb', berries: '#ff6b8b', herd: '#d9a066' };
  for (const n of m.nodes || []) { c.fillStyle = nc[n.res] || '#fff'; const s = n.res === 'gold' || n.res === 'stone' ? 2 : 1; c.fillRect(n.tx * sc, n.ty * sc, Math.max(2, s * sc), Math.max(2, s * sc)); }
  m.players.forEach((p, i) => { c.fillStyle = COLORS[i % 4]; c.strokeStyle = '#fff'; c.lineWidth = 1; c.fillRect(p.start.tx * sc, p.start.ty * sc, Math.max(5, 4 * sc), Math.max(5, 4 * sc)); c.strokeRect(p.start.tx * sc, p.start.ty * sc, Math.max(5, 4 * sc), Math.max(5, 4 * sc)); });
}
