// Timing, SRT and TTS manifest of the caster lines. Pure functions.
//   placeLines(lines, beats, duration_s) -> { placed, dropped, warnings }   start / end in video seconds
//     a line may carry alts (shorter versions of its text, longest first, checked like the line itself) and at_s (the video second it is meant for, e.g. the second a building finishes inside a long stretch) and filler: true
//     (a line that is dropped rather than said late, even in a story beat); keep: true = the line is never shortened for the sake of the next line, only to fit the video (the call of the winner)
//   idealStart(line, beat, dur)           -> the second a line is meant to start (at_s, or the place its "when" gives it in its beat)
//   validateTiming(placed, duration_s)    -> [issues]                     no overlap (except short interjections), inside the video
//   cuesOf(placedLine)                    -> [{ s0, s1, text }]           one sentence per cue, never across a sentence boundary
//   toSrt(placed, casters)                -> string
//   ttsManifest(placed, casters, opts)    -> manifest for the voice model (Fish Audio Drama 3 style prefix, numbers as words)
import '../server/local-env.mjs'; // RTS_* defaults from local-env.json
import { RATE, CASTERS } from './caster-facts.mjs';
import * as fsMod from 'node:fs';
const require_fs = () => fsMod;

export const PAUSE = process.env.RTS_PAUSE === '1'; // 08.11. owner: speaker change >= 0.45 s, after a beat/camera change >= 0.8 s, no overlap (G11)
export const GAP_SAME = PAUSE ? 0.3 : 0.3, GAP_OTHER = PAUSE ? Number(process.env.RTS_GAP_OTHER) || 0.47 : 0.2, GAP_BEAT = PAUSE ? Number(process.env.RTS_GAP_BEAT) || 0.85 : 0, MAX_DELAY = { before: 2.6, at: 3.6, react: 2.2, after: 6 }, INTERJECT_MAX_WORDS = 4;
// how late a line may start before the line in front of it should have been shorter (see placeLines, alts)
export const SOFT_DELAY = { before: 0.8, at: 0.8, react: 0.8, after: 2.0 };
export const wordsOf = (s) => String(s).split(/\s+/).filter(Boolean);

// A number like 2945 is spoken as several words ("two thousand nine hundred forty-five"): the duration estimate counts the words of the spoken form.
export function spokenWords(text) { return wordsOf(spokenText(text)).length; }
// a sentence also ends behind a closing quote ('then tier 2.” Who is right?'), and a quote after a sentence end starts a new one even in lower case ('DeepSeek? “keep workers coming”.')
export function sentencesOf(text) { return String(text).split(/(?<=[.!?…][”"’)]?)\s+(?=[(]?[A-Z0-9]|[“"])/).map((s) => s.trim()).filter(Boolean); }
export function estimateDuration(text, speaker, fight = false) {
  const rate = speaker === 'pbp' && fight ? RATE.pbp_fight : RATE[speaker] || RATE.ana;
  return +(spokenWords(text) / rate + 0.15 * Math.max(0, sentencesOf(text).length - 1)).toFixed(2);
}

const WHEN_RANK = { before: 0, at: 1, react: 2, after: 3 };
export function idealStart(line, b, dur) { return line.at_s != null ? line.at_s : ideal(line.when, b, dur); }
function ideal(when, b, dur) {
  switch (when) {
    case 'before': return Math.max(b.anchor - 3.6, b.anchor + 0.5 - dur);
    case 'react': return b.anchor + 0.3;
    case 'after': return b.anchor + 0.9;
    default: return b.anchor + 0.1;
  }
}

