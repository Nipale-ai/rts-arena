#!/usr/bin/env node
// Two-caster commentary track for a broadcast: a play-by-play caster and an analyst.
//   fact sheet + beat timeline from the match log and the broadcast plan  (tools/caster-facts.mjs)
//   -> an LLM writes the lines through any OpenAI-compatible endpoint     (--llm base_url,model[,key]; the product path)
//   -> a strict checker rejects every line with a number, name or claim that is not in the fact sheet (tools/caster-check.mjs)
//   -> rejected lines go back to the LLM once or twice, then are replaced by template lines (tools/caster-template.mjs)
//   -> timing: every line gets a video start time, no overlap (tools/caster-place.mjs)
//   -> the silences between the lines are filled with lines made from the match log (tools/caster-fill.mjs); a line is never said twice
//   -> outputs: casters.json, casters.srt (one sentence per cue), casters-tts.json (TTS manifest)
// Without --llm the deterministic template writer is used. --llm-output file.json plays back a saved LLM answer (offline / tests).
//   node tools/casters.mjs replays/<id> [--cut highlight|full] [--target 80,100] [--class "32 GB"] [--out dir]
//        [--llm http://host:port/v1,model[,key]] [--llm-output answer.json] [--dump-prompt] [--seed N] [--rounds 2]
import '../server/local-env.mjs'; // RTS_* defaults from local-env.json
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CASTERS, buildScript, describeBeat } from './caster-facts.mjs';
import { makeContext, checkLine, checkLines, DELIVERY, MAX_WORDS } from './caster-check.mjs';
import { placeLines, validateTiming, cuesOf, toSrt, ttsManifest, sentencesOf } from './caster-place.mjs';
import { templateLines } from './caster-template.mjs';
import { fillGaps } from './caster-fill.mjs';
import { commentaryStats, normText } from './caster-quality.mjs';
import { timelineOf } from './plan.mjs';
import { focusPlan } from './caster-focus.mjs';
import { loadRules } from './broadcast-rules.mjs';
import { SHOW_SCHEMA, World, validateShow } from './show-tags.mjs';
import { classWord, thingWord } from './lib/theme-words.mjs';

const wordsOfText = (t) => String(t).split(/\s+/).filter(Boolean).length;
// shorter versions of a line (the first sentences of it, or the ones the writer gave), each checked like the line itself: when the lines before it ran long
// the placer says the longest version that still leaves the next line its moment (tools/caster-place.mjs)
export function withAlts(lines, ctx) {
  return lines.map((l) => {
    const full = wordsOfText(l.text), cands = [...(l.alts || [])];
    const ss = sentencesOf(l.text);
    // a line with an alt of its own keeps those (the writer knows what must stay in it); only plain lines may be cut after a sentence
    if (!cands.length) for (let k = ss.length - 1; k >= 1; k--) cands.push(ss.slice(0, k).join(' '));
    const seen = new Set([l.text]);
    const ok = cands.filter((t) => { if (seen.has(t) || wordsOfText(t) < 2 || wordsOfText(t) >= full) return false; seen.add(t); return checkLine({ ...l, text: t, alts: undefined }, ctx).ok; }).sort((a, b) => wordsOfText(b) - wordsOfText(a));
    const { alts, ...rest } = l;
    return ok.length ? { ...rest, alts: ok } : rest;
  });
}
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

