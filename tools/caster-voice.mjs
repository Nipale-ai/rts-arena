#!/usr/bin/env node
// Voice track helpers for the casters: take cache keys, checks and scoring, timing, captions, booth reverb, polish chain.
// Used by tools/video-voices.mjs (the "Make video" voice path). Voice references are folders with referenz.wav + transkript.txt (see Settings > Voices).
import '../server/local-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SR = 48000;
// A2: Drama 3 (sglang-omni) rejects "seed" ("seed is not supported by this model", checked 05.11.2026): consistency comes from the fixed prefixes plus the pitch gate in scoreTake.
export const SAMPLING = { temperature: Number(process.env.RTS_TTS_TEMP) || 1.0, top_p: Number(process.env.RTS_TTS_TOP_P) || 0.9, top_k: 100, repetition_penalty: 1.0 }; // A2: RTS_TTS_TEMP lowers the pitch spread between takes
export const MODEL_ID = 'darioooooo0o/drama-3-w4a16-32gb@8061bada';
// A take is never time-stretched. Every stretch, even 3 %, made the voice rougher (harmonic-to-noise ratio down 0.4 to 1.7 dB on every line
// measured, 02.11.2026), and the owner heard those lines as robotic. A take that runs past its slot pushes the next lines a little later.
// FIT_TOLERANCE: in the take score a take up to 6 % longer than its slot still counts as fitting (it then moves the next line a little).
// MAX_LATE_S: a main line may start at most this much after its planned start; more stops the voice track (the line is too long for its picture).
export const FIT_TOLERANCE = 1.06, GAP = 0.1, MAX_LATE_S = Number(process.env.RTS_MAX_LATE_S) || 1.5; // A2: Drama 3 at temperature 0.6 speaks a little slower than planned; RTS_MAX_LATE_S raises the limit (reported)
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const db2g = (d) => Math.pow(10, d / 20);

// ---------------------------------------------------------------- voices
// The reference folders are not part of the repo. Env RTS_VOICES_DIR is a base folder that holds caster_a/ and caster_b/ (each with referenz.wav and
// transkript.txt); without it the default is empty and a folder is set per voice under Settings > Voices (or --voice). No folder = captions-only video.
const VOICES_BASE = process.env.RTS_VOICES_DIR || '';
const VOICE_SUB = { caster_a: 'caster_a', caster_b: 'caster_b' };
export const VOICE_DIRS = Object.fromEntries(Object.entries(VOICE_SUB).map(([n, sub]) => [n, VOICES_BASE ? `${VOICES_BASE}/${sub}` : '']));
export const DEFAULT_VOICES_DIR = null;
// A reference with noise gives noisy takes (Drama 3 clones the noise). Every reference gets a gentle spectral denoise first (afftdn, tracked
// noise floor, measured: floor -50 -> -61 dBFS, haze -27 -> -35 dB, the long-term spectrum moves by less than 1 dB) and is registered under a new
// server name (<voice>_c1), so the takes of the cleaned voice never mix with the old ones.
export const REF_CLEAN = 'highpass=f=70,afftdn=nr=12:nf=-55:tn=1:tr=1,lowpass=f=15500';
export const REF_CLEAN_VERSION = 'c1';
// overrides: { caster_b: '/path/to/folder with referenz.wav + transkript.txt' }
export function loadVoices(dir, names = Object.keys(VOICE_DIRS), { overrides = {}, clean = true, cacheDir = null } = {}) {
  const v = {};
  for (const n of names) {
    const d = overrides[n] ? path.resolve(overrides[n]) : dir ? path.join(dir, path.basename(VOICE_SUB[n])) : VOICE_DIRS[n];
    if (!d) throw new Error(`no reference folder for voice ${n}: pass --voice ${n}=<dir> or set RTS_VOICES_DIR`);
    const orig = path.join(d, 'referenz.wav'), text = fs.readFileSync(path.join(d, 'transkript.txt'), 'utf8').trim();
    const origHash = sha(fs.readFileSync(orig).toString('base64') + '\n' + text).slice(0, 16);
    let wav = orig, server = n, hash = origHash;
    if (clean && cacheDir) {
      const cdir = path.join(cacheDir, 'refs-clean'); fs.mkdirSync(cdir, { recursive: true });
      wav = path.join(cdir, `${n}-${origHash}-${REF_CLEAN_VERSION}.wav`);
      if (!fs.existsSync(wav)) {
        const r = spawnSync('ffmpeg', ['-nostdin', '-y', '-loglevel', 'error', '-i', orig, '-af', REF_CLEAN, '-ac', '1', '-c:a', 'pcm_s16le', wav], { encoding: 'utf8' });
        if (r.status !== 0) throw new Error('reference denoise failed: ' + r.stderr.slice(0, 300));
      }
      server = `${n}_${REF_CLEAN_VERSION}_${origHash.slice(0, 6)}`; hash = sha(origHash + REF_CLEAN + REF_CLEAN_VERSION).slice(0, 16);
    }
    v[n] = { name: n, server, dir: d, orig_wav: orig, ref_wav: wav, ref_text: text, ref_hash: hash, cleaned: wav !== orig };
  }
  return v;
}

