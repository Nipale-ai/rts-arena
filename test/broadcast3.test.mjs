import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveSubjects, liveSubject } from '../tools/subjects.mjs';
import { focusPlan } from '../tools/caster-focus.mjs';
import { makeContext, checkLine } from '../tools/caster-check.mjs';
import { aliasesOf } from '../tools/caster-facts.mjs';
import { computeHighlights } from '../tools/highlights.mjs';
import { buildPlan, addSlowMotion, timelineOf } from '../tools/plan.mjs';
import { Director } from '../tools/camera.mjs';

// ---- subjects come from the log: observation + orders + note ----
const OBS = JSON.stringify({
  t: 968, you: 1,
  units: [{ type: 'swordsman', n: 3, xy: [38, 40], ids: '267,271,275' }, { type: 'archer', n: 2, xy: [22, 25], ids: '281,295' }],
  buildings: [{ id: 45, type: 'town_center', xy: [18, 18] }, { id: 236, type: 'stables', xy: [20, 30] }],
  enemy_units: [{ type: 'archer', n: 9, xy: [49, 51], owner: 2, ids: '1,2' }, { type: 'ram', n: 2, xy: [36, 36], owner: 2, ids: '254,262' }],
  enemy_buildings: [{ id: 46, type: 'town_center', xy: [106, 106], owner: 2 }],
});
test('subjects: the thing a decision is about is read from the observation, the orders and the note', () => {
  const a = resolveSubjects(OBS, [{ cmd: 'attack_move', units: 'army', target: 46 }, { cmd: 'note', text: 'Enemy rams pushing my base, send the trio' }], 1);
  assert.equal(a[0].role, 'note');
  assert.deepEqual([a[0].kind, a[0].type, a[0].owner, a[0].ids], ['units', 'ram', 2, [254, 262]], 'the note names the rams');
  assert.ok(a.some((s) => s.role === 'target' && s.kind === 'building' && s.type === 'town_center' && s.owner === 2 && s.bid === 46), 'the attack target by building id');
  assert.ok(a.some((s) => s.role === 'actors' && s.kind === 'army'), 'the ordered army');
  const b = resolveSubjects(OBS, [{ cmd: 'train', building_id: 236, unit_type: 'light_cavalry' }, { cmd: 'note', text: 'More cavalry' }], 1);
  const site = b.find((x) => x.role === 'site');
  assert.deepEqual([site.kind, site.type, site.bid], ['building', 'stables', 236]);
  assert.equal(b[0].role, 'saw', 'without a named thing the enemy group it saw comes first');
  assert.deepEqual(resolveSubjects('not json', [], 1), []);
  // "enemy TC" is the enemy one, a bare TC the model's own
  assert.equal(resolveSubjects(OBS, [{ cmd: 'note', text: 'Full push on enemy TC' }], 1)[0].owner, 2);
  assert.equal(resolveSubjects(OBS, [{ cmd: 'note', text: 'protect the TC' }], 1)[0].owner, 1);
});

test('subjects: live position follows the unit ids in the snapshot, falls back to the logged position', () => {
  const s = { kind: 'units', owner: 2, type: 'ram', ids: [254, 262], x: 36, z: 36 };
  const snap = { units: [[254, 2, 5, 60, 61, 100, 4], [262, 2, 5, 62, 63, 100, 4], [9, 1, 1, 10, 10, 100, 1]], buildings: [] };
  const lv = liveSubject(snap, s, {});
  assert.ok(lv.found && Math.abs(lv.x - 61) < 2 && Math.abs(lv.z - 62) < 2);
  assert.deepEqual([liveSubject({ units: [], buildings: [] }, s, {}).x, liveSubject({ units: [], buildings: [] }, s, {}).found], [36, false]);
});

// ---- aliases: readable names are allowed, invented ones are not ----
const sheet = { game: 'RTS Arena', cls: '32 GB', players: [
  { p: 1, name: 'Qwen3.8-27B NVFP4+MTP3 (QuartzRT)', short: 'QuartzRT', model: 'qwen3.8-27b', hw: '1x RTX 5090 32 GB' },
  { p: 2, name: 'Qwen3.8-27B EXL3 4.0bpw+MTP (Zoe kit TP2)', short: 'Zoe kit TP2', model: 'qwen3.8-27b-exl3-4.0bpw', hw: '2x RTX 5060 Ti 16 GB (TP2)' }].map((q) => ({ ...q, aliases: aliasesOf(q.short) })),
  facts: [{ id: 'f1', kind: 'meta', tick: null, text: 'RTS Arena: two models.', data: {} }, { id: 'f2', kind: 'razed', tick: 100, text: '[00:10, minute 0] Zoe kit TP2 destroys QuartzRT\'s barracks with a ram.', data: {} }],
  casters: undefined, subjects: [{ id: 's1' }], result: { winner: 2, reason: 'victory', time: '10:00' } };