// ---------------------------------------------------------------- prompt
export function buildPrompt(sheet, beats, duration_s, rules = loadRules()) {
  const nBudget = beats.reduce((a, b) => a + b.budget_words, 0);
  let system = `You write the live commentary for an esports broadcast of a real-time strategy match. Two AI language models play against each other; viewers watch a ${Math.round(duration_s)} second highlight video with a camera that flies to whatever the casters talk about. Two original casters talk over it like real League of Legends casters: they never stop for long, they interrupt and finish each other's thoughts, they ask questions out loud and answer them later. A text-to-speech model reads the lines afterwards.

THE CASTERS (original characters, never imitate a real person)
pbp = ${CASTERS.pbp.name}, play-by-play. A young British man, football-commentator energy: breathless, rapid-fire, voice cracking when it gets wild. British phrasing ("what a strike", "they've thrown everything at it", "absolutely rattled", "he's gone for it!"), but invent your own lines, no catchphrases copied from real commentators. Dex says what happens on screen and asks what a viewer would ask. He talks in every stretch of the video: relaxed and curious in calm stretches (delivery calm or question), loud only in fights. In action he calls it in short punchy sentences.
ana = ${CASTERS.ana.name}, analyst. A Canadian woman, about 30 (a woman: she/her, never "he" for Juno), engaged and warm, medium-high energy: very quick, melodic, bright, clearly awake, a good analyst who enjoys the game, quick-witted with a laugh that comes easily ("okay, I love this", "honestly?", "that's a bold one", "oh, that's fun"). Not flat, never sleepy; not hype like Dex either, she saves the excited delivery for the moments where she reacts to action. Juno says what it all means: she answers Dex, explains the plans of the models in her own words, and gives the closing summary. She doubts decisions out loud, predicts (clearly as opinion) and later resolves it ("and there's the answer to my question"). Teases Dex, never mean to the players.
A REAL CONVERSATION: this is one running talk between two people, never two people reading turns. Every line reacts to the line before it: it answers the question, picks up the word, disagrees, or asks the next thing. Short lines go back and forth, mostly one or two sentences. Nobody holds a monologue: at most three lines in a row, each caster at least 30 percent of the words. delivery: "calm" means engaged and warm (the default), "hype" = excited (fights and big moments), "laugh", "question", "tense" (leaning in).
TRANSLATE: say in normal spoken English what the models do and think. Orders become plain actions ("it stops making ${classWord('workers', 'unit', 'worker')} to save food"), never command words like auto_train, cancel_standing, attack_wave or TC. Retell a note in your own words and still cite its fact. Numbers only where they carry the point, at most two in a line, and units before abstract scores ("7 ${classWord('spearmen', 'unit', 'spearman')} against 2").
They are a team, they banter, react to each other, use callbacks, build tension before a decision, resolve it afterwards, open with a hype welcome and finish with a strong closing line. No lists, no repeated cliches, nothing robotic: never write "Its note:" or "The numbers:"; talk like people.

HOW A DECISION IS CAST (beats of kind decision, the video runs in slow motion)
1. Before the order lands: set the scene on what the model saw (camera on the "saw" subject), ask the question ("what does it do now?").
2. When it lands: say in plain words what the model decided and why ("QuartzRT sends its whole army at the enemy ${thingWord('town center', 'building', 'town_center')}"). Attach the line to the subject the note is about.
3. After: react (short, from the other caster), doubt or praise (hedged), and name what is attacked or defended (camera on the target).
Later beats resolve the question that was asked.

NAMES: call the players by the names in the player list: the short name or the spoken alias ("QuartzRT", "Zoe's kit"). Never use a part of a name alone (not "Zoe", not "kit") and never invent a name. Model and hardware names exactly as the sheet writes them; hardware at most once or twice in the whole show.

SUBJECTS: every beat lists subjects (s1, s2, ...): the units, buildings or places that moment is about. Put "subject":"sN" on each line: the one the line talks about. The camera flies there a moment before the line starts and stays while it is discussed. Choose the subject that matches the words of the line, change subject when the talk changes. Only use ids listed for that beat.

BROADCAST RULES (the rule book BROADCAST-RULES.md, word for word, hash ${rules.hash})
${rules.text}

${SHOW_SCHEMA}

HARD RULES (a strict checker rejects every line that breaks one)
1. Grounding. Every factual claim comes from the FACT SHEET. Cite the fact ids a line uses in "facts". Never invent numbers, units, events, reasons or names. Fact "aim" tells what a decision is about.
2. Numbers: write digits (2945, 18:30, 1.7x), copy them exactly from a cited fact. No vague multipliers (twice, double, half, percent). Rounding only with "about" or "around", within 10 percent. Do not stuff lines with numbers: a few strong ones, the rest is talk.
3. Opinion: speculation, predictions and reasons only as clearly marked opinion or question ("I think", "maybe", "could", "is that ...?", "we'll see"). Set "opinion": true on such lines. Rhetorical questions are welcome.
4. Never claim one model, engine, quantisation or card is better in general; only what happened in this match. Never mention watts or power.
5. Quotes from a model's note are rare (at most one per minute, only when the wording is funny or striking): word for word from a cited note fact, in quotation marks, at least three words.
6. Live feel: a line may only use facts from its own beat or earlier (no spoilers). Winner words only in the last beats.
7. One plain paragraph per line, no stage directions, no emoji, at most ${MAX_WORDS} words, usually 8 to 24. One or two short sentences. AI players are "it", never "he" or "she".
9. Plain words for viewers. No letter-and-digit codes: not NVFP4, EXL3, 4.0bpw, MTP3, TP2 and the like. Translate them with the "In plain words" part of the spec facts ("a 4-bit version", "squeezed to 4 bits", "a speed-up trick that guesses several words ahead", said once at most). The model size (27B) and GPU names (RTX 5090, RTX 5060 Ti) are fine. Say what a difference means ("two different 4-bit formats") instead of naming the format.
8. A line with "interject": true is a reaction of at most 4 words that may overlap the other caster ("Oh!", "No way!", "Ha, brutal.").

DENSITY (important): the casters talk almost the whole video. Spoken pace is about 2.9 words per second; each beat shows its room in words (together about ${nBudget}). Fill 85 to 95 percent of every beat's room, in quiet stretches too: banter, what the models planned earlier (in your own words, cite the notes), who thinks slower, how the economy looks, a prediction, a joke. Leave only short natural breathing gaps. Alternate speakers, mostly one to three lines each before the other answers; hand over with a question now and then.

OUTPUT: only JSON, no text around it:
{"lines":[{"beat":<number>,"speaker":"pbp"|"ana","when":"before"|"at"|"react"|"after","delivery":"${DELIVERY.join('"|"')}","text":"...","facts":["f12"],"subject":"s3","opinion":false,"interject":false}]}
"when" places the line around the moment of its beat: before (a slight lead, tension), at, react (right after, very short), after (explanation after the moment). Lines are spoken in beat order; within a beat: before, at, react, after. delivery is the mood for the voice: hype (loud, fast), calm, question, laugh, tense.`;
  if (sheet.story) system = storySystem(system, sheet, beats, duration_s);
  const facts = sheet.facts.map((f) => `${f.id} [${f.kind}] ${f.text}${f.data?.eid != null ? ` {event ${f.data.eid}}` : ''}${f.data?.v_end != null ? ` {fight ends on screen at video ${Math.floor(f.data.v_end / 60)}:${String(Math.floor(f.data.v_end % 60)).padStart(2, '0')}: tell losses, kills, duration and the winner of this fight only from then on; before that only what is visible}` : ''}`).join('\n');
  const user = `MATCH: ${sheet.game}, class ${sheet.cls || 'n/a'}, ${sheet.players.length} players.
${sheet.players.map((q) => `- player ${q.p}: say "${q.short}"${q.say !== q.short ? ` or "${q.say}"` : ''} (full name: ${q.name}; hardware: ${q.hw})`).join('\n')}

FACT SHEET (the only things you may state)
${facts}

SUBJECTS (what the camera can show)
${(sheet.subjects || []).map((q) => `${q.id} ${q.label} [${q.kind}${q.role ? `, ${q.role}` : ''}]`).join('\n')}

BEATS (the moments of the video, in order; "speed" is the playback speed shown on screen)
${beats.map((b) => describeBeat(b, sheet)).join('\n')}

Write the whole dialogue now: hype welcome from Dex in beat 1 followed by Juno introducing the players, most beats get two to five lines, the slow-motion decisions get the most (before, the plan in plain words, the reaction, the doubt), a strong closing in the last beat. Keep the clock honest: nothing from a later beat.`;
  return { system, user: sheet.story ? user.replace(/Write the whole dialogue now:[\s\S]*$/, STORY_USER) : user, rules_hash: rules.hash };
}