export function placeLines(lines, beats, duration) {
  const byId = new Map(beats.map((b) => [b.id, b]));
  // lines are said in beat order; inside a beat in the order of their "when" (before, at, react, after), except a beat with lines that carry their own start second (at_s): there the start order rules
  const timed = new Set(lines.filter((l) => l.at_s != null).map((l) => l.beat));
  const key = (l) => { const b = byId.get(l.beat); return b ? idealStart(l, b, estimateDuration(l.text, l.speaker, b.fight)) : 0; };
  const items = lines.map((l, i) => ({ ...l, _i: i })).sort((a, b) => a.beat - b.beat || (timed.has(a.beat) ? key(a) - key(b) : 0) || (WHEN_RANK[a.when] ?? 1) - (WHEN_RANK[b.when] ?? 1) || a._i - b._i);
  const placed = [], dropped = [], warnings = [];
  // where a text would start and end if it were the next line (nothing is stored)
  const attempt = (L, text, b) => {
    const dur = estimateDuration(text, L.speaker, b.fight);
    const want = idealStart({ ...L, text }, b, dur);
    let start = want;
    const sameLast = [...placed].reverse().find((p) => p.speaker === L.speaker);
    const otherLast = [...placed].reverse().find((p) => p.speaker !== L.speaker);
    const lastAny = placed.reduce((m, p) => Math.max(m, p.end), 0.0);
    start = Math.max(start, 0.25);
    let overlapped = false;
    if (!PAUSE && L.interject && otherLast && wordsOf(text).length <= INTERJECT_MAX_WORDS) {
      // may sit inside the other caster's line, a little after its start and ending before it ends
      if (start < otherLast.end && otherLast.end - otherLast.start > 1.6) {
        const lo = otherLast.start + 0.7, hi = otherLast.end - 0.15 - dur;
        if (hi >= lo) { start = Math.min(Math.max(start, lo), hi); overlapped = start < otherLast.end; }
      }
    }
    if (!overlapped) {
      const prev = placed.length ? placed[placed.length - 1] : null;
      const gap = prev && prev.speaker === L.speaker ? GAP_SAME : GAP_OTHER;
      start = Math.max(start, lastAny + (placed.length ? (prev && prev.beat !== L.beat ? Math.max(gap, GAP_BEAT) : gap) : 0));
    }
    if (sameLast) start = Math.max(start, sameLast.end + GAP_SAME);
    return { text, dur, want, start, delay: start - want, overlapped };
  };
  for (let idx = 0; idx < items.length; idx++) {
    const L = items[idx];
    const b = byId.get(L.beat);
    if (!b) { dropped.push({ line: L, why: 'unknown beat' }); continue; }
    // a line may come with shorter versions of itself (alts, longest first): the longest one that leaves the next line its moment is said, so a long call never pushes the next one late
    // the moment that matters is the one of the first line of another beat (or a line with its own start second); the other lines of this beat follow in their shortest form and need their time
    let nx = null, restT = 0, firstSame = null;
    for (let j = idx + 1; j < items.length; j++) {
      const x = items[j];
      if (x.interject) continue;
      if (x.beat === L.beat && x.at_s == null) { firstSame = firstSame || x; restT += Math.min(...[x.text, ...(x.alts || [])].map((t) => estimateDuration(t, x.speaker, b.fight))) + GAP_OTHER; continue; }
      nx = x; break;
    }
    const nb = nx ? byId.get(nx.beat) : null;
    const nextOk = nx && nb ? idealStart(nx, nb, estimateDuration(nx.text, nx.speaker, nb.fight)) + (SOFT_DELAY[nx.when] ?? 1) - restT : duration - 0.25 - restT;
    // a line before the moment of its beat ends where the moment starts
    const sameOk = L.when === 'before' && firstSame ? idealStart(firstSame, b, estimateDuration(firstSame.text, firstSame.speaker, b.fight)) + (SOFT_DELAY[firstSame.when] ?? 1) : Infinity;
    const options = process.env.RTS_NOALT === '1' ? [L.text] : [L.text, ...(L.alts || [])]; // RTS_NOALT: the full text is always said (08.11., text must equal the script)
    let c = null;
    for (let k = 0; k < options.length; k++) {
      c = attempt(L, options[k], b);
      c.k = k;
      if (k === options.length - 1 || c.overlapped || (c.start + c.dur + GAP_OTHER <= (L.keep ? Infinity : Math.min(nextOk, sameOk)) && c.start + c.dur <= duration - 0.25)) break;
    }
    const { dur, start, delay, overlapped } = c;
    if (start + dur > duration - 0.25) { dropped.push({ line: L, why: `does not fit the video (would end at ${(start + dur).toFixed(1)} s of ${duration.toFixed(1)} s)` }); continue; }
    if (delay > (MAX_DELAY[L.when] ?? 2.8) * (Number(process.env.RTS_DELAY_X) || 1) && L.optional !== false && !overlapped && (!b.flow || L.filler)) { dropped.push({ line: L, why: `would start ${delay.toFixed(1)} s late (the lines before it take too long)` }); continue; }
    if (start > b.seg1 + 1.5) warnings.push(`line of beat ${b.id} starts ${(start - b.seg1).toFixed(1)} s after its moment is over`);
    const { alts, ...rest } = L;
    if (process.env.RTS_DELAYLOG) (placeLines._log ||= []).push({ beat: L.beat, when: L.when, speaker: L.speaker, text: c.text, want: +c.want.toFixed(2), start: +start.toFixed(2), dur: +dur.toFixed(2), delay: +delay.toFixed(2) });
    placed.push({ ...rest, text: c.text, ...(c.k > 0 ? { short: true } : {}), id: `L${placed.length + 1}`, start: +start.toFixed(2), end: +(start + dur).toFixed(2), dur, overlap: overlapped });
  }
  if (process.env.RTS_DELAYLOG) { require_fs().writeFileSync(process.env.RTS_DELAYLOG, JSON.stringify({ log: placeLines._log || [], dropped: dropped.map((d) => ({ text: d.line.text, why: d.why })) })); placeLines._log = []; }
  placed.sort((a, b) => a.start - b.start || a.end - b.end);
  placed.forEach((p, i) => { p.id = `L${i + 1}`; delete p._i; });
  return { placed, dropped, warnings };
}