// ---------------------------------------------------------------- cache keys and request specs
export const takeKey = (voice, e, index, sampling = SAMPLING) => sha(JSON.stringify([MODEL_ID, voice.ref_hash, e.voice, e.text_tts, sampling, index])).slice(0, 20);
export const maxNewTokens = (e) => Math.round(clamp(2.5 * (e.expected_s || 3) * 21.5, 150, 700));
export function glossaryOf(entries) { // words an ASR cannot know: names, codes (TP2, RTX), internal capitals
  const g = new Set(['Dex Harlan', 'Juno Quill', 'RTS Arena']);
  for (const e of entries) {
    for (const w of String(e.text).split(/\s+/)) { const t = w.replace(/^[^\w]+|[^\w]+$/g, ''); if (/[A-Z]/.test(t.slice(1)) || (/\d/.test(t) && /[A-Za-z]/.test(t))) g.add(t); }
    for (const m of String(e.text).matchAll(/\b([A-Z][a-z]+ kit)\b/g)) g.add(m[1]);
  }
  return [...g];
}

// ---------------------------------------------------------------- checks and scoring (pure)
// 07.11.: the noise floor is the quietest part of the pauses; a take with fewer than 15 pause frames has no real pause, the value then measures speech tails, not noise (83 % of such takes were flagged noisy, 10 % of takes with 30+ frames): judge and denoise it only with enough pause frames
export const floorTrusted = (m) => m == null || m.n_pause_frames == null || m.n_pause_frames >= 15;
export const LIMITS = { floorFail: -60, hissFail: -55, humFail: 8, werMax: 0.25, werMaxShort: 0.5, quietDb: -45, silenceS: 0.9, clipFrac: 0.001, clicksFail: 6, tailS: 1.5, leadS: 1.2, f0Octaves: 1.7, hazeFail: -26, f0St: 2.5 };
if (process.env.RTS_CLEAN === '1') Object.assign(LIMITS, { floorFail: -64, humFail: 5, hazeFail: -34 }); // 07.11.: a take that needs denoise or dehaze (the post-processing thresholds) does not pass: more rerolls until a clean one exists
if (process.env.RTS_F0ST) LIMITS.f0St = +process.env.RTS_F0ST; // 07.11.: narrower pitch window around the voice target (neighbour jumps)
// slot_s: how long the line may be (up to the next main line); fit: effective spoken length against the slot
export function sylCount(text) { // vowel-group estimate; digits count about half their length plus one
  let n = 0;
  for (const w of text.match(/[A-Za-z']+|\d+/g) || []) {
    if (/^\d+$/.test(w)) { n += w.length >= 3 ? w.length + 1 : w.length === 2 ? 2 : 1; continue; } // spoken digits: 88 = eighty-eight, 6840 about eight syllables
    if (/^[A-Z]{2,}$/.test(w) && !/[AEIOU]/.test(w)) { n += w.length; continue; } // spelled-out acronym (GLM = G L M)
    const lw = w.toLowerCase(); let k = (lw.match(/[aeiouy]+/g) || []).length;
    if (lw.endsWith('e') && !/(le|ee)$/.test(lw) && k > 1) k--;
    n += Math.max(1, k);
  }
  return n;
}
export function effectiveLen(m) { return Math.max(0.1, m.dur - Math.max(0, m.lead_s - 0.03) - Math.max(0, m.trail_s - 0.1)); }
export function scoreTake(m, e, opt = {}) {
  const L = { ...LIMITS, ...opt };
  const fails = [], soft = [];
  if (!m || m.error) return { ok: false, score: -1e3, fails: [m?.error || 'no metrics'], soft, hard: true };
  const [lo, hi] = e.accept_take_s || [0, 1e9];
  if (m.dur < lo || m.dur > hi) fails.push(`duration ${m.dur.toFixed(2)} s outside ${lo}-${hi} s`);
  if (m.rms_db < L.quietDb) fails.push(`too quiet (${m.rms_db} dB)`);
  if (m.longest_silence_s > L.silenceS) fails.push(`long silence ${m.longest_silence_s} s`);
  if (m.clip_frac > L.clipFrac) fails.push(`clipping ${(m.clip_frac * 100).toFixed(2)} %`);
  if (m.clicks > L.clicksFail) fails.push(`${m.clicks} clicks`);
  const wmax = (m.ref_words || 9) <= 3 ? L.werMaxShort : L.werMax;
  if (m.wer_soft > wmax) fails.push(`read-back WER ${m.wer_soft} > ${wmax} ("${m.heard}")`);
  if (m.tail_after_speech_s != null && m.tail_after_speech_s > L.tailS) fails.push(`${m.tail_after_speech_s} s of sound after the last word`);
  if (m.first_word_s != null && m.first_word_s > L.leadS) fails.push(`first word only at ${m.first_word_s} s`);
  if (m.f0 && m.ref_f0) { const oct = Math.abs(Math.log2(m.f0 / m.ref_f0)); if (oct > L.f0Octaves) fails.push(`pitch ${m.f0} Hz vs reference ${m.ref_f0} Hz`); }
  // 07.11. (owner): natural tempo. RTS_TEMPO="A,B" = target words per second of caster_a / caster_b; a take more than 20 % away from it fails (lines of fewer than 4 words excepted). RTS_F0ST narrows the pitch window so neighbours differ by at most about 3 semitones.
  // 07.11. (Koordinator): tempo in syllables per second (long model names make words/s unfair); target = the speaker's own median in the approved HC-3 takes, +-20 %
  if (process.env.RTS_TEMPO_SYL && e.words >= 4 && !e.interject) {
    const [ta, tb] = process.env.RTS_TEMPO_SYL.split(',').map(Number), tg = e.voice === 'caster_b' ? tb : ta, rate = sylCount(e.text || '') / effectiveLen(m);
    if (tg && Math.abs(rate / tg - 1) > 0.2) fails.push(`tempo ${rate.toFixed(1)} syllables/s, target ${tg} +-20 %`);
  }
  if (process.env.RTS_TEMPO && !process.env.RTS_TEMPO_SYL && e.words >= 4 && !e.interject) {
    const [ta, tb] = process.env.RTS_TEMPO.split(',').map(Number), tg = e.voice === 'caster_b' ? tb : ta, rate = e.words / effectiveLen(m);
    if (tg && Math.abs(rate / tg - 1) > 0.2) fails.push(`tempo ${rate.toFixed(1)} words/s, target ${tg} +-20 %`);
  }
  if (m.f0 && m.f0_target) { const sst = 12 * Math.log2(m.f0 / m.f0_target), st = Math.abs(sst), excited = ['hype', 'laugh', 'tense'].includes(e.delivery) || /!\s*$/.test(e.text || ''); if (excited ? (sst > 5 || sst < -L.f0St) : st > L.f0St) fails.push(`pitch ${st.toFixed(1)} semitones from the voice target ${m.f0_target} Hz (limit ${L.f0St})`); } // A2: one voice, one pitch
  // quality gate: noise in the pauses (hiss, hum) and under speech; the quietest moments of a clean take lie below -60 dBFS
  if (m.n_floor_db != null && floorTrusted(m) && m.n_floor_db > L.floorFail) fails.push(`noise floor ${m.n_floor_db} dBFS (limit ${L.floorFail})`);
  if (m.n_pause_hf_db != null && m.n_pause_hf_db > L.hissFail) fails.push(`hiss in the pauses ${m.n_pause_hf_db} dBFS (limit ${L.hissFail})`);
  if (m.n_hum_db != null && m.n_hum_db > L.humFail) fails.push(`hum ${m.n_hum_db} dB over its surroundings`);
  if (m.haze_db != null && m.haze_db > L.hazeFail) fails.push(`HF haze ${m.haze_db} dB (limit ${L.hazeFail}): noise behind the voice`);
  const eff = effectiveLen(m);
  const slot = e.slot_s ?? hi;
  const ratio = eff / slot;
  if (ratio > FIT_TOLERANCE) soft.push(`overlong: ${eff.toFixed(2)} s for a ${slot.toFixed(2)} s slot`);
  let score = 100 - 70 * m.wer_soft - 3 * m.clicks - 1000 * m.clip_frac - 6 * Math.max(0, m.longest_silence_s - 0.5);
  score -= ratio > 1 ? (ratio <= FIT_TOLERANCE ? 60 * (ratio - 1) : 60 * (FIT_TOLERANCE - 1) + 120 * (ratio - FIT_TOLERANCE)) : 0; // A2: 60 (was 25): with the pitch band, overlong takes piled up and pushed the last lines late
  if (e.expected_s) score -= 8 * Math.abs(Math.log(eff / e.expected_s));
  if (m.n_floor_db != null && floorTrusted(m)) score -= 0.5 * Math.max(0, m.n_floor_db + 70);
  if (m.haze_db != null) score -= 1.2 * Math.max(0, m.haze_db + 36);       // the cleaner the better (clean Juno takes sit at -37, clean Dex takes at -33)
  if (m.e_f0_std_st != null) { // liveliness: pitch spread, loudness dynamics, speech onsets per second, against the B1 reference (3.3 st, 20.6 dB, 3.2 per s)
    const lively = 0.5 * (m.e_f0_std_st / 3.3) + 0.2 * (m.e_loud_dyn_db / 20.6) + 0.3 * (m.e_onset_rate / 3.2);
    score += 14 * clamp(lively - 1, -0.5, 0.5);
  }
  if (m.f0 && m.f0_target) score -= 6 * Math.max(0, 12 * Math.abs(Math.log2(m.f0 / m.f0_target)) - 0.75); // A2: -6 per semitone beyond the dead band
  else if (m.f0 && m.ref_f0) score -= 3 * Math.min(1.5, Math.abs(Math.log2(m.f0 / m.ref_f0)));
  if (m.first_word_s != null && m.first_word_s > 0.6) score -= 8 * (m.first_word_s - 0.6);
  if (m.tail_after_speech_s != null && m.tail_after_speech_s > 0.8) score -= 6 * (m.tail_after_speech_s - 0.8);
  return { ok: fails.length === 0, score: +score.toFixed(2), fails, soft, ratio: +ratio.toFixed(3), eff: +eff.toFixed(3) };
}
// best take: passing takes first, then by score
export function pickBest(takes) {
  const ok = takes.filter((t) => t.res.ok);
  const pool = ok.length ? ok : takes;
  return [...pool].sort((a, b) => b.res.score - a.res.score || a.index - b.index)[0] || null;
}

// ---------------------------------------------------------------- timing (pure)
// lines: [{id, speaker, interject, planned (start_s), latest_end, dur}] (dur = processed take length). Main lines go one after the
// other (gap GAP); a take is never time-stretched: a line that runs into the next planned start pushes the following lines later (nudge),
// and a main line that starts more than MAX_LATE_S late is reported as 'late'. Interjections keep their place inside the line they sit in
// (they follow its shift). Every placed line has stretch 1 (the field stays for the reports and the caption timing).
export function placeTakes(lines, { gap = GAP, duration = Infinity } = {}) {
  // RTS_PAUSE=1 (08.11., owner, G11): no overlap at all, interjections are placed like every other line; pause 0.47 s at a speaker change, 0.85 s at a new beat (section), 0.3 s for the same speaker
  const PAUSE = process.env.RTS_PAUSE === '1';
  const mains = lines.filter((l) => PAUSE || !l.interject).sort((a, b) => a.planned - b.planned);
  const out = new Map(), changes = [];
  let prevEnd = -Infinity, prevL = null;
  mains.forEach((l, i) => {
    const g = !PAUSE || !prevL ? gap : prevL.beat !== l.beat ? 0.85 : prevL.speaker !== l.speaker ? 0.47 : 0.3;
    prevL = l;
    const s = Math.max(l.planned, prevEnd + g), nudge = s - l.planned;
    const limit = i + 1 < mains.length ? mains[i + 1].planned - gap : Math.max(l.latest_end, l.planned + l.dur);
    const end = s + l.dur;
    prevEnd = end;
    out.set(l.id, { id: l.id, start: +s.toFixed(3), end: +end.toFixed(3), stretch: 1, nudge_s: +nudge.toFixed(3), planned: l.planned, window_end: +Math.max(limit, l.latest_end).toFixed(3) });
  });
  for (const l of lines.filter((x) => x.interject && !PAUSE)) {
    const host = mains.find((m) => m.planned <= l.planned && l.planned < m.planned + m.dur);
    const shift = host ? out.get(host.id).start - host.planned : 0;
    const s = l.planned + shift;
    out.set(l.id, { id: l.id, start: +s.toFixed(3), end: +(s + l.dur).toFixed(3), stretch: 1, nudge_s: +shift.toFixed(3), planned: l.planned, window_end: l.latest_end, host: host?.id || null });
  }
  for (const l of lines) {
    const p = out.get(l.id);
    if (p.nudge_s > 0.02) changes.push({ id: l.id, kind: 'nudge', seconds: p.nudge_s, why: l.interject ? `follows ${p.host}` : 'the previous line ran longer than its slot' });
    if ((PAUSE || !l.interject) && p.nudge_s > MAX_LATE_S) changes.push({ id: l.id, kind: 'late', seconds: p.nudge_s, why: `starts more than ${MAX_LATE_S} s after its planned start` });
    if (p.end > l.latest_end + 0.05) changes.push({ id: l.id, kind: 'overrun', seconds: +(p.end - l.latest_end).toFixed(3), why: 'ends after the window of its beat' });
    if (p.end > duration) changes.push({ id: l.id, kind: 'past-video-end', seconds: +(p.end - duration).toFixed(3) });
  }
  return { placed: lines.map((l) => out.get(l.id)), changes };
}

// ---------------------------------------------------------------- captions (pure)
// cues of a line spread over the real take: boundaries by word share, mapped to the read-back word times
export function cueTimes(cues, words, { offset = 0, stretch = 1, start, end }) {
  if (!cues?.length) return [];
  const cw = cues.map((c) => String(c.text).split(/\s+/).filter(Boolean).length), tot = cw.reduce((a, b) => a + b, 0) || 1;
  const t = (frac) => {
    if (!words?.length) return start + frac * (end - start);
    const k = Math.min(words.length - 1, Math.round(frac * words.length));
    const raw = frac >= 1 ? words[words.length - 1].e : words[k].s;
    return clamp(start + (raw - offset) / stretch, start, end);
  };
  let acc = 0;
  return cues.map((c, i) => {
    const f0 = acc / tot; acc += cw[i]; const f1 = acc / tot;
    return { ...c, s0: +(i === 0 ? start : t(f0)).toFixed(3), s1: +(i === cues.length - 1 ? end : t(f1)).toFixed(3) };
  });
}
const tsrt = (s) => { const ms = Math.round(s * 1000); const p = (n, w = 2) => String(n).padStart(w, '0'); return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`; };
export const toSrt = (cues) => [...cues].sort((a, b) => a.s0 - b.s0).map((c, i) => `${i + 1}\n${tsrt(c.s0)} --> ${tsrt(c.s1)}\n${c.name ? c.name + ': ' : ''}${c.text}\n`).join('\n');

// identity of a script: lines with their text and voice (the placement may change, the words may not)
export const scriptHash = (entries) => sha(JSON.stringify(entries.map((e) => [e.id, e.voice, e.text_tts]))).slice(0, 16);

// a track (casters.json) with the real times of the voice track: lines, cues; lines without a voice are removed
export function applyVoices(track, voice) {
  const byId = new Map(voice.lines.map((l) => [l.id, l]));
  const lines = track.lines.filter((l) => byId.has(l.id)).map((l) => { const v = byId.get(l.id); return { ...l, start: v.start, end: v.end, duration_s: +(v.end - v.start).toFixed(3), cues: v.cues?.length ? v.cues.map(({ s0, s1, text }) => ({ s0, s1, text })) : l.cues }; });
  const cues = lines.flatMap((l) => l.cues.map((c) => ({ ...c, speaker: l.speaker, name: track.casters[l.speaker].short, role: track.casters[l.speaker].role, color: track.casters[l.speaker].color, line: l.id, delivery: l.delivery }))).sort((a, b) => a.s0 - b.s0);
  const removed = track.lines.filter((l) => !byId.has(l.id)).map((l) => l.id);
  // camera focus segments (tools/caster-focus.mjs) are tied to the lines: they move with the real start of their line
  let focus = track.focus;
  if (Array.isArray(focus) && focus.length) {
    const shift = focus.map((f) => { const v = byId.get(f.line); return v && v.planned_start != null ? v.start - v.planned_start : 0; });
    const o0 = focus.map((f, i) => (i === 0 ? f.o0 : f.o0 + shift[i]));
    for (let i = 1; i < o0.length; i++) o0[i] = Math.max(o0[i], o0[i - 1] + 0.05);
    focus = focus.map((f, i) => ({ ...f, o0: +o0[i].toFixed(3), o1: i + 1 < focus.length ? +o0[i + 1].toFixed(3) : f.o1 }));
  }
  return { ...track, lines, cues, focus, voice: { file: voice.wav, removed } };
}

// ---------------------------------------------------------------- the booth: one synthetic small-room impulse response (same for both voices)
function rng(seed) { let s = seed >>> 0; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
export function boothIR({ rt60 = 0.32, len_s = 0.55, seed = 7 } = {}) {
  const n = Math.round(len_s * SR), ch = [];
  for (let c = 0; c < 2; c++) {
    const r = rng(seed + 101 * c), h = new Float32Array(n);
    const early = [[5.3, 0.55], [8.9, -0.42], [13.1, 0.33], [17.7, -0.26]].map(([ms, a]) => [ms + (c ? 0.9 : 0), a]);
    for (const [ms, a] of early) h[Math.round(ms * SR / 1000)] += a;
    let lp = 0;
    for (let i = Math.round(0.014 * SR); i < n; i++) {
      const t = i / SR, env = Math.exp(-t * 6.91 / rt60) * Math.min(1, (t - 0.014) / 0.01), k = clamp(0.55 - 0.9 * t, 0.12, 0.55); // darker with time
      lp += (((r() * 2 - 1) * env) - lp) * k; h[i] += lp * 0.5;
    }
    let e = 0; for (let i = 0; i < n; i++) e += h[i] * h[i]; const g = 1 / Math.sqrt(e);
    for (let i = 0; i < n; i++) h[i] *= g;
    ch.push(h);
  }
  return ch;
}
function fft(re, im, inv) { // in place radix-2
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (2 * Math.PI / len) * (inv ? -1 : 1), wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2, tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
  if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
// full convolution by overlap-add, output length = x.length (the tail past the end is cut)
export function convolve(x, h, B = 8192) {
  let F = 1; while (F < B + h.length) F <<= 1;
  const hr = new Float64Array(F), hi = new Float64Array(F); hr.set(h); fft(hr, hi, false);
  const y = new Float32Array(x.length), br = new Float64Array(F), bi = new Float64Array(F);
  for (let o = 0; o < x.length; o += B) {
    br.fill(0); bi.fill(0); const m = Math.min(B, x.length - o); for (let i = 0; i < m; i++) br[i] = x[o + i];
    fft(br, bi, false);
    for (let i = 0; i < F; i++) { const r = br[i] * hr[i] - bi[i] * hi[i], q = br[i] * hi[i] + bi[i] * hr[i]; br[i] = r; bi[i] = q; }
    fft(br, bi, true);
    for (let i = 0; i < F && o + i < x.length; i++) y[o + i] += br[i];
  }
  return y;
}
export function wavF32(chs, sr = SR) { // float32 stereo / mono WAV buffer
  const n = chs[0].length, nc = chs.length, b = Buffer.alloc(44 + n * nc * 4);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * nc * 4, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(3, 20); b.writeUInt16LE(nc, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * nc * 4, 28); b.writeUInt16LE(nc * 4, 32); b.writeUInt16LE(32, 34); b.write('data', 36); b.writeUInt32LE(n * nc * 4, 40);
  for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) b.writeFloatLE(chs[c][i], 44 + (i * nc + c) * 4);
  return b;
}

// ---------------------------------------------------------------- polish per take (ffmpeg chain + trim + loudness)
export const VOICE_FX = {
  caster_a: { hp: 80, eq: ['equalizer=f=240:t=q:w=1.0:g=-1.5', 'equalizer=f=3600:t=q:w=1.2:g=1.2', 'equalizer=f=9500:t=h:w=0.7:g=0.8'], pan: -0.1 },
  caster_b: { hp: 85, eq: ['equalizer=f=300:t=q:w=1.0:g=-1.5', 'equalizer=f=3500:t=q:w=1.2:g=1.2', 'equalizer=f=9500:t=h:w=0.7:g=0.8'], pan: 0.1 },
};
export const DELIVERY_DB = { hype: 1.5, tense: -1.5, calm: 0, question: 0, laugh: 0.5 }; // keeps the dynamics of the delivery, a little
// "de-haze": the 6-15 kHz band is pulled down while the voice is in a vowel (keyed by the 0-1 kHz band of the same signal), so the hiss
// behind Dex's vowels goes while his s and t sounds (low band quiet) pass untouched. Measured: haze -30.4 -> -37.6 dB, sibilance -13.0 -> -13.4 dB.
export const DEHAZE = 'asplit=2[a][b];[a]acrossover=split=6000:order=4th[lo][hi];[b]lowpass=f=1000[key];[hi][key]sidechaincompress=threshold=0.03:ratio=8:attack=6:release=60:level_sc=1[hic];[lo][hic]amix=inputs=2:normalize=0,lowpass=f=15000';
export const DEHAZE_ABOVE_DB = -34; // takes hazier than this get it
const COMP = 'acompressor=threshold=0.1:ratio=2.2:attack=15:release=160:makeup=1.6:knee=4';
function ffDecodeGraph(file, after, graph) { // graph (filter_complex, one input) first, then the plain chain
  const r = spawnSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-i', file, '-filter_complex', `[0:a]${graph.replace(/^asplit=2\[a\]\[b\]/, 'asplit=2[a][b]')}[d];[d]${after}[o]`, '-map', '[o]', '-f', 'f32le', '-ac', '1', '-ar', String(SR), '-'], { maxBuffer: 1 << 29 });
  if (r.status !== 0) throw new Error('ffmpeg decode failed: ' + String(r.stderr).slice(0, 300));
  return new Float32Array(r.stdout.buffer.slice(r.stdout.byteOffset, r.stdout.byteOffset + r.stdout.byteLength));
}
function ffDecode(file, filter) {
  const r = spawnSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-i', file, '-af', filter, '-f', 'f32le', '-ac', '1', '-ar', String(SR), '-'], { maxBuffer: 1 << 29 });
  if (r.status !== 0) throw new Error('ffmpeg decode failed: ' + String(r.stderr).slice(0, 300));
  return new Float32Array(r.stdout.buffer.slice(r.stdout.byteOffset, r.stdout.byteOffset + r.stdout.byteLength));
}
// Downward expander for the pauses (inside a take): everything more than about 35 dB under the loud part is pulled down by up to 30 dB (opens in 3 ms,
// closes in 30 ms), so no hiss or breath noise is carried between the words, and nothing is carried under the game sound between the lines.
export function expandPauses(x, { belowDb = 35, maxCut = 30, ratio = 3 } = {}) {
  const fr = Math.round(0.005 * SR), n = Math.floor(x.length / fr); if (n < 4) return x;
  const lv = new Float32Array(n); for (let k = 0; k < n; k++) { let e = 0; for (let i = k * fr; i < (k + 1) * fr; i++) e += x[i] * x[i]; lv[k] = 10 * Math.log10(e / fr + 1e-12); }
  const top = [...lv].sort((a, b) => a - b)[Math.floor(n * 0.97)], thr = top - belowDb;
  const ao = 1 - Math.exp(-1 / (0.003 * SR)), ac = 1 - Math.exp(-1 / (0.03 * SR)); let g = 1;
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const k = Math.min(n - 1, Math.floor(i / fr)), l = Math.max(lv[Math.max(0, k - 1)], lv[k], lv[Math.min(n - 1, k + 1)]); // look at the neighbours: a word start is never cut
    const t = db2g(l < thr ? -Math.min(maxCut, (thr - l) * ratio) : 0);
    g += (t - g) * (t > g ? ao : ac); y[i] = x[i] * g;
  }
  return y;
}
export function gateTrim(x, { preS = 0.03, postS = 0.12, relDb = 40 } = {}) {
  const fr = Math.round(0.005 * SR), n = Math.floor(x.length / fr), db = new Float32Array(n);
  for (let k = 0; k < n; k++) { let e = 0; for (let i = k * fr; i < (k + 1) * fr; i++) e += x[i] * x[i]; db[k] = 10 * Math.log10(e / fr + 1e-12); }
  const sorted = [...db].sort((a, b) => a - b), top = sorted[Math.floor(sorted.length * 0.97)] ?? -20, thr = top - relDb;
  let a = 0, b = n - 1; while (a < n && db[a] < thr) a++; while (b > a && db[b] < thr) b--;
  const s = Math.max(0, a * fr - Math.round(preS * SR)), e = Math.min(x.length, (b + 1) * fr + Math.round(postS * SR));
  const y = x.slice(s, e), fi = Math.min(y.length, Math.round(0.006 * SR)), fo = Math.min(y.length, Math.round(0.06 * SR));
  for (let i = 0; i < fi; i++) y[i] *= i / fi;
  for (let i = 0; i < fo; i++) y[y.length - 1 - i] *= 0.5 - 0.5 * Math.cos(Math.PI * (i / fo));
  return { y, offset_s: s / SR };
}
export async function polishTake(rawWav, metrics, voiceName, delivery, { lufs = -20, lufsFn } = {}) {
  const fx = VOICE_FX[voiceName] || VOICE_FX.caster_a;
  const dehaze = metrics?.haze_db != null && metrics.haze_db > DEHAZE_ABOVE_DB;
  const denoise = (metrics?.n_floor_db != null && floorTrusted(metrics) && metrics.n_floor_db > -64) || (metrics?.n_hum_db != null && metrics.n_hum_db > 5); // last step, light: only takes that still carry some noise
  const simple = [denoise ? 'afftdn=nr=6:nf=-62:tn=1:tr=1' : null, metrics?.clicks >= 3 ? 'adeclick=w=55:o=75:t=2:b=2' : null, `highpass=f=${fx.hp}:poles=2`, ...fx.eq.filter((e) => !dehaze || !/g=0\.8$/.test(e)), COMP, 'aresample=48000'].filter(Boolean).join(',');
  const x = dehaze ? ffDecodeGraph(rawWav, simple, DEHAZE) : ffDecode(rawWav, simple);
  const { y, offset_s } = gateTrim(expandPauses(x));
  const l = lufsFn ? lufsFn(y) : null;
  const target = lufs + (DELIVERY_DB[delivery] ?? 0);
  let gain_db = Number.isFinite(l) ? target - l : 0;
  let peak = 0; for (let i = 0; i < y.length; i++) peak = Math.max(peak, Math.abs(y[i]));
  const maxGain = 20 * Math.log10(0.89 / (peak || 1));
  const limited = gain_db > maxGain; if (limited) gain_db = maxGain;
  const g = db2g(gain_db); for (let i = 0; i < y.length; i++) y[i] *= g;
  return { samples: y, offset_s, lufs_before: l, gain_db: +gain_db.toFixed(2), peak_limited: limited, dehaze, denoise, dur: y.length / SR };
}

// (The studio path of this file, a job runner for a remote TTS machine, is not part of the public copy. Use tools/video-voices.mjs.)
