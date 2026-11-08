#!/usr/bin/env node
// Story cut (w3-h, round 2): a 3 to 8 minute telling of the whole match instead of a highlight reel.
//   cold open (teaser of the climax) -> intro -> build-up -> first contact -> the decisive fight -> the end -> recap
// The game stops (freeze frame) at every key decision: the cards show what the model saw, its note word for word and its orders,
// Juno explains and asks whether it was right, then the game runs on at 1x to show the consequence. Between the stories the game is
// fast-forwarded on a speed ladder (1x ... 16x, never faster than 16x): the speed of a stretch follows how much happens in it.
//   buildStory(ev, hl, { target_s })  ->  { plan, teaser, story }
// Everything comes from the match log (events.json): no invented reasons, every pick is a pure function of the log and the target length.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TICK_HZ } from '../sim/util.mjs';
import { Timeline, describePlan, PLAN_DEFAULTS } from './plan.mjs';
import { scoreDecision } from './commentary.mjs';
import { shortOf } from './overlay.mjs';

export const STORY = {
  teaser_s: 0, teaser_pre_s: 6.5,       // cold open: this many output seconds of the climax (the base falls about teaser_pre_s in)
  lead_s: 6,                              // 1x run-up before a freeze (game seconds): the viewer sees the army move, the fog of war view of the model
  after1_s: 9, after_s: 21, after_speed: 3, // consequence: 1x for after1_s game seconds, then after_speed until after_s
  hold_s: { open: 10, single: 10, split: 12, compare: 10, decisive: 13 }, // freeze frame lengths (output seconds)
  fight_speed: 3,                         // big fights outside the story windows
  ladder: [1, 1.5, 2, 3, 4, 6, 8, 12, 16], cap: 16,             // playback speeds; nothing is ever faster than cap
  bin_ticks: 50,                          // fast-forward stretches are sampled every 5 game seconds
  gap_ticks: 320,                         // two freezes are at least this far apart (game ticks)
  short_gap_ticks: 200,                   // a fast-forward of at most 20 s of game time between slow stretches stays slow
  per_story_s: 27, base_s: 110,           // how many stories a target length can carry: (target - base_s) / per_story_s
  over: 1.18,                             // a cut may be this much longer than the target when it carries one more story
  tail_s: 24,                             // result banner and the end screen (the recap is spoken over it)
  pair_ticks: 150,                        // a decision of the other player this close to a key decision is shown next to it (split view)
};

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const clock = (tick) => { const s = Math.floor(tick / TICK_HZ); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const PLAN_WORDS = /bottleneck|counter|rush|raid|all-in|expand|siege|\bram|tier|defen[cs]e|push|attack|flank|retreat|scout|economy|boom/i;
const content = (e) => e.thought || e.summary || '';

// what an order-only decision is worth as a story (no note: nothing to quote, but the orders say what the model does)
function scoreOrdersOnly(e) {
  const s = e.summary || '';
  if (!s) return 0;
  let v = 1.6;
  if (/\battack\b/.test(s)) v += 1.8;
  if (/\bram\b|\bcatapult\b/.test(s)) v += 3.2;
  if (/advance tier/.test(s)) v += 1.5;
  if (/siege_workshop|stables/.test(s)) v += 0.6;
  return v;
}

// every decision as a story candidate (with the notes and the order-only ones), scored from the log
export function decisionCandidates(ev) {
  const dec = ev.events.filter((e) => e.type === 'llm_decision').sort((a, b) => a.t - b.t || a.p - b.p);
  const lastBy = {};
  const out = [];
  for (const e of dec) {
    const prev = lastBy[e.p] || null;
    lastBy[e.p] = e;
    let score = 0;
    if (e.thought) score = scoreDecision(e, prev, ev.events)?.score ?? 0;
    else score = scoreOrdersOnly(e);
    if (score > 0) out.push({ e, prev, score });
  }
  return out;
}

const seenOf = (e) => e.seen || null;
function momentOf(e, prev, score) {
  const s = seenOf(e), ps = prev && prev.seen ? prev.seen : null;
  return {
    id: e.id, p: e.p, n: e.n, t: e.t, start_tick: e.start_tick, score, tags: [], thought: e.thought || '', summary: e.summary, orders: e.orders, seen: s, prev_seen: ps,
    latency_ms: e.latency_ms, completion_tokens: e.completion_tokens, tok_s: e.tok_s,
    focus: s && s.enemy_xy ? { x: s.enemy_xy[0], y: s.enemy_xy[1], what: 'enemy' } : s && s.start ? { x: s.start[0] + 2, y: s.start[1] + 2, what: 'base' } : null,
  };
}

// ---------------------------------------------------------------- what happens when (chapters and weights)
export function keyTicks(ev) {
  const battles = ev.events.filter((e) => e.type === 'battle');
  const big = battles.filter((b) => b.kills >= 8 || b.value >= 500);
  const first = big[0] || battles[0] || null;
  const decisive = [...battles].sort((a, b) => b.value - a.value || a.t - b.t)[0] || null;
  const fall = ev.events.find((e) => e.type === 'base_destroyed') || null;
  const vic = ev.events.find((e) => e.type === 'victory') || null;
  const tiers = ev.events.filter((e) => e.type === 'tier_up');
  return { battles, first, decisive, fall, vic, tiers };
}

export function chaptersOf(ev, K) {
  const T = ev.ticks;
  const contact = K.first ? Math.max(900, K.first.t - 500) : T * 2;
  const decisive = K.decisive && K.decisive !== K.first ? Math.max(contact + 300, K.decisive.t - 600) : K.first ? Math.max(contact + 300, K.first.t + 400) : T * 2;
  const end = K.fall ? Math.max(decisive + 200, K.fall.t - 100) : K.vic ? Math.max(decisive + 200, K.vic.t - 200) : T * 2;
  return { contact, decisive, end };
}

function weightAt(tick, ev, K) {
  let w = 1;
  if (tick < 900) w *= 2.2;
  for (const t of K.tiers) if (Math.abs(tick - t.t) < 200) w *= 2.5;
  for (const b of K.battles) if (tick >= b.t - 60 && tick <= b.t_end + 60) w *= b.kills >= 8 ? 6 : 3;
  for (const e of ev.events) {
    if (e.type === 'key_building' && Math.abs(tick - e.t) < 80) w *= 1.5;
    else if (e.type === 'building_destroyed' && Math.abs(tick - e.t) < 90) w *= 3;
    else if (e.type === 'first_contact' && Math.abs(tick - e.t) < 100) w *= 3;
  }
  return w;
}

// ---------------------------------------------------------------- picking the stories
export function pickStories(ev, hl, target_s, S = STORY) {
  const K = keyTicks(ev);
  const ch = chaptersOf(ev, K);
  const cands = decisionCandidates(ev);
  const byP = (p) => cands.filter((c) => c.e.p === p);
  const units = [];
  // opening: the first decision with a note or orders of every player, shown side by side
  const firsts = [1, 2].map((p) => ev.events.find((e) => e.type === 'llm_decision' && e.p === p && content(e))).filter(Boolean);
  if (firsts.length) {
    const t = Math.max(...firsts.map((e) => e.t)) + 2;
    const decs = firsts.map((e) => e.id);
    // the model's note that is visible at the freeze: the latest content decision of each player up to t
    const latest = [1, 2].map((p) => [...ev.events].filter((e) => e.type === 'llm_decision' && e.p === p && e.t <= t && content(e)).at(-1)).filter(Boolean);
    units.push({ kind: 'open', fixed: true, prio: 1e3, tick: t, lead_tick: ev.bench ? 0 : Math.max(0, Math.min(...latest.map((e) => e.t)) - 60), decs: latest.map((e) => e.id), hold_s: S.hold_s.open + (ev.bench ? 8 : 0), after_s: 6, after1_s: 6, label: 'opening plans' });
  }
  // tier race: the second tier-up, both players side by side (army and buildings)
  if (K.tiers.length >= 2) {
    const t = K.tiers[1].t;
    units.push({ kind: 'compare', prio: 14, tick: t, lead_tick: t - 60, decs: [], hold_s: S.hold_s.compare, after_s: 18, after1_s: 8, label: 'tier race' });
  }
  // decisions, paired with the other player's decision close to it
  const pool = cands.filter((c) => c.e.t > 600).map((c) => {
    let bonus = 0;
    if (K.decisive && c.e.t >= K.decisive.t - 700 && c.e.t <= K.decisive.t + 60) bonus += 10;
    else if (K.first && c.e.t >= K.first.t - 500 && c.e.t <= K.first.t - 100) bonus += 8; // the decisions that start the first fight
    else if (K.first && c.e.t > K.first.t - 100 && c.e.t <= K.first.t + 20) bonus += 3;
    const partner = ev.events.filter((e) => e.type === 'llm_decision' && e.p !== c.e.p && content(e) && Math.abs(e.t - c.e.t) <= S.pair_ticks).sort((a, b) => Math.abs(a.t - c.e.t) - Math.abs(b.t - c.e.t))[0] || null;
    if (partner) bonus += 1.5;
    if (c.e.thought && PLAN_WORDS.test(c.e.thought)) bonus += 1.5; // the note states a plan or a reason
    return { ...c, partner, prio: c.score + bonus + (c.e.thought ? Math.min(1.5, c.e.thought.length / 90) : 0) };
  }).sort((a, b) => b.prio - a.prio || a.e.t - b.e.t);
  const want = clamp(Math.round((target_s - S.base_s) / S.per_story_s), 1, 14);
  const order = [...units]; // most important first: the opening, the tier race, then the decisions by chapter in turn (build-up, decisive fight, first contact, ...), then by priority
  const free = (t) => order.every((u) => Math.abs(u.tick - t) >= S.gap_ticks);
  const groups = { build: [], contact: [], fight: [] };
  for (const c of pool) { const g = c.e.t >= ch.decisive ? 'fight' : c.e.t >= ch.contact ? 'contact' : 'build'; groups[g].push(c); }
  const seq = ['fight', 'contact', 'fight', 'build', 'build', 'contact', 'fight', 'build', 'contact', 'build', 'fight', 'contact', 'build', 'build'];
  const used = new Set();
  const take = (c) => {
    const tick = c.partner ? Math.max(c.e.t, c.partner.t) : c.e.t, first = c.partner ? Math.min(c.e.t, c.partner.t) : c.e.t;
    if (!free(tick) || !free(first)) return false;
    const ids = c.partner ? [c.e, c.partner].sort((a, b) => a.t - b.t || a.p - b.p).map((e) => e.id) : [c.e.id];
    const decisive = K.decisive && c.e.t >= K.decisive.t - 700 && c.e.t <= K.decisive.t + 60;
    order.push({ kind: c.partner ? 'split' : 'decision', prio: c.prio, tick, lead_tick: first - S.lead_s * TICK_HZ, decs: ids, p: c.e.p, hold_s: decisive ? S.hold_s.decisive : c.partner ? S.hold_s.split : S.hold_s.single, after_s: decisive ? 46 : S.after_s, after1_s: decisive ? 14 : S.after1_s, after_speed: decisive ? 2 : S.after_speed, label: `decision ${c.e.n}` });
    used.add(c);
    return true;
  };
  for (const g of seq) { for (const c of groups[g]) if (!used.has(c) && take(c)) break; }
  for (const c of pool) if (!used.has(c)) take(c);
  if (target_s < 240) { const i = order.findIndex((u) => u.kind === 'compare'); if (i > 0) order.splice(Math.min(order.length, 3), 0, ...order.splice(i, 1)); } // a short cut: the decisive decisions before the tier race
  void want;
  const all = order.slice(0, Math.max(1, want)).sort((a, b) => a.tick - b.tick);
  // no window may run into the next lead: shorten the consequence stretch of a story that is followed closely
  for (let i = 0; i + 1 < all.length; i++) {
    const u = all[i], v = all[i + 1];
    const room = v.lead_tick - 30 - u.tick;
    if (room < u.after_s * TICK_HZ) { u.after_s = Math.max(5, Math.floor(room / TICK_HZ)); u.after1_s = Math.min(u.after1_s, u.after_s); }
  }
  return { units: all, order, K, ch, pool };
}

// ---------------------------------------------------------------- the plan
function snapSpeed(v, S) {
  let best = S.ladder[0], bd = 1e9;
  const lv = Math.log(clamp(v, 1, S.cap));
  for (const s of S.ladder) { const d = Math.abs(Math.log(s) - lv); if (d < bd) { bd = d; best = s; } }
  return best;
}

// big fights are never fast-forwarded: they run at fight_speed (outside the windows of the stories, which have their own)
export function fightRanges(ev, units, S, window, taken) {
  const out = [];
  const flips = ev.events.filter((e) => e.type === 'momentum_swing');
  const bigs = ev.events.filter((e) => e.type === 'battle' && (e.kills >= 8 || e.value >= 800 || flips.some((f) => f.t >= e.t && f.t <= (e.t_end ?? e.t) + 150)));
  for (const b of bigs) {
    let a = Math.max(window[0], b.t - 40), e = Math.min(window[1], b.t_end + 20);
    // cut away what a story window (or another fight) already holds
    let parts = [[a, e]];
    for (const r of [...taken, ...out]) parts = parts.flatMap(([x, y]) => (r.b <= x || r.a >= y ? [[x, y]] : [...(r.a > x ? [[x, r.a]] : []), ...(r.b < y ? [[r.b, y]] : [])]));
    for (const [x, y] of parts) if (y - x >= 60) out.push({ a: x, b: y, speed: S.fight_speed, kind: 'fight' });
  }
  return out;
}

function fixedRanges(units, S, window, ev = null) {
  const rs = [];
  for (const u of units) {
    const a = Math.max(window[0], u.lead_tick), h = u.tick, e1 = h + u.after1_s * TICK_HZ, e2 = h + u.after_s * TICK_HZ;
    rs.push({ a, b: h, speed: 1, kind: 'lead', unit: u.id });
    rs.push({ a: h, b: e1, speed: 1, kind: 'after', unit: u.id });
    if (e2 > e1) rs.push({ a: e1, b: Math.min(window[1], e2), speed: u.after_speed || S.after_speed, kind: 'after', unit: u.id });
  }
  const base = rs.filter((r) => r.b > r.a).sort((x, y) => x.a - y.a);
  if (!ev) return base;
  return [...base, ...fightRanges(ev, units, S, window, base)].sort((x, y) => x.a - y.a);
}

export function rangesWith(fixed, window, ev, K, lambda, S) {
  const rs = [];
  const gap = (a, b) => {
    if (b - a <= S.short_gap_ticks && rs.length) { rs.push({ a, b, speed: Math.max(1, Math.min(S.after_speed, rs[rs.length - 1].speed)), kind: 'ff' }); return; }
    const bins = [];
    for (let t = a; t < b; t += S.bin_ticks) bins.push({ a: t, b: Math.min(b, t + S.bin_ticks), w: weightAt((t + Math.min(b, t + S.bin_ticks)) / 2, ev, K) });
    const idx = bins.map((x) => S.ladder.indexOf(snapSpeed(lambda / x.w, S)));
    const sm = idx.map((v, i) => Math.min(v, idx[i - 1] ?? v, idx[i + 1] ?? v)); // slow down a little before and after an event
    bins.forEach((x, i) => { const sp = S.ladder[sm[i]]; const l = rs[rs.length - 1]; if (l && l.speed === sp && l.kind === 'ff' && l.b === x.a) l.b = x.b; else rs.push({ a: x.a, b: x.b, speed: sp, kind: 'ff' }); });
  };
  let cur = window[0];
  for (const f of fixed) { if (f.a > cur) gap(cur, f.a); rs.push({ ...f }); cur = Math.max(cur, f.b); }
  if (cur < window[1]) gap(cur, window[1]);
  // equal neighbours merge
  const out = [];
  for (const r of rs) { const l = out[out.length - 1]; if (l && l.speed === r.speed && l.kind === r.kind && l.kind === 'ff' && l.b === r.a) l.b = r.b; else out.push(r); }
  return out;
}

function solve(ev, K, units, window, target_s, S, P) {
  const holds = units.map((u) => ({ tick: u.tick, dur_s: u.hold_s }));
  const fixed = fixedRanges(units, S, window, ev);
  const dur = (lambda) => { const rs = rangesWith(fixed, window, ev, K, lambda, S); const tl = new Timeline(rs, window, { ...P, holds }); return { rs, tl, d: tl.duration_s }; };
  const lo0 = dur(1e6); // everything as fast as the cap allows
  if (lo0.d > target_s * S.over) return { ok: false, min_s: lo0.d };
  if (lo0.d > target_s) return { ok: true, ...lo0, lambda: 1e6, holds, fixed, slack: target_s - lo0.d }; // a little over the target: still about the length asked for
  let lo = 0.5, hi = 600, best = lo0;
  const slow = dur(0.5);
  if (slow.d <= target_s) return { ok: true, ...slow, lambda: 0.5, holds, fixed, slack: target_s - slow.d };
  for (let i = 0; i < 18; i++) {
    const mid = Math.sqrt(lo * hi), r = dur(mid);
    if (r.d > target_s) lo = mid; else { hi = mid; best = r; }
  }
  return { ok: true, ...best, lambda: hi, holds, fixed, slack: target_s - best.d };
}

// the parameters follow the target length: a 3 minute cut has shorter freezes, a shorter tail and fights a little faster, an 8 minute one has room for more
export function storyParams(target) {
  const h = clamp(0.55 + 0.0015 * target, 0.82, 1);
  const hs = (x) => +(x * h).toFixed(1);
  return {
    tail_s: clamp(10 + 0.055 * target, 15, 27), lead_s: target < 240 ? 5 : 6, after_s: target < 240 ? 16 : 21, after1_s: target < 240 ? 7 : 9,
    fight_speed: target < 240 ? 6 : target > 400 ? 2 : 3,
    cap: target < 240 ? 16 : 8, ladder: [1, 1.5, 2, 3, 4, 6, 8, 12, 16].filter((v) => v <= (target < 240 ? 16 : 8)), // a long cut leaves room to explain: the fast forward is never faster than 8x
    hold_s: { open: hs(36), single: hs(9), split: hs(10), compare: hs(10), decisive: hs(11) },
  };
}

export function buildStory(ev, hl, opts = {}) {
  const target = opts.target_s || 300;
  const S = { ...STORY, ...storyParams(target), ...(opts.story || {}) };
  const window = opts.window || [0, ev.ticks];
  const P = { ...PLAN_DEFAULTS, tail_s: S.tail_s, ramp_max_s: 3.0, ...(opts.params || {}) };
  const K = keyTicks(ev);
  // the cold open is not part of the main timeline: it is a second short clip that is put in front of it
  const teaserDur = S.teaser_s;
  const mainTarget = target - teaserDur;
  const picked = pickStories(ev, hl, target, S);
  let sol = null, n = picked.units.length;
  let units = picked.units;
  for (;;) {
    units.forEach((u, i) => { u.id = `u${i + 1}`; });
    sol = solve(ev, K, units, window, mainTarget, S, P);
    if (sol.ok || n <= 1) break;
    n--; // fewer stories until the cut fits: the least important one (end of the importance order) goes first
    const keep = new Set(picked.order.slice(0, n));
    units = picked.units.filter((u) => keep.has(u));
    // shortened windows of the stories that stay were computed with their old neighbours: that is fine (they only get longer room)
  }
  if (!sol.ok) throw new Error(`the story cut does not fit ${target} s even without stories (needs ${sol.min_s.toFixed(0)} s for the main part)`);
  const tl = sol.tl;
  const hl2 = { scenes: hl.scenes.map((s) => ({ ...s })) };
  const selected = []; // scenes are not followed by the director; the casters' focus and the story shots decide
  const plan0 = describePlan({ replay: ev.replay }, hl2, { mode: 'story', window, P: { ...P, holds: sol.holds }, ranges: sol.rs, selected, target: [target, target] });
  // moments (decisions of the stories) for the fog of war view, the saw-facts and the camera
  const byId = new Map(ev.events.filter((e) => e.type === 'llm_decision').map((e) => [e.id, e]));
  const lastBy = {};
  const prevOf = new Map();
  for (const e of ev.events.filter((x) => x.type === 'llm_decision').sort((a, b) => a.t - b.t)) { prevOf.set(e.id, lastBy[e.p] || null); lastBy[e.p] = e; }
  const moments = [];
  for (const u of units) for (const id of u.decs) {
    const e = byId.get(id);
    const m = momentOf(e, prevOf.get(id), 0);
    const order = [...u.decs].sort((x, y) => byId.get(x).t - byId.get(y).t);
    m.story = { unit: u.id, lead_tick: Math.max(0, u.lead_tick), hold_tick: u.tick, fog: true, hold_only: u.kind === 'open', fog_part: [order.indexOf(id), order.length] };
    moments.push(m);
  }
  moments.sort((a, b) => a.t - b.t);
  // chapters
  const chp = chaptersOf(ev, K);
  const defs = [['intro', 'INTRO', 0], ['build', 'BUILD-UP', Math.max(...units.filter((u) => u.kind === 'open').map((u) => u.tick + u.after_s * TICK_HZ), 0)], ['contact', 'FIRST CONTACT', chp.contact], ['fight', 'DECISIVE FIGHT', S.fight_at === 'first-big' && K.first ? Math.max(chp.contact + 300, K.first.t - 100) : chp.decisive], ['end', 'THE END', chp.end]];
  const chapters = [];
  for (const [id, title, tick] of defs) { if (tick < ev.ticks && (!chapters.length || tick > chapters.at(-1).tick_a + 100)) chapters.push({ id, title, tick_a: tick }); }
  chapters.forEach((c, i) => { c.tick_b = chapters[i + 1] ? chapters[i + 1].tick_a : ev.ticks; c.o0 = tl.outAt(c.tick_a); c.o1 = chapters[i + 1] ? tl.outAt(chapters[i + 1].tick_a) : tl.body_s; });
  const vic = K.vic;
  const recapO0 = vic ? Math.min(tl.body_s, tl.outAt(vic.t) + 2.4) : tl.body_s;
  chapters.at(-1).o1 = Math.max(chapters.at(-1).o0 + 1, recapO0);
  chapters.push({ id: 'recap', title: 'RECAP', tick_a: vic ? vic.t : ev.ticks, tick_b: ev.ticks, o0: chapters.at(-1).o1, o1: plan0.duration_s });
  for (const u of units) {
    u.chapter = [...chapters].reverse().find((c) => c.id !== 'recap' && u.tick >= c.tick_a)?.id || 'intro';
    u.o_lead = tl.outAt(Math.max(0, u.lead_tick)); u.o_hold0 = tl.outAt(u.tick); u.o_hold1 = tl.outAfterHold(u.tick); u.o_after1 = tl.outAt(u.tick + u.after_s * TICK_HZ);
  }
  const story = {
    version: 1, target_s: target, teaser_s: teaserDur, offset_s: teaserDur, main_s: +plan0.duration_s.toFixed(2), total_s: +(plan0.duration_s + teaserDur).toFixed(2),
    lambda: +sol.lambda.toFixed(2), cap: S.cap, chapters: chapters.map((c) => ({ ...c, o0: +c.o0.toFixed(2), o1: +c.o1.toFixed(2) })),
    units: units.map((u) => ({ ...u, o_lead: +u.o_lead.toFixed(2), o_hold0: +u.o_hold0.toFixed(2), o_hold1: +u.o_hold1.toFixed(2), o_after1: +u.o_after1.toFixed(2) })),
    holds: sol.holds,
  };
  const plan = { ...plan0, moments, story };
  // teaser_s 0 (default since 05.11.): no cold open; the show starts with the first line
  const teaser = teaserDur > 0 ? coldOpenPlan(ev, hl2, { seconds: teaserDur, pre_s: S.teaser_pre_s }) : null;
  if (teaser) { teaser.story = { ...story, teaser: true, units: [], offset_s: 0 }; story.teaser_window = teaser.window; }
  return { plan, teaser, story, stats: stats(plan, units) };
}

// cold open: the climax at 1x, a short clip of its own that is put in front of the main part (story cut and highlight cut)
export function coldOpenPlan(ev, hl, { seconds = 10, pre_s = 6.5 } = {}) {
  const K = keyTicks(ev), climax = K.fall ? K.fall.t : K.vic ? K.vic.t : ev.ticks - 100;
  const ta = Math.max(0, Math.round(climax - pre_s * TICK_HZ)), tb = Math.min(ev.ticks, ta + Math.round(seconds * TICK_HZ));
  return describePlan({ replay: ev.replay }, hl, { mode: 'story-teaser', window: [ta, tb], P: { ...PLAN_DEFAULTS, tail_s: 0 }, ranges: [{ a: ta, b: tb, speed: 1, kind: 'scene' }], selected: [], target: null });
}

function stats(plan, units) {
  const tl = new Timeline(plan.ranges, plan.window, plan.params);
  let freeze = tl.hold.reduce((a, b) => a + b, 0);
  const sp = {};
  for (const r of plan.ranges) { const k = r.speed; const dt = (r.b - r.a) / TICK_HZ / k; sp[k] = (sp[k] || 0) + dt; }
  return { duration_s: plan.duration_s, freeze_s: +freeze.toFixed(1), seconds_at_speed: Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, +v.toFixed(1)])), max_speed: Math.max(...plan.ranges.map((r) => r.speed)), units: units.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : null);
  const src = a.find((x, i) => !x.startsWith('--') && !(a[i - 1] || '').startsWith('--'));
  if (!src) { console.error('usage: node tools/story.mjs replays/<id> [--target 300] [--out plan.json]'); process.exit(2); }
  const ev = JSON.parse(fs.readFileSync(path.join(src, 'events.json'), 'utf8'));
  const hl = JSON.parse(fs.readFileSync(path.join(src, 'highlights.json'), 'utf8'));
  const r = buildStory(ev, hl, { target_s: +(opt('--target') || 300), story: opt('--story') ? JSON.parse(opt('--story')) : undefined });
  if (opt('--out')) fs.writeFileSync(opt('--out'), JSON.stringify(r.plan));
  console.log(JSON.stringify(r.stats));
  for (const c of r.story.chapters) console.log(`chapter ${c.title.padEnd(14)} ${clock(c.tick_a)}  out ${c.o0.toFixed(1)}-${c.o1.toFixed(1)}`);
  for (const u of r.story.units) console.log(`${u.id} ${u.kind.padEnd(8)} ${u.chapter.padEnd(8)} hold@${clock(u.tick)} decs ${u.decs.join(',')} out lead ${u.o_lead} hold ${u.o_hold0}-${u.o_hold1} after-> ${u.o_after1}`);
  console.log(`main ${r.story.main_s} s + cold open ${r.story.teaser_s} s = ${r.story.total_s} s`);
}
void shortOf;
