import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildScript, CASTERS } from '../tools/caster-facts.mjs';
import { makeContext, checkLine, checkLines, extractNumbers } from '../tools/caster-check.mjs';
import { placeLines, validateTiming, cuesOf, toSrt, ttsManifest, spokenText, sentencesOf, estimateDuration } from '../tools/caster-place.mjs';
import { templateLines } from '../tools/caster-template.mjs';
import { commentaryStats, qualityIssues, LIMITS, normText } from '../tools/caster-quality.mjs';
import { makeCasterTrack, buildPrompt, parseLlm, askLlm, cacheKey } from '../tools/casters.mjs';
import { addSlowMotion, buildPlan } from '../tools/plan.mjs';
import { detectMoments, digestObservation } from '../tools/commentary.mjs';
import { Overlay } from '../tools/overlay.mjs';
import { withArticle } from '../tools/lib/names.mjs';
import { timelineOf } from '../tools/plan.mjs';

// ---- a small synthetic match: 10 minutes, two LLM players, one battle, two key decisions, a base falls ----
const obs = (o) => JSON.stringify({ t: 100, you: 1, tier: 1, res: { food: 10, wood: 20, stone: 30, gold: 40 }, pop: { used: 10, cap: 20 }, army_value: 500, workers: { n: 8, idle: 1 }, units: [{ type: 'archer', n: 4, xy: [20, 20] }], enemy_units: [], enemy_buildings: [], enemy_minor_buildings: [], map: { start: [18, 18], explored_pct: 10 }, ...o });
const raid = obs({ army_value: 1055, enemy_units: [{ type: 'archer', n: 5, xy: [30, 20] }], events: [{ type: 'attacked', what: 'house' }] });
const dec = (id, t, p, user, thought, summary = 'train 2x archer') => ({ id, t, type: 'llm_decision', p, n: id, start_tick: t - 50, thought, orders: ['train'], summary, latency_ms: 4000, completion_tokens: 400, tok_s: 100, errors: [], seen: digestObservation(user) });
const PLAYERS = [{ id: 1, kind: 'llm', name: 'Qwen3.8-27B NVFP4+MTP3 (QuartzRT)', model: 'qwen3.8-27b', hardware: '1x RTX 5090 32 GB' }, { id: 2, kind: 'llm', name: 'Qwen3.8-27B EXL3 4.0bpw+MTP (Zoe kit TP2)', model: 'qwen3.8-27b-exl3-4.0bpw', hardware: '2x RTX 5060 Ti 16 GB (TP2)' }];
function fixture(extraEvents = [], players = PLAYERS) {
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
  const ev = { version: 1, replay: 'fixture', seed: 101, ticks: 6000, seconds: 600, players, events, final: [{ p: 1, kills: 3, losses: 40, kill_value: 300, lost_value: 3000, gathered: 1000, score: 100, tier: 2, alive: false }, { p: 2, kills: 40, losses: 3, kill_value: 3000, lost_value: 300, gathered: 2000, score: 900, tier: 2, alive: true }], result: { winner_team: 2, reason: 'victory', tick: 6000 }, series: { army, lost: [[], []], fighting: [[], []], destroyed: [], focus_x: [], focus_y: [], focus_spread: [] } };
  const hl = { scenes: [{ id: 1, rank: 1, start: 5200, end: 5950, kind: 'victory', title: '', focus: null, score: 5 }] };
  let plan = buildPlan(ev, hl, { mode: 'highlight', params: { tail_s: 10.5 } });
  plan = addSlowMotion(plan, detectMoments(ev, { max: 3 }));
  return { ev, plan };
}
const build = () => { const { ev, plan } = fixture(); return { ev, plan, ...buildScript(ev, plan, { cls: '32 GB' }) }; };
const line = (o) => ({ beat: 1, speaker: 'ana', when: 'at', delivery: 'calm', text: '', facts: [], opinion: false, interject: false, ...o });

test('casters: fact sheet and beats come only from the log, are deterministic and tile the video', () => {
  const a = build(), b = build();
  assert.deepEqual(a.sheet, b.sheet);
  assert.deepEqual(a.beats, b.beats);
  assert.ok(a.sheet.facts.some((f) => f.kind === 'note' && f.data.quote === 'Full push on enemy TC with whole army; queue more archers'), 'the note is kept word for word');
  assert.ok(a.sheet.facts.some((f) => f.kind === 'battle' && /2540 value destroyed/.test(f.text)));
  assert.ok(a.sheet.facts.every((f) => !/watt/i.test(f.text)));
  assert.equal(a.beats[0].kind, 'open');
  assert.equal(a.beats.at(-1).kind, 'close');
  for (let i = 0; i + 1 < a.beats.length; i++) { assert.ok(a.beats[i].seg1 <= a.beats[i + 1].seg0 + 1e-6); assert.ok(a.beats[i].anchor <= a.beats[i + 1].anchor); }
  assert.ok(a.beats.some((b2) => b2.kind === 'decision' && b2.slow), 'the analyst talks at the slow-motion decisions');
});

test('casters checker: grounded lines pass', () => {
  const { sheet, beats } = build();
  const ctx = makeContext(sheet, beats);
  const bt = beats.find((b) => b.kind === 'battle');
  const f = sheet.facts.find((x) => x.kind === 'battle').id;
  assert.deepEqual(checkLine(line({ beat: bt.id, text: 'Oh! 34 units gone, 2540 value destroyed!', facts: [f], speaker: 'pbp', delivery: 'hype' }), ctx).reasons, []);
  const note = sheet.facts.find((x) => x.kind === 'note' && x.data.moment);
  const dec3 = beats.find((b) => b.kind === 'decision');
  assert.deepEqual(checkLine(line({ beat: dec3.id, text: 'QuartzRT writes: “Full push on enemy TC with whole army”. Is that the right call?', facts: [note.id], delivery: 'question' }), ctx).reasons, []);
  assert.deepEqual(checkLine(line({ beat: dec3.id, text: 'Its note: “Full push on enemy TC with whole army.” Bold!', facts: [note.id] }), ctx).reasons, [], 'a quote may end with a full stop inside the marks and be only a part of the note');
  const open = beats[0];
  assert.deepEqual(checkLine(line({ beat: open.id, text: 'Today it is QuartzRT on one RTX 5090 against Zoe kit TP2 on two RTX 5060 Ti cards.', facts: sheet.facts.filter((x) => x.kind === 'player').map((x) => x.id) }), ctx).reasons, []);
});

