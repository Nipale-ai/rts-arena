import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { takeKey, scoreTake, pickBest, placeTakes, cueTimes, applyVoices, boothIR, convolve, gateTrim, scriptHash, glossaryOf, expandPauses, loadVoices, maxNewTokens, toSrt, MAX_LATE_S, SR } from '../tools/caster-voice.mjs';

const voice = { ref_hash: 'abc' };
const entry = { id: 'L1', voice: 'caster_a', text_tts: '[roaring] Hello there!', expected_s: 3, accept_take_s: [1, 7], slot_s: 4 };
const good = { key: 'k', dur: 3.2, lead_s: 0.04, trail_s: 0.1, longest_silence_s: 0.2, rms_db: -22, clip_frac: 0, clicks: 0, wer_soft: 0, ref_words: 6, heard: 'Hello there', f0: 200, ref_f0: 220, tail_after_speech_s: 0.2, first_word_s: 0.1 };

test('take cache key: stable, and it changes with voice reference, text, prefix, sampling and take index', () => {
  const k = takeKey(voice, entry, 0);
  assert.equal(k, takeKey(voice, entry, 0));
  assert.notEqual(k, takeKey(voice, entry, 1));
  assert.notEqual(k, takeKey({ ref_hash: 'def' }, entry, 0));
  assert.notEqual(k, takeKey(voice, { ...entry, text_tts: '[calm] Hello there!' }, 0));
  assert.notEqual(k, takeKey(voice, entry, 0, { temperature: 0.7, top_p: 0.9, top_k: 100, repetition_penalty: 1 }));
  assert.equal(k, takeKey(voice, { ...entry, start_s: 99, expected_s: 9 }, 0), 'placement does not change the take');
});

test('max_new_tokens: 2.5x the expected length at 21.5 frames/s, between 150 and 700', () => {
  assert.equal(maxNewTokens({ expected_s: 5 }), Math.round(2.5 * 5 * 21.5));
  assert.equal(maxNewTokens({ expected_s: 0.37 }), 150);
  assert.equal(maxNewTokens({ expected_s: 40 }), 700);
});

test('take checks: each failure has its own reason, a good take passes', () => {
  assert.equal(scoreTake(good, entry).ok, true);
  const f = (o) => scoreTake({ ...good, ...o }, entry);
  assert.match(f({ dur: 9 }).fails[0], /duration/);
  assert.match(f({ rms_db: -50 }).fails[0], /quiet/);
  assert.match(f({ longest_silence_s: 1.4 }).fails[0], /silence/);
  assert.match(f({ clip_frac: 0.01 }).fails[0], /clipping/);
  assert.match(f({ clicks: 9 }).fails[0], /clicks/);
  assert.match(f({ wer_soft: 0.4 }).fails[0], /WER/);
  assert.match(f({ tail_after_speech_s: 2 }).fails[0], /after the last word/);
  assert.match(f({ f0: 800 }).fails[0], /pitch/);
  assert.equal(scoreTake({ error: 'HTTP 500' }, entry).ok, false);
  assert.equal(scoreTake({ ...good, wer_soft: 0.4, ref_words: 1 }, entry).ok, true, 'a one-word interjection may be off by half');
});

test('best take: a passing take beats a better-scored failing one; the one that fits the slot wins', () => {
  const mk = (index, m) => ({ index, key: 'k' + index, res: scoreTake({ ...good, ...m }, entry) });
  const a = mk(0, { wer_soft: 0.5 }), b = mk(1, { dur: 3.9 }), c = mk(2, { dur: 6.5 });
  assert.equal(pickBest([a, b, c]).index, 1);
  assert.ok(c.res.soft.some((s) => s.startsWith('overlong')));
});

