#!/usr/bin/env node
// Speed curve / playback plan. Quiet stretches run at 4x / 8x / 16x (more if the target length needs it) with smooth
// ramps, highlight scenes run at 1x. The plan is declarative (ranges of game ticks with a speed) and a Timeline turns it
// into the exact map output time <-> game tick. forceNormalSpeed() forces 1x windows (to fit commentary later).
//   node tools/plan.mjs replays/<id> [--mode highlight|full] [--target 60,140] [--out plan.json] [--from-tick N --to-tick N]
//        [--force 3000-3400,9000-9500]   (force 1x windows, ticks)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TICK_HZ } from '../sim/util.mjs';
import { MOMENTS } from './commentary.mjs';

export const PLAN_DEFAULTS = {
  ramp_s: 1.1,            // shortest ramp (output seconds); a bigger change takes longer: ramp_s_base + ramp_per_ln * |ln(ratio)|, at most ramp_max_s
  ramp_base_s: 0.5, ramp_per_ln: 0.95, ramp_max_s: 3.4,
  tail_s: 4,              // hold on the last frame (result banner)
  min_quiet_s: 10,        // quiet gaps shorter than this (game seconds) are played at 1x
  ladder: [4, 8, 16, 32, 64],
  ladder_gap_s: [45, 140], // quiet gap shorter than 45 game s -> ladder[k], shorter than 140 -> ladder[k+1], else ladder[k+2]
  target_s: [60, 140],    // highlight cut length (output seconds)
  max_ladder_shift: 1,   // quiet stretches may run up to ladder[2 + 1] = 32x before scenes are dropped
  shift_penalty_s: 12,   // a faster ladder must win this many seconds of 1x action per step
  min_scenes: 2,
  base_fall_s: 10,        // the highlight cut always shows this much of a falling base at 1x
  res_ticks: 0.1,         // timeline sampling resolution (fine, so the speed ramps are smooth to the frame)
};

const sm = (u) => u * u * u * (u * (u * 6 - 15) + 10); // smootherstep: no acceleration jump at the ends

// Speed profile of one ramp: from speed sa to sb in `ramp_s` output seconds (shortened so that it covers at most maxLen ticks).
function rampTable(sa, sb, ramp_s, maxLen) {
  const la = Math.log(sa), lb = Math.log(sb), K = 240;
  const prof = (u) => Math.exp(la + (lb - la) * sm(u));
  let R = ramp_s, len = 0;
  for (let pass = 0; pass < 2; pass++) {
    len = 0;
    for (let k = 0; k < K; k++) len += prof((k + 0.5) / K) * (R / K) * TICK_HZ;
    if (len > maxLen) R *= maxLen / len; else break;
  }
  const g = new Float64Array(K + 1), v = new Float64Array(K + 1);
  v[0] = prof(0);
  for (let k = 0; k < K; k++) { g[k + 1] = g[k] + prof((k + 0.5) / K) * (R / K) * TICK_HZ; v[k + 1] = prof((k + 1) / K); }
  return {
    len: g[K],
    at(x) {
      if (x <= 0) return v[0];
      if (x >= g[K]) return v[K];
      let lo = 0, hi = K;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (g[m] <= x) lo = m; else hi = m; }
      return v[lo] + ((x - g[lo]) / (g[lo + 1] - g[lo])) * (v[lo + 1] - v[lo]);
    },
  };
}