test('casters: the rules of a war-preset day are a fact (numbers from the replay rules); other days keep their sheet and their numbering', () => {
  const { ev, plan } = fixture();
  const plain = buildScript(ev, plan, { cls: '32 GB' });
  assert.ok(!plain.sheet.facts.some((f) => f.kind === 'rules'), 'no rules fact without resolved rules');
  const war = { preset: 'war', noScoreWin: true, towerCaps: [2, 2, 2], warAtS: 600, warTopUp: 5000, popMax: 300 };
  const a = buildScript({ ...ev, rules: war }, plan, { cls: '32 GB' });
  const r = a.sheet.facts.filter((f) => f.kind === 'rules');
  assert.equal(r.length, 1);
  assert.equal(r[0].tick, null);
  assert.equal(r[0].id, `f${plain.sheet.facts.length + 1}`, 'added last: no other fact changes its number');
  assert.deepEqual(a.sheet.facts.filter((f) => f.kind !== 'rules'), plain.sheet.facts);
  assert.deepEqual(a.beats, plain.beats);
  for (const n of [2, 10, 5000, 300, 150]) assert.ok(new RegExp(`\\b${n}\\b`).test(r[0].text), `the fact names ${n}: ${r[0].text}`);
  assert.deepEqual(buildScript({ ...ev, rules: { ...war, noScoreWin: false } }, plan, { cls: '32 GB' }).sheet, plain.sheet, 'a day without the war win rule is unchanged');
  // the checker takes the numbers from the fact, and only when a line cites it
  const ctx = makeContext(a.sheet, a.beats), open = a.beats[0];
  const say = (o) => checkLine(line({ beat: open.id, delivery: 'calm', ...o }), ctx).reasons;
  assert.deepEqual(say({ text: 'The population limit is 300, not 150.', facts: [r[0].id] }), []);
  assert.deepEqual(say({ text: 'Each side may build two towers.', facts: [r[0].id] }), []);
  assert.match(say({ text: 'The population limit is 300, not 150.', facts: [] }).join(' '), /number 300 is not in a cited fact/);
  assert.match(say({ text: 'The population limit is 400.', facts: [r[0].id] }).join(' '), /number 400 is not in a cited fact/);
});