export function validateTiming(placed, duration) {
  const issues = [];
  const sorted = [...placed].sort((a, b) => a.start - b.start);
  for (const p of sorted) {
    if (p.start < 0 || p.end > duration) issues.push(`${p.id} outside the video`);
    const rate = spokenWords(p.text) / (p.end - p.start);
    if (rate > RATE.pbp_fight + 0.45) issues.push(`${p.id} is too fast (${rate.toFixed(2)} words/s)`);
  }
  for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++) {
    const a = sorted[i], b = sorted[j];
    if (b.start >= a.end - 1e-6) break;
    const inter = [a, b].find((x) => x.interject && wordsOf(x.text).length <= INTERJECT_MAX_WORDS);
    if (a.speaker === b.speaker || !inter) issues.push(`${a.id} and ${b.id} overlap (${a.speaker}/${b.speaker})`);
    else { const o = inter === a ? b : a; if (inter.start < o.start + 0.5 - 1e-6 || inter.end > o.end + 0.01) issues.push(`${inter.id} sticks out of ${o.id}`); }
  }
  return issues;
}

// ---------------------------------------------------------------- SRT / on-screen cues
const MAX_CUE_CHARS = 84;
const BARE_NUMBER_TAIL = /^[^,;:]*\b(?:has|have|had|is|are|at|with|on|got|holds?)\s+[\d][\d.,]*[kKxX%]?[.!?]?$/;
function splitLong(sentence) {
  if (sentence.length <= MAX_CUE_CHARS) return [sentence];
  const mid = sentence.length / 2;
  let best = -1;
  for (const m of sentence.matchAll(/[,;:—–]\s|\s[—–]\s/g)) {
    // never cut so that a cue is a bare number ("Zoe's TensorFold recipe has 5625."): the words that say what the number is stay in the same cue
    if (BARE_NUMBER_TAIL.test(sentence.slice(m.index + m[0].length))) continue;
    if (best < 0 || Math.abs(m.index + 1 - mid) < Math.abs(best - mid)) best = m.index + 1;
  }
  if (best < 12 || best > sentence.length - 12) return [sentence];
  return [sentence.slice(0, best).trim(), sentence.slice(best).trim()].flatMap(splitLong);
}
// cues of one line: one sentence per cue (a long sentence may be cut at a comma, never across a sentence end). Time is shared by spoken length.
export function cuesOf(p) {
  const parts = sentencesOf(p.text).flatMap(splitLong);
  const w = parts.map((t) => spokenWords(t) + 0.4);
  const tot = w.reduce((a, b) => a + b, 0);
  let t = p.start;
  return parts.map((text, i) => { const s0 = t; t += ((p.end - p.start) * w[i]) / tot; return { s0: +s0.toFixed(3), s1: +(i === parts.length - 1 ? p.end : t).toFixed(3), text }; });
}
const ts = (s) => { const ms = Math.round(s * 1000); const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), x = Math.floor((ms % 60000) / 1000); return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
export function toSrt(placed, casters = CASTERS) {
  const cues = placed.flatMap((p) => cuesOf(p).map((c) => ({ ...c, who: casters[p.speaker]?.short ?? p.speaker }))).sort((a, b) => a.s0 - b.s0);
  return cues.map((c, i) => `${i + 1}\n${ts(c.s0)} --> ${ts(c.s1)}\n${c.who}: ${c.text}\n`).join('\n');
}