const beats = [{ id: 1, kind: 'razed', anchor: 5, seg0: 4, seg1: 9, tick: 100, tick_end: 200, speed: 1, facts: ['f2'], clock: '00:10', subjects: ['s1'] }];
const ctx = makeContext(sheet, beats);
const L = (text, extra = {}) => ({ beat: 1, speaker: 'pbp', when: 'at', delivery: 'hype', text, facts: ['f2'], opinion: false, interject: false, ...extra });
test('aliases: "Zoe\'s kit" and "QuartzRT" pass, a part of the name alone and invented names do not', () => {
  assert.deepEqual(aliasesOf('Zoe kit TP2'), ['Zoe kit TP2', "Zoe's kit"]);
  assert.deepEqual(aliasesOf('QuartzRT'), ['QuartzRT']);
  assert.deepEqual(aliasesOf('Probe A'), ['Probe A']);
  assert.equal(checkLine(L("Zoe's kit takes down QuartzRT's barracks with a ram!"), ctx).ok, true, JSON.stringify(checkLine(L("Zoe's kit takes down QuartzRT's barracks with a ram!"), ctx)));
  assert.equal(checkLine(L("Zoe kit TP2 takes down QuartzRT's barracks with a ram!"), ctx).ok, true);
  assert.equal(checkLine(L('Zoe takes down the barracks with a ram!'), ctx).ok, false, '"Zoe" alone is not a defined alias');
  assert.equal(checkLine(L('That kit takes down the barracks with a ram!'), ctx).ok, false, '"kit" alone is not a defined alias');
  assert.equal(checkLine(L('Bob takes down the barracks with a ram!'), ctx).ok, false, 'invented names stay forbidden');
  assert.equal(checkLine(L("Zoe's kit takes down the barracks!", { subject: 's9' }), ctx).ok, false, 'a subject must be one of the beat');
  assert.equal(checkLine(L("Zoe's kit takes down the barracks!", { subject: 's1' }), ctx).ok, true);
});

// ---- focus plan and the director ----
const subjects = [
  { id: 's1', kind: 'building', owner: 1, type: 'town_center', x: 18, z: 18, ids: [], bid: null },
  { id: 's2', kind: 'building', owner: 2, type: 'town_center', x: 106, z: 106, ids: [], bid: null },
  { id: 's3', kind: 'units', owner: 2, type: 'ram', x: 60, z: 60, ids: [254], bid: null },
  { id: 's4', kind: 'fight', owner: 0, type: 'battle', x: 50, z: 55, ids: [], bid: null },
];
const FBEATS = [{ id: 1, subjects: ['s1'] }, { id: 2, subjects: ['s3'] }];
test('focus plan: contiguous segments, a subject stays on screen long enough, the camera leaves before the line starts', () => {
  const lines = [
    { id: 'L1', beat: 1, start: 0.5, end: 4, subject: 's1' }, { id: 'L2', beat: 1, start: 4.2, end: 5.0, subject: 's2' }, // too short to cut to
    { id: 'L3', beat: 2, start: 5.2, end: 9, subject: 's3' }, { id: 'L4', beat: 2, start: 9.3, end: 10, subject: 's3', interject: true },
    { id: 'L5', beat: 2, start: 12, end: 16, subject: 's4' }, { id: 'L6', beat: 2, start: 16.2, end: 19.5, subject: 's2' },
  ];
  const fp = focusPlan(lines, FBEATS, { subjects }, 20);
  assert.equal(fp[0].o0, 0); assert.equal(fp.at(-1).o1, 20);
  for (let i = 0; i + 1 < fp.length; i++) assert.ok(Math.abs(fp[i].o1 - fp[i + 1].o0) < 1e-9, 'contiguous');
  for (const s of fp) if (s.o1 !== 20) assert.ok(s.o1 - s.o0 >= 2.55, `dwell ${s.o1 - s.o0}`);
  const s4 = fp.find((s) => s.subject === 's4'), s2 = fp.find((s) => s.subject === 's2');
  assert.ok(s4.o0 < 12 && s4.o0 >= 12 - 2, 'the camera heads to the fight a little before the line');
  assert.ok(s2, 'the closing subject is shown');
});

