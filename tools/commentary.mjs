// Broadcast commentary, TEXT ONLY (no voice). Everything here is derived from the match log:
//   - digestObservation(): a small digest of what a model was shown (its fog-limited observation from io.jsonl)
//   - detectMoments():      the key decisions of the match (a model's own note + what it saw + what it ordered)
//   - momentCard():         the on-screen text of one decision (facts and the model's own words, never invented reasons)
//   - momentWindows():      where a moment sits on the output timeline (panel, slow motion, fog of war view)
//   - endScreen():          the final stats table
// Pure functions of their inputs: no clocks, no randomness.
import { WEIGHTS } from './highlight-weights.mjs';
import { TICK_HZ } from '../sim/util.mjs';
import { plainOrders } from './plain-orders.mjs';
import { entitiesOf } from './subjects.mjs';
import { displayName } from '../render/theme/display-name.mjs';

// the units of a beaten side vanish with its last building: the sample after that says nothing about the army that fought
export const withoutFinalWipe = (a) => (a.length > 1 && a.at(-1) === 0 && a.at(-2) > 0 ? a.slice(0, -1) : a);

const nice = (s) => displayName('any', s); // R1: the theme decides the words (default classic = the old underscore-to-space text)
const mmss = (tick) => { const s = Math.floor(tick / TICK_HZ); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const sumN = (o) => Object.values(o || {}).reduce((a, b) => a + b, 0);

export function decisionImportance(e, W = WEIGHTS) {
  const D = W.decision;
  let w = e.thought ? D.base : D.base * 0.4;
  for (const o of e.orders || []) w += D.orders[o] ?? 0;
  w += D.per_error * (e.errors?.length || 0);
  if ((e.latency_ms || 0) / 1000 >= D.slow_latency_s) w += D.slow_bonus;
  return w;
}

// ---------------------------------------------------------------- what the model saw
// `user` is the JSON text of the observation the model got (io.jsonl). The observation is limited by the player's fog
// of war, so enemy_units / enemy_buildings list only what that player could see or had seen.
export function digestObservation(user) {
  let o;
  try { o = typeof user === 'string' ? JSON.parse(user) : user; } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  const own = {};
  let ownN = 0;
  for (const u of o.units || []) { own[u.type] = (own[u.type] || 0) + u.n; ownN += u.n; }
  const enemy = {};
  let ex = 0, ey = 0, en = 0;
  for (const u of o.enemy_units || []) {
    enemy[u.type] = (enemy[u.type] || 0) + u.n;
    if (u.xy) { ex += u.xy[0] * u.n; ey += u.xy[1] * u.n; en += u.n; }
  }
  const eb = {};
  for (const b of o.enemy_buildings || []) { const k = b.type; eb[k] = eb[k] || { n: 0, vis: 0 }; eb[k].n++; if (b.vis) eb[k].vis++; }
  for (const b of o.enemy_minor_buildings || []) { eb[b.type] = eb[b.type] || { n: 0, vis: 0 }; eb[b.type].n += b.n; }
  const hit = (o.events || []).filter((e) => e.type === 'attacked');
  const hitWhat = {};
  for (const e of hit) hitWhat[e.what] = (hitWhat[e.what] || 0) + 1;
  const d = {
    t: o.t, tier: o.tier, res: o.res || null, pop: o.pop ? [o.pop.used, o.pop.cap] : null,
    army_value: o.army_value ?? null, workers: o.workers ? o.workers.n : null, idle_workers: o.workers ? o.workers.idle : null,
    own, own_army_n: ownN, enemy, enemy_n: en, enemy_xy: en ? [Math.round(ex / en), Math.round(ey / en)] : null,
    enemy_buildings: Object.fromEntries(Object.entries(eb).map(([k, v]) => [k, v.n])),
    attacked: hit.length ? { n: hit.length, what: hitWhat } : null,
    advancing: o.advancing ? o.advancing.to : null,
    explored_pct: o.map ? o.map.explored_pct : null,
    start: o.map && o.map.start ? o.map.start : null,
    ...entitiesOf(o),
  };
  return d;
}

// ---------------------------------------------------------------- key decisions
export const MOMENTS = {
  min_score: 3.2,         // a decision below this is not a key decision
  gap_s: 45,              // key decisions are at least this far apart (game seconds)
  max: 3,                 // per cut, see addSlowMotion for the length limit
  keyword: /counter|raid|rush|defen[cs]e|attack|engage|expand|push|siege|flank|retreat|tier|army|enemy/i,
  // slow motion and the lead before it, in game ticks
  lead: 30, pre: 10, post: 26, speed: 0.35,
};

const topTypes = (m, n = 3) => Object.entries(m || {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);

// Scores every LLM decision that carries a thought. The tags name the facts behind the score; each one is read from the
// log (this and the previous observation of the same player, the battles, the model's note and orders).
export function scoreDecision(e, prev, events, W = WEIGHTS) {
  if (!e.thought) return null;
  const tags = [];
  let score = decisionImportance(e, W);
  const s = e.seen || null, ps = prev && prev.seen ? prev.seen : null;
  if (s && s.enemy_n > 0) {
    if (!ps || ps.enemy_n === 0) { score += 2.5; tags.push({ k: 'enemy_in_view', text: 'enemy came into view' }); }
    else {
      const fresh = Object.keys(s.enemy).filter((t) => !(t in ps.enemy));
      if (fresh.length) { score += 1.5; tags.push({ k: 'new_enemy_type', text: `new in view: ${fresh.slice(0, 2).map(nice).join(', ')}` }); }
      else if (s.enemy_n >= 2 * ps.enemy_n && s.enemy_n >= 4) { score += 1; tags.push({ k: 'enemy_grew', text: `enemy in view ${ps.enemy_n} -> ${s.enemy_n}` }); }
    }
  }
  if (s && s.attacked) { score += 2; tags.push({ k: 'under_attack', text: 'under attack' }); }
  if (s && ps && ps.army_value > 0 && s.army_value != null && s.army_value <= 0.7 * ps.army_value && ps.army_value - s.army_value >= 150) {
    score += 1.5; tags.push({ k: 'army_lost', text: `army value ${ps.army_value} -> ${s.army_value}` });
  }
  const battle = events.find((b) => b.type === 'battle' && e.t >= b.t - 150 && e.t <= b.t_end + 150);
  if (battle) { score += 1.5; tags.push({ k: 'battle_on', text: 'battle going on' }); }
  if (e.orders.includes('advance_tier')) tags.push({ k: 'tier', text: 'advancing tier' });
  if (MOMENTS.keyword.test(e.thought)) score += 0.8;
  return { score: +score.toFixed(3), tags };
}

// Picks the key decisions of a match. opts: window [aTick, bTick], max, min_score, gap_s, margin (ticks from the window edges).
export function detectMoments(ev, opts = {}) {
  const M = { ...MOMENTS, ...opts };
  const win = opts.window || [0, ev.ticks];
  const margin = opts.margin ?? M.lead + M.pre + 5;
  const events = ev.events;
  const byP = {};
  const cand = [];
  for (const e of events) {
    if (e.type !== 'llm_decision') continue;
    const prev = byP[e.p] || null;
    byP[e.p] = e;
    const sc = scoreDecision(e, prev, events);
    if (!sc || sc.score < M.min_score) continue;
    if (e.t < win[0] + margin || e.t > win[1] - M.post - 5) continue;
    cand.push({ e, prev, ...sc });
  }
  cand.sort((a, b) => b.score - a.score || a.e.t - b.e.t || a.e.p - b.e.p);
  const out = [];
  for (const c of cand) {
    if (out.length >= M.max) break;
    if (out.some((m) => Math.abs(m.t - c.e.t) < M.gap_s * TICK_HZ)) continue;
    const e = c.e;
    out.push({
      id: e.id, p: e.p, n: e.n, t: e.t, start_tick: e.start_tick, score: c.score, tags: c.tags,
      thought: e.thought, summary: e.summary, orders: e.orders, seen: e.seen || null, prev_seen: c.prev && c.prev.seen ? c.prev.seen : null,
      latency_ms: e.latency_ms, completion_tokens: e.completion_tokens, tok_s: e.tok_s,
      focus: e.seen && e.seen.enemy_xy ? { x: e.seen.enemy_xy[0], y: e.seen.enemy_xy[1], what: 'enemy' } : e.seen && e.seen.start ? { x: e.seen.start[0] + 2, y: e.seen.start[1] + 2, what: 'base' } : null,
    });
  }
  return out.sort((a, b) => a.t - b.t);
}

// ---------------------------------------------------------------- text of one decision
const list = (m, n = 3) => topTypes(m, n).map(([k, v]) => `${v}x ${nice(k)}`).join(', ');

export function momentCard(m, players = []) {
  const name = players[m.p - 1]?.name ?? `P${m.p}`;
  const s = m.seen;
  const saw = [];
  if (s) {
    if (s.enemy_n > 0) saw.push(`In view: ${list(s.enemy)} (enemy)`);
    else {
      const eb = Object.keys(s.enemy_buildings || {});
      saw.push(eb.length ? `No enemy unit in view. Known enemy buildings: ${eb.slice(0, 3).map(nice).join(', ')}` : 'No enemy in view');
    }
    if (s.attacked) saw.push(`Hit ${s.attacked.n}x: ${Object.keys(s.attacked.what).slice(0, 3).map(nice).join(', ')}`);
    const own = s.own_army_n ? `Own army ${list(s.own)}` : 'No army yet';
    saw.push(`${own}${s.army_value != null ? ` (value ${s.army_value})` : ''}`);
    if (s.res) saw.push(`Stock ${s.res.food} food, ${s.res.wood} wood, ${s.res.stone} stone, ${s.res.gold} gold`);
  }
  const meta = [];
  if (m.latency_ms != null) meta.push(`thought for ${(m.latency_ms / 1000).toFixed(m.latency_ms < 10000 ? 1 : 0)} s`);
  if (m.completion_tokens != null) meta.push(`${m.completion_tokens} tokens`);
  if (m.tok_s != null) meta.push(`${Math.round(m.tok_s)} tok/s`);
  return {
    who: name, when: mmss(m.t), title: `${name} decides`,
    saw: saw.slice(0, 3), tags: m.tags.slice(0, 3).map((t) => t.text), thought: m.thought, ordered: plainOrders(m.summary).split(', ').slice(0, 3).join(', '), meta: meta.join(' · '),
  };
}

// Output-time layout of one moment: the panel and fog of war view start while the game still runs at 1x, the note
// appears when the order lands, the slow motion sits around that tick.
export function momentWindows(m, tl, M = MOMENTS) {
  if (m.story) { // story cut: 1x run-up, freeze frame at the hold tick, the model's view stays a little after the game runs on
    const o0 = tl.outAt(m.story.lead_tick), land = tl.outAt(m.t), h1 = tl.outAfterHold(m.story.hold_tick);
    const h0 = tl.outAt(m.story.hold_tick), [fi, fn] = m.story.fog_part || [0, 1], mid = (h0 + h1) / 2; // two decisions at one freeze frame: the first model's view, then the second's
    return { o0, slow0: land, land, slow1: h1, o1: h1 + 1.2, fog0: fn > 1 && fi > 0 ? mid : m.story.hold_only ? h0 : o0, fog1: fn > 1 && fi < fn - 1 ? mid : h1 + 1.0 };
  }
  const oLead = tl.outAt(m.t - M.lead - M.pre), oSlow0 = tl.outAt(m.t - M.pre), oLand = tl.outAt(m.t), oSlow1 = tl.outAt(m.t + M.post);
  return { o0: oLead, slow0: oSlow0, land: oLand, slow1: oSlow1, o1: oSlow1 + 1.4, fog0: oLead, fog1: oSlow1 + 1.0 };
}

// ---------------------------------------------------------------- end screen
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };

// Data of the end screen. ev: events.json (events, series, final, result). players: [{name, model, hw|hardware}].
export function endScreen(ev, players = []) {
  const v = ev.events.find((e) => e.type === 'victory');
  const resign = ev.events.find((e) => e.type === 'resign');
  const N = players.length || ev.players.length;
  const fin = ev.final || [];
  const winner = v && v.winner ? v.winner : resign ? (resign.p === 1 ? 2 : 1) : 0;
  const reason = v ? v.reason : resign ? 'resign' : 'cutoff';
  const rows = [];
  const col = (f) => Array.from({ length: N }, (_, i) => f(i));
  const dec = col((i) => ev.events.filter((e) => e.type === 'llm_decision' && e.p === i + 1));
  const peak = col((i) => (ev.series.army[i] || []).reduce((a, b) => Math.max(a, b), 0));
  const last = col((i) => withoutFinalWipe(ev.series.army[i] || []).at(-1) ?? 0);
  const add = (key, label, vals, fmt = (x) => String(x), better = 'high') => { // better: 'high' | 'low' | null (no leader marked)
    if (vals.every((x) => x == null)) return;
    let lead = -1;
    const nums = vals.map((x) => (typeof x === 'number' ? x : null));
    if (better && nums.every((x) => x != null) && N === 2 && nums[0] !== nums[1]) lead = (nums[0] > nums[1]) === (better === 'high') ? 0 : 1;
    rows.push({ key, label, vals: vals.map((x) => (x == null ? '-' : fmt(x))), raw: vals, lead });
  };
  const k = (x) => (x >= 10000 ? (x / 1000).toFixed(1) + 'k' : String(Math.round(x)));
  add('army_final', 'Army value at the end', last, k);
  add('army_peak', 'Army value, peak', peak, k);
  add('kills', 'Kills', col((i) => fin[i]?.kills ?? null), k);
  add('kill_value', 'Value destroyed', col((i) => fin[i]?.kill_value ?? null), k);
  add('gathered', 'Resources gathered', col((i) => (fin[i] ? fin[i].gathered : null)), k);
  add('score', 'Score', col((i) => fin[i]?.score ?? null), k);
  const lat = dec.map((d) => median(d.filter((e) => e.latency_ms != null).map((e) => e.latency_ms)));
  add('latency', 'Think time per decision (median)', lat, (x) => (x < 1000 ? Math.round(x) + ' ms' : (x / 1000).toFixed(1) + ' s'), 'low');
  const tok = dec.map((d) => { const t = d.filter((e) => e.completion_tokens && e.latency_ms); const ms = t.reduce((a, e) => a + e.latency_ms, 0); return t.length && ms ? t.reduce((a, e) => a + e.completion_tokens, 0) / (ms / 1000) : null; });
  add('tok_s', 'Tokens per second (mean)', tok, (x) => String(Math.round(x))); // the facts keep it; the video end card hides this row (render/finale.mjs)
  add('decisions', 'Decisions', dec.map((d) => (d.length ? d.length : null)), k, null);
  add('tokens', 'Tokens generated', dec.map((d) => { const t = d.reduce((a, e) => a + (e.completion_tokens || 0), 0); return t || null; }), k, null);
  return {
    winner, reason, time: mmss(ev.ticks), seconds: ev.seconds, draw: !winner,
    players: Array.from({ length: N }, (_, i) => ({ p: i + 1, name: players[i]?.name ?? `P${i + 1}`, model: players[i]?.model ?? '', hw: players[i]?.hw ?? players[i]?.hardware ?? '' })),
    rows,
  };
}
