// The check of a story cut before anything expensive is made: it reads the real script and the real shots, before the voices and before
// the final. It stops only on faults that can be measured from the replay and the script; taste stays with the people who look at the draft.
// Every check here comes from a fault that reached a finished video once.
//   precheckStory({ ev, track, parts, tl, plan, story, target_s }) -> { faults: [string], counts: {...} }
import '../server/local-env.mjs'; // RTS_* defaults from local-env.json
import { sentencesOf } from './caster-place.mjs';
import { spokenNames } from './overlay.mjs';
import { TICK_HZ } from '../sim/util.mjs';

const LOST = /\b(cut down|down|gone|lost|killed|dead|dies|die|fall|fell|falls|slain)\b/i;
const SLACK_S = 15; // a number may be as old as the picture that goes with it may lead (PANEL_SLACK in tools/story-show.mjs)
const clock = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// the seconds of the game a line talks about: what the picture shows while it is said, with a little slack
function secondsOf(line, tl) {
  const a = Math.floor(tl.tickAt(line.start) / TICK_HZ), b = Math.floor(tl.tickAt(line.end) / TICK_HZ);
  return [Math.max(0, a - SLACK_S), b + SLACK_S];
}
const everWas = (series, [a, b], n) => { for (let s = a; s <= Math.min(b, series.length - 1); s++) if (Math.round(series[s]) === n) return true; return false; };
// the two numbers were true at the same moment, in either order
const pairWas = (x, y, [a, b], n, m) => { for (let s = a; s <= Math.min(b, x.length - 1); s++) { const p = Math.round(x[s]), q = Math.round(y[s]); if ((p === n && q === m) || (p === m && q === n)) return true; } return false; };

// a count of workers or an army value said in a line against the field at that moment
export function numberFaults({ ev, lines, tl }) {
  const out = [], W = ev.series?.workers, A = ev.series?.army;
  if (!W || !A) return ['the events hold no worker series: numbers cannot be checked'];
  for (const l of lines) {
    const span = secondsOf(l, tl), at = `${clock(span[0] + SLACK_S)}`;
    for (const s of sentencesOf(l.text)) {
      const av = s.match(/army value (\d+) (?:against|to|vs\.?) (\d+)/i);
      if (av && !pairWas(A[0], A[1], span, +av[1], +av[2])) out.push(`${l.id}: says army value ${av[1]} against ${av[2]} at ${at}, the field has ${Math.round(A[0][span[0] + SLACK_S])} and ${Math.round(A[1][span[0] + SLACK_S])}`);
      if (!/\bworkers?\b/i.test(s) || LOST.test(s)) continue;
      const pair = s.match(/(\d+) workers? (?:against|to|vs\.?) (\d+)/i) || s.match(/(\d+) workers? for [^,]+, (\d+)/i) || s.match(/(\d+) workers?, [A-Z][\w.-]* (\d+)/) || s.match(/(\d+) for [^,]+ and (\d+) for/i);
      const each = s.match(/(\d+) workers? each/i);
      if (pair) { if (!pairWas(W[0], W[1], span, +pair[1], +pair[2])) out.push(`${l.id}: says ${pair[1]} and ${pair[2]} workers at ${at}, the field has ${W[0][span[0] + SLACK_S]} and ${W[1][span[0] + SLACK_S]}`); }
      else if (each) { if (!pairWas(W[0], W[1], span, +each[1], +each[1])) out.push(`${l.id}: says ${each[1]} workers each at ${at}, the field has ${W[0][span[0] + SLACK_S]} and ${W[1][span[0] + SLACK_S]}`); }
      else for (const m of s.matchAll(/(\d+) workers?/gi)) if (!everWas(W[0], span, +m[1]) && !everWas(W[1], span, +m[1])) out.push(`${l.id}: says ${m[1]} workers at ${at}, the field has ${W[0][span[0] + SLACK_S]} and ${W[1][span[0] + SLACK_S]}`);
    }
  }
  return out;
}

// a line that quotes the match chat is said while the bubble comes up: from 1 s before the line to 0.5 s before its end
export function chatFaults({ ev, lines, tl }) {
  const out = [];
  for (const c of ev.events.filter((e) => e.type === 'chat')) {
    const l = lines.find((x) => x.text.includes(c.text));
    if (!l) continue;
    const o = tl.outAt(c.t);
    if (o < l.start - 1.15 || o > l.end - 0.5) out.push(`${l.id}: quotes the chat line “${c.text}” at ${l.start.toFixed(1)}-${l.end.toFixed(1)} s, the bubble comes at ${o.toFixed(1)} s`);
  }
  return out;
}

