import test from 'node:test';
import assert from 'node:assert/strict';
import { TICK_HZ } from '../sim/util.mjs';
import { buildStory, storyParams, pickStories } from '../tools/story.mjs';
import { StoryData } from '../tools/story-data.mjs';
import { StoryOverlay } from '../tools/story-overlay.mjs';
import { Timeline, timelineOf } from '../tools/plan.mjs';
import { buildScript } from '../tools/caster-facts.mjs';
import { makeContext, checkLines } from '../tools/caster-check.mjs';
import { placeLines } from '../tools/caster-place.mjs';
import { buildPrompt } from '../tools/casters.mjs';
import { digestObservation, momentWindows } from '../tools/commentary.mjs';
import { Overlay } from '../tools/overlay.mjs';

// ---- a synthetic 18 minute match: openings, a tier race, an all-in, a lost fight, rams, a base that falls ----
const obs = (o) => JSON.stringify({ t: 100, you: 1, tier: 1, res: { food: 10, wood: 20, stone: 30, gold: 40 }, pop: { used: 10, cap: 20 }, army_value: 500, workers: { n: 12, idle: 1 }, units: [{ type: 'archer', n: 4, xy: [20, 20] }], enemy_units: [], enemy_buildings: [], enemy_minor_buildings: [], map: { start: [18, 18], explored_pct: 10 }, ...o });
const seeEnemy = obs({ army_value: 1055, enemy_units: [{ type: 'archer', n: 5, xy: [30, 20] }, { type: 'ram', n: 3, xy: [32, 22] }], events: [{ type: 'attacked', what: 'house' }] });
let nextId = 1;
const dec = (t, p, n, thought, summary, user = obs({})) => ({ id: 0, t, type: 'llm_decision', p, n, start_tick: t - 50, thought, orders: ['train'], summary, latency_ms: 9000 + n * 100, completion_tokens: 900, tok_s: 100, errors: [], seen: digestObservation(user) });
const PLAYERS = [{ id: 1, kind: 'llm', name: 'Qwen3.8-27B NVFP4+MTP3 (QuartzRT)', model: 'qwen3.8-27b', hardware: '1x RTX 5090 32 GB' }, { id: 2, kind: 'llm', name: 'Qwen3.8-27B EXL3 4.0bpw+MTP (Zoe kit TP2)', model: 'qwen3.8-27b-exl3-4.0bpw', hardware: '2x RTX 5060 Ti 16 GB (TP2)' }];
function fixture() {
  const T = 10800, secs = T / 10 + 1;
  const events = [
    dec(40, 1, 1, 'Opening: keep TC churning workers, add farm, then barracks.', 'train 3x worker, build farm'),
    dec(70, 2, 1, null, 'train 2x worker, build farm, build house'),
    { t: 600, type: 'first_contact', p: 1, other: 2, loc: [60, 60], what: 'worker' },
    dec(2000, 1, 5, 'Wood is the bottleneck: send idle worker to wood, then rush barracks to counter enemy barracks.', 'build barracks', obs({ workers: { n: 18, idle: 0 } })),
    dec(2030, 2, 4, null, 'train 1x spearman, build house'),
    { t: 2500, type: 'key_building', p: 2, building: 'barracks', loc: [100, 100] },
    { t: 4000, type: 'tier_up', p: 2, tier: 2 },
    { t: 6000, type: 'tier_up', p: 1, tier: 2 },
    dec(7000, 2, 9, null, 'attack, train 3x ram, train 2x light_cavalry'),
    dec(7500, 1, 12, 'Going all-in: full army attacks enemy TC now; will reinforce behind them.', 'attack', obs({ army_value: 2455 })),
    dec(7510, 2, 10, 'Marching the whole army on the enemy base, queuing reinforcements.', 'attack, train 4x archer', obs({ army_value: 2740 })),
    { t: 8200, type: 'battle', t_end: 8500, loc: [50, 50], value: 2540, kills: 34, peak_value_per_s: 225, peak_tick: 8300, participants: { 1: { lost_units: 34, lost_value: 2540, lost_buildings: 0, lost_by_type: { archer: 34 }, peak_fighting: 0 }, 2: { lost_units: 0, lost_value: 0, lost_buildings: 0, lost_by_type: {}, peak_fighting: 40 } } },
    dec(9000, 1, 15, 'Full push on enemy TC with whole army; queue more archers', 'attack, train 2x archer', seeEnemy),
    dec(9040, 2, 13, null, 'attack, train 4x spearman', obs({ army_value: 4410 })),
    { t: 9500, type: 'building_destroyed', p: 1, building: 'mining_camp', loc: [29, 28], by: 2, value: 60, src: 'ram' },
    { t: 10300, type: 'base_destroyed', p: 1, loc: [20, 20], by: 2, value: 550, src: 'ram' },
    { t: 10800, type: 'victory', winner: 2, winner_team: 2, reason: 'victory' },
  ];
  events.sort((a, b) => a.t - b.t);
  events.forEach((e) => { e.id = nextId++; });
  const army = [new Array(secs).fill(500), new Array(secs).fill(900)];
  for (let s = 0; s < secs; s++) { army[0][s] = s > 820 ? 300 : 1200; army[1][s] = 2000 + s; }
  const ev = { version: 1, replay: 'fixture', seed: 101, ticks: T, seconds: T / 10, players: PLAYERS, events, starts: [{ tx: 18, ty: 18 }, { tx: 106, ty: 106 }], final: [{ p: 1, kills: 3, losses: 40, kill_value: 300, lost_value: 3000, gathered: 1000, score: 100, tier: 2, alive: false }, { p: 2, kills: 40, losses: 3, kill_value: 3000, lost_value: 300, gathered: 2000, score: 900, tier: 2, alive: true }], series: { army, lost: army, fighting: army, destroyed: new Array(secs).fill(0), focus_x: new Array(secs).fill(null), focus_y: new Array(secs).fill(null), focus_spread: new Array(secs).fill(null) }, verified: { ok: true } };
  const hl = { scenes: [] };
  return { ev, hl };
}