// ---------------------------------------------------------------- the story cut: the prompt gets the chapter structure
const STORY_USER = `Write the whole dialogue now, as one running conversation of Dex and Juno. Every beat belongs to a chapter and has a type (see THE STORY CUT): both casters talk in every stretch, fill the freeze frames and the run-ups before them with the real explanation in plain words, translate notes and orders instead of reading them out, ask the question before the consequence and answer it afterwards. Keep the clock honest: nothing from a later beat. Aim for about 2.4 words per second over the whole video.`;
function storySystem(base, sheet, beats, duration_s) {
  const ch = sheet.story.chapters.map((c) => `${c.title} (${c.o0.toFixed(0)}-${c.o1.toFixed(0)} s)`).join(', ');
  let s = base
    .replace(/viewers watch a \d+ second highlight video with a camera that flies to whatever the casters talk about\./, `viewers watch a ${Math.round(duration_s)} second story of the whole match with a camera that flies to whatever the casters talk about. The video explains what the two models see, think and order, and the game stops (freeze frame) at every key decision while the casters explain.`)
    .replace(/\nHOW A DECISION IS CAST[\s\S]*?\n\nNAMES:/, '\nNAMES:')
    .replace(/DENSITY \(important\)[\s\S]*?\n\nOUTPUT:/, 'DENSITY (important): the casters talk almost all the time, back and forth. Spoken pace is about 2.9 words per second; each beat shows its room in words. Fill 80 to 95 percent of every beat\'s room (a freeze frame of 11 seconds has room for about 30 words: two or three lines). Leave only short natural breathing gaps. Alternate speakers all the time.\n\nOUTPUT:');
  const story = `
THE STORY CUT (chapters: ${ch})
The video tells the match from the start to the end. Dex and Juno tell it together: Dex says what happens and asks, Juno explains what the models see, think and order, in plain words, and whether it was right. The beat types:
- OPENING: Dex gives one short hype welcome and asks who is playing, Juno introduces both players (names, model, hardware once) and what is at stake.
- RUN-UP (the game runs at 1x toward a key decision, the screen shows the deciding model's fog of war view): the two set the scene with the facts of the beat: what the model could see, where its army stands. Build the question: what will it do?
- FREEZE FRAME (the game is paused, the screen shows each deciding model's note and orders in cards): this is the heart of the show. Dex asks what the model does, Juno says in plain words what it saw, what it plans and what it orders, and one of them asks out loud whether that was the right call. When two decisions are shown side by side, compare the two plans. The cards show the note word for word, so the casters do not need to read it.
- CONSEQUENCE (the game runs on): they answer the question with the facts of the beat (army values, units lost, buildings razed) and explain what the decision led to, as an opinion where it is a judgement ("I think that was the turning point").
- FAST FORWARD (build, the game runs fast): they talk through the strategy of both sides in plain words: what each model is trying to do, what worries it, who is ahead and why. A few numbers from the econ facts where they carry the point, never a list of ${classWord('workers', 'unit', 'worker')}, buildings and clock times.
- ACTION (battle, razed, base): Dex calls it, short punchy sentences, Juno reacts.
- TIER UP / FIRST CONTACT: Dex says it, Juno says what it means for the plan.
- VICTORY: Dex's final call, then the RECAP: the two talk through why it was won (use the why facts), calm and clear, then a closing line.
TENSION, INTENT, DEX RUNS, LINGO, FOG OF WAR: follow the BROADCAST RULES above. In this cut: open a question before a freeze frame or a fight and answer it after; explain intent in the fast-forward stretches; the fog of war view (the deciding model's own view) is shown during run-ups and freeze frames, say it where it helps, once or twice.
The chapter titles are on a bar at the bottom; you may announce a new chapter naturally by what happens, but never with a meta line like "Chapter one" or "next chapter". Every freeze frame has its own subject camera: put "subject" on each line.
Never say a number that is not in a cited fact. The decision numbers (decision 54) are in the facts and may be said.`;
  s = s.replace('\nNAMES:', story + '\n\nNAMES:');
  return s;
}