// what the owner asked of every cut: the whole map, each side's fog of war, close shots, models and hardware early, the differences told
export function pictureFaults({ ev, lines, parts, tl, story, plan, target_s }) {
  const out = [], P = ev.players;
  const camOf = (p) => (typeof p.cam === 'string' ? p.cam : p.cam?.k);
  const fogOf = (p) => (typeof p.fog === 'object' && p.fog ? p.fog.p : p.fog) || 0;
  const map = parts.filter((p) => camOf(p) === 'map' && !fogOf(p)).length, close = parts.filter((p) => camOf(p) !== 'map').length;
  const fog = [1, 2].map((n) => parts.filter((p) => fogOf(p) === n).length);
  if (map < 2) out.push(`only ${map} shots of the whole map, at least 2`);
  for (const n of [0, 1]) if (fog[n] < 1) out.push(`no shot through the fog of war of ${P[n].name}`);
  if (close < parts.length * 0.4) out.push(`only ${close} of ${parts.length} shots are close`);
  const dur = plan.duration_s ?? story?.main_s;
  if (target_s && dur < 0.85 * target_s) out.push(`the cut runs ${Math.round(dur)} s, the target is ${target_s} s`);
  // the first minute says who plays on what
  const intro = lines.filter((l) => l.start < 60).map((l) => l.text).join(' ');
  const said = spokenNames(P.map((p) => p.name)); // the names the casters say: two setups of one model are told apart by their labels ("Maya", "TensorFold")
  for (const p of P) {
    const nm = said[P.indexOf(p)];
    if (p.kind === 'llm' && !intro.includes(nm)) out.push(`the first minute does not name ${p.name}`);
    const hw = String(p.hardware || '').match(/RTX \d+|\d{4}|Mac Studio|Spark/);
    if (p.kind === 'llm' && hw && !intro.includes(hw[0]) && !intro.includes(hw[0].replace('RTX ', ''))) out.push(`the first minute does not name the hardware ${hw[0]} of ${p.name}`);
  }
  // the difference between the two: one is faster, one is smarter
  if (P.every((p) => p.kind === 'llm')) {
    const all = lines.map((l) => l.text).join(' ');
    if (!/\b(faster|quicker|tokens? per second|speed)\b/i.test(all)) out.push('no line says which side is faster');
    if (!/\b(smarter|knowledge|brains?|code test|intelligen\w+)\b/i.test(all)) out.push('no line says which side knows more');
  }
  // a freeze with the tier race table: the table stays in the picture (a clean whole map hides it)
  for (const u of story?.units || []) if (u.kind === 'compare') {
    const h0 = tl.outAt(u.tick), h1 = tl.outAfterHold(u.tick);
    const hidden = parts.filter((p) => p.clean && p.o0 < h1 && p.o1 > h0).reduce((m, p) => m + Math.min(p.o1, h1) - Math.max(p.o0, h0), 0);
    if (hidden > 1) out.push(`a clean shot hides the tier race table for ${hidden.toFixed(1)} s of its ${(h1 - h0).toFixed(1)} s freeze`);
  }
  return out;
}

