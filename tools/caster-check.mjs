// Strict checker for caster lines. A line passes only if every number, name and claim can be traced to the fact sheet.
//   checkLine(line, ctx) -> { ok, reasons: [..] }       ctx = makeContext(sheet, beats)
//   checkLines(lines, ctx) -> { ok, bad: [{ index, line, reasons }] }
// What is checked (see README, Broadcast module / casters):
//   numbers   every number, number word and clock must appear in a fact the line cites (or in the beat: its clock, speed badge, own facts)
//   names     capitalised words, codes like TP2 / EXL3 / 5090 must come from the log; model and hardware phrases must match a player;
//             a distinctive part of a player name (Zoe, kit) only counts with the whole short name
//   claims    no watts, no general superiority claims, no "proves", no vague multipliers (twice, half)
//   opinion   prediction or cause words need a hedge or a question mark, or a quote of the model's own note
//   quotes    text in quotation marks must be a word-for-word piece of a cited note
//   time      a line may not use a fact from after the end of its beat (no spoilers); winner words only at the end
//   format    one paragraph, no lists, no stage directions, delivery tag from the closed list, length limits
import '../server/local-env.mjs'; // RTS_* defaults from local-env.json
import { CASTERS, numbersIn, aliasesOf } from './caster-facts.mjs';
import { MOMENTS } from './commentary.mjs';
import { validateShow } from './show-tags.mjs';
import { themeVocabulary } from './lib/theme-words.mjs';

export const DELIVERY = ['hype', 'calm', 'question', 'laugh', 'tense'];
export const MAX_WORDS = 38;
const SPOILER_TICKS = 25;