// ---------------------------------------------------------------- LLM
export function parseLlm(text) {
  let t = String(text).replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  const arr = t.indexOf('['), arrEnd = t.lastIndexOf(']');
  let j;
  try { j = JSON.parse(a >= 0 && (arr < 0 || a < arr) ? t.slice(a, b + 1) : t.slice(arr, arrEnd + 1)); } catch (e) { throw new Error(`the LLM answer is not JSON: ${e.message}`); }
  const list = Array.isArray(j) ? j : j.lines;
  if (!Array.isArray(list)) throw new Error('the LLM answer has no "lines" array');
  return list.map((l) => normaliseLine(l));
}
const SPEAKER = { pbp: 'pbp', ana: 'ana', 'play-by-play': 'pbp', analyst: 'ana', dex: 'pbp', juno: 'ana' };
export function normaliseLine(l) {
  return {
    beat: Number(l.beat), speaker: SPEAKER[String(l.speaker || '').toLowerCase()] ?? l.speaker, when: ['before', 'at', 'react', 'after'].includes(l.when) ? l.when : 'at',
    delivery: String(l.delivery || (String(l.text || '').includes('?') ? 'question' : 'calm')).toLowerCase(), text: String(l.text ?? '').replace(/\s+/g, ' ').trim(),
    facts: Array.isArray(l.facts) ? l.facts.map(String) : [], subject: l.subject ? String(l.subject) : null, show: l.show ?? null, opinion: !!l.opinion, interject: !!l.interject,
    ...(Number.isFinite(l.at_s) ? { at_s: l.at_s } : {}), ...(l.keep ? { keep: true, optional: false } : {}), // a hand-written script: its own start second, said in full
  };
}