test('timing: a take is never stretched; a longer take pushes the next lines, every change is reported', () => {
  const lines = [
    { id: 'A', planned: 0.5, latest_end: 5, dur: 4.6 },        // slot until 4.9: ends at 5.1, pushes B by 0.2 s
    { id: 'B', planned: 5.0, latest_end: 9, dur: 3.5 },        // starts at 5.2, ends at 8.7
    { id: 'C', planned: 9.1, latest_end: 12, dur: 2.0 },       // room again: stays at 9.1
    { id: 'I', planned: 6.0, latest_end: 7, dur: 0.4, interject: true },
  ];
  const { placed, changes } = placeTakes(lines);
  const p = Object.fromEntries(placed.map((x) => [x.id, x]));
  for (const x of placed) assert.equal(x.stretch, 1, `${x.id} is not stretched`);
  assert.equal(p.A.end, 5.1);
  assert.equal(p.B.start, 5.2);
  assert.equal(p.B.end, 8.7);
  assert.equal(p.C.start, 9.1);
  assert.equal(p.I.start, 6.2, 'interjection follows B');
  assert.ok(changes.some((c) => c.id === 'B' && c.kind === 'nudge' && c.seconds === 0.2));
  assert.ok(!changes.some((c) => c.kind === 'time-stretch'));
  assert.ok(!changes.some((c) => c.kind === 'late'));
});

test('timing: a main line more than MAX_LATE_S after its planned start is reported as late', () => {
  const { placed, changes } = placeTakes([{ id: 'A', planned: 0, latest_end: 2, dur: 3 }, { id: 'B', planned: 1, latest_end: 4, dur: 1 }]);
  const b = placed.find((x) => x.id === 'B');
  assert.ok(b.nudge_s > MAX_LATE_S);
  assert.ok(changes.some((c) => c.id === 'B' && c.kind === 'late'));
});

test('no voice tool speeds up or slows down a take (a time-stretch made the voices sound robotic)', () => {
  for (const f of ['tools/caster-voice.mjs', 'tools/caster-voice-post.mjs', 'tools/video-voices.mjs']) {
    const src = fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    assert.ok(!/rubberband|atempo|stretchSamples/.test(src), `${f} has no time-stretch`);
  }
});

test('timing: a short take is not moved and not stretched; no overlap between main lines', () => {
  const { placed, changes } = placeTakes([{ id: 'A', planned: 1, latest_end: 5, dur: 2 }, { id: 'B', planned: 5.1, latest_end: 8, dur: 2 }]);
  assert.deepEqual(placed.map((p) => [p.start, p.stretch, p.nudge_s]), [[1, 1, 0], [5.1, 1, 0]]);
  assert.equal(changes.length, 0);
});

test('interjection follows the shift of the line it sits in', () => {
  const { placed } = placeTakes([{ id: 'A', planned: 1, latest_end: 3, dur: 1.5 }, { id: 'B', planned: 3.0, latest_end: 8, dur: 4 }, { id: 'I', planned: 4, latest_end: 5, dur: 0.4, interject: true }, { id: 'X', planned: 0.2, latest_end: 1, dur: 0.1, interject: true }]);
  const p = Object.fromEntries(placed.map((x) => [x.id, x]));
  assert.equal(p.I.start, 4 + p.B.nudge_s);
});

test('captions follow the real take: cue boundaries by word share, first cue starts at the line, last ends with it', () => {
  const cues = [{ s0: 0, s1: 1, text: 'One two three.' }, { s0: 1, s1: 2, text: 'Four five six.' }];
  const words = ['One', 'two', 'three', 'Four', 'five', 'six'].map((w, i) => ({ w, s: 0.1 + i * 0.5, e: 0.5 + i * 0.5 }));
  const t = cueTimes(cues, words, { offset: 0.1, stretch: 1, start: 10, end: 13.2 });
  assert.equal(t[0].s0, 10); assert.equal(t[1].s1, 13.2);
  assert.ok(Math.abs(t[0].s1 - 11.5) < 1e-6 && t[1].s0 === t[0].s1);
  const srt = toSrt([{ ...t[0], name: 'Dex' }]);
  assert.match(srt, /00:00:10,000 --> 00:00:11,500\nDex: One two three\./);
});