const WORDNUM = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, dozen: 12 };
const ORDINAL = { third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12 };
const TWO_OK = /^(ent|models?|sides?|players?|teams?|armies|ais?|casters?|machines?|bots?|minds?|setups?|of|engines?|gpus?|cards?|kinds?|fronts?|of them|more)\b/;
const APPROX = /^(about|around|roughly|nearly|almost|over|under|some|approximately|close|than|more|less)$/;
const VAGUE_MULT = /\b(twice|double[sd]?|triple[sd]?|tripling|doubling|half|halved|halves|quarter|percent|per cent)\b|%/i;
const WATTS = /\b(watts?|kilowatts?|kw|kwh|power draw|power limit|power consumption|\d+\s?w)\b/i;
const GENERAL = [
  /\b(better|smarter|stronger|superior|worse|dumber|weaker|inferior)\s+(model|quant|quantization|engine|recipe|setup|hardware|gpus?|kit|ai|llm|brain)\b/i,
  /\b(best|worst|greatest|strongest|smartest)\s+(model|quant|quantization|engine|recipe|setup|hardware|gpus?|kit|ai|llm|brain)\b/i,
  /\b(in general|generally|across the board|state[- ]of[- ]the[- ]art|always better|never better|proves?|proof that|proven|objectively)\b/i,
  /\b(better|faster|smarter|stronger)\s+(than)\s+(every|all|any)\b/i,
];
const PREDICT = /\b(will|won't|going to|gonna|is bound to|has to|must|inevitabl\w+|no way (?:back|out))\b/i;
const CAUSE = /\b(because|that's why|that is why|which is why|the reason|thanks to|due to|so that)\b/i;
export const HEDGE = /\b(i think|i guess|i bet|i suspect|i'd say|i would say|my guess|maybe|perhaps|probably|possibly|might|could|looks like|looks to me|seems|feels like|if |is that|are they|does that|do they|can they|would|wonder|not sure|whether)\b|\?/i;
const WIN_WORDS = /\b(wins?|won|winner|victory|victorious|takes the match|game over|gg)\b/i;
const OK_CAPS = new Set(['i', "i'm", "i'll", "i'd", "i've", 'oh', 'ok', 'okay', 'wow', 'hey', 'no', 'yes', 'ai', 'ais', 'llm', 'llms', 'gpu', 'gpus', 'rts', 'tts', 'gg', 'hp', 'ui', 'vs', 'tc', 'ko', 'wait', 'whoa', 'boom', 'bam', 'ouch', 'nope']);
const SUBJECT_VERB = /^(is|was|has|had|takes|took|goes|went|wins|won|loses|lost|sends|sent|makes|made|gets|got|knows|says|said|looks|puts|comes|did|does|will|can|would|writes|thinks|builds|attacks|pushes)\b|^['’]s\b/i;
const COMMON_START = new Set(['that', 'it', 'this', 'there', 'here', 'what', 'who', 'he', 'she', 'they', 'we', 'you', 'which', 'one', 'nobody', 'everyone', 'everything', 'nothing', 'something', 'time', 'luck', 'army', 'value', 'both', 'each', 'all', 'now', 'then', 'so', 'and', 'but', 'well', 'look', 'how', 'why', 'when', 'where', 'whose', 'did', 'do', 'does', 'is', 'are', 'was', 'were', 'can', 'could', 'would', 'will', 'should', 'if', 'as', 'not', 'yes', 'no', 'just', 'still', 'only', 'even', 'every', 'any', 'some', 'many', 'much', 'more', 'less', 'once', 'twice', 'too', 'not', 'never', 'always', 'maybe', 'perhaps', 'honestly', 'frankly', 'clearly']);
const STAGE = /(\*[^*]+\*|\[[^\]]*\]|\([^)]*\)|<[^>]+>)/;
const EMOJI = /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/u;

const norm = (s) => String(s).toLowerCase().replace(/[“”"‘’']/g, '').replace(/[^a-z0-9+.\-\s]/g, ' ').replace(/(?<!\d)\.|\.(?!\d)/g, ' ').replace(/\s+/g, ' ').trim();
const wordsOf = (s) => String(s).split(/\s+/).filter(Boolean);
const stripEdge = (t) => t.replace(/^[^\w“"(]+|[^\w”")+%]+$/g, '');

export function makeContext(sheet, beats, opts = {}) {
  const facts = new Map(sheet.facts.map((f) => [f.id, f]));
  const vocab = new Set();
  const addWords = (s) => { for (const w of String(s).split(/[\s,;:!?()“”"]+/)) { const t = w.replace(/^[^\w]+|[^\w+]+$/g, '').toLowerCase().replace(/['’]s$/, ''); if (t) vocab.add(t); } };
  const entities = [];
  for (const q of sheet.players) { const al = q.aliases || aliasesOf(q.short); for (const s of [q.name, q.short, q.model, q.hw, ...al]) { addWords(s); } entities.push(q.name, q.short, q.model, q.hw, ...al); }
  for (const q of sheet.players) if (q.creator) { addWords(q.creator); entities.push(q.creator); }
  for (const c of Object.values(sheet.casters || CASTERS)) { addWords(c.name); addWords(c.short); }
  addWords(sheet.game);
  for (const f of sheet.facts) addWords(f.text);
  for (const w of (process.env.RTS_EXTRA_VOCAB || '').split(',').filter(Boolean)) addWords(w); // Hardware Cup (07.11.): engine and recipe names the commentary may still say although the label is the hardware
  for (const w of themeVocabulary()) addWords(w); // C1: the words of the active theme are game vocabulary, like the lower case classic words (nothing is added for classic)
  // distinctive name parts: appear in one player's short name only
  const partOwners = new Map();
  for (const q of sheet.players) for (const w of q.short.split(/\s+/)) { const k = w.toLowerCase(); if (!partOwners.has(k)) partOwners.set(k, new Set()); partOwners.get(k).add(q.p); }
  const distinct = [];
  for (const q of sheet.players) {
    const parts = q.short.split(/\s+/);
    if (parts.length < 2) continue;
    const phrases = (q.aliases || aliasesOf(q.short)).map((x) => x.toLowerCase());
    for (const w of parts) if (w.length > 1 && partOwners.get(w.toLowerCase()).size === 1) distinct.push({ word: w.toLowerCase(), phrase: q.short.toLowerCase(), phrases });
  }
  // everything that names a model, a setup or a card: such strings are checked as names, not as numbers
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pats = new Set();
  for (const e of entities.filter(Boolean)) { pats.add(esc(e)); for (const w of e.split(/\s+/)) if (/\d/.test(w) && /[A-Za-z]/.test(w)) pats.add(esc(w.replace(/[,;]$/, ''))); }
  for (const q of sheet.players) for (const m of q.hw.matchAll(/\b(\d{4})(?:\s*Ti)?\b/g)) pats.add(`(?:\\d+x\\s+)?(?:RTX\\s+)?${m[1]}(?:\\s*Ti)?s?`);
  if (sheet.cls) pats.add(esc(sheet.cls));
  for (const q of sheet.players) for (const m of q.hw.matchAll(/\d+\s*GB/g)) pats.add(esc(m[0]));
  const entityRes = [...pats].sort((a, b) => b.length - a.length).map((x) => new RegExp(`(?<![A-Za-z0-9])${x}(?:['’]s)?(?![A-Za-z0-9])`, 'gi')); // regex-safe: pats holds escaped text
  return { esc, sheet, world: opts.world || null, beats: new Map(beats.map((b) => [b.id, b])), facts, vocab, entities: entities.filter(Boolean), entityRes, distinct };
}

// numbers a line says: returns [{ value, kind: 'num'|'clock'|'word', raw, approx }]
export function extractNumbers(text, ctx) {
  let t = String(text);
  // known names and hardware strings carry digits (Qwen3.8-27B, 1x RTX 5090 32 GB): they are checked as names, not as numbers
  if (ctx) for (const re of ctx.entityRes) t = t.replace(re, ' ENT ');
  const toks = t.split(/\s+/).filter(Boolean);
  const res = [];
  for (let i = 0; i < toks.length; i++) {
    const raw = toks[i];
    const tk = stripEdge(raw).replace(/['’]s$/, '');
    const low = tk.toLowerCase();
    const prev = (toks[i - 1] || '').toLowerCase().replace(/[^a-z]/g, '');
    const prev2 = (toks[i - 2] || '').toLowerCase().replace(/[^a-z]/g, '');
    const approx = APPROX.test(prev) || APPROX.test(prev2);
    let m;
    if (/^\d{1,2}:\d{2}$/.test(tk)) { res.push({ kind: 'clock', raw: tk, value: tk, approx: false }); continue; }
    if ((m = /^(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(x|k|s|ms|th|st|nd|rd|%)?$/i.exec(tk))) {
      let v = Number(m[1].replace(/,/g, '') + (m[2] || ''));
      const suf = (m[3] || '').toLowerCase();
      if (suf === 'k') v *= 1000;
      if (suf === 'ms') { res.push({ kind: 'num', raw: tk, value: v, approx }); continue; }
      res.push({ kind: 'num', raw: tk, value: v, approx, suffix: suf });
      continue;
    }
    // number words, also "twenty-one", "two hundred", "three thousand"
    const parts = low.split('-');
    if (parts.every((p) => p in WORDNUM) && !(low === 'one' && !(/^(hundred|thousand)/.test((toks[i + 1] || '').toLowerCase())))) {
      let v = parts.reduce((a, p) => a + WORDNUM[p], 0);
      let j = i + 1;
      while (j < toks.length) {
        const nx = stripEdge(toks[j]).toLowerCase();
        if (nx === 'hundred') { v = (v || 1) * 100; j++; } else if (nx === 'thousand') { v = (v || 1) * 1000; j++; } else if (nx === 'and' && /^(hundred|thousand)?$/.test('') && toks[j + 1] && stripEdge(toks[j + 1]).toLowerCase() in WORDNUM && v >= 100) { j++; } else if (nx in WORDNUM && v >= 100 && v % 100 === 0 && WORDNUM[nx] < 100) { v += WORDNUM[nx]; j++; } else break;
      }
      const next = (toks[j] || '').toLowerCase().replace(/[^a-z ]/g, '');
      res.push({ kind: 'word', raw: tk, value: v, approx, two: v === 2 && TWO_OK.test(next) });
      i = j - 1;
      continue;
    }
    if (low === 'hundred' || low === 'thousand' || low === 'hundreds' || low === 'thousands') { res.push({ kind: 'word', raw: tk, value: low.startsWith('h') ? 100 : 1000, approx }); continue; }
    if (low in ORDINAL) { res.push({ kind: 'word', raw: tk, value: ORDINAL[low], approx }); continue; }
  }
  return res;
}

function allowedFor(line, beat, ctx) {
  const nums = new Set(), clocks = new Set();
  const take = (text) => { const n = numbersIn(text); n.nums.forEach((v) => nums.add(v)); n.clocks.forEach((c) => clocks.add(c)); };
  const cited = (line.facts || []).map((id) => ctx.facts.get(id)).filter(Boolean);
  for (const f of cited) take(f.text);
  if (beat) {
    for (const id of beat.facts) take(ctx.facts.get(id)?.text || '');
    clocks.add(beat.clock);
    nums.add(Math.round(beat.speed * 100) / 100);
    if (beat.slow) nums.add(MOMENTS.speed);
  }
  return { nums, clocks, cited };
}

const sentences = (t) => String(t).split(/(?<=[.!?…])\s+(?=[“"(]?[A-Z0-9])/).filter(Boolean);

export function checkLine(line, ctx) {
  const reasons = [];
  const bad = (r) => reasons.push(r);
  const text = String(line.text ?? '').replace(/’/g, "'");
  const beat = ctx.beats.get(line.beat);
  if (!beat) bad(`unknown beat ${line.beat}`);
  if (!CASTERS[line.speaker]) bad(`unknown speaker "${line.speaker}" (use pbp or ana)`);
  if (!DELIVERY.includes(line.delivery)) bad(`delivery must be one of ${DELIVERY.join(', ')}`);
  if (!text.trim()) { bad('empty text'); return { ok: false, reasons }; }
  const nw = wordsOf(text).length;
  if (nw > MAX_WORDS) bad(`too long: ${nw} words, at most ${MAX_WORDS}`);
  if (/\n/.test(text) || /^\s*([-*•]|\d+[.)])\s/.test(text)) bad('one plain paragraph, no list');
  if (STAGE.test(text)) bad('no stage directions or markup in the text (the delivery tag carries the mood)');
  if (EMOJI.test(text)) bad('no emoji');
  if (/\b(?:null|undefined|NaN)\b|\[object /.test(text)) bad('broken text from a template (null, undefined, NaN)');
  if (/\ba (?!one\b|once\b)[aeio]\w/i.test(text.replace(/[“"][^”"]*[”"]/g, ' '))) bad('"a" in front of a vowel: "an"');
  if (/(?:'s){2}\b/i.test(text)) bad('a doubled possessive ("Zoe\'s\'s"): a name that already has a possessive or ends in s takes no second \'s (tools/lib/names.mjs poss())');
  { const outside = text.replace(/[“"][^”"]*[”"]/g, ' '); if (/\b(he|him|his|himself|she|her|hers|herself)\b/i.test(outside) && !/\b(dex|juno)\b/i.test(outside)) bad('AI players are "it", never "he" or "she" (BROADCAST-RULES.md)'); }
  if (line.interject && nw > 4) bad('an interjection has at most 4 words');
  if (line.subject != null && line.subject !== '' && beat && !(beat.subjects || []).includes(line.subject)) bad(`subject ${line.subject} is not one of the subjects of beat ${line.beat} (${(beat.subjects || []).join(', ') || 'none'})`);
  const cites = line.facts || [];
  for (const id of cites) if (!ctx.facts.has(id)) bad(`cites unknown fact ${id}`);
  const { nums, clocks, cited } = allowedFor(line, beat, ctx);

  // ---- numbers ----
  for (const n of extractNumbers(text, ctx)) {
    if (n.kind === 'clock') { if (!clocks.has(n.value)) bad(`clock ${n.raw} is not in a cited fact`); continue; }
    if (n.two && !nums.has(2)) continue; // "the two models"
    if (nums.has(n.value)) continue;
    if (n.suffix === 'x' && nums.has(n.value)) continue;
    if (n.approx && [...nums].some((a) => a > 0 && Math.abs(a - n.value) / a <= 0.1)) continue;
    bad(`number ${n.raw} is not in a cited fact`);
  }
  if (VAGUE_MULT.test(text) && !cited.some((f) => VAGUE_MULT.test(f.text))) bad('no vague multipliers (twice, double, half, percent): use a number from a fact');

  // ---- jargon: letter+digit codes (NVFP4, EXL3, 4.0bpw, TP2, MTP3) mean nothing to viewers; say it in plain words ("a 4-bit version", "a speed-up trick"). Allowed: model size (27B), GPU names, the player names themselves ----
  {
    let t = text.toLowerCase();
    for (const q of ctx.sheet.players) for (const nm of [q.short, ...(q.aliases || [])].filter(Boolean).sort((x, y) => y.length - x.length)) t = t.split(nm.toLowerCase()).join(' ');
    for (const raw of t.split(/\s+/)) {
      const tk = raw.replace(/^[^\w]+|[^\w+]+$/g, '').replace(/['’]s$/, '');
      if (!tk || !/\d/.test(tk) || !/[a-z]/.test(tk)) continue;
      if (/^\d+(\.\d+)?(st|nd|rd|th|x|k|s|ms|m|b|gb|mb|tb|ti)$/.test(tk)) continue; // 27b, 1.7x, 32gb, 5060ti
      if (/^qwen[\d.]*-\d+b$/.test(tk) || /^rtx$/.test(tk)) continue;
      bad(`jargon code "${tk}": say it in plain words for viewers (use the plain-language field of the spec fact: "4-bit", "a speed-up trick"); only model size like 27B and GPU names are fine`);
    }
  }

  // ---- names ----
  const rest = ctx.entityRes.reduce((t, re) => t.replace(re, ' '), text);
  const toks = rest.split(/\s+/).filter(Boolean);
  let startOfSentence = true;
  for (let ti = 0; ti < toks.length; ti++) {
    const raw = toks[ti];
    const tk = stripEdge(raw);
    const startHere = startOfSentence;
    startOfSentence = /[.!?…:]["”)]?$/.test(raw);
    if (!tk) continue;
    const low = tk.toLowerCase().replace(/['’]s$/, '');
    if (ctx.vocab.has(low) || ctx.vocab.has(low.replace(/s$/, ''))) continue;
    if (OK_CAPS.has(low)) continue;
    if (/\d/.test(tk) && /[A-Za-z]/.test(tk) && !/^\d+(st|nd|rd|th|x|k|s|ms)$/i.test(tk)) { bad(`"${tk}" is not a name or code from the log`); continue; }
    if (/^[A-Z]{2,}$/.test(tk)) { bad(`"${tk}" is not a name or code from the log`); continue; }
    if (/[a-z][A-Z]/.test(tk)) { bad(`"${tk}" is not a name from the log`); continue; }
    if (/^[A-Z][a-z]/.test(tk) && !startHere) bad(`"${tk}" is a name that is not in the log`);
    else if (/^[A-Z][a-z]/.test(tk) && startHere && !/[,;:]$/.test(raw) && !COMMON_START.has(low) && SUBJECT_VERB.test(toks[ti + 1] || '')) bad(`"${tk}" is a name that is not in the log`); // an invented name at the start of a sentence ("Bob takes ...")
  }
  for (const m of text.matchAll(/\b(?:(\w+)\s+)?(?:(\d+)x\s+)?(?:RTX\s+)?(5090|5060\s*Ti|5060|4090|4080|4070|3090|H100|A100|B200)s?\b/gi)) {
    const core = m[3].replace(/\s+/g, '').toLowerCase();
    const owner = ctx.sheet.players.find((q) => q.hw.toLowerCase().replace(/\s+/g, '').includes(core));
    // a plain number that equals a GPU model number (an army value of 4070) is a number, if a cited fact has it and the words before it do not talk about hardware (on, runs, GPU, card, RTX)
    if (!owner && /^\d+$/.test(core) && nums.has(Number(core)) && !/\b(on|runs?|running|gpu|card|hardware|rtx)\b/i.test(text.slice(Math.max(0, m.index - 8), m.index + m[0].length))) continue;
    if (!owner) { bad(`hardware "${m[0].trim()}" is not in the log`); continue; }
    const cnt = /^(\d+)x/.exec(owner.hw);
    const word = (m[1] || '').toLowerCase();
    const said = m[2] ? Number(m[2]) : word in WORDNUM ? WORDNUM[word] : null;
    if (said != null && cnt && said !== Number(cnt[1])) bad(`hardware count ${said} does not match "${owner.hw}"`);
  }
  if (/\brtx\b/i.test(text) && !/\b(5090|5060)/i.test(text) && !/\brtx\b/i.test(rest)) { /* RTX only inside an entity: fine */ }
  const low = text.toLowerCase();
  for (const d of ctx.distinct) {
    if (process.env.RTS_ALLOW_ALONE === 'all' || (process.env.RTS_ALLOW_ALONE || '').split(',').includes(d.word.toLowerCase())) continue; // Hardware Cup (07.11.): the label is the hardware, the commentary says "the Mac", "the Spark", "the 5090"
    const stripped = [...d.phrases, ...ctx.sheet.players.map((q) => (q.creator || '').toLowerCase()).filter(Boolean)].sort((a, b) => b.length - a.length).reduce((t, ph) => t.split(ph).join(' '), low);
    if (new RegExp(`(?<![A-Za-z0-9])${ctx.esc(d.word)}(?![A-Za-z0-9])`).test(stripped)) bad(`"${d.word}" alone: use the whole name "${ctx.sheet.players.find((q) => q.short.toLowerCase() === d.phrase).short}"`);
  }

  // ---- claims ----
  if (WATTS.test(text)) bad('no power / watt talk');
  for (const g of GENERAL) { const m = g.exec(text); if (m) bad(`general claim "${m[0]}": only this match, never "better in general"`); }
  const hedged = HEDGE.test(text) || line.delivery === 'question';
  const quoteIn = [...text.matchAll(/[“"]([^”"]{8,})[”"]/g)].map((m) => m[1]);
  const notes = cited.filter((f) => (f.kind === 'note' || f.kind === 'say') && f.data?.quote); // a model's own note, or a line said in the match chat
  if (PREDICT.test(text.replace(/\b(we|you|let us|let's)( will|'ll)? (see|find out|know|learn)\b|\bwe will see\b|\bwe'll see\b/gi, ' ')) && !hedged) bad('a prediction needs a hedge ("I think", "maybe", a question)');
  if (CAUSE.test(text) && !hedged && !notes.length) bad('a reason needs a hedge, or cite the note that says it');
  if (line.opinion && !hedged) bad('marked as opinion but sounds like a fact: add "I think" / a question');
  for (const q of quoteIn) {
    const qn = norm(q).replace(/\.\.\./g, ' ');
    const ok = qn.split(/\s{2,}/).every((seg) => notes.some((f) => norm(f.data.quote).includes(seg.trim())));
    if (!ok || wordsOf(q).length < 3) bad(`quote “${q}” is not word for word from a cited note`);
  }
  if (cites.length === 0 && nw > 9 && !hedged && !/[!]/.test(text)) bad('a longer statement needs at least one cited fact');

  // ---- who wins, and nothing from the future ----
  const win = ctx.sheet.result?.winner;
  for (const s of sentences(text)) {
    if (!WIN_WORDS.test(s) || /\b(not|n't|never|no|if|could|maybe)\b/i.test(s)) continue;
    const named = ctx.sheet.players.filter((q) => (q.aliases || [q.short]).some((a) => s.toLowerCase().includes(a.toLowerCase())));
    if (named.length === 1 && win && named[0].p !== win) bad(`"${named[0].short}" does not win this match`);
    if (beat && !['victory', 'close'].includes(beat.kind) && !hedged && !/\b(win|won)\b.*\?/.test(s)) bad('winner words belong to the end of the video');
  }
  // the final numbers (the scoreboard) are the end screen: only the closing beat may say them
  if (beat && beat.kind !== 'close' && cited.some((f) => f.kind === 'final')) bad('the final numbers belong to the closing beat at the end screen');
  if (beat) for (const f of cited) if (f.tick != null && f.tick > beat.tick_end + SPOILER_TICKS) bad(`fact ${f.id} is from later in the match than this moment`);
  return { ok: reasons.length === 0, reasons };
}

export function checkLines(lines, ctx) {
  const warn = [];
  const byId = ctx.beats;
  const badLines = [], badShow = [];
  lines.forEach((line, index) => { const r = checkLine(line, ctx); if (!r.ok) badLines.push({ index, line, reasons: r.reasons }); });
  // show tags are checked against the log (they never make a line fail: an invalid tag is dropped and the inferrer reads the line)
  if (ctx.world) lines.forEach((line, index) => { if (line.show == null) return; const b = byId && byId.get(line.beat), v = validateShow(line.show, ctx.world, b ? b.tick_end : ctx.world.ev.ticks); if (v.reasons.length) badShow.push({ index, line, reasons: v.reasons }); });
  // Dex speaks in runs: his lines in one beat hold at least two sentences together (no lone shout with silence around it)
  if (byId) { const perBeat = new Map(); for (const l of lines) if (l.speaker === 'pbp' && !l.interject) { const o = perBeat.get(l.beat) || { n: 0 }; o.n += sentences(l.text).length; perBeat.set(l.beat, o); } for (const [b, o] of perBeat) if (o.n < 2 && byId.get(b)?.role === 'action') warn.push(`beat ${b}: Dex has a lone shout, not a run of two or three sentences`); }
  // conversation-level: not three lines in a row from one speaker, no copy-paste openings
  for (let i = 2; i < lines.length; i++) if (lines[i].speaker === lines[i - 1].speaker && lines[i].speaker === lines[i - 2].speaker && lines[i].beat === lines[i - 2].beat) warn.push(`lines ${i - 1}-${i + 1}: one speaker three times in a row`);
  const openings = new Map();
  for (const l of lines) { const k = wordsOf(l.text).slice(0, 2).join(' ').toLowerCase(); openings.set(k, (openings.get(k) || 0) + 1); }
  for (const [k, c] of openings) if (c > 2 && k.length > 3) warn.push(`opening "${k}" used ${c} times`);
  return { ok: badLines.length === 0, bad: badLines, badShow, warnings: warn };
}
