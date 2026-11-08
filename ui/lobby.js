import { $, el, api, mmss, COLORS, header, startMatch, demoMatchBody } from './common.js';
import { openVideoDialog } from './video.js';

const app = $('#app');
let creators = {};
const SHOW = 12;
let olderOpen = false;
const list = el('div', { class: 'list' });
app.append(header(),
  el('h1', {}, 'Lobby'),
  el('p', { class: 'sub' }, 'Connect your own models, press Play, watch them fight. Every match is saved as a replay.'),
  el('h2', {}, 'Matches'), list);

function playerChip(p, win) {
  const c = p.creator && creators[p.creator];
  return el('span', { class: 'pl' + (win ? ' win' : '') },
    c ? el('img', { src: '/' + c.logo, alt: '' }) : el('span', { class: 'dot', style: `background:${COLORS[(p.slot - 1) % 4]}` }),
    p.display, c ? el('span', { class: 'by', title: 'recipe by ' + c.name }, `recipe by ${c.name}`) : null,
    p.team ? el('span', { class: 'dim mono', style: 'font-weight:400;font-size:11px' }, `T${p.team}`) : null);
}

function card(m) {
  const winT = m.result?.winnerTeam;
  const vs = el('div', { class: 'vs' });
  m.players.forEach((p, i) => { if (i) vs.append(el('span', { class: 'sep' }, 'vs')); vs.append(playerChip(p, winT && p.team === winT)); });
  const models = m.players.map((p) => p.model).filter(Boolean).join('  |  ');
  const meta = el('div', { class: 'meta' },
    m.class ? el('span', {}, m.class) : null,
    m.map?.type === 'custom' ? el('span', {}, `map: ${m.map.name}`) : null,
    el('span', {}, `seed ${m.seed}`),
    m.status === 'running' && m.progress ? el('span', {}, `game time ${mmss(m.progress.game_seconds)}`) : null,
    m.result ? el('span', {}, `${m.result.winner ? 'winner: ' + m.result.winner : 'no winner'} (${m.result.reason || '-'})`) : null,
    m.result?.game_seconds != null ? el('span', {}, `duration ${mmss(m.result.game_seconds)} game, ${m.result.wall_seconds ?? '-'} s real`) : null,
    el('span', {}, models));
  const act = el('div', { class: 'act' }, el('span', { class: 'badge ' + m.status }, m.status));
  if (m.godMode || m.result?.godMode) act.prepend(el('span', { class: 'badge god', title: 'The spectator intervened (God mode). This match never counts for rankings or statistics.' }, 'God mode · not ranked'));
  if (m.status === 'running') {
    const pct = Math.min(100, ((m.progress?.game_seconds || 0) / ((m.rules?.time_limit_min || 60) * 60)) * 100);
    act.prepend(el('div', { class: 'bar', title: 'game time vs time limit' }, el('i', { style: `width:${pct}%` })));
    act.append(el('a', { class: 'btn small primary', href: m.watch_url }, 'Watch'),
      el('button', { class: 'btn small danger', onclick: async () => { await api(`/api/matches/${m.id}/stop`, {}); refresh(); } }, 'Stop'));
  } else {
    act.append(el('a', { class: 'btn small primary', href: m.replay_url }, 'Replay'));
    if (m.players.length === 2) { // post-match broadcast: script + voices + camera + sound (see ui/video.js)
      const v = m.video, busy = v && (v.status === 'running' || v.status === 'queued');
      act.append(el('button', { class: 'btn small' + (v?.ready ? '' : ''), title: 'Make the finished broadcast video of this match', onclick: () => openVideoDialog(m.id, { onChange: refresh }) },
        busy ? `Video ${v.percent}%` : v?.ready ? 'Video' : 'Make video'));
    }
  }
  const when = m.created ? new Date(m.created).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  const plain = m.players.map((p) => p.display).join(' vs ');
  const title = m.name && m.name !== plain ? el('div', { class: 'mtitle', style: 'grid-column:1/-1;font-weight:600;font-size:15px' }, m.name, when ? el('span', { class: 'dim', style: 'font-weight:400;font-size:12px;margin-left:10px' }, when) : null) : null;
  return el('div', { class: 'mcard' }, title, vs, act, meta);
}

// first run (no match yet): three ways in. Built once, so the 2 s refresh does not swallow a click.
const demoErr = el('div', { class: 'err' });
const demoBtn = el('button', { class: 'btn primary', type: 'button', onclick: async () => {
  demoErr.textContent = '';
  demoBtn.disabled = true; demoBtn.textContent = 'Starting ...';
  try { await startMatch(demoMatchBody()); } catch (e) { demoErr.textContent = e.message; demoBtn.disabled = false; demoBtn.textContent = 'Watch a demo match'; }
} }, 'Watch a demo match');
const step = (btn, title, text) => el('div', { class: 'step' }, el('div', {}, el('div', { class: 'stitle' }, title), el('div', { class: 'dim' }, text)), btn);
const gettingStarted = el('section', { class: 'panel start' },
  el('div', { class: 'stitle big' }, 'Getting started'),
  el('div', { class: 'dim', style: 'margin-bottom:6px' }, 'No match has been played yet. You do not need a model to see one.'),
  step(demoBtn, 'See it first', 'Two built-in bots play each other. Starts right away, no setup.'),
  step(el('a', { class: 'btn', href: '/new' }, 'Connect your model'), 'Bring your own LLM', 'Point it at any OpenAI-compatible server (llama.cpp, LM Studio, Ollama, vLLM).'),
  step(el('a', { class: 'btn', href: '/check' }, 'Check your setup'), 'Something not working?', 'See what this machine has, and what "Make video" still needs.'),
  demoErr);

async function refresh() {
  try {
    const ms = (await api('/api/matches')).sort((a, b) => (b.status === 'running') - (a.status === 'running') || b.created - a.created); // live matches first
    // newest 12 stay on the page (running ones always); the rest sits in an "older" fold (still in the data, only filtered here)
    let shown = 0;
    const top = [], older = [];
    for (const m of ms) { if (m.status === 'running' || shown < SHOW) { top.push(m); if (m.status !== 'running') shown++; } else older.push(m); }
    const kids = top.map(card);
    if (older.length) {
      const d = el('details', { class: 'older', style: 'margin-top:14px' }, el('summary', { style: 'cursor:pointer;color:var(--dim);padding:6px 2px' }, `Older matches (${older.length}), mostly test runs`), el('div', { class: 'list', style: 'margin-top:10px' }, ...older.map(card)));
      d.open = olderOpen; d.addEventListener('toggle', () => { olderOpen = d.open; });
      kids.push(d);
    }
    if (ms.length) list.replaceChildren(...kids);
    else if (list.firstChild !== gettingStarted) list.replaceChildren(gettingStarted);
  } catch (e) { list.replaceChildren(el('div', { class: 'err' }, e.message)); }
}

const st = await api('/api/state');
creators = Object.fromEntries(st.creators.map((c) => [c.id, c]));
await refresh();
setInterval(refresh, 2000);