test('applyVoices: lines and captions get the real times; lines without a voice are removed', () => {
  const track = { casters: { pbp: { short: 'Dex', role: 'pbp', color: '#fff' } }, lines: [{ id: 'L1', speaker: 'pbp', start: 1, end: 2, delivery: 'hype', cues: [{ s0: 1, s1: 2, text: 'Hi' }] }, { id: 'L2', speaker: 'pbp', start: 3, end: 4, delivery: 'hype', cues: [{ s0: 3, s1: 4, text: 'Bye' }] }], cues: [] };
  const v = applyVoices(track, { wav: 'x.wav', lines: [{ id: 'L1', start: 1.4, end: 3.1, cues: [{ s0: 1.4, s1: 3.1, text: 'Hi' }] }] });
  assert.equal(v.lines.length, 1); assert.equal(v.lines[0].start, 1.4); assert.equal(v.cues[0].s0, 1.4); assert.deepEqual(v.voice.removed, ['L2']);
});

test('booth: impulse response is deterministic, the same for both voices, and convolution with an impulse is the identity', () => {
  const a = boothIR(), b = boothIR();
  assert.deepEqual(Array.from(a[0].slice(0, 2000)), Array.from(b[0].slice(0, 2000)));
  const e = a[0].reduce((s, v) => s + v * v, 0); assert.ok(Math.abs(e - 1) < 1e-3);
  const x = new Float32Array(30000).map((_, i) => Math.sin(i * 0.01)), id = new Float32Array(10); id[0] = 1;
  const y = convolve(x, id); let err = 0; for (let i = 0; i < x.length; i++) err = Math.max(err, Math.abs(x[i] - y[i])); assert.ok(err < 1e-4);
  const h = new Float32Array(300); h[250] = 0.5; const z = convolve(x, h); assert.ok(Math.abs(z[1000] - 0.5 * x[750]) < 1e-4);
});

test('trim: silence at both ends goes, a little room stays, fades are applied', () => {
  const n = SR * 3, x = new Float32Array(n); for (let i = SR; i < 2 * SR; i++) x[i] = 0.3 * Math.sin(i * 0.2);
  const { y, offset_s } = gateTrim(x);
  assert.ok(y.length / SR > 1.1 && y.length / SR < 1.3 && offset_s > 0.9 && offset_s < 1);
  assert.equal(y[0], 0); assert.ok(Math.abs(y[y.length - 1]) < 1e-3);
});

test('script hash covers text and voice, not timing; glossary finds names and codes', () => {
  const e = [{ id: 'L1', voice: 'caster_a', text_tts: '[x] Hi', start_s: 1 }];
  assert.equal(scriptHash(e), scriptHash([{ ...e[0], start_s: 5 }]));
  assert.notEqual(scriptHash(e), scriptHash([{ ...e[0], text_tts: '[x] Hey' }]));
  const g = glossaryOf([{ text: 'QuartzRT on one RTX 5090, Zoe kit TP2 wins.' }]);
  for (const w of ['QuartzRT', 'RTX', 'TP2', 'Zoe kit']) assert.ok(g.includes(w), w);
});

test('applyVoices: camera focus segments move with the real start of their line', () => {
  const track = { casters: { pbp: { short: 'Dex', role: 'pbp', color: '#fff' } }, focus: [{ o0: 0, o1: 5, line: 'L1' }, { o0: 5, o1: 9, line: 'L2' }, { o0: 9, o1: 12, line: 'L3' }],
    lines: ['L1', 'L2', 'L3'].map((id, i) => ({ id, speaker: 'pbp', start: i * 4, end: i * 4 + 3, delivery: 'calm', cues: [] })), cues: [] };
  const v = applyVoices(track, { wav: 'x.wav', lines: [{ id: 'L1', start: 0, end: 5, planned_start: 0 }, { id: 'L2', start: 6, end: 9, planned_start: 5 }, { id: 'L3', start: 9, end: 11, planned_start: 9 }] });
  assert.deepEqual(v.focus.map((f) => [f.o0, f.o1]), [[0, 6], [6, 9], [9, 12]]);
});

