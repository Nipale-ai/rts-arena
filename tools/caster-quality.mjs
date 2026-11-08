#!/usr/bin/env node
// How lively is the commentary of a finished track? Pure measurements on the placed lines (the casters.json of a render, or the result of makeCasterTrack).
//   commentaryStats(track) -> { words, words_per_s, talk_fraction, longest_gap_s, gaps, repeated_lines, repeated_sentences, first_line_delay_s, max_lag_s, mean_lag_s }
//   qualityIssues(stats, limits) -> [text]   the limits below; an empty list means the track is dense, gap-free, varied and on time
//   node tools/caster-quality.mjs a-casters.json [b-casters.json ...] [--json]     one table row per track
// Definitions: gap = time between the end of one line and the start of the next (before the first line and after the last one, too); lag = how
// long the call of a moment (the first line of a beat that is before or at, or a line with its own start second) starts after the moment it was meant for (its own start time at_s, or the place its "when" gives it in its beat); a repeated line
// is a line whose words are exactly the words of an earlier line (short interjections of up to four words are exempt, they are reactions).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { idealStart, wordsOf, sentencesOf } from './caster-place.mjs';

// limits of a lively broadcast (README, casters: density). The talk target is 2.3 to 2.8 plain words per second; with the voices at 2.6 (Juno) and 3.0 (Dex) spoken words per second and breaths between lines about 2.1 to 2.3 is what a full track reaches, so below 2.0 the track is too thin.
export const LIMITS = { min_words_per_s: 2.0, max_gap_s: 8, max_repeated_lines: 0, max_repeated_sentences: 0, max_first_line_delay_s: 1.0, max_lag_s: 3.0 };

