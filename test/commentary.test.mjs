import test from 'node:test';
import assert from 'node:assert/strict';
import { MOMENTS, digestObservation, detectMoments, scoreDecision, momentCard, momentWindows, endScreen } from '../tools/commentary.mjs';
import { addSlowMotion, buildPlan, timelineOf } from '../tools/plan.mjs';
import { Overlay, feedLine, speedBadge, shortOf, shortNames } from '../tools/overlay.mjs';
import { Director } from '../tools/camera.mjs';

const obs = (o) => JSON.stringify({ t: 100, you: 1, tier: 1, res: { food: 10, wood: 20, stone: 30, gold: 40 }, pop: { used: 10, cap: 20 }, army_value: 500, workers: { n: 8, idle: 1 }, units: [{ type: 'archer', n: 4, xy: [20, 20] }, { type: 'spearman', n: 2, xy: [21, 20] }], enemy_units: [], enemy_buildings: [], enemy_minor_buildings: [], map: { start: [18, 18], explored_pct: 10 }, ...o });
const dec = (id, t, p, user, thought = 'a note', extra = {}) => ({ id, t, type: 'llm_decision', p, n: id, start_tick: t - 50, thought, orders: ['train'], summary: 'train 2x archer', latency_ms: 4000, completion_tokens: 400, tok_s: 100, errors: [], seen: digestObservation(user), ...extra });

test('commentary: the observation digest only holds what the model was shown', () => {
  const d = digestObservation(obs({ enemy_units: [{ type: 'archer', n: 5, xy: [30, 20] }, { type: 'worker', n: 1, xy: [34, 22] }], events: [{ type: 'attacked', what: 'barracks' }] }));
  assert.deepEqual(d.own, { archer: 4, spearman: 2 });
  assert.deepEqual(d.enemy, { archer: 5, worker: 1 });
  assert.equal(d.enemy_n, 6);
  assert.deepEqual(d.attacked, { n: 1, what: { barracks: 1 } });
  assert.equal(digestObservation('not json'), null);
});

test('commentary: decision moments come from real facts and need a note', () => {
  const calm = obs({});
  const raid = obs({ enemy_units: [{ type: 'archer', n: 5, xy: [30, 20] }], events: [{ type: 'attacked', what: 'house' }] });
  const E = [dec(1, 1000, 1, calm), dec(2, 2000, 1, raid, 'Enemy archers are raiding, train spearmen'), dec(3, 2100, 2, raid, null), dec(4, 3000, 1, calm, 'x')];
  const s = scoreDecision(E[1], E[0], E);
  assert.ok(s.tags.some((t) => t.k === 'enemy_in_view') && s.tags.some((t) => t.k === 'under_attack'));
  assert.equal(scoreDecision(E[2], null, E), null, 'no note, nothing to explain');
  const ms = detectMoments({ ticks: 6000, events: E }, { min_score: 3 });
  assert.equal(ms.length, 1);
  assert.equal(ms[0].id, 2);
  assert.deepEqual(ms[0].focus, { x: 30, y: 20, what: 'enemy' });
  const c = momentCard(ms[0], [{ name: 'Kai' }]);
  assert.equal(c.thought, 'Enemy archers are raiding, train spearmen', 'the note is shown word for word');
  assert.ok(c.saw[0].includes('5x archer'));
  assert.ok(!JSON.stringify(c).includes('counter'), 'no reasons beyond the log');
  // too close to the edge of the window: not chosen
  assert.equal(detectMoments({ ticks: 6000, events: E }, { window: [1990, 6000], min_score: 3 }).length, 0);
});