const fakeEv = { version: 1, replay: 'syn', ticks: 18000, tick_hz: 10, seconds: 1800, players: [{ id: 1, name: 'A', kind: 'llm' }, { id: 2, name: 'B', kind: 'bot' }],
  events: [{ t: 18000, type: 'victory', winner: 2, winner_team: 2, reason: 'victory', id: 7 }],
  series: { army: [new Array(1801).fill(0), new Array(1801).fill(0)], lost: [[], []], fighting: [new Array(1801).fill(0), new Array(1801).fill(0)], destroyed: new Array(1801).fill(0), focus_x: new Array(1801).fill(null), focus_y: new Array(1801).fill(null), focus_spread: new Array(1801).fill(null) } };
const snapAt = (out) => ({ units: [[254, 2, 5, 40 + out * 0.8, 40 + out * 0.8, 100, 1, 0, 0, 0], [3, 1, 1, 22, 22, 100, 1, 0, 0, 0]], buildings: [[500, 1, 5, 20, 26, 100, 100, 0]] });
function runDirector(focus, seconds = 24) {
  const plan = buildPlan(fakeEv, computeHighlights(fakeEv), { mode: 'highlight', target_s: [20, 40] });
  const tl = timelineOf(plan);
  const d = new Director({ size: 128, starts: [{ tx: 18, ty: 18 }, { tx: 106, ty: 106 }], aspect: 1.05, scenes: plan.scenes, timeline: tl, events: fakeEv.events, focus, subjects });
  const out = [];
  for (let f = 0; f < seconds * 60; f++) out.push({ t: f / 60, ...d.update(f / 60, 1 / 60, snapAt(f / 60)), key: d.cur.key, mode: d.mode });
  return out;
}
test('director: the camera goes to the subject of the caster line before it starts and holds it while it is discussed', () => {
  const focus = [{ o0: 0, o1: 6, subject: 's1' }, { o0: 6, o1: 15, subject: 's3' }, { o0: 15, o1: 24, subject: 's2' }];
  const out = runDirector(focus);
  const at = (t) => out[Math.round(t * 60)];
  assert.ok(Math.hypot(at(5.9).tx - 18, at(5.9).tz - 18) < 6, 'on the first base');
  const ram = (t) => 40 + t * 0.8;
  assert.ok(Math.hypot(at(11).tx - ram(11), at(11).tz - ram(11)) < 8, `on the (moving) ram at 11 s: ${at(11).tx}`);
  assert.ok(Math.hypot(at(14.5).tx - ram(14.5), at(14.5).tz - ram(14.5)) < 8, 'holds it until the line is done');
  assert.ok(Math.hypot(at(23.5).tx - 106, at(23.5).tz - 106) < 8, 'then flies to the enemy base');
  assert.ok(out.filter((c) => c.t > 1).every((c) => c.mode === 'talk' || c.mode === 'collapse'), 'the talk drives the camera');
});
test('director: smooth. no hard cut on a 100 tile flight, no jumps, no sudden rotation, low side-on view', () => {
  const focus = [{ o0: 0, o1: 5, subject: 's1' }, { o0: 5, o1: 14, subject: 's2' }, { o0: 14, o1: 20, subject: 's3' }, { o0: 20, o1: 24, subject: 's1' }];
  const out = runDirector(focus);
  let maxStep = 0, maxAz = 0, maxHor = 0;
  for (let i = 1; i < out.length; i++) {
    const a = out[i - 1], b = out[i];
    maxStep = Math.max(maxStep, Math.hypot(b.tx - a.tx, b.tz - a.tz));
    maxAz = Math.max(maxAz, Math.abs(b.az - a.az));
    maxHor = Math.max(maxHor, Math.abs(b.pol - a.pol));
  }
  assert.ok(maxStep < 2.2, `largest look-at step per frame ${maxStep} tiles (130 tiles per second would be a cut)`);
  assert.ok(maxAz < 0.012, `rotation per frame ${maxAz}`);
  assert.ok(maxHor < 0.006, `pitch per frame ${maxHor}`);
  for (const c of out) { const e = 90 - (c.pol * 180) / Math.PI; assert.ok(e <= 35.01 && e >= 8, `elevation ${e}`); }
});
test('director: a hard cut only when the next subject is very far away (and never otherwise)', () => {
  const near = [{ o0: 0, o1: 5, subject: 's1' }, { o0: 5, o1: 24, subject: 's4' }];
  const far = [{ o0: 0, o1: 5, subject: 's1' }, { o0: 5, o1: 24, subject: 's2' }];
  const jumps = (out) => { let n = 0; for (let i = 1; i < out.length; i++) if (Math.hypot(out[i].tx - out[i - 1].tx, out[i].tz - out[i - 1].tz) > 4) n++; return n; };
  assert.equal(jumps(runDirector(near)), 0);
  assert.equal(jumps(runDirector(far)), 0, 'the base to base flight (about 120 tiles) is flown, not cut');
});

