import test from 'node:test';
import assert from 'node:assert/strict';
import { computeHighlights, tensionSeries, buildScenes } from '../tools/highlights.mjs';
import { WEIGHTS, SCENE } from '../tools/highlight-weights.mjs';
import { buildPlan, forceNormalSpeed, timelineOf, Timeline, PLAN_DEFAULTS } from '../tools/plan.mjs';
import { Overlay, speedBadge, OVERLAY } from '../tools/overlay.mjs';
import { Director } from '../tools/camera.mjs';
import { scriptedReplay } from '../test-support/replays.mjs';
import { computeEvents } from '../tools/events.mjs';

// ---- synthetic event log: a 30 minute game with a few fights, no sim needed ----
function synthetic(seconds = 1800) {
  const secs = seconds + 1;
  const destroyed = new Array(secs).fill(0), fighting = [new Array(secs).fill(0), new Array(secs).fill(0)];
  const fights = [[300, 330], [700, 760], [1000, 1010], [1500, 1560], [1700, 1740]];
  for (const [a, b] of fights) for (let s = a; s <= b; s++) { destroyed[s] = 250 + ((s * 37) % 400); fighting[0][s] = 12; fighting[1][s] = 9; }
  const events = [
    { t: 3000, type: 'first_contact', p: 1, other: 2, loc: [60, 60], what: 'worker' },
    { t: 7200, type: 'tier_up', p: 1, tier: 2 },
    { t: 10000, type: 'momentum_swing', from: 1, to: 2, lead: 400, army: [100, 500] },
    { t: 17400, type: 'base_destroyed', p: 2, loc: [100, 100], by: 1, value: 550 },
    { t: 18000, type: 'victory', winner: 1, winner_team: 1, reason: 'victory' },
  ];
  for (const [a, b] of fights) events.push({ t: a * 10, type: 'battle', t_end: b * 10, loc: [a / 10, 50], value: 5000, kills: 20, peak_value_per_s: 600, peak_tick: a * 10 + 50, participants: {} });
  events.sort((x, y) => x.t - y.t);
  events.forEach((e, i) => (e.id = i + 1));
  return {
    version: 1, replay: 'synthetic', ticks: seconds * 10, tick_hz: 10, seconds, players: [{ id: 1, name: 'Alpha', kind: 'llm' }, { id: 2, name: 'Beta', kind: 'bot' }], events,
    series: { army: [new Array(secs).fill(0), new Array(secs).fill(0)], lost: [[], []], fighting, destroyed, focus_x: new Array(secs).fill(null), focus_y: new Array(secs).fill(null), focus_spread: new Array(secs).fill(null) },
  };
}

test('highlights: tension is deterministic and the weights come from one file', () => {
  const ev = synthetic();
  const a = tensionSeries(ev), b = tensionSeries(ev);
  assert.deepEqual(a, b);
  const doubled = tensionSeries(ev, { ...WEIGHTS, destroyed: WEIGHTS.destroyed * 2 });
  assert.ok(doubled[320] > a[320] * 1.4);
  assert.ok(a[320] > a[100], 'a fight is more tense than calm build-up');
  assert.ok(a[1740] > 0 && a[1799] > 0);
});

test('highlights: scenes are ordered, inside the game, ranked, and cover the fights', () => {
  const ev = synthetic();
  const hl = computeHighlights(ev);
  assert.ok(hl.scenes.length >= 5);
  for (let i = 0; i < hl.scenes.length; i++) {
    const s = hl.scenes[i];
    assert.ok(s.start >= 0 && s.end <= ev.ticks && s.end > s.start);
    assert.ok((s.end - s.start) / 10 >= SCENE.min_len_s - 1 && (s.end - s.start) / 10 <= SCENE.max_len_s + SCENE.min_len_s);
    if (i) assert.ok(s.start >= hl.scenes[i - 1].end, 'no overlap');
  }
  assert.deepEqual([...hl.scenes.map((s) => s.rank)].sort((x, y) => x - y), hl.scenes.map((_, i) => i + 1));
  for (const [a, b] of [[300, 330], [700, 760], [1500, 1560], [1700, 1740]]) {
    let covered = 0;
    for (let sec = a; sec <= b; sec++) if (hl.scenes.some((s) => s.start <= sec * 10 && s.end > sec * 10)) covered++;
    assert.ok(covered >= (b - a + 1) * 0.95, `fight ${a}-${b} is covered by scenes (${covered}/${b - a + 1}s)`);
  }
  const top = hl.scenes.find((s) => s.rank === 1);
  assert.ok(['victory', 'base_destroyed', 'battle'].includes(top.kind));
  // a scene's focus points at the fight
  const sc = hl.scenes.find((s) => s.start <= 3000 && s.end >= 3300);
  assert.ok(sc.focus && Math.abs(sc.focus.x - 30) < 5);
});