export function parseLlmArg(s) { const [base, model, ...key] = String(s).split(','); return { base: base.replace(/\/$/, ''), model, key: key.join(',') || process.env.OPENAI_API_KEY || '' }; }

async function chat(cfg, messages) {
  const res = await fetch(`${cfg.base}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(cfg.key ? { authorization: `Bearer ${cfg.key}` } : {}) },
    body: JSON.stringify({ model: cfg.model, messages, temperature: 0.8, max_tokens: 6000 }), signal: AbortSignal.timeout(cfg.timeout_ms || 300000),
  });
  if (!res.ok) throw new Error(`LLM endpoint answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return j.choices?.[0]?.message?.content ?? '';
}
// cached by hash of (model, messages): the same prompt never calls the endpoint twice, and a saved answer can be dropped into the cache by hand
export const cacheKey = (model, messages) => sha(JSON.stringify([model, messages]));
export async function askLlm(cfg, messages, cacheDir) {
  const key = cacheKey(cfg.model, messages);
  const file = cacheDir ? path.join(cacheDir, `${key}.json`) : null;
  if (file && fs.existsSync(file)) { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return { text: j.response, key, cached: true, model: j.model || cfg.model, note: j.note || null }; }
  const text = await chat(cfg, messages);
  if (file) { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify({ model: cfg.model, key, response: text }, null, 1)); }
  return { text, key, cached: false, model: cfg.model, note: null };
}