test('noise check: a hazy take (HF haze behind the vowels) fails, a clean one does not; livelier takes score higher', () => {
  const clean = { ...good, haze_db: -34, e_f0_std_st: 3.3, e_loud_dyn_db: 20, e_onset_rate: 3.2 };
  assert.equal(scoreTake(clean, entry).ok, true);
  const hazy = scoreTake({ ...clean, haze_db: -24 }, entry);
  assert.equal(hazy.ok, false); assert.match(hazy.fails[0], /haze/);
  const flat = scoreTake({ ...clean, e_f0_std_st: 1.5, e_onset_rate: 2.2, e_loud_dyn_db: 14 }, entry);
  const lively = scoreTake({ ...clean, e_f0_std_st: 4.5, e_onset_rate: 3.8, e_loud_dyn_db: 24 }, entry);
  assert.ok(lively.score > flat.score + 8, `lively ${lively.score} flat ${flat.score}`);
  assert.ok(scoreTake({ ...clean, haze_db: -37 }, entry).score > scoreTake({ ...clean, haze_db: -29 }, entry).score, 'cleaner is better');
});

test('quality gate: a noise floor above -60 dBFS, hiss in the pauses or hum fail a take; the gate pulls pauses down and keeps the words', () => {
  const clean = { ...good, n_floor_db: -66, n_pause_hf_db: -70, n_hum_db: 1 };
  assert.equal(scoreTake(clean, entry).ok, true);
  assert.match(scoreTake({ ...clean, n_floor_db: -52 }, entry).fails[0], /noise floor/);
  assert.match(scoreTake({ ...clean, n_pause_hf_db: -50 }, entry).fails[0], /hiss/);
  assert.match(scoreTake({ ...clean, n_hum_db: 12 }, entry).fails[0], /hum/);
  const n = SR * 2, x = new Float32Array(n); let s = 7;
  for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; const noise = ((s / 0x7fffffff) * 2 - 1) * 0.002; x[i] = noise + (i > SR * 0.5 && i < SR * 1.2 ? 0.3 * Math.sin(i * 0.15) : 0); }
  const y = expandPauses(x), rms = (a, f, t) => { let e = 0; for (let i = Math.round(f * SR); i < Math.round(t * SR); i++) e += a[i] * a[i]; return 10 * Math.log10(e / ((t - f) * SR) + 1e-14); };
  assert.ok(rms(x, 0.1, 0.4) - rms(y, 0.1, 0.4) > 15, 'the pause before the word is pulled down');
  assert.ok(rms(x, 1.6, 1.9) - rms(y, 1.6, 1.9) > 15, 'the pause after the word is pulled down');
  assert.ok(Math.abs(rms(x, 0.7, 1.0) - rms(y, 0.7, 1.0)) < 0.5, 'the word stays untouched');
});

test('reference cleaning: a cleaned reference changes the voice identity (new server name, new take keys); without cleaning the original is used', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-'));
  const mk = (d) => { fs.mkdirSync(d, { recursive: true }); const n = 44100; const b = Buffer.alloc(44 + n * 2); b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(44100, 24); b.writeUInt32LE(88200, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40); for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin(i * 0.05)), 44 + 2 * i); fs.writeFileSync(path.join(d, 'referenz.wav'), b); fs.writeFileSync(path.join(d, 'transkript.txt'), 'hello there'); };
  mk(path.join(dir, 'a')); const cache = path.join(dir, 'cache');
  const raw = loadVoices(null, ['caster_a'], { overrides: { caster_a: path.join(dir, 'a') }, clean: false }).caster_a;
  const cl = loadVoices(null, ['caster_a'], { overrides: { caster_a: path.join(dir, 'a') }, clean: true, cacheDir: cache }).caster_a;
  assert.equal(raw.server, 'caster_a'); assert.equal(raw.cleaned, false);
  assert.match(cl.server, /^caster_a_c1_/); assert.equal(cl.cleaned, true); assert.ok(fs.existsSync(cl.ref_wav));
  assert.notEqual(takeKey(raw, entry, 0), takeKey(cl, entry, 0));
});