// ---------------- timeline ----------------
export class Timeline {
  constructor(ranges, window, params = {}) {
    this.P = { ...PLAN_DEFAULTS, ...params };
    this.a = window[0];
    this.b = window[1];
    const res = this.P.res_ticks;
    const N = Math.max(1, Math.ceil((this.b - this.a) / res));
    this.N = N;
    this.res = res;
    const rs = ranges.filter((r) => r.b > this.a && r.a < this.b).map((r) => ({ ...r, a: Math.max(r.a, this.a), b: Math.min(r.b, this.b) }));
    const speed = new Float64Array(N);
    let k = 0;
    for (let i = 0; i < N; i++) {
      const g = this.a + (i + 0.5) * res;
      while (k < rs.length - 1 && g >= rs[k].b) k++;
      speed[i] = rs[k].speed;
    }
    // Ramps sit inside the faster neighbour. A ramp is smooth in OUTPUT time: ln(speed) follows a smoothstep over ramp_s
    // seconds, and the game time it covers is the integral of the speed (so a 32x -> 1x ramp covers many game seconds).
    for (let j = 0; j + 1 < rs.length; j++) {
      const L = rs[j], R = rs[j + 1];
      if (L.speed === R.speed) continue;
      const B = L.b;
      const fast = L.speed > R.speed ? L : R;
      const rl = Math.min(this.P.ramp_max_s, Math.max(this.P.ramp_s, this.P.ramp_base_s + this.P.ramp_per_ln * Math.abs(Math.log(L.speed / R.speed))));
      const tab = rampTable(L.speed, R.speed, rl, 0.45 * (fast.b - fast.a));
      const g0 = L.speed > R.speed ? B - tab.len : B;
      for (let i = Math.max(0, Math.floor((g0 - this.a) / res)); i < N; i++) {
        const g = this.a + (i + 0.5) * res;
        if (g < g0) continue;
        if (g > g0 + tab.len) break;
        speed[i] = tab.at(g - g0);
      }
    }
    this.speed = speed;
    // freeze frames (story cut): the game stops at a tick for dur_s output seconds; the hold sits BEFORE sample i (the tick of the hold)
    const hold = new Float64Array(N + 1);
    for (const h of this.P.holds || []) { const i = Math.min(N - 1, Math.max(0, Math.round((h.tick - this.a) / res))); hold[i] += h.dur_s; }
    this.hold = hold;
    const T = new Float64Array(N + 1);
    for (let i = 0; i < N; i++) T[i + 1] = T[i] + hold[i] + res / (TICK_HZ * speed[i]);
    this.T = T;
    this.body_s = T[N];
    this.duration_s = T[N] + this.P.tail_s;
  }
  // game tick shown at output time t (seconds); holds the last tick during the tail and during a freeze frame
  tickAt(t) {
    const { T, N, res, hold } = this;
    if (t <= 0) return this.a;
    if (t >= T[N]) return this.b;
    let lo = 0, hi = N;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] <= t) lo = m; else hi = m; }
    const local = t - T[lo];
    if (local < hold[lo]) return this.a + lo * res;
    return this.a + (lo + (local - hold[lo]) / (T[lo + 1] - T[lo] - hold[lo])) * res;
  }
  // output time at which a game tick is shown (the START of a freeze frame at that tick)
  outAt(tick) {
    const x = Math.min(this.N, Math.max(0, Math.round(((tick - this.a) / this.res) * 1e4) / 1e4));
    const i = Math.min(this.N - 1, Math.floor(x));
    return x === i ? this.T[i] : this.T[i] + this.hold[i] + (x - i) * (this.T[i + 1] - this.T[i] - this.hold[i]);
  }
  // output time at which the game runs on again after the freeze frame at this tick (the same as outAt when there is none)
  outAfterHold(tick) { const i = Math.min(this.N - 1, Math.max(0, Math.round((tick - this.a) / this.res))); return this.T[i] + this.hold[i]; }
  speedAtTick(tick) { return this.speed[Math.min(this.N - 1, Math.max(0, Math.floor((tick - this.a) / this.res)))]; }
  // 0 during a freeze frame
  speedAtOut(t) {
    if (t >= this.body_s) return 1;
    const { T, N } = this;
    let lo = 0, hi = N;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] <= t) lo = m; else hi = m; }
    return t - T[lo] < this.hold[lo] ? 0 : this.speed[lo];
  }
}