// ---------------------------------------------------------------- the whole track
export async function makeCasterTrack({ ev, plan, cls = '', llm = null, llmOutput = null, cacheDir = null, seed = 0, rounds = 2, fill = true, log = () => {} }) {
  const { sheet, beats, duration_s } = buildScript(ev, plan, { cls });
  const world = new World(ev), rules = loadRules();
  const ctx = makeContext(sheet, beats, { world });
  { // A3 (05.11.): a fight has an end on screen. v_end = output time at which its last tick is shown; results (losses, kills, duration, winner of the fight) may be told from then on
    const tl0 = timelineOf(plan);
    for (const f of sheet.facts) if (f.kind === 'battle' && f.data?.t_end != null) f.data.v_end = +tl0.outAt(f.data.t_end).toFixed(2);
  }
  const prompt = buildPrompt(sheet, beats, duration_s, rules);
  const messages = [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }];
  const tl = timelineOf(plan);
  const info = { source: 'template', model: null, prompt_hash: sha(JSON.stringify(messages)), rules_hash: rules.hash, show_invalid: [], template_dropped: [], cached: null, note: null, rounds_used: 0, rejected_first_pass: [], replaced: [], llm_error: null, repeated_dropped: [], fill: null };
  let lines = null;
  if (llmOutput) {
    const raw = fs.readFileSync(llmOutput, 'utf8');
    try { const j = JSON.parse(raw); lines = parseLlm(typeof j.response === 'string' ? j.response : raw); info.model = j.model || 'saved answer'; info.note = j.note || null; } catch (e) { info.llm_error = e.message; }
    if (lines) info.source = 'llm';
  } else if (llm) {
    try {
      const r = await askLlm(llm, messages, cacheDir);
      lines = parseLlm(r.text); info.source = 'llm'; info.model = r.model; info.cached = r.cached; info.note = r.note;
      let res = checkLines(lines, ctx);
      const allOk = (r) => r.ok && !r.badShow.length;
      info.rejected_first_pass = res.bad.map((b) => ({ beat: b.line.beat, text: b.line.text, reasons: b.reasons }));
      for (let round = 0; round < rounds && !allOk(res); round++) {
        info.rounds_used = round + 1;
        const fb = [...res.bad.map((b) => `line ${b.index}: ${b.reasons.join('; ')}`), ...res.badShow.map((b) => `line ${b.index}: show tag: ${b.reasons.join('; ')}`)].join('\n');
        const msgs = [...messages, { role: 'assistant', content: r.text }, { role: 'user', content: `The checker rejected these lines:\n${fb}\n\nRewrite ONLY those lines so they pass (keep the beat; fix or drop the wrong number, name or claim; fix or drop an invalid show tag). Answer with JSON {"lines":[{"index":<line number>, ...the line fields}]}.` }];
        let fix;
        try { fix = await askLlm(llm, msgs, cacheDir); } catch (e) { info.llm_error = e.message; break; }
        let j; try { j = JSON.parse(fix.text.slice(fix.text.indexOf('{'), fix.text.lastIndexOf('}') + 1)); } catch { break; }
        for (const f of j.lines || []) if (Number.isInteger(f.index) && lines[f.index]) lines[f.index] = normaliseLine({ ...lines[f.index], ...f });
        res = checkLines(lines, ctx);
      }
    } catch (e) { info.llm_error = e.message; lines = null; log(`LLM failed: ${e.message}`); }
  }
  const tpl = (opts) => { // the template must pass the checker itself; a line that does not is dropped, never shipped (and counted, so a template bug is visible)
    const ls = templateLines(sheet, beats, { seed, world, tl, ...opts }), r = checkLines(ls, ctx);
    if (r.ok) return ls;
    info.template_dropped.push(...r.bad.map((b) => ({ beat: b.line.beat, text: b.line.text, reasons: b.reasons })));
    return ls.filter((l, i) => !r.bad.some((b) => b.index === i));
  };
  if (!lines) lines = tpl({});
  else {
    // repair: lines that still fail are replaced by the template lines of their beat
    let res = checkLines(lines, ctx);
    if (!info.rejected_first_pass.length) info.rejected_first_pass = res.bad.map((b) => ({ beat: b.line.beat, text: b.line.text, reasons: b.reasons }));
    if (!res.ok) {
      // a hand-written script (keep) is said as written or not at all: a line the checker rejects stops the run, it is never swapped for template lines
      const handBad = res.bad.filter((b) => b.line.keep);
      if (handBad.length) throw new Error(`hand-written script: the checker rejects ${handBad.length} line(s): ${handBad.map((b) => `"${b.line.text}" (${b.reasons.join('; ')})`).join(' | ')}`);
      // no silent swap (Koordinator 06.11.): a rejected line stops the run with its reasons; only RTS_ALLOW_TEMPLATE_REPLACE=1 (dev, public tool) lets the template take its place and counts it in generated.replaced
      if (process.env.RTS_ALLOW_TEMPLATE_REPLACE !== '1') throw new Error(`${res.bad.length} line(s) rejected by the checker would be replaced by template lines, stopped: ${res.bad.map((b) => `"${b.line.text}" (${b.reasons.join('; ')})`).join(' | ')}`);
      const badBeats = new Set(res.bad.map((b) => b.line.beat));
      info.replaced = res.bad.map((b) => ({ beat: b.line.beat, text: b.line.text, reasons: b.reasons }));
      const keep = lines.filter((l, i) => !res.bad.some((b) => b.index === i));
      const repl = [...badBeats].flatMap((id) => tpl({ only: id }));
      lines = [...keep, ...repl];
      info.source = keep.length ? 'llm+template' : 'template';
    }
  }
  // the final check always runs: nothing leaves this function that fails
  // show tags: only valid ones go into the script (an invalid tag is dropped; the generic inferrer reads the line instead)
  for (const l of lines) {
    if (l.show == null) continue;
    const b = ctx.beats.get(l.beat), v = validateShow(l.show, world, b ? b.tick_end : ev.ticks);
    if (v.reasons.length) info.show_invalid.push({ beat: l.beat, text: l.text, reasons: v.reasons });
    l.show = v.tags.length ? (v.tags.length === 1 ? v.tags[0] : v.tags) : null;
  }
  // a line is never said twice in one video (a short interjection may come again): the later copy goes, whoever wrote it
  { const seenText = new Set(); lines = lines.filter((l) => { const k = normText(l.text); if (l.interject && wordsOfText(l.text) <= 4) return true; if (seenText.has(k)) { info.repeated_dropped.push({ beat: l.beat, text: l.text }); return false; } seenText.add(k); return true; }); }
  const final = checkLines(lines, ctx);
  if (!final.ok) throw new Error(`internal: lines still fail the checker: ${JSON.stringify(final.bad.map((b) => [b.line.text, b.reasons]))}`);
  const first = placeLines(withAlts(lines, ctx), beats, duration_s), dropped = first.dropped, warnings = first.warnings;
  let placed = first.placed;
  // a shorter version (alts) can equal an earlier line: the later copy goes (the gap-fill may use the time)
  { const seenText = new Set(); placed = placed.filter((p) => { const k = normText(p.text); if (p.interject && wordsOfText(p.text) <= 4) return true; if (seenText.has(k)) { dropped.push({ line: p, why: 'said before (shorter version equals an earlier line)' }); return false; } seenText.add(k); return true; }); placed.forEach((p, i) => { p.id = `L${i + 1}`; }); }
  if (fill) {
    const fr = fillGaps({ placed, beats, sheet, ctx, ev, tl, world, duration: duration_s, seed });
    info.fill = { lines: fr.fills.length, facts: fr.added_facts, rejected: fr.rejected.slice(0, 20), rejected_n: fr.rejected.length };
    placed = [...placed, ...fr.fills].sort((a, b) => a.start - b.start || a.end - b.end);
    placed.forEach((p, i) => { p.id = `L${i + 1}`; });
  }
  const timing = validateTiming(placed, duration_s);
  const cues = placed.flatMap((p) => cuesOf(p).map((c) => ({ ...c, speaker: p.speaker, name: CASTERS[p.speaker].short, role: CASTERS[p.speaker].role, color: CASTERS[p.speaker].color, line: p.id, delivery: p.delivery, subject: p.subject ?? null }))).sort((a, b) => a.s0 - b.s0);
  const focus = focusPlan(placed, beats, sheet, duration_s);
  const q = commentaryStats({ duration_s, beats, lines: placed });
  const stats = { show_tagged: placed.filter((p) => p.show).length, lines: placed.length, words: q.words, words_per_s: q.words_per_s, talk_fraction: q.talk_fraction, longest_gap_s: q.longest_gap_s, focus_changes: Math.max(0, focus.length - 1), filled_lines: placed.filter((p) => p.fill).length, repeated_lines: q.repeated_lines, repeated_sentences: q.repeated_sentences, first_line_delay_s: q.first_line_delay_s, max_lag_s: q.max_lag_s };
  const track = {
    version: 2, stats, focus, subjects: sheet.subjects, replay: ev.replay, duration_s, casters: CASTERS, generated: info, beats, facts: sheet.facts.map(({ id, kind, tick, text, data }) => ({ id, kind, tick, text, ...(data?.v_end != null ? { tick_end: data.t_end, v_end: data.v_end } : {}) })),
    lines: placed.map((p) => ({ id: p.id, beat: p.beat, speaker: p.speaker, caster: CASTERS[p.speaker].name, start: p.start, end: p.end, duration_s: p.dur, delivery: p.delivery, text: p.text, facts: p.facts, subject: p.subject ?? null, show: p.show ?? null, opinion: p.opinion, interject: !!p.interject, when: p.when, ...(p.fill ? { fill: true } : {}), ...(p.at_s != null ? { at_s: p.at_s } : {}), cues: cuesOf(p) })),
    cues, dropped: dropped.map((d) => ({ beat: d.line.beat, text: d.line.text, why: d.why })), warnings: [...warnings, ...final.warnings], timing_issues: timing, check: { ok: true, lines: lines.length, placed: placed.length },
  };
  return { track, srt: toSrt(placed), tts: ttsManifest(placed, CASTERS, { duration_s }), prompt, sheet, beats, ctx };
}

