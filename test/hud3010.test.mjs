import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScript, aliasesOf } from '../tools/caster-facts.mjs';
import { makeContext, checkLine, checkLines } from '../tools/caster-check.mjs';
import { placeLines, cuesOf } from '../tools/caster-place.mjs';
import { templateLines } from '../tools/caster-template.mjs';
import { makeCasterTrack } from '../tools/casters.mjs';
import { addSlowMotion, buildPlan, timelineOf } from '../tools/plan.mjs';
import { detectMoments, digestObservation } from '../tools/commentary.mjs';
import { Overlay, feedLine } from '../tools/overlay.mjs';
import { poss, sayName } from '../tools/lib/names.mjs';
import { cleanThought } from '../tools/lib/thought.mjs';
import { stripToolMarkup } from '../render/note-text.mjs';

// ---- a small synthetic match: 10 minutes, two LLM players, one battle, two key decisions, a base falls ----
const obs = (o) => JSON.stringify({ t: 100, you: 1, tier: 1, res: { food: 10, wood: 20, stone: 30, gold: 40 }, pop: { used: 10, cap: 20 }, army_value: 500, workers: { n: 8, idle: 1 }, units: [{ type: 'archer', n: 4, xy: [20, 20] }], enemy_units: [], enemy_buildings: [], enemy_minor_buildings: [], map: { start: [18, 18], explored_pct: 10 }, ...o });
const raid = obs({ army_value: 1055, enemy_units: [{ type: 'archer', n: 5, xy: [30, 20] }], events: [{ type: 'attacked', what: 'house' }] });
const dec = (id, t, p, user, thought, summary = 'train 2x archer') => ({ id, t, type: 'llm_decision', p, n: id, start_tick: t - 50, thought, orders: ['train'], summary, latency_ms: 4000, completion_tokens: 400, tok_s: 100, errors: [], seen: digestObservation(user) });
const PLAYERS0 = [{ id: 1, kind: 'llm', name: 'Qwen3.8-27B NVFP4+MTP3 (QuartzRT)', model: 'qwen3.8-27b', hardware: '1x RTX 5090 32 GB' }, { id: 2, kind: 'llm', name: 'Qwen3.8-27B EXL3 4.0bpw+MTP (Zoe kit TP2)', model: 'qwen3.8-27b-exl3-4.0bpw', hardware: '2x RTX 5060 Ti 16 GB (TP2)' }];
function fixture(extraEvents = [], names = null, window = null) {
  const PLAYERS = names ? PLAYERS0.map((p, i) => ({ ...p, name: names[i] })) : PLAYERS0;
  const secs = 601;
  const events = [
    ...extraEvents,
    { t: 600, type: 'first_contact', p: 1, other: 2, loc: [60, 60], what: 'worker' },
    { t: 1500, type: 'key_building', p: 2, building: 'barracks', loc: [100, 100] },
    { t: 2500, type: 'tier_up', p: 1, tier: 2 },
    dec(1, 1000, 1, obs({}), 'Boom economy first, barracks next round.'),
    dec(2, 3000, 2, obs({}), null, 'attack, train 3x ram'),
    { t: 5600, type: 'battle', t_end: 5900, loc: [50, 50], value: 2540, kills: 34, peak_value_per_s: 225, peak_tick: 5700, participants: { 1: { lost_units: 34, lost_value: 2540, lost_buildings: 0, lost_by_type: { spearman: 20, archer: 14 }, peak_fighting: 10 }, 2: { lost_units: 0, lost_value: 0, lost_buildings: 0, lost_by_type: {}, peak_fighting: 10 } } },
    dec(3, 4400, 1, raid, 'Full push on enemy TC with whole army; queue more archers', 'attack, train 2x archer'),
    { t: 5300, type: 'base_destroyed', p: 1, loc: [20, 20], by: 2, value: 550, src: 'ram' },
    { t: 5500, type: 'building_destroyed', p: 1, building: 'barracks', loc: [20, 28], by: 2, value: 140, src: 'ram' },
    { t: 6000, type: 'victory', winner: 2, winner_team: 2, reason: 'victory' },
  ];
  events.sort((a, b) => a.t - b.t);
  events.forEach((e, i) => { e.id = i + 1; });
  const army = [new Array(secs).fill(500), new Array(secs).fill(900)];
  const ev = { version: 1, replay: 'fixture', seed: 101, ticks: 6000, seconds: 600, players: PLAYERS, events, final: [{ p: 1, kills: 3, losses: 40, kill_value: 300, lost_value: 3000, gathered: 1000, score: 100, tier: 2, alive: false }, { p: 2, kills: 40, losses: 3, kill_value: 3000, lost_value: 300, gathered: 2000, score: 900, tier: 2, alive: true }], result: { winner_team: 2, reason: 'victory', tick: 6000 }, series: { army, lost: [[], []], fighting: [[], []], destroyed: [], focus_x: [], focus_y: [], focus_spread: [] } };
  const hl = { scenes: [{ id: 1, rank: 1, start: 5200, end: 5950, kind: 'victory', title: '', focus: null, score: 5 }] };
  let plan = buildPlan(ev, hl, { mode: 'highlight', params: { tail_s: 10.5 }, ...(window ? { window } : {}) });
  plan = addSlowMotion(plan, detectMoments(ev, { max: 3 }));
  return { ev, plan };
}