// ---------------- ranges ----------------
function normalize(ranges, window, P) {
  const [wa, wb] = window;
  const rs = ranges.filter((r) => r.b > r.a).sort((x, y) => x.a - y.a).map((r) => ({ ...r }));
  // short quiet gaps become 1x
  for (const r of rs) if (r.kind === 'quiet' && (r.b - r.a) / TICK_HZ < P.min_quiet_s) { r.speed = 1; r.kind = 'merged'; }
  // merge neighbours with equal speed that are both "normal"
  const out = [];
  for (const r of rs) {
    const l = out[out.length - 1];
    if (l && l.speed === 1 && r.speed === 1) { l.b = r.b; l.kind = l.kind === 'forced' || r.kind === 'forced' ? 'forced' : l.kind === 'scene' || r.kind === 'scene' ? 'scene' : 'merged'; if (r.scene) l.scenes = [...(l.scenes || [l.scene]), r.scene].filter(Boolean); }
    else out.push({ ...r });
  }
  if (out.length) { out[0].a = wa; out[out.length - 1].b = wb; }
  return out;
}

function quietSpeed(len_s, P, shift) {
  const [g1, g2] = P.ladder_gap_s;
  const k = len_s < g1 ? 0 : len_s < g2 ? 1 : 2;
  return P.ladder[Math.min(P.ladder.length - 1, Math.max(0, k + shift))];
}

function rangesFor(selected, window, P, shift) {
  const [wa, wb] = window;
  const sc = selected.map((s) => ({ a: Math.max(wa, s.start), b: Math.min(wb, s.end), scene: s.id })).filter((s) => s.b > s.a).sort((x, y) => x.a - y.a);
  const rs = [];
  let cur = wa;
  for (const s of sc) {
    if (s.a > cur) rs.push({ a: cur, b: s.a, kind: 'quiet' });
    rs.push({ a: Math.max(cur, s.a), b: s.b, speed: 1, kind: 'scene', scene: s.scene });
    cur = Math.max(cur, s.b);
  }
  if (cur < wb) rs.push({ a: cur, b: wb, kind: 'quiet' });
  for (const r of rs) if (r.kind === 'quiet') r.speed = quietSpeed((r.b - r.a) / TICK_HZ, P, shift);
  return normalize(rs, window, P);
}

// ---------------- plan ----------------
// opts: mode 'highlight' | 'full', target_s [min,max], window [aTick,bTick], params overrides, forced [{a,b}|{at,out_s}]
export function buildPlan(ev, hl, opts = {}) {
  const P = { ...PLAN_DEFAULTS, ...(opts.params || {}) };
  const mode = opts.mode || 'highlight';
  const window = opts.window || [0, ev.ticks];
  const target = opts.target_s || P.target_s;
  const inWin = hl.scenes.filter((s) => s.end > window[0] && s.start < window[1]);
  const byRank = [...inWin].sort((x, y) => x.rank - y.rank);
  const mandatory = inWin.filter((s) => s.kind === 'victory' || s.kind === 'resign');
  if (mode === 'highlight') for (const s of inWin.filter((x) => x.kind === 'base_destroyed')) mandatory.push({ ...s, end: Math.min(s.end, s.start + P.base_fall_s * TICK_HZ) });
  let selected, shift = 0, ranges, tl;
  const make = (sel, sh) => { const rs = rangesFor(sel, window, P, sh); return [rs, new Timeline(rs, window, P)]; };
  if (mode === 'full') {
    selected = inWin;
    [ranges, tl] = make(selected, 0);
  } else {
    // Try every quiet-speed shift: add scenes in rank order while the cut stays within the target length (lower
    // ranked scenes may still fill gaps), then keep the shift that gives the most 1x action.
    const oneX = (sel) => sel.reduce((x, r) => x + (r.end - r.start) / TICK_HZ, 0);
    let best = null;
    for (let sh = 0; sh <= P.max_ladder_shift; sh++) {
      let sel = [...mandatory];
      let [rs, t] = make(sel, sh);
      for (const s of byRank) {
        if (sel.some((x) => x.id === s.id)) continue;
        const [rs2, t2] = make([...sel, s], sh);
        if (t2.duration_s <= target[1]) { sel = [...sel, s]; rs = rs2; t = t2; }
      }
      if (t.duration_s > target[1]) continue; // even the mandatory scenes do not fit at this shift
      const score = oneX(sel) - P.shift_penalty_s * sh;
      if (!best || score > best.score + 1e-6) best = { sel, rs, t, sh, score };
    }
    if (!best) {
      // nothing fits: speed the quiet stretches up further until the mandatory scenes (or one best scene) fit
      let sel = mandatory.length ? [...mandatory] : byRank.slice(0, 1);
      for (let k = 0; k < 6; k++) {
        const [rs, t] = make(sel, P.max_ladder_shift);
        if (t.duration_s <= target[1] || !quietLeft(rs, P)) { best = { sel, rs, t, sh: P.max_ladder_shift }; break; }
        P.ladder = P.ladder.map((v) => v * 2);
      }
      best ||= { sel, ...(() => { const [rs, t] = make(sel, P.max_ladder_shift); return { rs, t }; })(), sh: P.max_ladder_shift };
    }
    selected = best.sel; ranges = best.rs; tl = best.t; shift = best.sh;
    // too short: slow the quiet stretches down by one step
    void shift;
  }
  let plan = describePlan(ev, hl, { mode, window, P, ranges, selected, target });
  if (opts.forced?.length) plan = forceNormalSpeed(plan, opts.forced);
  return plan;
}