test('story plan: chapters in order, freeze frames at the decisions, no speed above 16x, near the target length', () => {
  const { ev, hl } = fixture();
  for (const target of [180, 300, 480]) {
    const a = buildStory(ev, hl, { target_s: target, story: { teaser_s: 10 } }), b = buildStory(ev, hl, { target_s: target, story: { teaser_s: 10 } });
    assert.deepEqual(a.plan.ranges, b.plan.ranges, 'deterministic');
    assert.ok(a.story.total_s <= target * 1.2 && a.story.total_s >= target * 0.55, `${target}: ${a.story.total_s}`);
    assert.ok(Math.max(...a.plan.ranges.map((r) => r.speed)) <= 16, 'never faster than 16x');
    assert.ok(Math.min(...a.plan.ranges.map((r) => r.speed)) >= 1, 'never slower than 1x outside the freeze frames');
    const ids = a.story.chapters.map((c) => c.id);
    assert.equal(ids[0], 'intro'); assert.equal(ids.at(-1), 'recap');
    for (let i = 0; i + 1 < a.story.chapters.length; i++) assert.ok(a.story.chapters[i].o1 <= a.story.chapters[i + 1].o0 + 1e-6);
    assert.equal(a.story.units[0].kind, 'open');
    for (let i = 0; i + 1 < a.story.units.length; i++) assert.ok(a.story.units[i].o_after1 <= a.story.units[i + 1].o_lead + 0.2, 'story windows do not overlap');
    assert.equal(a.teaser.duration_s, 10, 'the cold open is 10 s of the climax');
  }
  const n = (t) => buildStory(ev, hl, { target_s: t }).story.units.length;
  assert.ok(n(180) <= n(300) && n(300) <= n(480), 'longer cuts carry more stories');
  assert.ok(storyParams(180).tail_s < storyParams(480).tail_s + 1e-9);
});