const build = () => { const { ev, plan } = fixture(); return { ev, plan, ...buildScript(ev, plan, { cls: '32 GB' }) }; };
const line = (o) => ({ beat: 1, speaker: 'ana', when: 'at', delivery: 'calm', text: '', facts: [], opinion: false, interject: false, ...o });

const NAME_SETS = [
  ['Qwen3.8-27B NVFP4+MTP3 (QuartzRT)', "Qwen3.8-Flash-Next FP4+MTP (Zoe's TensorFold recipe)"],
  ['Qwen3.8-27B NVFP4+MTP3 (James)', 'Qwen3.8-27B EXL3 4.0bpw+MTP (QuartzRT)'],
  ["Qwen3.8-27B NVFP4+MTP3 (Zoe's TensorFold recipe)", 'Qwen3.8-27B EXL3 (James kit TP2)'],
];
const DOUBLE = /(?:['’]s){2}\b|s['’]s['’]/;

test('names: possessive of a name never doubles the apostrophe-s', () => {
  assert.equal(poss('QuartzRT'), "QuartzRT's");
  assert.equal(poss('James'), "James'");
  assert.equal(poss("Zoe's TensorFold recipe"), "Zoe's TensorFold recipe's");
  assert.equal(poss("Zoe's"), "Zoe's");
  assert.equal(poss("James'"), "James'");
  assert.equal(sayName('Zoe kit TP2'), "Zoe's kit");
  assert.equal(sayName("Zoe's TensorFold recipe"), "Zoe's TensorFold recipe");
  assert.equal(sayName('James kit TP2'), "James' kit");
  assert.equal(sayName('QuartzRT'), 'QuartzRT');
  for (const n of ["Zoe's TensorFold recipe", 'James', 'QuartzRT', 'Zoe kit TP2']) {
    assert.ok(!DOUBLE.test(poss(n)), poss(n));
    for (const a of aliasesOf(n)) assert.ok(!DOUBLE.test(a), a);
  }
  assert.deepEqual(aliasesOf("Zoe's TensorFold recipe"), ["Zoe's TensorFold recipe"]);
});

test('names: no caster line, caption, feed line or banner has a doubled possessive, whatever the names are', async () => {
  for (const names of NAME_SETS) {
    const { ev, plan } = fixture([], names);
    const { sheet, beats } = buildScript(ev, plan, { cls: '32 GB' });
    for (const f of sheet.facts) assert.ok(!DOUBLE.test(f.text), f.text);
    const ls = templateLines(sheet, beats, { seed: 3 });
    for (const l of ls) assert.ok(!DOUBLE.test(l.text), l.text);
    assert.deepEqual(checkLines(ls, makeContext(sheet, beats)).bad.map((x) => [x.line.text, x.reasons]), []);
    const r = await makeCasterTrack({ ev, plan, cls: '32 GB' });
    for (const c of r.track.cues) assert.ok(!DOUBLE.test(c.text), c.text);
    // the feed and the ticker
    const tl = timelineOf(plan);
    const ov = new Overlay({ events: ev.events, timeline: tl, players: ev.players, ev });
    for (const t of ov.ticker) assert.ok(!DOUBLE.test(t.text), t.text);
    for (const f of ov.feed) assert.ok(!DOUBLE.test(f.text), f.text);
    const name = (p) => ev.players[p - 1].name;
    for (const e of [{ type: 'base_destroyed', p: 1, by: 2 }, { type: 'first_contact', p: 1, other: 2, what: 'worker' }]) assert.ok(!DOUBLE.test(feedLine(e, name).text));
  }
  // the checker refuses a doubled possessive from any source (an LLM answer, a future template)
  const { sheet, beats } = build();
  const ctx = makeContext(sheet, beats);
  const bad = checkLine(line({ beat: beats[1].id, text: "That is Zoe's's TensorFold recipe." }), ctx);
  assert.ok(bad.reasons.some((x) => /doubled possessive/.test(x)), bad.reasons.join('; '));
});

test('captions: a cue split never leaves a bare "has 5625." without the words that say what it is', () => {
  const p = { text: "Checking the numbers: QuartzRT has 1885 in army value, Zoe's TensorFold recipe has 5625.", start: 0, end: 6 };
  const cues = cuesOf(p);
  assert.ok(cues.length >= 1);
  for (const c of cues) assert.ok(!/^[^,:]*\bhas \d+\.$/.test(c.text) || /army value/.test(c.text), c.text);
  assert.ok(cues.some((c) => /army value/.test(c.text) && /5625/.test(c.text)), 'the number and its label share a cue: ' + JSON.stringify(cues.map((c) => c.text)));
  // a long sentence with a harmless comma is still cut there
  assert.equal(cuesOf({ text: 'QuartzRT is expanding with a second town center right now, and the scouts have a good look at it.', start: 0, end: 5 }).length, 2);
});

test('closing line: the scoreboard is only said when the victory is in the cut', async () => {
  const { ev, plan } = fixture();
  const whole = buildScript(ev, plan, { cls: '32 GB' });
  const closeW = whole.beats.at(-1);
  assert.equal(closeW.kind, 'close');
  assert.ok(whole.sheet.facts.some((f) => f.kind === 'final' && closeW.facts.includes(f.id)), 'the real end carries the final numbers');
  const lines = templateLines(whole.sheet, whole.beats, { seed: 1 });
  assert.ok(lines.some((l) => /scoreboard/.test(l.text)));
  // a cut that stops before the victory: no final numbers anywhere in its closing beat
  const cut = fixture([], null, [0, 5800]);
  assert.deepEqual(cut.plan.window, [0, 5800]);
  const part = buildScript(cut.ev, cut.plan, { cls: '32 GB' });
  const closeP = part.beats.at(-1);
  assert.equal(closeP.kind, 'close');
  assert.ok(!part.sheet.facts.some((f) => f.kind === 'final' && closeP.facts.includes(f.id)), 'no final numbers in a cut that stops before the end');
  assert.ok(!templateLines(part.sheet, part.beats, { seed: 1 }).some((l) => /scoreboard/.test(l.text)));
  // and the checker refuses the final numbers in any other beat
  const f = whole.sheet.facts.find((x) => x.kind === 'final');
  const other = whole.beats.find((b) => b.kind === 'decision') || whole.beats[1];
  const r = checkLine(line({ beat: other.id, text: `The scoreboard: kills ${f.data.kills[0]} to ${f.data.kills[1]}.`, facts: [f.id] }), makeContext(whole.sheet, whole.beats));
  assert.ok(r.reasons.some((x) => /closing beat/.test(x)), r.reasons.join('; '));
});

test('thought card: no log tag, the first sentence with substance, filler shows nothing', () => {
  assert.equal(cleanThought('[reasoning] Let me analyze the situation.'), null);
  assert.equal(cleanThought('[reasoning] Let me start.'), null);
  assert.equal(cleanThought("[reasoning] Let's grasp the situation."), null);
  assert.equal(cleanThought('[reasoning] Big problem:'), null);
  assert.equal(cleanThought(''), null);
  assert.equal(cleanThought(null), null);
  // a model wrote its tool call into the note (real case: Qwen, match of 31.10., decision 22)
  assert.equal(cleanThought('</parameter> </function> </tool_call> <tool_call> <function=scout> <parameter=unit_id> 353'), null);
  assert.equal(cleanThought('Push the base now. </parameter> </function>'), 'Push the base now.');
  assert.equal(stripToolMarkup('Hold until food<400 and wood>10, then push'), 'Hold until food<400 and wood>10, then push', 'a comparison is no tag');
  // cut by the 120 character cap in the middle of a word (real case: "... lower wave to 10 so base force s")
  assert.equal(cleanThought('Scattered units (2 spears, 2 archers, spear, cav) push through enemy archers at the TC; lower wave to 10 so base force s'), 'Scattered units (2 spears, 2 archers, spear, cav) push through enemy archers at the TC; lower wave to 10 so base force…');
  assert.equal(cleanThought("[reasoning] I'm at 303 seconds with resources low on food (44)."), "I'm at 303 seconds with resources low on food (44).");
  // decimals stay inside their sentence: no lost start, no wrong number
  assert.equal(cleanThought("[reasoning] I'm at 313 seconds with a tight food situation at 39, though income is generating about 6.5 food per second."), "I'm at 313 seconds with a tight food situation at 39, though income is generating about 6.5 food per second.");
  assert.equal(cleanThought("Hold 2.5x more workers than the enemy, then attack."), "Hold 2.5x more workers than the enemy, then attack.");
  assert.equal(cleanThought("Got v1.2 of the plan: boost wood."), "Got v1.2 of the plan: boost wood.");
  assert.equal(cleanThought("Wood is low (0.8/s). Fix it now."), "Wood is low (0.8/s). Fix it now.");
  assert.equal(cleanThought("Pushing enemy base. Advance tier 2 now."), "Pushing enemy base. Advance tier 2 now.");
  assert.equal(cleanThought("Let me think. Boom to 30 workers."), "Boom to 30 workers.");
  assert.equal(cleanThought('[reply] Training archers now, then I attack.'), 'Training archers now, then I attack.');
  assert.equal(cleanThought('Let me think. Boom to 30 workers, then rush.'), 'Boom to 30 workers, then rush.');
  assert.equal(cleanThought('Boom economy first, barracks next round.'), 'Boom economy first, barracks next round.');
});

test('overlay: the winner banner is gone before the end table comes in, never both at once', () => {
  const { ev, plan } = fixture();
  const tl = timelineOf(plan);
  const ov = new Overlay({ events: ev.events, timeline: tl, players: ev.players, ev });
  assert.ok(ov.end && ov.banner);
  const s0 = ov.end.s0;
  let bannerSeen = false, endSeen = false;
  for (let t = ov.banner.s0; t < s0 + 3; t += 0.05) {
    const u = ov.at(t, tl.tickAt(t));
    if (u.banner && u.banner.a > 0) bannerSeen = true;
    if (u.end && u.end.a > 0) endSeen = true;
    assert.ok(!(u.banner && u.banner.a > 0 && u.end && u.end.a > 0), `banner ${u.banner && u.banner.a} and table ${u.end && u.end.a} at ${t.toFixed(2)}`);
  }
  assert.ok(bannerSeen && endSeen);
});