const quietLeft = (ranges, P) => ranges.some((r) => r.kind === 'quiet') && P.ladder[P.ladder.length - 1] < 4096;

export function describePlan(ev, hl, { mode, window, P, ranges, selected, target, forced = [] }) {
  const tl = new Timeline(ranges, window, P);
  const keyframes = [];
  for (let t = 0; t < tl.body_s; t += 0.5) keyframes.push([+t.toFixed(2), +tl.tickAt(t).toFixed(1), +tl.speedAtOut(t).toFixed(2)]);
  const oneX = ranges.filter((r) => r.speed === 1).reduce((a, r) => a + (r.b - r.a) / TICK_HZ, 0);
  return {
    version: 1, replay: ev.replay, mode, tick_hz: TICK_HZ, window, params: P, target_s: mode === 'highlight' ? target : null,
    ranges, selected_scenes: selected.map((s) => s.id).sort((x, y) => x - y), forced,
    scenes: hl.scenes.map((s) => ({ id: s.id, rank: s.rank, start: s.start, end: s.end, kind: s.kind, title: s.title, focus: s.focus, score: s.score, selected: selected.some((x) => x.id === s.id) })),
    duration_s: +tl.duration_s.toFixed(3), body_s: +tl.body_s.toFixed(3),
    stats: { normal_speed_game_s: +oneX.toFixed(1), max_speed: Math.max(...ranges.map((r) => r.speed)), ranges: ranges.length },
    keyframes,
  };
}

// Force 1x for the given windows ({a,b} ticks, or {at, out_s, pre_s?}: at a tick, long enough for out_s output seconds).
export function forceNormalSpeed(plan, windows) {
  const P = plan.params;
  const ws = windows.map((w) => {
    if (w.a !== undefined) return { a: w.a, b: w.b };
    const pre = (w.pre_s ?? 1) * TICK_HZ;
    return { a: Math.max(plan.window[0], w.at - pre), b: Math.min(plan.window[1], w.at - pre + w.out_s * TICK_HZ) };
  }).filter((w) => w.b > w.a);
  let rs = plan.ranges.map((r) => ({ ...r }));
  for (const w of ws) {
    const next = [];
    for (const r of rs) {
      if (r.b <= w.a || r.a >= w.b || r.speed === 1) { next.push(r); continue; }
      if (r.a < w.a) next.push({ ...r, b: w.a });
      next.push({ a: Math.max(r.a, w.a), b: Math.min(r.b, w.b), speed: 1, kind: 'forced' });
      if (r.b > w.b) next.push({ ...r, a: w.b });
    }
    rs = next;
  }
  // a forced window may start inside an already-1x range: mark nothing, it is 1x anyway
  rs = normalize(rs, plan.window, P);
  const forced = [...(plan.forced || []), ...ws].sort((x, y) => x.a - y.a);
  const selected = plan.scenes.filter((s) => s.selected);
  return describePlan({ replay: plan.replay }, { scenes: plan.scenes }, { mode: plan.mode, window: plan.window, P, ranges: rs, selected, target: plan.target_s, forced });
}