test('story plan: the game stops at a decision (freeze frame) and runs on after it', () => {
  const { ev, hl } = fixture();
  const { plan, story } = buildStory(ev, hl, { target_s: 300, story: { teaser_s: 10 } });
  const tl = timelineOf(plan);
  assert.equal(tl.hold.reduce((a, b) => a + b, 0) > 20, true, 'freeze frames add up');
  for (const u of story.units) {
    const o0 = tl.outAt(u.tick), o1 = tl.outAfterHold(u.tick);
    assert.ok(Math.abs(o1 - o0 - u.hold_s) < 0.05, 'hold length');
    assert.equal(tl.speedAtOut((o0 + o1) / 2), 0);
    assert.equal(tl.tickAt(o0 + 0.1), tl.tickAt(o1 - 0.1), 'the tick stands still');
    assert.ok(tl.tickAt(o1 + 1) > tl.tickAt(o1 - 0.1), 'and runs on afterwards');
    assert.ok(tl.speedAtOut(o1 + 0.2) >= 1 && tl.speedAtOut(o1 + 0.2) <= 2.1, '1x to 2x right after');
  }
  // a Timeline without holds behaves as before
  const t2 = new Timeline([{ a: 0, b: 1000, speed: 2 }], [0, 1000], {});
  assert.equal(t2.hold.every((v) => v === 0), true);
  assert.ok(Math.abs(t2.outAt(500) - 25) < 0.01);
});

test('story data: the strategy card quotes the newest note word for word, orders only for a model without notes', () => {
  const { ev } = fixture();
  const d = new StoryData(ev);
  const c1 = d.card(1, 2100), c2 = d.card(2, 2100);
  assert.equal(c1.plan.text, 'Wood is the bottleneck: send idle worker to wood, then rush barracks to counter enemy barracks.');
  assert.equal(c2.plan, null);
  assert.equal(c2.orders.text, 'train 1 spearman, build a house');
  assert.equal(d.card(1, 100).plan.text, 'Opening: keep TC churning workers, add farm, then barracks.');
  assert.equal(d.tier(2, 4100), 2); assert.equal(d.tier(1, 4100), 1);
  const cr = d.compareRows(6000);
  assert.deepEqual(cr.rows.find((r) => r.label === 'TIER').vals, ['2', '2']);
});

test('story overlay: bar, cards and the split view at a freeze frame', () => {
  const { ev, hl } = fixture();
  const { plan, story } = buildStory(ev, hl, { target_s: 300, story: { teaser_s: 10 } });
  const tl = timelineOf(plan);
  const so = new StoryOverlay({ ev, plan, timeline: tl, players: PLAYERS.map((p, i) => ({ ...p, color: i ? '#f80' : '#48f' })) });
  let last = -1;
  for (let t = 0; t < plan.duration_s; t += 7) { const s = so.at(t, tl.tickAt(t)); assert.ok(s.bar.p >= last); last = s.bar.p; assert.ok(s.bar.items.length >= 6); }
  const u = story.units.find((x) => x.kind !== 'open' && x.kind !== 'compare');
  const mid = (tl.outAt(u.tick) + tl.outAfterHold(u.tick)) / 2;
  const s = so.at(mid, tl.tickAt(mid));
  assert.ok(s.split && s.split.a > 0.9, 'the split view is up during a freeze frame');
  assert.ok(s.split.cols.length >= 1 && s.split.cols.every((c) => c.ordered));
  assert.ok(s.cards.length === 2 && s.cards.every((c) => c.a > 0.9));
  const o = so.at(1.0, tl.tickAt(1.0));
  assert.equal(o.split, null);
  const cmp = story.units.find((x) => x.kind === 'compare');
  if (cmp) { const m = (tl.outAt(cmp.tick) + tl.outAfterHold(cmp.tick)) / 2; assert.equal(so.at(m, tl.tickAt(m)).split.kind, 'compare'); }
  // the cold open clip: no cards, a label, the bar starts in chapter 0
  const so2 = new StoryOverlay({ ev, plan: { ...plan, ...{ story: { ...story, teaser: true, units: [], offset_s: 0 } } }, timeline: timelineOf(buildStory(ev, hl, { target_s: 300, story: { teaser_s: 10 } }).teaser), players: PLAYERS });
  const t0 = so2.at(2, 10300);
  assert.equal(t0.cards, null); assert.match(t0.tag, /LATER IN THIS MATCH/); assert.equal(t0.bar.cur, 0);
});