export const normText = (t) => String(t).toLowerCase().replace(/[“”"‘’']/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

export function gapsOf(lines, duration) {
  const s = [...lines].sort((a, b) => a.start - b.start);
  const gaps = [];
  let t = 0;
  for (const p of s) { if (p.start - t > 0.01) gaps.push({ from: +t.toFixed(2), to: +p.start.toFixed(2), len: +(p.start - t).toFixed(2) }); t = Math.max(t, p.end); }
  if (duration - t > 0.01) gaps.push({ from: +t.toFixed(2), to: +duration.toFixed(2), len: +(duration - t).toFixed(2) });
  return gaps;
}

export function repeatsOf(lines, minSentenceWords = 5) {
  const seen = new Map(), sent = new Map();
  const rl = [], rs = [];
  for (const l of [...lines].sort((a, b) => a.start - b.start)) {
    const nw = wordsOf(l.text).length;
    const k = normText(l.text);
    if (!(l.interject && nw <= 4)) { if (seen.has(k)) rl.push({ text: l.text, first: seen.get(k), again: l.start }); else seen.set(k, l.start); }
    for (const s of sentencesOf(l.text)) {
      const ks = normText(s);
      if (ks.split(' ').length < minSentenceWords) continue;
      if (sent.has(ks) && sent.get(ks) !== l.id) rs.push({ text: s, first: sent.get(ks), again: l.start }); else if (!sent.has(ks)) sent.set(ks, l.id ?? l.start);
    }
  }
  // a repeated line is also a repeated sentence: count the sentence repeats that are not whole-line repeats
  const wholeLine = new Set(rl.map((r) => normText(r.text)));
  return { lines: rl, sentences: rs.filter((r) => !wholeLine.has(normText(r.text))) };
}

export function commentaryStats(track) {
  const dur = track.duration_s, lines = track.lines || [], beats = new Map((track.beats || []).map((b) => [b.id, b]));
  const words = lines.reduce((a, l) => a + wordsOf(l.text).length, 0);
  const talk = lines.reduce((a, l) => a + (l.end - l.start), 0);
  const gaps = gapsOf(lines, dur);
  const rep = repeatsOf(lines);
  // the lag is measured on the call of each moment: the first line of a beat that names it (when: before, at) and every line with its own start second (at_s);
  // a gap-fill line has no moment, and a second line, a follow-up or a reaction comes behind the call by design
  const calls = new Map();
  for (const l of [...lines].sort((a, b) => a.start - b.start)) if (!l.fill && (l.when === 'before' || l.when === 'at') && !calls.has(l.beat)) calls.set(l.beat, l);
  const callSet = new Set([...calls.values(), ...lines.filter((l) => !l.fill && l.at_s != null)]);
  const lags = [...callSet].map((l) => { const b = beats.get(l.beat); return b ? Math.max(0, l.start - Math.max(0.25, idealStart(l, b, l.end - l.start))) : 0; });
  const first = [...lines].filter((l) => !l.fill).sort((a, b) => a.start - b.start)[0];
  const fb = first ? beats.get(first.beat) : null;
  return {
    lines: lines.length, words, words_per_s: +(words / dur).toFixed(2), talk_fraction: +(talk / dur).toFixed(2),
    longest_gap_s: +Math.max(0, ...gaps.map((g) => g.len)).toFixed(1), gaps_over_8s: gaps.filter((g) => g.len > 8).length, gaps,
    repeated_lines: rep.lines.length, repeated_sentences: rep.sentences.length, repeats: rep,
    first_line_start_s: first ? first.start : null, first_line_delay_s: first && fb ? +Math.max(0, first.start - idealStart(first, fb, first.end - first.start)).toFixed(2) : null,
    max_lag_s: +Math.max(0, ...lags).toFixed(2), mean_lag_s: +(lags.reduce((a, b) => a + b, 0) / Math.max(1, lags.length)).toFixed(2),
  };
}

export function qualityIssues(st, limits = LIMITS) {
  const out = [];
  if (st.words_per_s < limits.min_words_per_s) out.push(`too thin: ${st.words_per_s} words/s (at least ${limits.min_words_per_s})`);
  if (st.longest_gap_s > limits.max_gap_s) out.push(`silence of ${st.longest_gap_s} s (at most ${limits.max_gap_s} s)`);
  if (st.repeated_lines > limits.max_repeated_lines) out.push(`${st.repeated_lines} line(s) repeated word for word: ${st.repeats.lines.map((r) => `"${r.text}"`).join(', ')}`);
  if (st.repeated_sentences > limits.max_repeated_sentences) out.push(`${st.repeated_sentences} sentence(s) repeated word for word: ${st.repeats.sentences.map((r) => `"${r.text}"`).join(', ')}`);
  if (st.first_line_delay_s != null && st.first_line_delay_s > limits.max_first_line_delay_s) out.push(`first line starts ${st.first_line_delay_s} s late`);
  if (st.max_lag_s > limits.max_lag_s) out.push(`a line starts ${st.max_lag_s} s after its moment (at most ${limits.max_lag_s} s)`);
  return out;
}

// ---------------------------------------------------------------- CLI
function main() {
  const a = process.argv.slice(2);
  const files = a.filter((x) => !x.startsWith('--'));
  if (!files.length) { console.error('usage: node tools/caster-quality.mjs a-casters.json [b-casters.json ...] [--json]'); process.exit(2); }
  const rows = files.map((f) => ({ file: f, ...commentaryStats(JSON.parse(fs.readFileSync(f, 'utf8'))) }));
  if (a.includes('--json')) { console.log(JSON.stringify(rows.map(({ gaps, repeats, ...r }) => r), null, 1)); return; }
  const pad = (s, n) => String(s).padEnd(n);
  console.log([pad('track', 56), pad('lines', 6), pad('words/s', 8), pad('talk', 6), pad('gap max', 8), pad('gaps>8', 7), pad('rep.lines', 10), pad('rep.sent', 9), pad('1st delay', 10), pad('lag max', 8)].join(''));
  for (const r of rows) console.log([pad(path.basename(r.file).slice(0, 54), 56), pad(r.lines, 6), pad(r.words_per_s, 8), pad(r.talk_fraction, 6), pad(r.longest_gap_s, 8), pad(r.gaps_over_8s, 7), pad(r.repeated_lines, 10), pad(r.repeated_sentences, 9), pad(r.first_line_delay_s, 10), pad(r.max_lag_s, 8)].join(''));
  for (const r of rows) { const iss = qualityIssues(r); if (iss.length) console.log(`${path.basename(r.file)}:\n  ${iss.join('\n  ')}`); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