// what the owner asked of every script: one running conversation, orders and notes translated, no reading out of numbers.
// This measures the shape only. Whether it sounds natural stays with the people who listen to the draft.
export const TALK = { minShare: 0.3, maxRun: 3, minTurnsPerMin: 6, quotesPerMin: 1, maxNumbers: 2, maxClocks: 5 };
const RAW_ORDER = /\b[a-z]+_[a-z_]+\b|\bTC\b/;
const wordCount = (s) => String(s).split(/\s+/).filter(Boolean).length;
export function dialogueFaults({ lines }) {
  const out = [], said = lines.filter((l) => l.speaker);
  if (!said.length) return out;
  const words = { pbp: 0, ana: 0 };
  for (const l of said) words[l.speaker] = (words[l.speaker] || 0) + wordCount(l.text);
  const all = words.pbp + words.ana;
  for (const [k, name] of [['pbp', 'Dex'], ['ana', 'Juno']]) if (words[k] / all < TALK.minShare) out.push(`${name} has ${Math.round(100 * words[k] / all)} percent of the words, at least ${100 * TALK.minShare}: that is no conversation`);
  let run = 1, turns = 0;
  for (let i = 1; i < said.length; i++) {
    if (said[i].speaker === said[i - 1].speaker) { if (++run === TALK.maxRun + 1) out.push(`${said[i].id}: one caster ${run} lines in a row, at most ${TALK.maxRun}`); }
    else { run = 1; turns++; }
  }
  const min = Math.max(1 / 60, (said[said.length - 1].end - said[0].start) / 60);
  if (turns / min < TALK.minTurnsPerMin) out.push(`${(turns / min).toFixed(1)} changes of speaker per minute, at least ${TALK.minTurnsPerMin}`);
  const quotes = said.filter((l) => /[“"][^”"]{8,}[”"]/.test(l.text)).length;
  if (quotes > Math.max(1, Math.round(min * TALK.quotesPerMin))) out.push(`${quotes} word-for-word quotes in ${min.toFixed(1)} minutes, at most ${TALK.quotesPerMin} per minute: translate them`);
  let clocks = 0;
  for (const l of said) {
    const raw = l.text.match(RAW_ORDER);
    if (raw) out.push(`${l.id}: command word “${raw[0]}” is read out, say it in plain words`);
    clocks += (l.text.match(/\b\d{1,2}:\d{2}\b/g) || []).length;
    const rest = l.text.replace(/\b\d{1,2}:\d{2}\b/g, ' ').replace(/\bRTX \d+\b|\b\d+ GB\b|\btier \d\b|\b(?:5090|5060)(?:['’]s)?\b/gi, ' ').replace(/\b\w*\d\w*-\w+\b/g, ' ');
    const n = (rest.match(/\b\d[\d.,]*\b/g) || []).length;
    if (n > TALK.maxNumbers) out.push(`${l.id}: ${n} numbers in one line, at most ${TALK.maxNumbers}`);
  }
  if (clocks > TALK.maxClocks) out.push(`${clocks} clock times said, at most ${TALK.maxClocks}`);
  return out;
}

export function captionFaults({ track }) {
  const out = [];
  for (const c of track.cues || []) if (sentencesOf(c.text).length > 1) out.push(`caption over a sentence end: “${c.text}”`);
  for (const d of track.dropped || []) out.push(`line dropped: “${d.text || d.line?.text}” (${d.why})`);
  for (const k of ['show_invalid', 'template_dropped', 'replaced']) for (const x of track.generated?.[k] || []) out.push(`${k}: “${x.text}” ${x.reasons}`);
  return out;
}

// BROADCAST-RULES.md rule 1a (calm camera), measured on the show tags of the script: one tag per line (two only in a line with two different content tags), a base shot (place.base) at most about 3 times a minute, a new base shot at least 9 s after any other shot and 14 s after the last base shot,
// never a base switch inside 8 s. Content tags (event, versus, inset, building, follow, fog, view) are not limited here.
export const CALM = { maxPlacePerMin: 3.5, afterShotS: 9, afterBaseS: 14, baseSwitchS: 8 };
const tagKindOf = (t) => { const ks = Object.keys(t).filter((k) => k !== 'at' && k !== 'fog'); return ks[0] || 'fog'; };
const tagKeyOf = (t) => JSON.stringify(Object.fromEntries(Object.entries(t).filter(([k]) => k !== 'at').sort()));
export function cameraFaults({ lines }) {
  const out = [], said = [...lines].filter((l) => l.show != null).sort((a, b) => a.start - b.start);
  let lastKey = null, lastChangeT = -99, lastPlaceT = -99, lastBase = null, placeCues = 0;
  for (const l of said) {
    const tags = Array.isArray(l.show) ? l.show : [l.show];
    const dur = l.end - l.start, content = tags.filter((t) => !['place', 'map'].includes(tagKindOf(t)));
    if (tags.length > 1 && !(tags.length === 2 && content.length === 2 && tagKeyOf(tags[0]) !== tagKeyOf(tags[1]))) out.push(`${l.id}: ${tags.length} show tags in a line of ${dur.toFixed(1)} s: one shot per line (two only with two different content tags)`);
    for (const t of tags) {
      const k = tagKindOf(t), key = tagKeyOf(t), isNew = key !== lastKey;
      if (k === 'place') {
        placeCues++;
        if (isNew) {
          const b = t.place?.base ?? null;
          if (lastBase != null && b != null && b !== lastBase && l.start - lastPlaceT < CALM.baseSwitchS) out.push(`${l.id}: base switch ${l.start - lastPlaceT < 0 ? 0 : (l.start - lastPlaceT).toFixed(1)} s after the last base shot, at least ${CALM.baseSwitchS} s`);
          else if (l.start - lastChangeT < CALM.afterShotS) out.push(`${l.id}: base shot ${(l.start - lastChangeT).toFixed(1)} s after the last shot, at least ${CALM.afterShotS} s`);
          lastPlaceT = l.start; lastBase = b;
        }
      }
      if (isNew) { lastChangeT = l.start; lastKey = key; }
    }
  }
  if (said.length) {
    const min = Math.max(1, (said[said.length - 1].end - said[0].start) / 60), rate = placeCues / min;
    if (rate > CALM.maxPlacePerMin) out.push(`${placeCues} base cues in ${min.toFixed(1)} minutes = ${rate.toFixed(1)} per minute, at most ${CALM.maxPlacePerMin} (BROADCAST-RULES.md 1a: calm camera, map as the resting shot)`);
  }
  return out;
}

// ---- B (05.11.): the faults of the day, each measured before voices and render ----
// A3 spoilers: a line that cites a fight (fact with v_end) and tells its result (losses, kills, duration, winner) before the fight is over on screen
const RESULT = /\b(loses?|lost|killed|kills?|fell|falls?|destroyed|no losses|takes no|goes on for|came out ahead|decided|turning point|wiped)\b|\b\d+\s+(units?|kills?|buildings?|seconds? of)\b/i;
export function spoilerFaults({ lines, facts = [] }) {
  const out = [], by = new Map(facts.map((f) => [f.id, f]));
  for (const l of lines) {
    for (const id of l.facts || []) {
      const f = by.get(id);
      if (!f || f.v_end == null || f.kind !== 'battle') continue;
      if (l.start < f.v_end - 0.3 && RESULT.test(l.text)) out.push(`${l.id}: tells the result of a fight (${id}) at ${l.start.toFixed(0)} s, the fight ends on screen at ${f.v_end.toFixed(0)} s: only what is visible until then (rule 10a)`);
    }
  }
  return out;
}
// A1: no small map; a line about a card, a decision or a plan must keep the plan cards up (a `clean` part, the whole map or a fog view, clears them)
export function decisionCardFaults({ lines, parts = [] }) {
  const out = [], WORDS = /\b(cards?|decisions? \d+|its plan|big plan|the plan)\b/i;
  for (const l of lines) {
    if (!WORDS.test(l.text)) continue;
    const ps = parts.filter((p) => p.line === l.id);
    if (ps.some((p) => p.clean && !p.fog)) out.push(`${l.id}: talks about a card or a decision, but its shot clears the plan cards (${ps.find((p) => p.clean && !p.fog).tag?.text || 'whole map'}): use the decision view (inset tag) or {"map":{"cards":true}}`);
  }
  return out;
}
export function insetFaults({ parts = [] }) {
  const out = [];
  if (/(^|&)inset=1(&|$)/.test(process.env.RTS_QUERY || '')) out.push('the small map "WHAT ... SAW WHEN IT DECIDED" is on (RTS_QUERY inset=1): it stays off');
  for (const p of parts) if (p.inset) out.push(`${p.line}: a part still carries the small inset map`);
  return out;
}
// words Drama 3 reads wrong (05.11.: "help!" sounds like a cry for help)
export const TTS_BLOCK = [/\bhelp\b[^.?!]*!/i, /\bhelp me\b/i, /\bmayday\b/i, /\bsave us\b/i];
export function ttsFaults({ lines }) {
  const out = [];
  for (const l of lines) for (const re of TTS_BLOCK) if (re.test(l.text)) { out.push(`${l.id}: “${(re.exec(l.text) || [''])[0]}” is read as a cry (TTS block list): reword`); break; }
  return out;
}
// thinking time is told in real seconds: the game runs slower than the clock on screen (speed 0.5)
export function thinkFaults({ lines }) {
  const out = [];
  let firstThink = true; // 07.11. (owner): "real seconds" only at the FIRST thinking time of a video; later ones may say "seconds" or paraphrase
  for (const l of lines) {
    const t = l.text, sec = /\b\d+(?:\.\d+)?\s+(?:real\s+)?seconds?\b/i.test(t);
    if (!sec) continue;
    if (!firstThink) continue;
    if (/\b(thought|thinks?|thinking|think time|took|per decision)\b/i.test(t) && !/\b(fight|battle|clash|war|game time|of fighting)\b/i.test(t)) firstThink = false;
    if (/\b(thought|thinks?|thinking|think time|took|per decision)\b/i.test(t) && !/\b(fight|battle|clash|war|game time|of fighting)\b/i.test(t) && !/\breal seconds?\b/i.test(t)) out.push(`${l.id}: a thinking time without “real seconds” (the game clock runs slower than the real clock)`);
  }
  return out;
}

export function precheckStory({ ev, track, parts, tl, plan, story, target_s }) {
  const lines = track.lines || [];
  return { faults: [...numberFaults({ ev, lines, tl }), ...chatFaults({ ev, lines, tl }), ...pictureFaults({ ev, lines, parts, tl, story, plan, target_s }), ...dialogueFaults({ lines }), ...captionFaults({ track }), ...cameraFaults({ lines }), ...spoilerFaults({ lines, facts: track.facts || [] }), ...decisionCardFaults({ lines, parts }), ...insetFaults({ parts }), ...ttsFaults({ lines }), ...thinkFaults({ lines })] };
}