test('story casters: beats tile the video, freeze frames are Juno\'s, Dex only calls action, facts are grounded', () => {
  const { ev, hl } = fixture();
  const { plan } = buildStory(ev, hl, { target_s: 300, story: { teaser_s: 10 } });
  const { sheet, beats, duration_s } = buildScript(ev, plan, { cls: '32 GB' });
  for (let i = 0; i + 1 < beats.length; i++) assert.ok(Math.abs(beats[i].seg1 - beats[i + 1].seg0) < 0.05, `beat ${i + 1} tiles`);
  assert.ok(Math.abs(beats.at(-1).seg1 - (duration_s - 0.3)) < 0.05);
  assert.equal(beats[0].kind, 'open'); assert.equal(beats.at(-1).kind, 'close');
  const holds = beats.filter((b) => b.kind === 'hold');
  assert.ok(holds.length >= 2);
  for (const h of holds) {
    assert.equal(h.role, 'calm'); assert.equal(h.speed, 0); assert.ok(h.freeze);
    const notes = h.facts.map((id) => sheet.facts.find((f) => f.id === id)).filter((f) => f && (f.kind === 'note' || f.kind === 'orders'));
    assert.ok(notes.length >= 1, 'the decision itself is a fact of its freeze frame');
  }
  assert.ok(beats.filter((b) => b.role === 'action').every((b) => ['battle', 'razed', 'base', 'victory'].includes(b.kind)));
  assert.ok(beats.every((b) => b.flow && b.chapter));
  assert.ok(sheet.story.chapters.length >= 5);
  // a line quoting the note word for word passes, a changed quote does not; the placement keeps the lines of a long freeze frame
  const ctx = makeContext(sheet, beats);
  const h = holds.find((x) => x.facts.some((id) => sheet.facts.find((f) => f.id === id).kind === 'note'));
  const noteFact = h.facts.map((id) => sheet.facts.find((f) => f.id === id)).find((f) => f.kind === 'note');
  const line = (text) => ({ beat: h.id, speaker: 'ana', when: 'at', delivery: 'calm', text, facts: [noteFact.id], opinion: false, interject: false, subject: null });
  const good = checkLines([line(`The note says “${noteFact.data.quote.split(' ').slice(0, 4).join(' ')}”.`)], ctx);
  assert.ok(good.ok, JSON.stringify(good.bad));
  assert.equal(checkLines([line('The note says “rush the town center now”.')], ctx).ok, false);
  const placed = placeLines([line('One. Two three four five six seven eight nine.'), { ...line('Another sentence about the plan goes here.'), when: 'after' }, { ...line('And a third one follows, quite long indeed.'), when: 'after' }], beats, duration_s);
  assert.equal(placed.dropped.length, 0, 'story beats never drop a late line');
  // the prompt knows the structure
  const p = buildPrompt(sheet, beats, duration_s);
  assert.match(p.system, /THE STORY CUT/); assert.match(p.system, /FREEZE FRAME/); assert.doesNotMatch(p.system, /highlight video/);
  assert.match(p.user, /FREEZE FRAME: the game is paused/); assert.match(p.user, /\[chapter /);
});

test('story moments: windows come from the story, only single decisions get the fog of war view', () => {
  const { ev, hl } = fixture();
  const { plan } = buildStory(ev, hl, { target_s: 300, story: { teaser_s: 10 } });
  const tl = timelineOf(plan);
  assert.ok(plan.moments.length >= 2 && plan.moments.every((m) => m.story));
  const m = plan.moments[0], w = momentWindows(m, tl);
  assert.ok(w.o0 < w.land && w.land < w.slow1);
  const ov = new Overlay({ events: ev.events, timeline: tl, players: PLAYERS.map((p, i) => ({ ...p, name: p.name, color: i ? '#f80' : '#48f' })), moments: plan.moments, ev, story: plan });
  const at = ov.at(tl.outAt(plan.story.units[1].tick) + 0.3, plan.story.units[1].tick);
  assert.equal(at.badge.hold, true); assert.equal(at.badge.label, 'PAUSED');
  assert.ok(at.story && at.story.bar);
  assert.ok(pickStories(ev, hl, 300).units.length >= 2);
});

test('plain words: the spec facts carry a plain-language field and the checker rejects letter+digit codes', async () => {
  const { plainQuant } = await import('../tools/caster-facts.mjs');
  assert.match(plainQuant('NVFP4+MTP3'), /4-bit/); assert.match(plainQuant('NVFP4+MTP3'), /speed-up trick/);
  assert.match(plainQuant('EXL3 4.0bpw+MTP'), /4-bit/);
  assert.equal(plainQuant(null), null);
  const { ev, hl } = fixture();
  const { plan } = buildStory(ev, hl, { target_s: 300, story: { teaser_s: 10 } });
  const { sheet, beats } = buildScript(ev, plan, { cls: '32 GB' });
  assert.ok(sheet.facts.some((f) => f.kind === 'spec' && /in plain words: a 4-bit version/.test(f.text)), 'plain-language field in the spec fact');
  const ctx = makeContext(sheet, beats);
  const sp = sheet.facts.find((f) => f.kind === 'spec').id;
  const line = (text) => ({ beat: 1, speaker: 'ana', when: 'at', delivery: 'calm', text, facts: [sp], opinion: false, interject: false, subject: null });
  const r = (t) => checkLines([line(t)], ctx);
  assert.equal(r('QuartzRT runs NVFP4+MTP3 on one RTX 5090.').ok, false);
  assert.ok(r('QuartzRT runs NVFP4+MTP3 on one RTX 5090.').bad.some((b) => /jargon code/.test(JSON.stringify(b))));
  assert.equal(r('A 27B model squeezed to 4 bits on one RTX 5090.').ok, true, JSON.stringify(r('A 27B model squeezed to 4 bits on one RTX 5090.').bad));
  assert.match(buildPrompt(sheet, beats, 300).system, /Plain words for viewers/);
});

test('tier race: workers and army come from the field at that tick, never from an older report', () => {
  const stale = { type: 'llm_decision', t: 10, p: 1, n: 1, seen: { workers: 18, own: { spearman: 9 }, own_army_n: 9 } };
  const d = new StoryData({ events: [stale], series: { army: [[0, 0, 995], [0, 0, 355]], workers: [[18, 19, 20], [25, 25, 24]], army_types: [[{}, {}, { spearman: 13 }], [{}, {}, {}]] } });
  const at = 2 * TICK_HZ;
  const c = d.compare(1, at);
  assert.equal(c.workers, 20); assert.equal(c.army, '13 spearmen');
  assert.deepEqual(d.compareRows(at).rows.find((r) => r.label === 'WORKERS').vals, ['20', '24']);
  assert.deepEqual(d.compareRows(at).rows.find((r) => r.label === 'ARMY').vals, ['13 spearmen', 'none']);
  assert.deepEqual(d.compareRows(at).rows.find((r) => r.label === 'ARMY VALUE').vals, ['995', '355']);
  // no field data: an empty cell, not an old number
  assert.equal(new StoryData({ events: [stale], series: {} }).compare(1, at).workers, null);
});
