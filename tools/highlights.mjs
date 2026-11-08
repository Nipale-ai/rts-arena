#!/usr/bin/env node
// Highlight scoring: per-second tension from events.json, then a ranked list of scenes with start / end ticks.
//   node tools/highlights.mjs replays/<id> [--events events.json] [--out highlights.json]
import fs from 'node:fs';
import { poss, withArticle } from './lib/names.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WEIGHTS as W0, SCENE as S0 } from './highlight-weights.mjs';
import { TICK_HZ } from '../sim/util.mjs';
import { displayName } from '../render/theme/display-name.mjs';

const r2 = (v) => Math.round(v * 100) / 100;

export function tensionSeries(ev, W = W0) {
  const secs = ev.series.destroyed.length;
  const t = new Array(secs).fill(0);
  for (let s = 0; s < secs; s++) {
    let fight = 0;
    for (const f of ev.series.fighting) fight += f[s];
    t[s] += W.destroyed * Math.sqrt(ev.series.destroyed[s] / 100) + W.fighting * Math.sqrt(fight);
  }
  const spike = (s0, w, tau, extra = 0) => {
    if (w <= 0) return;
    for (let s = Math.max(0, s0); s < secs; s++) {
      const a = w * Math.exp(-(s - s0) / tau);
      if (a < 0.05) break;
      t[s] += a;
    }
    void extra;
  };
  for (const e of ev.events) {
    const s0 = Math.floor(e.t / TICK_HZ);
    if (e.type === 'llm_decision') {
      const D = W.decision;
      if (!e.thought && !e.orders.length) continue;
      let w = e.thought ? D.base : D.base * 0.4;
      for (const o of e.orders) w += D.orders[o] ?? 0;
      w += D.per_error * (e.errors?.length || 0);
      if ((e.latency_ms || 0) / 1000 >= D.slow_latency_s) w += D.slow_bonus;
      spike(s0, w, D.tau);
    } else if (e.type === 'llm_error') {
      spike(s0, W.decision.per_error, W.decision.tau);
    } else {
      const c = W.events[e.type];
      if (c) spike(s0, c.w, c.tau);
    }
  }
  // smooth once
  const k = W.smooth, h = (k.length - 1) / 2;
  return t.map((_, s) => {
    let a = 0, n = 0;
    for (let i = 0; i < k.length; i++) { const j = s + i - h; if (j >= 0 && j < secs) { a += k[i] * t[j]; n += k[i]; } }
    return a / n;
  });
}