test('commentary: slow motion around the landing tick, 1x lead before it, plan keeps its length bookkeeping', () => {
  const ev = { replay: 'x', ticks: 6000 };
  const hl = { scenes: [{ id: 1, rank: 1, start: 5000, end: 5900, kind: 'victory', title: '', focus: null, score: 5 }] };
  const plan = buildPlan(ev, hl, { mode: 'highlight' });
  const m = { id: 2, p: 1, t: 2000, score: 9, focus: { x: 30, y: 20, what: 'enemy' } };
  const p2 = addSlowMotion(plan, [m]);
  assert.equal(p2.moments.length, 1);
  const tl = timelineOf(p2);
  assert.equal(tl.speedAtTick(1975), 1, 'lead at 1x');
  assert.ok(Math.abs(tl.speedAtTick(2005) - MOMENTS.speed) < 1e-9, 'slow at the landing tick');
  assert.ok(tl.speedAtTick(2200) > 1.5, 'fast again afterwards');
  const w = momentWindows(m, tl);
  assert.ok(w.o0 < w.slow0 && w.slow0 < w.land && w.land < w.slow1 && w.slow1 < w.o1);
  assert.ok(w.slow1 - w.slow0 > 9, 'about 11 s of slow motion (room for the casters)');
  assert.deepEqual(speedBadge(tl, w.land).slow, true);
  assert.match(speedBadge(tl, w.land).label, /^0\.\d+x$/);
  assert.equal(addSlowMotion(plan, [m], { maxDuration: 1 }).moments.length, 0, 'a budget keeps the cut short');
  // overlay: panel, fog view of that player, the note appears when the order lands
  const ov = new Overlay({ events: [], timeline: tl, players: [{ name: 'Kai' }, { name: 'Bo' }], moments: [{ ...m, thought: 'hello', summary: 'train', seen: null, tags: [] }] });
  assert.equal(ov.at(w.o0 - 0.1, 0).moment, null);
  const u = ov.at(w.land - 0.5, 1990);
  assert.equal(u.moment.p, 1); assert.equal(u.fog.p, 1); assert.equal(u.moment.thought_a, 0);
  assert.equal(ov.at(w.land + 0.5, 2010).moment.thought_a, 1);
  assert.equal(ov.at(w.o1 + 0.1, 2300).fog, null);
  // camera looks at what the model saw
  const d = new Director({ size: 128, starts: [{ tx: 18, ty: 18 }, { tx: 106, ty: 106 }], aspect: 1.3, scenes: p2.scenes, timeline: tl, moments: [m] });
  d.update(w.land, 1 / 60, { units: [], buildings: [] });
  assert.equal(d.mode, 'decision');
});

test('commentary: end screen data, action feed lines', () => {
  const ev = {
    ticks: 6000, seconds: 600, players: [{}, {}], series: { army: [[0, 500, 100], [0, 300, 900]] },
    final: [{ p: 1, kills: 3, kill_value: 100, gathered: 900, score: 50 }, { p: 2, kills: 9, kill_value: 700, gathered: 800, score: 90 }],
    events: [dec(1, 100, 1, obs({}), 'n', { latency_ms: 2000 }), dec(2, 200, 1, obs({}), 'n', { latency_ms: 4000 }), dec(3, 300, 2, obs({}), 'n', { latency_ms: 1000 }), { type: 'victory', t: 6000, winner: 2, reason: 'victory' }],
  };
  const e = endScreen(ev, [{ name: 'A', model: 'm1', hw: 'h1' }, { name: 'B', model: 'm2', hardware: 'h2' }]);
  assert.equal(e.winner, 2); assert.equal(e.reason, 'victory'); assert.equal(e.time, '10:00');
  const row = (k) => e.rows.find((r) => r.key === k);
  assert.deepEqual(row('army_final').raw, [100, 900]); assert.equal(row('army_final').lead, 1);
  assert.deepEqual(row('army_peak').raw, [500, 900]);
  assert.deepEqual(row('kills').vals, ['3', '9']);
  assert.deepEqual(row('latency').vals, ['3.0 s', '1.0 s']); assert.equal(row('latency').lead, 1, 'lower think time leads');
  assert.equal(row('decisions').lead, -1, 'no leader for a count of decisions');
  assert.equal(e.players[1].hw, 'h2');
  const draw = endScreen({ ...ev, events: ev.events.slice(0, 3) }, []);
  assert.equal(draw.winner, 0);
  const f = feedLine({ type: 'losses', p: 1, by: 2, n: 4, types: { archer: 3, worker: 1 }, value: 300 }, (p) => 'P' + p);
  assert.equal(f.text, 'P2 kills 3x archer, 1x worker');
  assert.equal(feedLine({ type: 'llm_decision' }, () => ''), null);
  assert.equal(shortOf('Qwen3.8-27B EXL3 (Zoe kit TP2)'), 'Zoe kit TP2');
  assert.equal(shortOf('Rush'), 'Rush');
  assert.equal(shortOf("DeepSeek-V4.1-Flash (Bob's TensorFold Metal recipe)"), 'DeepSeek-V4.1-Flash', 'a bracket too long for a label gives way to the part in front');
  // two players with the same part in brackets keep apart by the part in front
  assert.deepEqual(shortNames(['Probe A (mock)', 'Probe B (mock)']), ['Probe A', 'Probe B']);
  assert.deepEqual(shortNames(['Qwen3.8-27B NVFP4+MTP3 (QuartzRT)', "DeepSeek-V4.1-Flash (Bob's TensorFold Metal recipe)"]), ['Qwen3.8-27B', 'DeepSeek-V4.1-Flash'], 'two different models: the model names');
  assert.deepEqual(shortNames(['Qwen3.8-27B NVFP4+MTP3 (QuartzRT)', 'Qwen3.8-27B EXL3 (Zoe kit TP2)']), ['QuartzRT', 'Zoe kit TP2']);
});