export function writeTrack(dir, base, r) {
  fs.mkdirSync(dir, { recursive: true });
  const files = { json: path.join(dir, `${base}-casters.json`), srt: path.join(dir, `${base}-casters.srt`), tts: path.join(dir, `${base}-casters-tts.json`), prompt: path.join(dir, `${base}-casters-prompt.json`) };
  fs.writeFileSync(files.json, JSON.stringify(r.track, null, 1));
  fs.writeFileSync(files.srt, r.srt);
  fs.writeFileSync(files.tts, JSON.stringify(r.tts, null, 1));
  fs.writeFileSync(files.prompt, JSON.stringify({ prompt_hash: r.track.generated.prompt_hash, rules_hash: r.track.generated.rules_hash, messages: [{ role: 'system', content: r.prompt.system }, { role: 'user', content: r.prompt.user }] }, null, 1));
  return files;
}

// ---------------------------------------------------------------- CLI
async function main() {
  const a = process.argv.slice(2);
  const opt = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : null);
  const src = a.find((x, i) => !x.startsWith('--') && !(a[i - 1] || '').startsWith('--'));
  if (!src) { console.error('usage: node tools/casters.mjs replays/<id> [--cut highlight|full] [--target 80,100] [--class "32 GB"] [--out dir] [--llm base_url,model[,key]] [--llm-output file] [--plan plan.json] [--no-fill] [--dump-prompt]'); process.exit(2); }
  const { loadReplay } = await import('./lib/replay.mjs');
  const { prepare } = await import('./render-broadcast.mjs');
  const rep = loadReplay(src);
  const { ev, plans } = prepare(rep, { target: opt('--target') || undefined, 'no-moments': a.includes('--no-moments') });
  const cut = opt('--cut') === 'full' ? 'full' : 'highlight';
  if (opt('--plan')) plans[cut] = JSON.parse(fs.readFileSync(opt('--plan'), 'utf8'));
  const outDir = path.resolve(opt('--out') || path.join(rep.dir, 'broadcast'));
  const cls = opt('--class') || rep.start.class || '';
  const llm = opt('--llm') ? parseLlmArg(opt('--llm')) : null;
  const r = await makeCasterTrack({ ev, plan: plans[cut], cls, llm, llmOutput: opt('--llm-output'), cacheDir: path.join(outDir, 'llm-cache'), seed: +(opt('--seed') || 0), rounds: +(opt('--rounds') || 2), fill: !a.includes('--no-fill'), log: console.log });
  const files = writeTrack(outDir, `${rep.id}-${cut}`, r);
  console.log(`${r.track.lines.length} lines (${r.track.generated.source}), ${r.track.cues.length} cues, dropped ${r.track.dropped.length}, rejected by the checker in the first pass: ${r.track.generated.rejected_first_pass.length}`);
  console.log(Object.values(files).join('\n'));
  if (a.includes('--dump-prompt')) console.log(r.prompt.system + '\n\n' + r.prompt.user);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e); process.exit(1); });