export function buildScenes(ev, tension, S = S0) {
  const secs = tension.length;
  // 1. hysteresis regions
  const regions = [];
  let open = null, below = 0;
  for (let s = 0; s < secs; s++) {
    const v = tension[s];
    if (!open) { if (v >= S.start_threshold) { open = { a: s, b: s }; below = 0; } continue; }
    if (v >= S.end_threshold) { open.b = s; below = 0; } else if (++below > S.hold_s) { regions.push(open); open = null; }
  }
  if (open) regions.push(open);
  // 2. rolls, merge
  let sc = regions.map((r) => ({ a: Math.max(0, r.a - S.pre_roll_s), b: Math.min(secs - 1, r.b + S.post_roll_s) }));
  const merged = [];
  for (const r of sc) {
    const last = merged[merged.length - 1];
    if (last && r.a - last.b < S.merge_gap_s) last.b = Math.max(last.b, r.b); else merged.push({ ...r });
  }
  // 3. split long scenes at their calmest second (not near the ends)
  const out = [];
  const split = (r) => {
    if (r.b - r.a + 1 <= S.max_len_s) { out.push(r); return; }
    const lo = r.a + Math.floor(S.max_len_s * 0.35), hi = Math.min(r.b - Math.floor(S.max_len_s * 0.35), r.a + S.max_len_s);
    let m = lo;
    for (let s = lo; s <= hi; s++) if (tension[s] < tension[m]) m = s;
    split({ a: r.a, b: m });
    split({ a: m + 1, b: r.b });
  };
  merged.forEach(split);
  // 4. min length
  for (const r of out) {
    const need = S.min_len_s - (r.b - r.a + 1);
    if (need > 0) {
      const right = Math.min(secs - 1 - r.b, Math.ceil(need / 2));
      r.b += right;
      r.a = Math.max(0, r.a - (need - right));
    }
  }
  // 5. describe
  const players = ev.players;
  const nm = (p) => players[p - 1]?.name ?? `P${p}`;
  const scenes = out.map((r) => {
    const t0 = r.a * TICK_HZ, t1 = (r.b + 1) * TICK_HZ;
    let peak = 0, peakS = r.a, integral = 0;
    for (let s = r.a; s <= r.b; s++) { integral += tension[s]; if (tension[s] > peak) { peak = tension[s]; peakS = s; } }
    const inside = ev.events.filter((e) => e.t < t1 && (e.t_end ?? e.t) >= t0);
    const kinds = new Set(inside.map((e) => e.type));
    let dval = 0;
    for (let s = r.a; s <= r.b; s++) dval += ev.series.destroyed[s];
    const kind = S.kind_priority.find((k) => kinds.has(k)) || (dval > 0 ? 'battle' : 'activity');
    const main = inside.filter((e) => e.type === kind).sort((x, y) => (y.value ?? y.lead ?? 0) - (x.value ?? x.lead ?? 0))[0];
    let title;
    if (!main && kind === 'battle') title = `Battle: ${dval} value destroyed`;
    else if (!main) title = 'Action';
    else if (kind === 'victory') title = `${nm(main.winner)} wins: ${main.reason}`;
    else if (kind === 'resign') title = `${nm(main.p)} resigns`;
    else if (kind === 'base_destroyed') title = `${poss(nm(main.p))} base falls`;
    else if (kind === 'battle') title = `Battle: ${dval} value destroyed`;
    else if (kind === 'momentum_swing') title = `Momentum swings to ${nm(main.to)}`;
    else if (kind === 'building_destroyed') title = `${nm(main.p)} loses ${withArticle(displayName('building', main.building))}`;
    else if (kind === 'expansion') title = `${nm(main.p)} expands`;
    else if (kind === 'tier_up') title = `${nm(main.p)} reaches tier ${main.tier}`;
    else if (kind === 'first_contact') title = 'First contact';
    else if (kind === 'key_building') title = `${nm(main.p)} builds ${withArticle(displayName('building', main.building))}`;
    else title = main.thought ? `${nm(main.p)}: ${main.thought}` : `${nm(main.p)} decides`;
    // focus: location of the strongest located event, else the centroid of the fighting units
    let focus = null;
    const located = inside.filter((e) => e.loc).sort((x, y) => (y.value ?? 0) - (x.value ?? 0));
    const bigBattle = located.find((e) => e.type === 'battle' || e.type === 'base_destroyed');
    const pick = bigBattle || located[0];
    if (pick) focus = { x: pick.loc[0], y: pick.loc[1], spread: 8 };
    const fx = ev.series.focus_x, fy = ev.series.focus_y, fs_ = ev.series.focus_spread;
    let n = 0, cx = 0, cy = 0, sp = 0;
    for (let s = r.a; s <= r.b; s++) if (fx[s] !== null) { n++; cx += fx[s]; cy += fy[s]; sp += fs_[s]; }
    if (n && !bigBattle) focus = { x: cx / n, y: cy / n, spread: sp / n };
    return {
      start: t0, end: Math.min(ev.ticks, t1), peak_tick: peakS * TICK_HZ, peak: r2(peak), integral: r2(integral),
      score: r2(peak * S.score_peak + integral * S.score_integral), kind, title, focus: focus && { x: r2(focus.x), y: r2(focus.y), spread: r2(focus.spread) },
      events: inside.map((e) => e.id),
    };
  });
  const ranked = [...scenes].sort((a, b) => b.score - a.score || a.start - b.start);
  ranked.forEach((s, i) => { s.rank = i + 1; });
  scenes.sort((a, b) => a.start - b.start).forEach((s, i) => { s.id = i + 1; });
  return scenes;
}

export function computeHighlights(ev, { weights = W0, scene = S0 } = {}) {
  const tension = tensionSeries(ev, weights);
  const scenes = buildScenes(ev, tension, scene);
  return { version: 1, replay: ev.replay, ticks: ev.ticks, tick_hz: TICK_HZ, tension: tension.map(r2), scenes, ranked: [...scenes].sort((a, b) => a.rank - b.rank).map((s) => s.id) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const src = a.find((x) => !x.startsWith('--') && a[a.indexOf(x) - 1] !== '--events' && a[a.indexOf(x) - 1] !== '--out');
  const opt = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : null);
  if (!src) { console.error('usage: node tools/highlights.mjs replays/<id> [--events f] [--out f]'); process.exit(2); }
  const evf = opt('--events') || path.join(src, 'events.json');
  const ev = JSON.parse(fs.readFileSync(evf, 'utf8'));
  const hl = computeHighlights(ev);
  const out = opt('--out') || path.join(src, 'highlights.json');
  fs.writeFileSync(out, JSON.stringify(hl));
  const tot = hl.scenes.reduce((x, s) => x + (s.end - s.start) / TICK_HZ, 0);
  console.log(`${out}: ${hl.scenes.length} scenes, ${tot.toFixed(0)}s of ${(ev.ticks / TICK_HZ).toFixed(0)}s`);
  for (const id of hl.ranked.slice(0, 8)) { const s = hl.scenes[id - 1]; console.log(`  #${s.rank} ${(s.start / 10).toFixed(0)}-${(s.end / 10).toFixed(0)}s score ${s.score} peak ${s.peak} ${s.kind}: ${s.title}`); }
}