// ---------------------------------------------------------------- spoken form for the TTS
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
export function intWords(n) {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? '-' + ONES[n % 10] : '');
  if (n < 1000) return ONES[Math.floor(n / 100)] + ' hundred' + (n % 100 ? ' ' + intWords(n % 100) : '');
  if (n < 1e6) return intWords(Math.floor(n / 1000)) + ' thousand' + (n % 1000 ? ' ' + intWords(n % 1000) : '');
  return intWords(Math.floor(n / 1e6)) + ' million' + (n % 1e6 ? ' ' + intWords(n % 1e6) : '');
}
const digitsWords = (d) => d.split('').map((c) => ONES[+c]).join(' ');
export function numberWords(str, gpu = false) {
  const clean = str.replace(/,/g, '');
  const [i, f] = clean.split('.');
  const n = Number(i);
  let w = gpu && /^\d{4}$/.test(i) && n >= 5000 && n <= 5099 ? `${intWords(Math.floor(n / 100))} ${n % 100 ? intWords(n % 100) : 'hundred'}` : intWords(n); // 5090 -> fifty ninety
  if (f !== undefined) w += ' point ' + digitsWords(f);
  return w;
}
const SPELL = /^(NVFP|EXL|MTP|TP|RTX|GPU|LLM|TC|GB|TB|AI|RTS|TTS|PBP|HP|NF|FP|BPW|KV|CPU|RAM|VRAM|GLM|MLX|DGX|NVMe)$/;
// words the voice model would stumble over: the caption keeps the written form
const SAY_AS = { GiB: 'gigabytes', Robin: 'Robin', amberlabs: 'Amber Labs' };
function spokenToken(tok, next, prev) {
  const m = /^([^\w“"(]*)(.*?)([^\w”")%+]*)$/.exec(tok);
  const [, pre, core, post] = m;
  if (!core) return tok;
  let c = core.replace(/['’]s$/, (x) => x);
  if (SAY_AS[c]) return pre + SAY_AS[c] + post;
  let m2;
  if ((m2 = /^(\d{1,2}):(\d{2})$/.exec(c))) {
    const mm = Number(m2[1]), ss = Number(m2[2]);
    c = ss === 0 ? `${intWords(mm)} o'clock` : ss < 10 ? `${intWords(mm)} oh ${intWords(ss)}` : `${intWords(mm)} ${intWords(ss)}`;
  } else if ((m2 = /^(\d[\d,]*(?:\.\d+)?)x$/i.exec(c))) {
    c = /^[A-Z0-9]/.test(next || '') && /^\d+$/.test(m2[1]) ? numberWords(m2[1]) : numberWords(m2[1]) + ' times';
  } else if (!/^(5090|5060)s$/.test(c) && (m2 = /^(\d[\d,]*(?:\.\d+)?)s$/.exec(c))) c = numberWords(m2[1]) + ' seconds';
  else if ((m2 = /^(5090|5060)(['’]?s)?$/.exec(c))) c = numberWords(m2[1], true) + (m2[2] ? "'s" : ''); // 07.11.: "5090's" -> fifty ninety's (nie five thousand ninety s)
  else if (/^\d+(\.\d+){2,}$/.test(c)) c = c.split('.').map((d) => numberWords(d)).join(' point '); // version 1.2.3 -> one point two point three
  else if (/^\d[\d,]*(\.\d+)?$/.test(c)) c = numberWords(c, /^rtx/i.test(prev || "") || /^ti\b/i.test(next || "") || /^(5090|5060)$/.test(c)); // 07.11. owner: never "five thousand ninety"; 5090 -> fifty ninety, 5060 -> fifty sixty, also without RTX before it
  else if (/\d/.test(c) || /[a-z][A-Z]/.test(c) && /\d/.test(c)) {
    c = c.replace(/(\d+(?:\.\d+)?)|([A-Za-z]+)|([^A-Za-z0-9]+)/g, (_, d, w, sep) => {
      if (d) return ' ' + numberWords(d, /^(5090|5060)$/.test(d)) + ' ';
      if (w) return ' ' + (SPELL.test(w.toUpperCase()) && (w === w.toUpperCase() || w.length <= 3 && w === w.toLowerCase()) ? w.toUpperCase().split('').join(' ') : w) + ' ';
      return sep.includes('+') ? ' plus ' : ' ';
    }).replace(/\s+/g, ' ').trim();
  } else if (c === 'Ti') c = 'T I';
  else if (SPELL.test(c) && c === c.toUpperCase()) c = c === 'GB' ? 'gigabytes' : c.split('').join(' ');
  return pre + c + post;
}
export function spokenText(text) {
  const toks = String(text).split(/\s+/).filter(Boolean);
  return toks.map((t, i) => spokenToken(t, toks[i + 1], toks[i - 1])).join(' ').replace(/\s+([,.!?;:])/g, '$1');
}

// Style prefixes for the TTS, one set per voice. caster_a (Dex): young British man, breathless football-style commentator, rapid-fire,
// voice cracking with excitement. caster_b (Juno): Canadian woman, about 30, engaged and warm, quick and melodic, a laugh that comes easily; excited only when she reacts to action.
const A = 'young British man, football commentator';
const B = 'Canadian woman, about thirty';
// A2 (05.11.2026): one fixed prefix per register and voice (loud / question / calm), no whisper, roaring or cracking voice: Drama 3 moves pitch and
// timbre with the style text, so twelve different prefixes made Dex sound like two men. laugh and tense use the calm prefix (loud when the line ends in "!").
const FIXED = {
  pbp: { loud: `[${A}, excited, loud, fast]`, question: `[${A}, curious, rising, quick]`, calm: `[${A}, quick, upbeat, fluent]` },
  ana: { loud: `[${B}, Canadian accent, excited, animated, fast, emphatic]`, question: `[${B}, Canadian accent, curious, animated, leaning in, wry]`, calm: `[${B}, Canadian accent, engaged, warm, animated, lively pace, smiling]` },
};
export function fixedStyle(speaker, delivery, text = '') {
  const reg = delivery === 'hype' ? 'loud' : delivery === 'question' ? 'question' : ((delivery === 'tense' || delivery === 'laugh') && /!\s*$/.test(String(text)) ? 'loud' : 'calm');
  return FIXED[speaker][reg];
}
const hash = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
// One word tag at most, only where it adds punch: the last plain word before a "!" of a hype line (never a name or a number), the
// closing words of a tense line, a short interjection. `orig` is the caption text, used to pick the word (the spoken text has numbers as words).
export function addWordTag(spoken, delivery, interject, orig = spoken) {
  if (interject && delivery === 'hype') return `<forceful>${spoken}</forceful>`;
  if (delivery === 'hype') {
    const cands = [...orig.matchAll(/([A-Za-z][\w'-]*)([!?]+)/g)].filter((m) => m[1].length > 2 && !/\d/.test(m[1]) && (/^[a-z]/.test(m[1]) || (m.index === 0 || /[.!?]\s$/.test(orig.slice(Math.max(0, m.index - 2), m.index))) && m[1].length <= 5));
    const m = cands.at(-1);
    if (m) { const i = spoken.lastIndexOf(m[0]); if (i >= 0) return spoken.slice(0, i) + `<emphasis>${m[1]}</emphasis>${m[2]}` + spoken.slice(i + m[0].length); }
  }
  if (delivery === 'tense') {
    const m = /((?:[A-Za-z][\w'-]*\s+){0,2}[A-Za-z][\w'-]*)([.?!…]*)$/.exec(spoken);
    if (m && spoken.split(/\s+/).length >= 4) return spoken.slice(0, m.index) + `<slow>${m[1]}</slow>${m[2]}`;
  }
  return spoken;
}

export function ttsManifest(placed, casters = CASTERS, opts = {}) {
  const sorted = [...placed].sort((a, b) => a.start - b.start);
  const entries = sorted.map((p, i) => {
    const style = fixedStyle(p.speaker, p.delivery, p.text);
    const spoken0 = spokenText(p.text).replace(/\s+/g, ' ');
    const spoken = addWordTag(spoken0.replace(/(^|[.!?]\s+)([a-z])/g, (_, a, c) => a + c.toUpperCase()), p.delivery, p.interject, p.text);
    const next = sorted.slice(i + 1).find((q) => q.speaker === p.speaker || !q.interject);
    return {
      id: p.id, speaker: p.speaker, caster: casters[p.speaker].name, voice: casters[p.speaker].voice, delivery: p.delivery,
      style, text_tts: `${style} ${spoken}`, text: p.text, start_s: p.start, target_duration_s: +(p.end - p.start).toFixed(2),
      expected_s: +(p.end - p.start).toFixed(2), accept_take_s: [+(0.35 * (p.end - p.start)).toFixed(2), +(2.3 * (p.end - p.start)).toFixed(2)],
      latest_end_s: +(next ? Math.max(p.end, next.start - 0.05) : opts.duration_s ?? p.end).toFixed(2), words: wordsOf(p.text).length, beat: p.beat, interject: !!p.interject,
    };
  });
  return {
    version: 1, tts: 'Fish Audio Drama 3 (sglang-omni /v1/audio/speech), one request per entry', voices: Object.fromEntries(Object.values(casters).map((c) => [c.voice, { who: `${c.name} (${c.role})`, description: c.voice_note, reference: c.voice_ref }])),
    rules: 'text_tts is one paragraph: a style prefix in square brackets, numbers as words, at most one word tag. accept_take_s: a take is accepted when its length is 0.35x to 2.3x of expected_s; place each take at start_s.',
    entries,
  };
}