test('highlights: stable on a real bot replay', () => {
  const dir = scriptedReplay(['rush', 'turtle'], 21);
  const ev = computeEvents(dir);
  const a = computeHighlights(ev), b = computeHighlights(ev);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

// ---- plan ----
const ev = synthetic();
const hl = computeHighlights(ev);

test('plan: highlight cut lands in 60-140 s, scenes at exactly 1x, quiet stretches on the 4/8/16/32 ladder', () => {
  const plan = buildPlan(ev, hl, { mode: 'highlight' });
  assert.ok(plan.duration_s >= 60 && plan.duration_s <= 140, `duration ${plan.duration_s}`);
  assert.ok(plan.selected_scenes.length >= 2);
  assert.ok(plan.ranges.some((r) => r.kind === 'scene' && r.speed === 1));
  for (const r of plan.ranges) assert.ok(r.speed === 1 || [4, 8, 16, 32, 64].includes(r.speed), `speed ${r.speed}`);
  const tl = timelineOf(plan);
  // the victory scene is mandatory and plays at 1x until the end
  const v = hl.scenes.find((s) => s.kind === 'victory');
  if (v) assert.equal(tl.speedAtTick(ev.ticks - 5), 1);
  // inside the middle of every selected scene the speed is exactly 1
  // (of a falling base only its first seconds are kept: PLAN_DEFAULTS.base_fall_s)
  for (const s of plan.scenes.filter((x) => x.selected)) {
    const end = s.kind === 'base_destroyed' ? Math.min(s.end, s.start + PLAN_DEFAULTS.base_fall_s * 10) : s.end;
    assert.equal(Math.round(tl.speedAtTick((s.start + end) / 2) * 1000) / 1000, 1);
  }
  // a long quiet stretch is fast
  assert.ok(Math.max(...plan.ranges.map((r) => r.speed)) >= 16);
});

test('plan: full cut plays every scene at 1x and is longer than the highlight cut', () => {
  const full = buildPlan(ev, hl, { mode: 'full' }), hi = buildPlan(ev, hl, { mode: 'highlight' });
  assert.equal(full.selected_scenes.length, hl.scenes.length);
  assert.ok(full.duration_s > hi.duration_s);
  assert.ok(full.stats.max_speed <= 16);
});

test('plan: timeline is monotonic, invertible and the speed ramps are smooth', () => {
  const plan = buildPlan(ev, hl, { mode: 'highlight' });
  const tl = timelineOf(plan);
  let prev = -1, prevSp = null, maxStep = 0;
  for (let f = 0; f < Math.floor(tl.body_s * 60); f++) {
    const t = f / 60, g = tl.tickAt(t);
    assert.ok(g > prev, 'strictly increasing');
    prev = g;
    assert.ok(Math.abs(tl.outAt(g) - t) < 1e-6, 'outAt inverts tickAt');
    const sp = tl.speedAtOut(t);
    if (prevSp !== null) maxStep = Math.max(maxStep, Math.abs(Math.log(sp / prevSp)));
    prevSp = sp;
  }
  // no jump: a 1x -> 32x ramp (ln 32 = 3.47) takes up to 3 s = 180 frames, one frame changes ln(speed) by far less than 0.15
  assert.ok(maxStep < 0.15, `largest per-frame change of ln(speed): ${maxStep}`);
  assert.equal(tl.tickAt(0), 0);
  assert.equal(tl.tickAt(tl.duration_s + 5), ev.ticks);
  // a ramp takes about ramp_s of output time
  const r = plan.ranges.find((x, i) => i + 1 < plan.ranges.length && x.speed > 1 && plan.ranges[i + 1].speed === 1);
  const o1 = tl.outAt(r.b);
  let t = o1 - 0.05;
  while (tl.speedAtOut(t) < r.speed * 0.98 && t > 0) t -= 1 / 120;
  assert.ok(o1 - t > PLAN_DEFAULTS.ramp_s - 0.3 && o1 - t < PLAN_DEFAULTS.ramp_max_s + 0.4, `ramp duration ${o1 - t}`);
});

test('plan: the speed badge text is always there and marks any speed other than 1x', () => {
  const plan = buildPlan(ev, hl, { mode: 'highlight' });
  const tl = timelineOf(plan);
  let seenOn = 0, seenOff = 0;
  for (let t = 0; t < tl.duration_s; t += 1 / 60) {
    const b = speedBadge(tl, t);
    assert.match(b.label, /^\d+x$/);
    if (tl.speedAtOut(t) >= 1.6 && b.speed > 1.6) assert.ok(b.on, `badge on at ${t}`);
    if (b.on) { seenOn++; assert.ok(Number(b.label.slice(0, -1)) >= 2); } else { seenOff++; assert.equal(b.label, '1x'); }
  }
  assert.ok(seenOn > 100 && seenOff > 100);
});

test('plan: forceNormalSpeed makes the given windows 1x (to fit commentary) and leaves the rest alone', () => {
  const plan = buildPlan(ev, hl, { mode: 'highlight' });
  const q = plan.ranges.find((r) => r.kind === 'quiet' && r.b - r.a > 3000);
  const w = { a: q.a + 400, b: q.a + 900 };
  const forced = forceNormalSpeed(plan, [w]);
  const tl = timelineOf(forced), tl0 = timelineOf(plan);
  assert.equal(tl.speedAtTick((w.a + w.b) / 2), 1);
  assert.equal(tl.speedAtTick(w.a + 20), 1);
  assert.ok(forced.duration_s > plan.duration_s + 40 * 0.7, `${forced.duration_s} vs ${plan.duration_s}`); // 50 game s at 1x instead of fast
  assert.ok(forced.duration_s < plan.duration_s + 62); // longer, smoother ramps cost a little more
  assert.ok(tl.speedAtTick(q.b - 100) === tl0.speedAtTick(q.b - 100) || q.b - 100 < w.b, 'speeds elsewhere stay');
  assert.deepEqual(forced.forced, [w]);
  // {at, out_s}: 4 output seconds of 1x starting 1 s before the tick
  const f2 = forceNormalSpeed(plan, [{ at: q.a + 1500, out_s: 4 }]);
  const t2 = timelineOf(f2);
  assert.equal(t2.speedAtTick(q.a + 1500), 1);
  assert.ok(t2.outAt(q.a + 1500 + 30) - t2.outAt(q.a + 1500 - 10) > 3.9 - 0.2);
  // a forced window inside a scene changes nothing
  const sc = plan.ranges.find((r) => r.kind === 'scene');
  const same = forceNormalSpeed(plan, [{ a: sc.a + 20, b: sc.a + 60 }]);
  assert.ok(Math.abs(same.duration_s - plan.duration_s) < 1e-6);
  // idempotent
  const again = forceNormalSpeed(forced, [w]);
  assert.ok(Math.abs(again.duration_s - forced.duration_s) < 1e-6);
});

test('plan: a window plans only that part of the game', () => {
  const plan = buildPlan(ev, hl, { mode: 'highlight', window: [2800, 3600] });
  const tl = timelineOf(plan);
  assert.equal(tl.tickAt(0), 2800);
  assert.equal(tl.tickAt(1000), 3600);
  assert.equal(plan.ranges[0].a, 2800);
  assert.equal(plan.ranges[plan.ranges.length - 1].b, 3600);
});

test('plan: short gaps between scenes are played at 1x, not ramped up and down', () => {
  const rs = [{ a: 0, b: 1000, speed: 1, kind: 'scene' }, { a: 1000, b: 1060, speed: 8, kind: 'quiet' }, { a: 1060, b: 2000, speed: 1, kind: 'scene' }];
  const tl = new Timeline(rs, [0, 2000]);
  assert.ok(tl.speedAtTick(1030) <= 8);
  const hl2 = { scenes: [{ id: 1, rank: 1, start: 0, end: 1000, kind: 'battle', title: '', focus: null, score: 5 }, { id: 2, rank: 2, start: 1060, end: 2000, kind: 'battle', title: '', focus: null, score: 4 }] };
  const plan = buildPlan({ replay: 'x', ticks: 2000 }, hl2, { mode: 'full' });
  assert.equal(plan.ranges.length, 1);
  assert.equal(plan.ranges[0].speed, 1);
});

// ---- overlay and camera ----
function llmEvents() {
  const E = [];
  let id = 0;
  for (let i = 0; i < 40; i++) E.push({ id: ++id, t: 100 + i * 15, type: 'llm_decision', p: 1, n: i + 1, thought: `thought ${i}`, orders: i % 7 === 0 ? ['attack_move'] : ['train'], summary: 'x', latency_ms: 1500, completion_tokens: 80, tok_s: 50, errors: [] });
  E.push({ id: ++id, t: 300, type: 'llm_decision', p: 2, n: 1, thought: null, orders: ['train'], summary: 'train 2x archer', latency_ms: 900, completion_tokens: 20, tok_s: 30, errors: [] });
  return E.sort((a, b) => a.t - b.t);
}
const PL = [{ id: 1, name: 'Alpha', color: '#4d8dff' }, { id: 2, name: 'Beta', color: '#ff7a45' }];

test('overlay: a thought is shown for about 2 s near its player, one card per player at a time', () => {
  const plan = buildPlan(ev, hl, { mode: 'full', window: [0, 1000] });
  const tl = timelineOf(plan);
  // at 1x (gap short -> everything 1x for the first 100 s)
  const ov = new Overlay({ events: llmEvents(), timeline: tl, players: PL });
  let shown = new Map();
  for (let t = 0; t < tl.body_s; t += 1 / 60) {
    const u = ov.at(t, tl.tickAt(t));
    const mine = u.cards.filter((c) => c.p === 1);
    assert.ok(mine.length <= 1);
    for (const c of mine) { const k = c.n; const e = shown.get(k) || { a: t, b: t }; e.b = t; shown.set(k, e); assert.ok(c.a >= 0 && c.a <= 1); }
  }
  assert.ok(shown.size >= 3);
  for (const [, e] of shown) assert.ok(e.b - e.a <= OVERLAY.card_s + 0.05, 'a card never stays longer than card_s');
  const full = [...shown.values()].filter((e) => e.b - e.a > OVERLAY.card_s - 0.1);
  assert.ok(full.length >= 1, 'an undisturbed card is shown for ~2 s');
  // player 2 has no thought: the order summary is used
  const u = ov.at(tl.outAt(300) + 0.5, 300);
  const c2 = u.cards.find((c) => c.p === 2);
  assert.ok(c2 && c2.kind === 'orders' && /archer/.test(c2.text));
  // stats: decisions so far and the last latency
  const s = ov.at(tl.outAt(500), 500).stats[0];
  assert.ok(s.decisions > 20 && s.latency_ms === 1500);
});

test('overlay: ticker and end banner come from the events', () => {
  const plan = buildPlan(ev, hl, { mode: 'full' });
  const tl = timelineOf(plan);
  const ov = new Overlay({ events: ev.events, timeline: tl, players: PL });
  const t0 = tl.outAt(7200) + 0.5;
  assert.match(ov.at(t0, 7200).ticker.text, /Alpha reaches tier 2/);
  assert.equal(ov.at(0.1, 1).ticker, null);
  const end = ov.at(tl.duration_s - 0.5, ev.ticks);
  assert.ok(end.banner && end.banner.title === 'Alpha wins' && end.banner.a === 1);
  assert.equal(ov.at(tl.outAt(1000), 1000).banner, null);
});

test('camera: deterministic, and it heads for the scene before it starts', () => {
  const plan = buildPlan(ev, hl, { mode: 'highlight' });
  const tl = timelineOf(plan);
  const sc = plan.scenes.find((s) => s.selected && s.focus);
  const snap = { units: [], buildings: [] };
  const mk = () => new Director({ size: 128, starts: [{ tx: 18, ty: 18 }, { tx: 106, ty: 106 }], aspect: 1.3, scenes: plan.scenes, timeline: tl });
  const run = (d) => { const out = []; for (let f = 0; f < 60 * 12; f++) out.push(d.update(tl.outAt(sc.start) - 6 + f / 60, 1 / 60, snap)); return out; };
  const a = run(mk()), b = run(mk());
  assert.deepEqual(a, b);
  const d0 = Math.hypot(a[0].tx - sc.focus.x, a[0].tz - sc.focus.y), d1 = Math.hypot(a[a.length - 1].tx - sc.focus.x, a[a.length - 1].tz - sc.focus.y);
  assert.ok(d1 < d0 * 0.5 || d1 < 12, `camera approaches the focus: ${d0} -> ${d1}`);
  for (const c of a) assert.ok(Number.isFinite(c.tx) && c.dist >= 14 && c.dist <= 260);
});