// Slow motion at key decisions (moments from tools/commentary.mjs). Each moment gets a 1x lead (the fog of war view and the
// "what it saw" text run in real time), then the game slows to `speed` around the tick where the order lands.
// Moments are added in the given order while the cut stays within maxDuration (seconds). Returns a new plan with plan.moments.
export function addSlowMotion(plan, moments, opts = {}) {
  const lead = opts.lead ?? MOMENTS.lead, pre = opts.pre ?? MOMENTS.pre, post = opts.post ?? MOMENTS.post, speed = opts.speed ?? MOMENTS.speed;
  const maxDur = opts.maxDuration ?? Infinity, maxCount = opts.maxCount ?? Infinity;
  let cur = plan;
  const chosen = [];
  for (const m of moments) {
    if (chosen.length >= maxCount) break;
    const a = m.t - lead - pre, b = m.t + post;
    if (a < cur.window[0] || b > cur.window[1]) continue;
    if (chosen.some((c) => Math.abs(c.t - m.t) < lead + pre + post + 20)) continue;
    let p2 = forceNormalSpeed(cur, [{ a, b }]);
    const sa = m.t - pre, sb = b;
    const rs = [];
    for (const r of p2.ranges) {
      if (r.b <= sa || r.a >= sb) { rs.push(r); continue; }
      if (r.a < sa) rs.push({ ...r, b: sa });
      rs.push({ a: Math.max(r.a, sa), b: Math.min(r.b, sb), speed, kind: 'slowmo' });
      if (r.b > sb) rs.push({ ...r, a: sb });
    }
    p2 = describePlan({ replay: p2.replay }, { scenes: p2.scenes }, { mode: p2.mode, window: p2.window, P: p2.params, ranges: rs, selected: p2.scenes.filter((s) => s.selected), target: p2.target_s, forced: p2.forced });
    if (p2.duration_s > maxDur) continue;
    cur = p2;
    chosen.push(m);
  }
  return { ...cur, moments: chosen.sort((x, y) => x.t - y.t), slowmo: { lead, pre, post, speed } };
}

export function timelineOf(plan) { return new Timeline(plan.ranges, plan.window, plan.params); }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : null);
  const src = a.find((x, i) => !x.startsWith('--') && !(a[i - 1] || '').startsWith('--'));
  if (!src) { console.error('usage: node tools/plan.mjs replays/<id> [--mode highlight|full] [--target 60,140] [--out plan.json]'); process.exit(2); }
  const ev = JSON.parse(fs.readFileSync(path.join(src, 'events.json'), 'utf8'));
  const hl = JSON.parse(fs.readFileSync(path.join(src, 'highlights.json'), 'utf8'));
  const mode = opt('--mode') || 'highlight';
  const window = opt('--from-tick') || opt('--to-tick') ? [+(opt('--from-tick') || 0), +(opt('--to-tick') || ev.ticks)] : null;
  const forced = opt('--force') ? opt('--force').split(',').map((x) => { const [a, b] = x.split('-').map(Number); return { a, b }; }) : undefined;
  const plan = buildPlan(ev, hl, { mode, target_s: opt('--target') ? opt('--target').split(',').map(Number) : undefined, window: window || undefined, forced });
  const out = opt('--out') || path.join(src, mode === 'full' ? 'plan-full.json' : 'plan.json');
  fs.writeFileSync(out, JSON.stringify(plan));
  console.log(`${out}: ${mode}, ${plan.duration_s}s output for ${((plan.window[1] - plan.window[0]) / TICK_HZ).toFixed(0)}s game, ${plan.selected_scenes.length}/${plan.scenes.length} scenes at 1x, max speed ${plan.stats.max_speed}x`);
}