test('casters checker: rejects wrong numbers, names, hardware, claims, quotes and spoilers', () => {
  const { sheet, beats } = build();
  const ctx = makeContext(sheet, beats);
  const bt = beats.find((b) => b.kind === 'battle');
  const f = sheet.facts.find((x) => x.kind === 'battle').id;
  const why = (o) => checkLine(line({ beat: bt.id, facts: [f], ...o }), ctx).reasons.join(' | ');
  assert.match(why({ text: 'That is 2600 value destroyed.' }), /number 2600/);
  assert.match(why({ text: 'Thirty-five units gone.' }), /number Thirty-five|number 35|not in a cited fact/);
  assert.match(why({ text: 'At 12:34 it happened.' }), /clock 12:34/);
  assert.match(why({ text: 'Zoe kit TP2 loses nothing here, and Zoe is happy.' }), /alone|Zoe/);
  assert.match(why({ text: 'Then GPT-5 joins the fight.' }), /GPT-5/);
  assert.match(why({ text: 'Claude pushes forward, and then Claude wins.' }), /not in the log/);
  assert.match(why({ text: 'QuartzRT runs on two RTX 5090 cards.' }), /hardware count/);
  assert.match(why({ text: 'Also on an RTX 4090 maybe.' }), /hardware ".*4090/);
  assert.match(why({ text: 'The 5090 draws a lot of watts.' }), /watt/);
  assert.match(why({ text: 'QuartzRT is simply the better model overall.' }), /general claim/);
  assert.match(why({ text: 'This proves the engine matters.' }), /general claim/);
  assert.match(why({ text: 'That was double the losses.' }), /vague multipliers/);
  assert.match(why({ text: 'QuartzRT will lose this.' }), /prediction/);
  assert.match(why({ text: 'I think QuartzRT will lose this.' }), /^$/);
  assert.match(why({ text: 'It lost because it is a worse build.' }), /reason|general/);
  assert.match(why({ text: 'The note says “we should hide in the forest” here.', facts: [f] }), /quote/);
  assert.match(why({ text: 'Zoe kit TP2 wins the match!' }), /winner words/);
  assert.match(why({ text: 'Fine.', delivery: 'shouting' }), /delivery/);
  assert.match(why({ text: '(laughs) good one' }), /stage directions/);
  assert.match(why({ text: 'word '.repeat(60) }), /too long/);
  assert.match(why({ text: 'Big fight.', facts: ['f999'] }), /unknown fact/);
  // a fact from after the end of the moment is a spoiler
  const base = sheet.facts.find((x) => x.kind === 'base');
  assert.match(checkLine(line({ beat: beats[0].id, text: 'The base falls!', facts: [base.id] }), ctx).reasons.join(), /later in the match/);
  // the loser never wins
  const close = beats.at(-1);
  const wl = checkLine(line({ beat: close.id, text: 'QuartzRT wins the match.', facts: [sheet.facts.find((x) => x.kind === 'victory').id], speaker: 'pbp' }), ctx).reasons.join();
  assert.match(wl, /does not win/);
  const ok = checkLine(line({ beat: close.id, text: 'Zoe kit TP2 wins the match.', facts: [sheet.facts.find((x) => x.kind === 'victory').id], speaker: 'pbp' }), ctx);
  assert.ok(ok.ok, ok.reasons.join());
});

test('casters checker: number words, clocks, rounding with "about"', () => {
  const n = (t) => extractNumbers(t).map((x) => x.value);
  assert.deepEqual(n('twenty-one units and 2,945 value at 16:07'), [21, 2945, '16:07']);
  assert.deepEqual(n('about 3k and 1.7x and three hundred'), [3000, 1.7, 300]);
  const { sheet, beats } = build();
  const ctx = makeContext(sheet, beats);
  const bt = beats.find((b) => b.kind === 'battle');
  const f = sheet.facts.find((x) => x.kind === 'battle').id;
  assert.ok(checkLine(line({ beat: bt.id, facts: [f], text: 'About 2500 value went up in smoke.' }), ctx).ok);
  assert.ok(!checkLine(line({ beat: bt.id, facts: [f], text: 'About 3000 value went up in smoke.' }), ctx).ok);
});

test('casters timing: lines sit around their moments, no overlap except short interjections, silence allowed', () => {
  const { beats, duration_s } = build();
  const bt = beats.find((b) => b.kind === 'battle');
  const lines = [
    line({ beat: bt.id, speaker: 'pbp', when: 'before', delivery: 'tense', text: 'Here they come!' }),
    line({ beat: bt.id, speaker: 'pbp', when: 'at', delivery: 'hype', text: 'Thirty four units fall in one go, what a clash this is!' }),
    line({ beat: bt.id, speaker: 'ana', when: 'react', delivery: 'hype', text: 'Oh!', interject: true }),
    line({ beat: bt.id, speaker: 'ana', when: 'after', delivery: 'calm', text: 'That is a lot of units. I think the push came too early.', opinion: true }),
  ];
  const { placed, dropped } = placeLines(lines, beats, duration_s);
  assert.equal(dropped.length, 0, JSON.stringify(dropped.map((d) => [d.line.text, d.why])));
  assert.deepEqual(validateTiming(placed, duration_s), []);
  const before = placed.find((p) => p.text === 'Here they come!');
  const react = placed.find((p) => p.text === 'Oh!');
  assert.ok(before.start < bt.anchor + 0.5, 'a slight lead before the fight');
  assert.ok(react.start >= bt.anchor, 'the reaction comes right after');
  const big = placed.find((p) => /clash/.test(p.text));
  assert.ok(react.start > big.start && react.end <= big.end + 0.01, 'the interjection sits inside the other caster line');
  const reg = placed.filter((p) => !p.interject).sort((a, b) => a.start - b.start);
  for (let i = 1; i < reg.length; i++) assert.ok(reg[i].start >= reg[i - 1].end, 'regular lines never overlap');
  // pace, measured on real takes: Juno 3.15 words per second, Dex 3.0 and 3.15 in fights
  const pbpFight = estimateDuration('one two three four five six seven eight nine ten', 'pbp', true), ana = estimateDuration('one two three four five six seven eight nine ten', 'ana', true);
  assert.ok(Math.abs(ana - 10 / 3.15) < 0.01 && Math.abs(pbpFight - 10 / 3.15) < 0.01);
  // a hand-made overlap of two regular lines is reported
  const bad = [{ ...placed[0], id: 'A', start: 1, end: 3, interject: false, speaker: 'pbp' }, { ...placed[0], id: 'B', start: 2, end: 4, interject: false, speaker: 'ana' }];
  assert.match(validateTiming(bad, 10).join(), /overlap/);
  // too many words for the window: the late line is dropped, never squeezed
  const flood = Array.from({ length: 12 }, (_, i) => line({ beat: bt.id, speaker: i % 2 ? 'ana' : 'pbp', text: 'This is a long line with many words that takes about five seconds to say out loud now.' }));
  const r = placeLines(flood, beats, duration_s);
  assert.ok(r.dropped.length > 0);
  assert.deepEqual(validateTiming(r.placed, duration_s), []);
});

test('casters SRT: a sentence end behind a quote or before a quote also ends the cue', () => {
  const texts = ['DeepSeek: “Finish archery range, then tier 2.” Who\'s right?', '“army marches on enemy base, scout ahead.” Who runs out of buildings first?', 'DeepSeek? “keep workers coming”.', 'Its plan: “All 43 push enemy TC now”.'];
  assert.deepEqual(sentencesOf(texts[0]), ['DeepSeek: “Finish archery range, then tier 2.”', 'Who\'s right?']);
  assert.deepEqual(sentencesOf(texts[1]), ['“army marches on enemy base, scout ahead.”', 'Who runs out of buildings first?']);
  assert.deepEqual(sentencesOf(texts[2]), ['DeepSeek?', '“keep workers coming”.']);
  assert.deepEqual(sentencesOf(texts[3]), [texts[3]], 'a quote inside a sentence stays');
  for (const text of texts) for (const c of cuesOf({ id: 'L1', speaker: 'ana', start: 0, end: 6, text })) assert.ok(!/[.!?][”"’]?\s+\S/.test(c.text), `no sentence end inside "${c.text}"`);
});

test('casters SRT: one sentence per cue, a cue never crosses a sentence boundary', () => {
  const p = { id: 'L1', speaker: 'pbp', start: 10, end: 20, text: 'Wow! Qwen3.8-27B just took 1.7x longer, can you believe it? Yes, I can. It happened at 16:07, and the whole army went in, one unit after another, right into the fog.' };
  const cues = cuesOf(p);
  assert.ok(cues.length >= 4);
  assert.equal(cues[0].s0, 10); assert.equal(cues.at(-1).s1, 20);
  for (let i = 0; i < cues.length; i++) {
    assert.ok(cues[i].s1 > cues[i].s0);
    if (i) assert.ok(Math.abs(cues[i].s0 - cues[i - 1].s1) < 0.002, 'cues follow each other');
    assert.equal(sentencesOf(cues[i].text).length, 1, `no sentence boundary inside "${cues[i].text}"`);
    assert.ok(!/[.!?]\s+[A-Z0-9]/.test(cues[i].text));
  }
  assert.ok(cues.some((c) => c.text.includes('Qwen3.8-27B') && c.text.includes('1.7x')), 'decimals are not sentence ends');
  const srt = toSrt([{ ...p, id: 'L1' }]);
  const blocks = srt.trim().split(/\n\n/);
  assert.equal(blocks.length, cues.length);
  assert.match(blocks[0], /^1\n00:00:10,000 --> 00:00:\d\d,\d{3}\nDex: Wow!$/);
  // a long sentence may be cut at a comma but the pieces stay inside the sentence
  assert.ok(cues.filter((c) => c.text.includes('the whole army') || c.text.includes('right into the fog')).length >= 1);
});

test('casters template fallback: lively, grounded, passes the checker, fits the timeline, deterministic', () => {
  const { sheet, beats, duration_s } = build();
  const ctx = makeContext(sheet, beats);
  const a = templateLines(sheet, beats, { seed: 3 }), b = templateLines(sheet, beats, { seed: 3 });
  assert.deepEqual(a, b);
  assert.ok(a.length >= beats.length);
  const res = checkLines(a, ctx);
  assert.deepEqual(res.bad.map((x) => [x.line.text, x.reasons]), []);
  assert.ok(new Set(a.map((l) => l.speaker)).size === 2, 'both casters talk');
  assert.ok(a.some((l) => l.speaker === 'pbp' && (l.text.match(/[.!?](\s|$)/g) || []).length >= 2), 'Dex speaks in runs of sentences, not lone shouts');
  assert.ok(!a.some((l) => l.speaker === 'pbp' && l.interject), 'no lone interjections');
  assert.ok(a.some((l) => l.delivery === 'hype') && a.some((l) => l.delivery === 'question' || l.delivery === 'tense'));
  const { placed } = placeLines(a, beats, duration_s);
  assert.deepEqual(validateTiming(placed, duration_s), []);
  assert.ok(placed.length >= beats.length - 1);
  assert.notDeepEqual(templateLines(sheet, beats, { seed: 4 }).map((l) => l.text), a.map((l) => l.text), 'another seed picks other variants');
  // the base falls: the analyst answers the earlier question
  assert.ok(a.some((l) => /right call/.test(l.text)) || a.some((l) => /town center/.test(l.text)));
});

test('casters TTS manifest: Drama 3 style prefix, numbers as words, one tag at most, voices, take range', () => {
  const placed = [
    { id: 'L1', speaker: 'pbp', start: 5, end: 8, dur: 3, delivery: 'hype', text: 'Oh no, 34 units gone, 2540 value destroyed in 26 seconds!', interject: false, beat: 1 },
    { id: 'L2', speaker: 'ana', start: 8.4, end: 12, dur: 3.6, delivery: 'tense', text: 'Zoe kit TP2 has 1x RTX 5090 at 16:07 and 0.4x slow motion.', interject: false, beat: 1 },
    { id: 'L3', speaker: 'pbp', start: 9, end: 9.5, dur: 0.5, delivery: 'hype', text: 'Wow!', interject: true, beat: 1 },
  ];
  const m = ttsManifest(placed, CASTERS, { duration_s: 20 });
  assert.deepEqual(m.entries.map((e) => e.voice), ['caster_a', 'caster_b', 'caster_a']);
  for (const e of m.entries) {
    assert.match(e.text_tts, /^\[[A-Za-z -]+(?:, [A-Za-z -]+){1,7}\] /, 'one short style prefix in square brackets');
    assert.match(e.text_tts, e.speaker === 'pbp' ? /^\[young British man/ : /^\[Canadian woman/, 'the style fits the voice the owner picked');
    const sw = e.style.slice(1, -1).split(/[\s,]+/).filter(Boolean).length;
    assert.ok(sw >= 3 && sw <= 16, `style has ${sw} words`);
    assert.ok(!/\d/.test(e.text_tts), `numbers are words: ${e.text_tts}`);
    assert.ok(!e.text_tts.includes('\n'));
    assert.ok((e.text_tts.match(/<(emphasis|fast|slow|forceful|stress|soft|whisper)>/g) || []).length <= 1);
    assert.deepEqual(e.accept_take_s, [+(0.35 * e.expected_s).toFixed(2), +(2.3 * e.expected_s).toFixed(2)]);
    assert.ok(e.latest_end_s >= e.start_s + e.target_duration_s - 0.01);
  }
  assert.match(m.entries[0].text_tts, /thirty-four units gone, two thousand five hundred forty value destroyed in twenty-six/);
  assert.match(m.entries[1].text_tts, /sixteen oh seven/);
  assert.match(m.entries[1].text_tts, /one R T X fifty ninety/);
  assert.match(m.entries[1].text_tts, /zero point four/);
  assert.equal(spokenText('Qwen3.8-27B'), 'Qwen three point eight twenty-seven B');
});

test('casters writer: an LLM answer is checked, bad lines are replaced, a cached answer needs no server', async () => {
  const { ev, plan } = fixture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'casters-'));
  const { sheet, beats } = buildScript(ev, plan, { cls: '32 GB' });
  const bt = beats.find((b) => b.kind === 'battle');
  const f = sheet.facts.find((x) => x.kind === 'battle').id;
  const answer = { lines: [
    { beat: beats[0].id, speaker: 'pbp', when: 'at', delivery: 'hype', text: 'Welcome to RTS Arena, I am Dex Harlan!', facts: [sheet.facts[0].id] },
    { beat: bt.id, speaker: 'pbp', when: 'at', delivery: 'hype', text: 'Oh! 34 units gone, 2540 value destroyed!', facts: [f] },
    { beat: bt.id, speaker: 'ana', when: 'after', delivery: 'calm', text: 'QuartzRT drew 600 watts there and is the better model.', facts: [f] },
  ] };
  const file = path.join(dir, 'answer.json');
  fs.writeFileSync(file, JSON.stringify({ model: 'test-answer', response: JSON.stringify(answer) }));
  // no silent swap: by default a rejected line stops the run with its reason (Koordinator 06.11.); the template swap exists only with RTS_ALLOW_TEMPLATE_REPLACE=1
  await assert.rejects(makeCasterTrack({ ev, plan, cls: '32 GB', llmOutput: file }), /would be replaced by template lines, stopped.*watts/);
  process.env.RTS_ALLOW_TEMPLATE_REPLACE = '1';
  let r;
  try { r = await makeCasterTrack({ ev, plan, cls: '32 GB', llmOutput: file }); } finally { delete process.env.RTS_ALLOW_TEMPLATE_REPLACE; }
  assert.equal(r.track.generated.source, 'llm+template');
  assert.equal(r.track.generated.replaced.length, 1);
  assert.match(r.track.generated.replaced[0].reasons.join(), /watt|general/);
  assert.ok(r.track.lines.some((l) => l.text.startsWith('Oh! 34 units')));
  assert.ok(!r.track.lines.some((l) => /watts/.test(l.text)));
  assert.deepEqual(r.track.timing_issues, []);
  assert.ok(r.track.cues.length >= r.track.lines.length);
  // a hand-written script (keep): a rejected line stops the run, it is never swapped for template lines
  const handFile = path.join(dir, 'hand.json');
  fs.writeFileSync(handFile, JSON.stringify({ model: 'test-answer', response: JSON.stringify({ lines: answer.lines.map((l) => ({ ...l, keep: true })) }) }));
  await assert.rejects(makeCasterTrack({ ev, plan, cls: '32 GB', llmOutput: handFile }), /hand-written script.*watts/);
  // cache: the same prompt is answered from disk, the endpoint is never called
  const cfg = { base: 'http://127.0.0.1:9/v1', model: 'cached-model', key: '' };
  const msgs = [{ role: 'system', content: r.prompt.system }, { role: 'user', content: r.prompt.user }];
  fs.mkdirSync(path.join(dir, 'c'));
  fs.writeFileSync(path.join(dir, 'c', `${cacheKey(cfg.model, msgs)}.json`), JSON.stringify({ model: 'cached-model', response: JSON.stringify(answer) }));
  process.env.RTS_ALLOW_TEMPLATE_REPLACE = '1'; // this answer holds a bad line on purpose; only the cache is tested here
  let r2;
  try { r2 = await makeCasterTrack({ ev, plan, cls: '32 GB', llm: cfg, cacheDir: path.join(dir, 'c') }); } finally { delete process.env.RTS_ALLOW_TEMPLATE_REPLACE; }
  assert.equal(r2.track.generated.cached, true);
  assert.deepEqual(r2.track.generated.prompt_hash, r.track.generated.prompt_hash);
  // an endpoint that is down: the template writer takes over
  const r3 = await makeCasterTrack({ ev, plan, cls: '32 GB', llm: { ...cfg, model: 'other' }, cacheDir: path.join(dir, 'c2') });
  assert.equal(r3.track.generated.source, 'template');
  assert.ok(r3.track.generated.llm_error);
  assert.deepEqual(parseLlm('```json\n{"lines":[{"beat":1,"speaker":"Dex","text":"Hi."}]}\n```')[0].speaker, 'pbp');
  assert.ok(buildPrompt(sheet, beats, 90).system.includes('Juno Quill'));
});

test('casters overlay: captions follow the cues, two at most, with speaker colour and name; no generic cards', () => {
  const { ev, plan } = fixture();
  const tl = timelineOf(plan);
  const cues = [
    { s0: 5, s1: 8, speaker: 'pbp', name: 'Dex', role: 'play-by-play', color: '#3ddc97', text: 'Hello there!' },
    { s0: 6, s1: 6.6, speaker: 'ana', name: 'Juno', role: 'analyst', color: '#c792ea', text: 'Oh!' },
  ];
  const ov = new Overlay({ events: ev.events, timeline: tl, players: PLAYERS, moments: plan.moments || [], ev, captions: cues });
  assert.equal(ov.at(4, 0).captions.length, 0);
  const u = ov.at(6.3, 100);
  assert.equal(u.captions.length, 2);
  assert.equal(u.captions[0].name, 'Dex'); assert.equal(u.captions[1].color, '#c792ea');
  assert.equal(ov.at(7, 100).captions.length, 1);
  assert.equal(ov.at(9, 100).captions.length, 0);
  for (let t = 0; t < 60; t += 1.3) assert.equal(ov.at(t, 0).cards.length, 0);
  assert.deepEqual(ov.at(6.3, 100), ov.at(6.3, 100), 'pure function of time');
});

test('roles: the template keeps Dex to action beats and the opening; written scripts have both casters everywhere', () => {
  const { sheet, beats } = build(), ctx = makeContext(sheet, beats), byId = new Map(beats.map((b) => [b.id, b]));
  assert.ok(beats.every((b) => ['action', 'open', 'calm'].includes(b.role)));
  assert.ok(beats.filter((b) => b.kind === 'decision').every((b) => b.role === 'calm'), 'the decision moments are Juno\'s');
  for (const seed of [0, 1, 2, 3]) {
    const lines = templateLines(sheet, beats, { seed });
    for (const l of lines) if (l.speaker === 'pbp') assert.notEqual(byId.get(l.beat).role, 'calm', `Dex speaks in a calm beat: ${l.text}`);
    assert.ok(checkLines(lines, ctx).warnings.every((w) => !/Dex speaks/.test(w)));
  }
  const calm = beats.find((b) => b.role === 'calm');
  const r = checkLines([line({ beat: calm.id, speaker: 'pbp', text: 'Hello there.' })], ctx);
  assert.ok(!r.warnings.some((w) => /Dex speaks/.test(w)), 'Dex may talk in a calm beat');
  assert.match(buildPrompt(sheet, beats, 90).system, /A REAL CONVERSATION/);
  assert.match(buildPrompt(sheet, beats, 90).system, /TRANSLATE:/);
  assert.doesNotMatch(buildPrompt(sheet, beats, 90).system, /stays silent in every calm beat/);
});

test('casters: a fight in which only buildings fall never says "hardly a unit lost" or "no real damage"', () => {
  // the old template picked the side by lost value and then talked about its units: buildings lost, no unit lost -> "Hardly a unit lost. Was that all?"
  const { ev, plan } = fixture();
  const bt = ev.events.find((e) => e.type === 'battle');
  Object.assign(bt, { kills: 2, value: 600, participants: { 1: { lost_units: 0, lost_value: 600, lost_buildings: 2, lost_by_type: { house: 2 }, peak_fighting: 10 }, 2: { lost_units: 0, lost_value: 0, lost_buildings: 0, lost_by_type: {}, peak_fighting: 10 } } });
  const { sheet, beats } = buildScript(ev, plan, { cls: '32 GB' }), ctx = makeContext(sheet, beats), said = [];
  for (let seed = 0; seed < 12; seed++) {
    const lines = templateLines(sheet, beats, { seed });
    said.push(...lines.map((l) => l.text));
    assert.deepEqual(checkLines(lines, ctx).bad.map((x) => [x.line.text, x.reasons]), [], `seed ${seed}`);
  }
  assert.doesNotMatch(said.join('\n'), /Hardly a unit lost|no real damage|real beating|Hardly any damage/);
  assert.match(said.join('\n'), /No units lost, but .+ loses 2 buildings\./);
});

test('casters: a building that crumbles in sudden death has no attacker (never "the player" or "player 0")', () => {
  // by = 0 and no weapon: nobody destroyed it (sim/game.mjs suddenDeathStep). The old text said "player 0 destroys ..." and the template "the player razes ...".
  const { ev, plan } = fixture([
    { t: 5700, type: 'building_destroyed', p: 1, building: 'siege_workshop', loc: [20, 30], by: 0, value: 240, src: null },
    { t: 5800, type: 'building_destroyed', p: 2, building: 'barracks', loc: [100, 90], by: 0, value: 140, src: null },
  ]);
  const { sheet, beats } = buildScript(ev, plan, { cls: '32 GB' });
  const crumbs = sheet.facts.filter((f) => f.kind === 'razed' && f.data.crumble);
  assert.equal(crumbs.length, 2);
  for (const f of crumbs) { assert.match(f.text, /crumbles away/); assert.doesNotMatch(f.text, /player \d|destroys/); }
  // a real attack keeps its attacker
  assert.ok(sheet.facts.some((f) => f.kind === 'razed' && !f.data.crumble && /Zoe kit TP2 destroys QuartzRT's barracks with a ram/.test(f.text)));
  const proto = beats.find((b) => b.kind === 'battle');
  const ctxBeats = crumbs.map((f, i) => ({ ...proto, id: 100 + i, kind: 'razed', facts: [f.id], role: 'action', fight: true, tick: f.tick, tick_end: f.tick + 100 }));
  const ctx = makeContext(sheet, [...beats, ...ctxBeats]);
  const say = [];
  for (const seed of [0, 1, 2, 3, 4, 5]) {
    const lines = templateLines(sheet, ctxBeats, { seed });
    assert.ok(lines.length >= 2);
    assert.deepEqual(checkLines(lines, ctx).bad.map((x) => [x.line.text, x.reasons]), []);
    for (const l of lines) {
      say.push(l.text);
      assert.doesNotMatch(l.text, /the player|player \d/i, l.text);
      for (const sentence of sentencesOf(l.text)) assert.match(sentence, /^[“"(]?[A-Z0-9]/, `a sentence starts in lower case: ${sentence}`);
    }
  }
  assert.ok(say.some((t) => /crumbl/.test(t)), 'the casters say what happened');
  // the base itself crumbling: the base line names the loser, not an attacker
  const bf = { id: 'f9999', kind: 'base', tick: 5000, p: 1, text: "[08:20, minute 8] QuartzRT's base falls: the town center crumbles away.", data: { p: 1, by: 0, src: null, crumble: true } };
  const sheet2 = { ...sheet, facts: [...sheet.facts, bf] };
  const bb = { ...proto, id: 200, kind: 'base', facts: [bf.id], role: 'action', fight: true, tick: 5000, tick_end: 6000 };
  const out = templateLines(sheet2, [bb], { seed: 1 });
  assert.ok(out.some((l) => /town center crumbles away|base crumbles all on its own/.test(l.text)));
  assert.ok(out.every((l) => !/the player|player \d/i.test(l.text)));
});

// ---- density, gaps, repeats, lag (owner's review: 1.5 words/s, silences up to 29 s, repeated lines, commentary behind the game) ----
const qline = (id, start, end, text, o = {}) => ({ id, beat: 1, speaker: 'ana', when: 'at', text, start, end, interject: false, ...o });
const qbeat = { id: 1, anchor: 0, seg0: 0, seg1: 40 };

test('casters quality: the measures find thin, gappy, repeating and late commentary', () => {
  const words = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
  // a dense track: a line every 4 s, no repeat
  const good = { duration_s: 40, beats: [qbeat], lines: Array.from({ length: 10 }, (_, i) => qline(`L${i}`, i * 4, i * 4 + 3.6, `Line number ${i} says something different. ${words(8)}`, { beat: 1 })) };
  const g = commentaryStats(good);
  assert.ok(g.words_per_s >= 2.2 && g.longest_gap_s <= 0.5 && g.repeated_lines === 0 && g.repeated_sentences === 0);
  // a line is "repeated" when its words are exactly those of an earlier line, case and punctuation aside; short interjections are reactions and exempt
  const rep = { duration_s: 40, beats: [qbeat], lines: [qline('A', 0, 3, 'The state of play: both sides are on tier 3.'), qline('B', 10, 13, 'the state of play - both sides are on tier 3'), qline('C', 20, 21, 'Oh!', { interject: true }), qline('D', 25, 26, 'Oh!', { interject: true }), qline('E', 30, 33, 'Brutal start. Probe A keeps building up its economy now.'), qline('F', 35, 38, 'A different opener here. Probe A keeps building up its economy now!')] };
  const r = commentaryStats(rep);
  assert.equal(r.repeated_lines, 1);
  assert.equal(r.repeated_sentences, 1, 'a long sentence said again inside another line counts too');
  assert.match(qualityIssues(r).join('|'), /repeated word for word/);
  // gaps include the start and the end of the video
  const gappy = { duration_s: 60, beats: [qbeat], lines: [qline('A', 2, 5, words(8)), qline('B', 30, 33, words(8))] };
  const gp = commentaryStats(gappy);
  assert.equal(gp.longest_gap_s, 27);
  assert.equal(gp.gaps_over_8s, 2);
  assert.match(qualityIssues(gp).join('|'), /silence of 27/);
  assert.match(qualityIssues(gp).join('|'), /too thin/);
  // lag: a call that starts long after its moment is late, a follow-up, a reaction and a gap-fill line are not measured
  const late = { duration_s: 40, beats: [{ ...qbeat, anchor: 5 }], lines: [qline('A', 12, 15, words(8)), qline('B', 16, 19, words(8), { when: 'after' }), qline('C', 20, 23, words(8), { fill: true })] };
  assert.ok(commentaryStats(late).max_lag_s > LIMITS.max_lag_s);
  assert.match(qualityIssues(commentaryStats(late)).join('|'), /after its moment/);
  assert.equal(commentaryStats({ ...late, lines: late.lines.slice(1) }).max_lag_s, 0);
  // only the call of a moment counts: a second line of the beat comes behind it by design, a line with its own start second is a call of its own
  const two = { duration_s: 60, beats: [{ ...qbeat, anchor: 5, seg1: 50 }], lines: [qline('A', 5.2, 8, words(8)), qline('B', 20, 23, words(8))] };
  assert.ok(commentaryStats(two).max_lag_s < 0.2);
  const timed = { ...two, lines: [qline('A', 5.2, 8, words(8)), qline('B', 20, 23, words(8), { at_s: 12 })] };
  assert.ok(Math.abs(commentaryStats(timed).max_lag_s - 8) < 0.01);
  assert.equal(normText('The “State” of play!'), 'the state of play');
});

test('casters placement: shorter versions (alts), keep, own start second (at_s) and droppable fillers', () => {
  const beats = [{ id: 1, kind: 'battle', anchor: 10, seg0: 8, seg1: 18, fight: false, role: 'action' }, { id: 2, kind: 'battle', anchor: 14, seg0: 13, seg1: 20, fight: false, role: 'action' }, { id: 3, kind: 'close', anchor: 30, seg0: 21, seg1: 40, fight: false, role: 'calm' }];
  const long = 'One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen.';
  const L = (o) => line({ beat: 1, speaker: 'pbp', text: long, ...o });
  // the long version would push the next beat late: its shorter version is said
  const a = placeLines([L({ alts: ['One two three four five.'] }), line({ beat: 2, speaker: 'ana', text: 'Next moment is here.' })], beats, 60);
  const first = a.placed.find((p) => p.beat === 1), next = a.placed.find((p) => p.beat === 2);
  assert.equal(first.text, 'One two three four five.');
  assert.equal(first.short, true);
  assert.ok(next.start <= 14.1 + 0.8 + 1e-6, 'the next beat keeps its moment');
  // nothing is in the way: the long version stays
  const b = placeLines([L({ alts: ['One two three four five.'] }), line({ beat: 3, speaker: 'ana', text: 'Much later.' })], beats, 60);
  assert.equal(b.placed.find((p) => p.beat === 1).text, long);
  // keep: the call is never shortened for the sake of the next line
  const c = placeLines([L({ keep: true, alts: ['One two three four five.'] }), line({ beat: 2, speaker: 'ana', text: 'Next moment is here.' })], beats, 60);
  assert.equal(c.placed.find((p) => p.beat === 1).text, long);
  // the last line must fit the video: its shorter version is taken when the long one does not fit
  const d = placeLines([L({ beat: 3, alts: ['One two three.'] })], beats, 33);
  assert.equal(d.placed.length, 1);
  assert.ok(d.placed[0].end <= 33 - 0.25);
  // a line with its own start second sits there, not at the start of its beat
  const e = placeLines([line({ beat: 3, speaker: 'ana', text: 'Early line here.' }), line({ beat: 3, speaker: 'ana', text: 'The barracks is up right now.', at_s: 33 })], beats, 60);
  const at = e.placed.find((p) => /barracks/.test(p.text));
  assert.ok(Math.abs(at.start - 33) < 0.01, `at_s: ${at.start}`);
  assert.equal(e.placed[0].text, 'Early line here.');
  // a flow beat never loses a line to lateness, a filler does
  const fb = [{ ...beats[0], flow: true }];
  const crowd = [L({ text: long }), L({ text: long }), L({ text: long }), L({ text: long, filler: true })];
  const f = placeLines(crowd, fb, 100);
  assert.equal(f.placed.length, 3);
  assert.equal(f.dropped.length, 1);
  assert.match(f.dropped[0].why, /late/);
});

test('casters template: nothing is said twice, composed lines rotate, alts are shorter and still pass the checker', () => {
  const { sheet, beats } = build();
  const bt = beats.find((b) => b.kind === 'battle');
  // the same kind of moment eight times over, as in a long match
  const many = Array.from({ length: 8 }, (_, i) => ({ ...bt, id: 300 + i, tick: bt.tick + i * 10, tick_end: bt.tick_end + i * 10, anchor: bt.anchor + i * 5, seg0: bt.seg0 + i * 5, seg1: bt.seg1 + i * 5 }));
  const ctx = makeContext(sheet, [...beats, ...many]);
  const lines = templateLines(sheet, many, { seed: 5 });
  assert.deepEqual(checkLines(lines, ctx).bad.map((x) => [x.line.text, x.reasons]), []);
  const seen = new Map();
  for (const l of lines) { const k = normText(l.text); assert.ok(!seen.has(k) || (l.interject && l.text.split(/\s+/).length <= 4), `said twice: ${l.text}`); seen.set(k, 1); }
  const dex = lines.filter((l) => l.speaker === 'pbp');
  assert.ok(new Set(dex.map((l) => l.text.split(/[.!?]/)[0])).size >= Math.min(6, dex.length), 'Dex does not open every call the same way');
  for (const l of lines.filter((x) => x.alts?.length)) {
    for (const t of l.alts) assert.ok(t.length < l.text.length, `an alt is shorter: ${t}`);
    assert.deepEqual(checkLines(l.alts.map((t) => ({ ...l, text: t, alts: undefined })), ctx).bad.map((x) => [x.line.text, x.reasons]), [], 'the shorter versions pass the checker');
  }
});

test('casters track: the finished commentary is dense, has no long silence, no repeat, starts on time and every filler is grounded', async () => {
  const { ev, plan } = fixture();
  const r = await makeCasterTrack({ ev, plan, cls: '32 GB' });
  const st = commentaryStats(r.track);
  const bad = qualityIssues(st, { ...LIMITS, min_words_per_s: 1.5 });
  assert.deepEqual(bad, []);
  assert.deepEqual(r.track.timing_issues, []);
  // the gap-fill lines are checked like any other line and never come after the sign-off
  const last = r.track.lines.filter((l) => !l.fill).at(-1);
  for (const l of r.track.lines.filter((x) => x.fill)) {
    assert.ok(l.start < last.start, `a filler after the sign-off: ${l.text}`);
    assert.equal(l.speaker, 'ana');
    assert.deepEqual(checkLines([{ ...l, beat: l.beat, interject: false }], makeContext({ ...r.sheet, facts: r.sheet.facts }, r.beats)).bad.map((x) => x.reasons), []);
  }
  // without the gap-fill the same track has no fill line
  const r0 = await makeCasterTrack({ ev, plan, cls: '32 GB', fill: false });
  assert.equal(r0.track.lines.filter((l) => l.fill).length, 0);
  assert.ok(r.track.lines.length >= r0.track.lines.length);
  assert.ok(st.longest_gap_s <= commentaryStats(r0.track).longest_gap_s + 1e-9, 'the fill never makes a silence longer');
});

test('casters checker: an army value that looks like a GPU model number is a number, a GPU nobody has is still caught', () => {
  const { sheet, beats } = build();
  const bt = beats.find((b) => b.kind === 'battle');
  const f = { id: 'f9001', kind: 'series', tick: bt.tick, text: '[10:00, minute 10] Army value right now: QuartzRT 4070, Zoe kit TP2 810.', data: {} };
  const sheet2 = { ...sheet, facts: [...sheet.facts, f] };
  const ctx = makeContext(sheet2, beats);
  const ok = checkLine(line({ beat: bt.id, text: '4070 against 810 in army value: QuartzRT holds the edge.', facts: [f.id] }), ctx);
  assert.deepEqual(ok.reasons, []);
  const gpu = checkLine(line({ beat: bt.id, text: 'QuartzRT runs on a 4070 here, with 810 for the other side.', facts: [f.id] }), ctx);
  assert.match(gpu.reasons.join(), /hardware/, 'talking about hardware, the number is not enough');
  const fake = checkLine(line({ beat: bt.id, text: 'QuartzRT runs on an RTX 4070 here.', facts: [f.id] }), ctx);
  assert.match(fake.reasons.join(), /hardware/);
  const none = checkLine(line({ beat: bt.id, text: 'QuartzRT runs on a 4090 here.', facts: [f.id] }), ctx);
  assert.ok(!none.ok);
});

test('casters template: a match with no army at all gets no "0 to 0" statements', () => {
  const { sheet, beats } = build();
  const bt = beats.find((b) => b.kind === 'battle');
  const mk = (kind, data, text) => ({ id: `f90${kind.length}${text.length}`, kind, tick: bt.tick, text, data });
  const lull = mk('series', { army: [0, 0] }, '[10:00, minute 10] Army value right now: QuartzRT 0, Zoe kit TP2 0.');
  const conseq = mk('conseq', { army0: [0, 0], army1: [0, 0], lost: [{ n: 0 }, { n: 0 }] }, '[10:00, minute 10] Since the decision: army value QuartzRT 0 to 0, Zoe kit TP2 0 to 0; units lost 0 and 0.');
  const sheet2 = { ...sheet, facts: [...sheet.facts, lull, conseq] };
  const bl = { ...bt, id: 400, kind: 'lull', role: 'calm', fight: false, facts: [lull.id] };
  const ba = { ...bt, id: 401, kind: 'after', role: 'calm', fight: false, facts: [conseq.id] };
  const ctx = makeContext(sheet2, [...beats, bl, ba]);
  const lines = templateLines(sheet2, [bl, ba], { seed: 2 });
  assert.ok(lines.length >= 2);
  assert.deepEqual(checkLines(lines, ctx).bad.map((x) => [x.line.text, x.reasons]), []);
  for (const l of lines) assert.doesNotMatch(l.text, /\b0 to 0\b|\b0 for\b|value (right now|stands at|is dead level at) 0\b/, l.text);
});

// Player names are free text from the match config. The real pairs and names full of regex characters run through the whole script chain:
// nothing may crash, no broken word may reach a fact or a line.
const NAME_PAIRS = [
  ['Qwen3.8-27B NVFP4+MTP3 (QuartzRT)', "DeepSeek-V4.1-Flash (Bob's TensorFold Metal recipe)"],
  ['Qwen3.8-27B NVFP4+MTP3 (QuartzRT)', 'Qwen3.8-27B EXL3 (Zoe kit TP2)'],
  ["GLM-5.2 (Zoe's TensorFold recipe)", 'Kimi-K3 (a recipe by someone with a very long name indeed)'],
  ['Alpha (with (nested) brackets', 'Beta) closes first ('],
  ['C++ [draft] (a|b)*', 'Star* model? (x+y) ^$'],
  ['One', 'Two'],
  ['Same Name', 'Same Name'],
  ['', ' '],
];
const BROKEN = /\b(?:null|undefined|NaN)\b|\[object /;
for (const names of NAME_PAIRS) {
  test(`casters: names ${JSON.stringify(names)} run through the whole chain`, async () => {
    const { ev, plan } = fixture([], PLAYERS.map((p, i) => ({ ...p, name: names[i] })));
    const r = await makeCasterTrack({ ev, plan, cls: '32 GB', log() {} });
    assert.ok(r.track.lines.length >= 4, `only ${r.track.lines.length} lines`);
    const { sheet } = buildScript(ev, plan, { cls: '32 GB' });
    for (const f of sheet.facts) { assert.ok(!BROKEN.test(f.text), f.text); assert.ok(!/\ba [aeio]\w/.test(f.text.replace(/“[^”]*”/g, ' ')), f.text); }
    for (const l of r.track.lines) assert.ok(!BROKEN.test(l.text), l.text);
  });
}

test('casters: two different models are named by the model, spoken by its first word; two setups of one model by the setup', () => {
  const two = (names) => buildScript(...(({ ev, plan }) => [ev, plan, { cls: '32 GB' }])(fixture([], PLAYERS.map((p, i) => ({ ...p, name: names[i] }))))).sheet.players.map((q) => [q.short, q.say]);
  assert.deepEqual(two(NAME_PAIRS[0]), [['Qwen3.8-27B', 'Qwen'], ['DeepSeek-V4.1-Flash', 'DeepSeek']]);
  assert.deepEqual(two(NAME_PAIRS[1]).map((x) => x[0]), ['QuartzRT', 'Zoe kit TP2']);
});

test('casters: the article fits the word', () => {
  for (const [w, s] of [['archer', 'an archer'], ['ram', 'a ram'], ['archery range', 'an archery range'], ['unit', 'a unit'], ['upgrade', 'an upgrade'], ['outpost', 'an outpost'], ['one', 'a one'], ['8B', 'an 8B'], ['27B', 'a 27B']]) assert.equal(withArticle(w), s);
});

test('casters checker: broken words never pass', () => {
  const { sheet, beats } = build(), ctx = makeContext(sheet, beats);
  for (const text of ['The army value is null right now.', 'It has undefined units here.', 'It kills it with a archer.']) assert.ok(checkLine(line({ text }), ctx).reasons.length > 0 || !checkLine(line({ text }), ctx).ok, text);
});

test('plural of game words: barracks stays barracks, one source for all texts', async () => {
  const { pluralOf } = await import('../tools/lib/names.mjs');
  assert.equal(pluralOf('barracks'), 'barracks');
  assert.equal(pluralOf('spearman'), 'spearmen');
  assert.equal(pluralOf('light cavalry'), 'light cavalry');
  assert.equal(pluralOf('archery range'), 'archery ranges');
  for (const f of ['caster-facts', 'caster-story', 'story-data']) {
    const src = fs.readFileSync(new URL(`../tools/${f}.mjs`, import.meta.url), 'utf8');
    assert.ok(!/nice\(t\) \+ 's'/.test(src), `${f} builds its own plural`);
  }
});

test('the win rule in the facts is the rule of the sim: the town center alone does not end a match', () => {
  const src = fs.readFileSync(new URL('../tools/caster-facts.mjs', import.meta.url), 'utf8');
  assert.match(src, /every building that can train units/);
  assert.match(fs.readFileSync(new URL('../sim/game.mjs', import.meta.url), 'utf8'), /if \(!tc && !prod\) return true;/);
});

test('a hand-written line keeps its start second and is said in full', async () => {
  const { normaliseLine } = await import('../tools/casters.mjs');
  const n = normaliseLine({ beat: 1, speaker: 'pbp', when: 'at', text: 'One. Two.', at_s: 4.5, keep: true });
  assert.equal(n.at_s, 4.5);
  assert.equal(n.keep, true);
  assert.equal(n.optional, false);
  assert.equal(normaliseLine({ beat: 1, speaker: 'pbp', when: 'at', text: 'x' }).at_s, undefined);
});

test('the highlight cut uses the show tags of the lines, not only the story cut', () => {
  const src = fs.readFileSync(new URL('../tools/render-broadcast.mjs', import.meta.url), 'utf8');
  assert.match(src, /const show = await showLayer\(/);
  assert.match(src, /subjects: tracks\[cut\]\?\.subjects \?\? \[\], show \}/);
});

test('writer prompt: no beat tells the writer that Dex stays silent (the checker wants him at 30 percent of the words)', () => {
  const src = fs.readFileSync(new URL('../tools/caster-facts.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /Dex stays silent/);
  assert.match(src, /Dex still speaks/);
});

test('hard stop: a written script with replaced, template_dropped or show_invalid lines ends the render before any window or frame', () => {
  const src = fs.readFileSync(new URL('../tools/render-story.mjs', import.meta.url), 'utf8');
  assert.match(src, /SCRIPT STOP: generated\./);
  assert.match(src, /'replaced', 'template_dropped', 'show_invalid'/);
  const pre = fs.readFileSync(new URL('../tools/story-precheck.mjs', import.meta.url), 'utf8');
  assert.match(pre, /\['show_invalid', 'template_dropped', 'replaced'\]/);
});