// ---- smooth time scale ----
test('plan: the time scale is eased in and out around a key decision (no sudden jump of the game speed)', () => {
  const ev = { replay: 'x', ticks: 6000 };
  const hl = { scenes: [{ id: 1, rank: 1, start: 5000, end: 5900, kind: 'victory', title: '', focus: null, score: 5 }] };
  const plan = addSlowMotion(buildPlan(ev, hl, { mode: 'highlight' }), [{ id: 2, p: 1, t: 2000, score: 9, focus: { x: 30, y: 20, what: 'enemy' } }]);
  const tl = timelineOf(plan);
  // the game speed the viewer sees is the speed of the tick clock: measured over 0.1 s windows, ln(speed) never changes by more than 0.35 per 0.1 s
  let maxD = 0, prev = null;
  const v = (t) => (tl.tickAt(t + 0.1) - tl.tickAt(t)) / 0.1;
  for (let t = 0; t + 0.2 < tl.body_s; t += 1 / 60) { const l = Math.log(v(t)); if (prev !== null) maxD = Math.max(maxD, Math.abs(l - prev)); prev = l; }
  assert.ok(maxD < 0.06, `ln(speed) changes by at most ${maxD} per frame`);
  assert.ok(Math.abs(Math.log(v(0.5) / v(0.55))) < 0.06);
  // and the ramps take their time: 1x -> slow motion (0.9x to 0.4x) at least 0.6 s, slow motion -> fast (0.5x to 12x) at least 1.5 s
  const first = (pred, from = 0) => { let t = from; while (t < tl.body_s && !pred(tl.speedAtOut(t))) t += 1 / 60; return t; };
  const a = first((s) => s < 0.9, first((s) => s > 0.99, 5)), bb = first((s) => s < 0.4, a);
  assert.ok(bb - a > 0.6, `ramp into the slow motion ${bb - a} s`);
  const c = first((s) => s > 0.5, bb), d = first((s) => s > 12, c);
  assert.ok(d - c > 1.5, `ramp out of the slow motion ${d - c} s`);
});

// ---- the delivered script ----
test('script: the delivered caster track talks almost all the time at 2.3 to 2.8 words per second, every line has a subject', () => {
  const f = new URL('../render/screenshots/w3-h-2610/s101-highlight-casters.json', import.meta.url);
  if (!fs.existsSync(f)) return;
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.ok(j.stats.words_per_s >= 2.2 && j.stats.words_per_s <= 2.8, `words per second ${j.stats.words_per_s}`);
  assert.ok(j.stats.talk_fraction >= 0.8, `talk fraction ${j.stats.talk_fraction}`);
  assert.ok(j.stats.longest_gap_s <= 3, `longest silence ${j.stats.longest_gap_s}`);
  assert.ok(j.lines.every((l) => l.subject), 'every line names its subject');
  assert.ok(j.lines.some((l) => /plan here: “/.test(l.text)), 'a note is quoted naturally');
  assert.ok(!j.lines.some((l) => /Its note/.test(l.text)), 'no robotic phrasing');
});

test('subjects: a bare building word in a note is not the enemy one', () => {
  const o = JSON.stringify({ t: 900, you: 2, units: [], buildings: [{ id: 5, type: 'town_center', xy: [70, 70] }], enemy_units: [], enemy_buildings: [{ id: 9, type: 'farm', xy: [20, 20], owner: 1 }] });
  assert.ok(!resolveSubjects(o, [{ cmd: 'note', text: 'Shift 6 to wood to resolve held farm' }], 2).some((s) => s.role === 'note' && s.owner === 1));
  assert.equal(resolveSubjects(o, [{ cmd: 'note', text: 'Burn their farm next' }], 2).find((s) => s.role === 'note')?.owner, 1);
});
