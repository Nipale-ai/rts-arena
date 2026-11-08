// Fact sheet and beat timeline for the two-caster commentary. Everything here comes from the match log (events.json) and the
// broadcast plan (which video second every game tick lands on after fast-forward / slow motion). Nothing is invented:
//   buildScript(ev, plan, opts) -> { sheet, beats, duration_s }
//   sheet.facts   = numbered facts (id, kind, tick, text, nums): the only thing a caster line may claim
//   beats         = the moments of the video the casters talk about, each with a video-time window and a word budget
// Pure functions of their inputs (no clocks, no randomness).
import '../server/local-env.mjs'; // RTS_* defaults from local-env.json
import { readFileSync } from 'node:fs';
import { TICK_HZ } from '../sim/util.mjs';
import { poss, sayName, withArticle } from './lib/names.mjs';
import { endScreen, momentWindows } from './commentary.mjs';
import { shortNames, brandOf, OVERLAY } from './overlay.mjs';
import { timelineOf } from './plan.mjs';
import { MOMENTS } from './commentary.mjs';
import { BUILDINGS, POP_MAX } from '../sim/data.mjs';
import { WEATHER } from '../sim/world-data.mjs';
import { storyBeats } from './caster-story.mjs';
import { crumbled } from './story-data.mjs';
import { plainOrders } from './plain-orders.mjs';
import { displayName, displayPlural } from '../render/theme/display-name.mjs';
import { thingWord, classWord } from './lib/theme-words.mjs';
export { crumbled };

export const CASTERS = {
  pbp: { id: 'pbp', name: 'Dex Harlan', short: 'Dex', role: 'play-by-play', color: '#3ddc97', voice: 'caster_a', voice_ref: 'caster_a/referenz.wav', voice_note: 'young British man, breathless football-style commentator, rapid-fire, voice cracking with excitement' },
  ana: { id: 'ana', name: 'Juno Quill', short: 'Juno', role: 'analyst', color: '#c792ea', voice: 'caster_b', voice_ref: 'caster_b/referenz.wav', voice_note: 'Canadian woman, about 30, engaged and warm, very quick and melodic, bright, laughs easily', gender: 'woman' },
};
export const GAME_NAME = 'RTS Arena';

// Short readable names the casters may use, derived from the log name only: "QuartzRT" stays, "Zoe kit TP2" also becomes "Zoe's kit"
// (code words with digits or capitals such as TP2, and single letters, are dropped; the first word gets a possessive). A part of a name alone ("Zoe") stays forbidden.
export function aliasesOf(short) {
  // the last one is what the casters say: a model code is spoken by its first word ("Qwen3.8-27B" -> "Qwen")
  return [...new Set([short, sayName(short), brandOf(short)])]; // tools/lib/names.mjs: "Zoe's TensorFold recipe" stays, never "Zoe's's"
}
export const isBuildingType = (t) => Object.prototype.hasOwnProperty.call(BUILDINGS, t);

export const nice = (s) => displayName('any', s); // R1: the theme decides the words (default classic = the old underscore-to-space text)
export const clockOf = (tick) => { const s = Math.floor(tick / TICK_HZ); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const minuteOf = (tick) => Math.floor(tick / TICK_HZ / 60);
const plural = (t, n) => (n === 1 ? nice(t) : displayPlural('any', t)); // the plural of the theme (classic: the regular plural, the one pluralOf makes)
// C1: words the old texts wrote as fixed English. Classic gives exactly those words; a theme that renames the thing gives its own ("Landing Core", "Settlers").
const TC = () => thingWord('town center', 'building', 'town_center');
const WORKERS = () => classWord('workers', 'unit', 'worker');
const WONDER = () => thingWord('wonder', 'building', 'wonder');
const aWONDER = () => (nice('wonder') === 'wonder' ? 'a WONDER' : `${withArticle(nice('wonder')).split(' ')[0]} ${nice('wonder').toUpperCase()}`);
const count = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const typeList = (m, n = 3) => Object.entries(m || {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([t, c]) => `${c} ${plural(t, c)}`).join(', ');
const when = (tick) => `[${clockOf(tick)}, minute ${minuteOf(tick)}]`;

// Every number a fact allows a caster to say. Clocks like 09:50 count as one token, "minute 9" gives the 9.
export function numbersIn(text) {
  const out = { clocks: new Set(), nums: new Set() };
  const t = String(text).replace(/\b\d{1,2}:\d{2}\b/g, (m) => { out.clocks.add(m); return ' '; });
  for (const m of t.matchAll(/(?<![A-Za-z0-9.])(\d+)(?:\.(\d+))?(?=x\b|k\b|s\b|%)|(?<![A-Za-z0-9.])(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?![A-Za-z0-9])/g)) {
    const v = m[1] != null ? Number(m[1] + (m[2] ? '.' + m[2] : '')) : Number(m[3].replace(/,/g, '') + (m[4] || ''));
    if (Number.isFinite(v)) out.nums.add(v);
  }
  return out;
}

const IMPORTANCE = { say: 26, weather: 12, caravan: 30, sea: 38, chat: 24, open: 100, close: 100, victory: 95, wonder: 88, shrine: 36, decision: 90, base: 80, orders: 50, first_contact: 55, tier_up: 45, razed: 28, razed_prod: 40, key: 20, key_big: 32, lull: 10 };
const LEAD_S = { chat: 0.2, open: 0, close: 0, victory: 0.8, wonder: 0.5, shrine: 0.3, base: 1.4, battle: 1.6, razed: 1.0, orders: 0.5, first_contact: 0.8, tier_up: 0.5, key: 0.3, lull: 0 };
const FIGHT = new Set(['battle', 'razed', 'base', 'victory', 'sea']);
// the mood of a beat: action (fights, razed buildings, the base falling, the final call), open, or calm; both casters talk in all of them
export const ACTION_KINDS = FIGHT;
export const roleOf = (kind) => (FIGHT.has(kind) ? 'action' : kind === 'open' ? 'open' : 'calm');
const PROD = new Set(['barracks', 'archery_range', 'stables', 'siege_workshop', 'town_center']);
// spoken words per second: Dex is fast (breathless British football style), Juno slower and relaxed
// spoken words per second, measured on the real takes of two finished videos (176 lines, 01.11.2026): Dex 2.97, Dex in a fight 3.14, Juno 3.19 and 3.11.
// A guess that is too slow leaves silent holes in the talk, one that is too fast squeezes the voice.
export const RATE = { pbp: 3.0, pbp_fight: 3.15, ana: 3.15 };
export const MIN_GAP_S = 2.8;

// plain-language version of a quantisation / speed-trick code, read from the model name only (no invented specs)
export function plainQuant(q) {
  if (!q) return null;
  const parts = [];
  const bits = /NVFP(\d)/i.exec(q) || /(\d+(?:\.\d+)?)\s*bpw/i.exec(q);
  if (bits) parts.push(`a ${Math.round(Number(bits[1]))}-bit version (squeezed to ${Math.round(Number(bits[1]))} bits per weight)`);
  if (/MTP/i.test(q)) parts.push('with a speed-up trick that guesses several words ahead');
  return parts.length ? parts.join(', ') : null;
}

// The rule changes of a day with its own win rule (preset war), written from the resolved rules of the replay (ev.rules, see enrichEvents).
// The casters may say their numbers only when a fact names them. Any other day has no ev.rules and gets no such fact: those sheets stay as they were.
export function dayRulesText(rules) {
  if (!rules || !rules.noScoreWin) return null;
  const parts = ['No win on points and none on time: a match ends only when one side is wiped out.'];
  const caps = Array.isArray(rules.towerCaps) ? rules.towerCaps.filter((n) => Number.isFinite(n)) : [];
  if (caps.length) parts.push(`Towers are limited: each side may build at most ${Math.max(...caps)} towers${new Set(caps).size > 1 ? ` (${caps.join(', ')} at tiers 1 to ${caps.length})` : ''}.`);
  if (rules.warAtS > 0) parts.push(`War phase from minute ${+(rules.warAtS / 60).toFixed(1)}: both sides get unlimited resources, every resource is topped up to ${rules.warTopUp} again and again.`);
  if (rules.popMax > POP_MAX) parts.push(`The population limit is ${rules.popMax} instead of the usual ${POP_MAX}.`);
  return `Rules of the day (preset ${rules.preset}): ${parts.join(' ')}`;
}

export function buildScript(ev, plan, opts = {}) {
  const shorts = shortNames(ev.players.map((p) => p.name));
  const players = ev.players.map((p, i) => { const short = shorts[i].trim() || `Player ${i + 1}`; const al = aliasesOf(short); return { p: i + 1, name: p.name, short, say: al[al.length - 1], aliases: al, model: p.model, hw: p.hardware ?? p.hw ?? '', creator: p.creator || null }; });
  const N = players.length;
  const sh = (p) => players[p - 1]?.short ?? `player ${p}`;
  const tl = timelineOf(plan);
  const duration = plan.duration_s;
  const raw = []; // facts before numbering
  const F = (kind, tick, p, text, data = {}) => { raw.push({ kind, tick, p, text, data, seq: raw.length }); return raw.length - 1; };
  const win = plan.window || [0, ev.ticks];
  const es = endScreen(ev, players);
  const row = (k) => es.rows.find((r) => r.key === k);
  const decisions = ev.events.filter((e) => e.type === 'llm_decision');
  const moments = plan.moments || [];
  const momentIds = new Set(moments.map((m) => m.id));

  // ---- match-level facts (no tick) ----
  F('meta', null, null, `${GAME_NAME}: two AI models play a real-time strategy match against each other. Class ${opts.cls || 'unknown'}. Map seed ${ev.seed}. The match lasts ${es.time} game time.`);
  // the rules of the day (war preset only) are added as the last fact (addRulesFact below), so that the numbering of every other fact stays as it is
  const rulesText = dayRulesText(ev.rules);
  const addRulesFact = () => (rulesText ? addFact('rules', null, null, rulesText, (({ preset, towerCaps, warAtS, warTopUp, popMax }) => ({ preset, towerCaps, warAtS, warTopUp, popMax }))(ev.rules)) : null);
  for (const q of players) F('player', null, q.p, `Player ${q.p}: short name "${q.short}", full name "${q.name}", model "${q.model}", hardware "${q.hw}".${q.say !== q.short ? ` Spoken alias: "${q.say}".` : ''}`, { p: q.p });
  // what the show is, who the two contestants are (parsed from the names in the log only) and how a match is won
  F('show', null, null, 'How the show works: two AI models play a real-time strategy game against each other, with no human help. Every decision comes from the model itself. The game does not wait for a model: a model that thinks faster gets more decisions.');
  const spec = players.map((q) => {
    const pl = ev.players[q.p - 1], nm = String(q.name);
    const params = (/(\d+(?:\.\d+)?B)\b/.exec(nm) || [])[1] || null;
    const inner = (/\(([^)]*)\)\s*$/.exec(nm) || [])[1] || null;
    const quant = nm.replace(/^\S+\s+/, '').replace(/\s*\([^)]*\)\s*$/, '').trim() || null;
    return { p: q.p, params, quant, engine: inner, creator: pl.creator || null, plain: plainQuant(quant) };
  });
  for (const x of spec) F('spec', null, x.p, `Contestant ${x.p} (${players[x.p - 1].short}): ${x.params ? `${x.params} parameters` : 'parameter count not in the log'}; quantisation and speed tricks ${x.quant ? `"${x.quant}"` : 'not in the log'}${x.plain ? ` (in plain words: ${x.plain})` : ''}; engine or kit "${x.engine || 'not in the log'}"${x.creator ? `, recipe by ${x.creator}` : ''}; runs on ${players[x.p - 1].hw}.`, x);
  if (N === 2) { // what tells the two apart, only from what the log knows: an unknown part is left out, never written as "?" or "null"
    const [A, B] = spec, [hA, hB] = [players[0].hw, players[1].hw], cr = (x) => (x.creator ? `, recipe by ${x.creator}` : ''), parts = [];
    if (brandOf(players[0].short) !== players[0].short && brandOf(players[1].short) !== players[1].short) parts.push(`two different models (${players[0].short} against ${players[1].short})`);
    else {
      if (A.params && B.params) parts.push(A.params === B.params ? `same base model size (${A.params} against ${B.params})` : `different model sizes (${A.params} against ${B.params})`);
      if (A.plain && A.plain === B.plain) parts.push(`both squeezed the same way (${A.plain}) but in two different formats`);
      else if ((A.plain || A.quant) && (B.plain || B.quant)) parts.push(`different quantisation (${A.plain || A.quant} against ${B.plain || B.quant})`);
    }
    if (A.engine && B.engine) parts.push(`different engine and recipe (${A.engine}${cr(A)} against ${B.engine}${cr(B)})`);
    if (hA && hB) parts.push(hA === hB ? `the same hardware (${hA})` : `different hardware (${hA} against ${hB})`);
    if (parts.length) { const t = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]; F('spec', null, null, `${t[0].toUpperCase()}${t.slice(1)}.`, { spec }); }
  }
  // measured before the match on the test bench (bench.json next to the log, same numbers as the recipe pages): what a model is before it plays
  for (const b of ev.bench?.players || []) {
    const q = players[b.p - 1]; if (!q) continue;
    F('bench', null, b.p, `Measured on our test bench on ${b.measured}, not in this match: ${q.short} on ${q.hw}: ${b.peak_gib} GiB of memory in use at its peak; ${b.decode_tok_s} tokens per second with one request; 500 words in about ${b.words_500_s} s; knowledge test ${b.knowledge}; code test ${b.code}.`, { bench: b });
  }
  F('howto', null, null, `How a match is won: build an economy with ${WORKERS()}, build an army, then destroy the other side's ${TC()} and every building that can train units. The ${TC()} alone does not end it.` + (ev.events.some((e) => /shrine/.test(e.type)) ? ' Every relic shrine a side holds gives it 1 victory point per second, and enough points also win the match.' : ''));
  const lat = row('latency'), toks = row('tok_s'), dc = row('decisions');
  if (lat && toks) {
    const l = lat.raw, t = toks.raw;
    F('think', null, null, `Think time per decision (median): ${players.map((q, i) => `${q.short} ${(l[i] / 1000).toFixed(1)} s`).join(', ')}. Tokens per second (mean): ${players.map((q, i) => `${q.short} ${Math.round(t[i])}`).join(', ')}.`, { lat: l, tok: t });
    if (N === 2 && l[0] > 0 && l[1] > 0) {
      const slow = l[1] > l[0] ? 1 : 0, ratio = l[slow] / l[1 - slow];
      F('think', null, null, `${ratio < 1.05 ? 'Both models take about the same think time per decision.' : `${poss(players[slow].short)} median think time is ${ratio.toFixed(1)}x ${poss(players[1 - slow].short)}.`} ${t[0] > t[1] ? players[0].short : players[1].short} generates ${(Math.max(t[0], t[1]) / Math.min(t[0], t[1])).toFixed(1)}x as many tokens per second as ${t[0] > t[1] ? players[1].short : players[0].short}.`, { slower: l[1] > l[0] ? 2 : 1, faster_tok: t[0] > t[1] ? 1 : 2 });
    }
    const tk = row('tokens'), asked = players.map((q) => decisions.filter((e) => e.p === q.p && e.asked_again).length);
    if (tk) F('think', null, null, `Tokens written in the whole match: ${players.map((q, i) => `${q.short} ${tk.raw[i]}`).join(', ')}. Times an answer held no orders, so the game asked again: ${players.map((q, i) => `${q.short} ${asked[i]}`).join(', ')}.`, { tokens: tk.raw, asked });
  }
  if (dc) {
    const notes = players.map((q, i) => decisions.filter((e) => e.p === q.p && e.thought).length);
    F('notes', null, null, `Decisions with a written note: ${players.map((q, i) => `${q.short} ${notes[i]} of ${dc.raw[i]}`).join(', ')}.`, { notes, decisions: dc.raw });
  }

  // ---- events ----
  const evFact = new Map(); // event id -> raw index
  for (const e of ev.events) {
    let i = -1;
    switch (e.type) {
      case 'first_contact': i = F('first_contact', e.t, e.p, `${when(e.t)} First contact: ${sh(e.p)} spots ${poss(sh(e.other))} ${nice(e.what)}.`, { p: e.p, other: e.other, what: e.what }); break;
      case 'key_building': i = F('key_building', e.t, e.p, `${when(e.t)} ${sh(e.p)} finishes its first ${nice(e.building)}.`, { p: e.p, building: e.building }); break;
      case 'tier_up': i = F('tier_up', e.t, e.p, `${when(e.t)} ${sh(e.p)} reaches tier ${e.tier}.`, { p: e.p, tier: e.tier }); break;
      case 'expansion': i = F('expansion', e.t, e.p, `${when(e.t)} ${sh(e.p)} expands with a second ${TC()}.`, { p: e.p }); break;
      case 'momentum_swing': i = F('swing', e.t, e.to, `${when(e.t)} Army-value lead flips to ${sh(e.to)} (army value ${e.army[0]} against ${e.army[1]}).`, { to: e.to, army: e.army }); break;
      case 'battle': {
        const parts = [];
        for (let p = 1; p <= N; p++) {
          const P = e.participants[p];
          if (!P) continue;
          const lost = P.lost_units + P.lost_buildings;
          parts.push(lost ? `${sh(p)} loses ${count(P.lost_units, 'unit')}${P.lost_buildings ? ` and ${count(P.lost_buildings, 'building')}` : ''} (${typeList(P.lost_by_type)})` : `${sh(p)} loses nothing`);
        }
        const dur = Math.max(1, Math.round((e.t_end - e.t) / TICK_HZ));
        i = F('battle', e.t, null, `${when(e.t)} Battle, ${dur} s: ${e.value} value destroyed, ${count(e.kills, 'kill')}. ${parts.join('. ')}.`, { value: e.value, kills: e.kills, dur, peak_tick: e.peak_tick, t_end: e.t_end, participants: e.participants });
        break;
      }
      // by = 0 and no weapon: nobody destroyed it, the building crumbled in sudden death (sim/game.mjs suddenDeathStep is the only building kill without a killer)
      case 'building_destroyed': i = F('razed', e.t, e.p, crumbled(e) ? `${when(e.t)} ${poss(sh(e.p))} ${nice(e.building)} crumbles away. Nobody destroyed it: in sudden death every building loses hit points and nobody can rebuild or repair.` : `${when(e.t)} ${sh(e.by)} destroys ${poss(sh(e.p))} ${nice(e.building)}${e.src ? ` with ${withArticle(nice(e.src))}` : ''}.`, { p: e.p, by: e.by, building: e.building, src: e.src, crumble: crumbled(e) }); break;
      case 'base_destroyed': i = F('base', e.t, e.p, crumbled(e) ? `${when(e.t)} ${poss(sh(e.p))} base falls: the ${TC()} crumbles away. Nobody destroyed it: in sudden death every building loses hit points and nobody can rebuild or repair.` : `${when(e.t)} ${poss(sh(e.p))} base falls: ${sh(e.by)} destroys the ${TC()}${e.src ? ` with ${withArticle(nice(e.src))}` : ''}.`, { p: e.p, by: e.by, src: e.src, crumble: crumbled(e) }); break;
      case 'wonder_started': i = F('wonder', e.t, e.p, `${when(e.t)} ${sh(e.p)} finishes ${aWONDER()}. If it stands for ${Math.round(e.secs / 60)} minutes, ${sh(e.p)} wins.`, { p: e.p, secs: e.secs }); break;
      case 'wonder_warning': i = F('wonder', e.t, e.p, `${when(e.t)} ${poss(sh(e.p))} ${WONDER()} has ${e.secs} seconds left.`, { p: e.p, secs: e.secs }); break;
      case 'wonder_destroyed': i = F('wonder', e.t, e.p, `${when(e.t)} ${poss(sh(e.p))} ${WONDER()} is destroyed with ${e.secs} seconds left${e.by ? ` by ${sh(e.by)}` : ''}.`, { p: e.p, secs: e.secs, by: e.by }); break;
      case 'wonder_completed': i = F('wonder', e.t, e.p, `${when(e.t)} ${poss(sh(e.p))} ${WONDER()} is complete.`, { p: e.p }); break;
      case 'control_point_captured': i = F('shrine', e.t, e.p, `${when(e.t)} ${sh(e.p)} takes a relic shrine${e.from_team ? ' from the other side' : ''}${e.vp > 0 ? `; ${e.vp} victory points so far` : ''}.`, { p: e.p, vp: e.vp }); break;
      case 'control_victory': i = F('shrine', e.t, e.p, `${when(e.t)} ${sh(e.p)} reaches the shrine point target.`, { p: e.p }); break;
      // the living world (sim/world.mjs): the sky, caravans, the sea, and the lines the players say to each other (quoted word for word)
      case 'weather_change': if (e.t > 0) i = F('weather', e.t, null, `${when(e.t)} The weather turns to ${e.kind}: ${WEATHER[e.kind]?.text || e.kind}. It is the same sky for both sides.`, { kind: e.kind }); break;
      case 'caravan_raid': i = F('caravan', e.t, e.p, `${when(e.t)} ${sh(e.p)} raids a neutral trade caravan and takes ${e.gold} gold.`, { p: e.p, gold: e.gold, raid: true }); break;
      case 'caravan_trade': i = F('caravan', e.t, e.paid[0]?.[0] ?? null, `${when(e.t)} A neutral trade caravan reaches its post: ${e.paid.map(([p, g]) => `${sh(p)} earns ${g} gold as its escort`).join(', ')}.`, { paid: e.paid }); break;
      case 'naval_battle': i = F('sea', e.t, null, `${when(e.t)} Sea battle: ${Object.entries(e.ships_lost).map(([p, n]) => `${sh(+p)} loses ${count(n, 'ship')}`).join(', ')}, ${e.value} value sunk.`, { lost: e.ships_lost, value: e.value }); break;
      case 'chat': i = F('say', e.t, e.p, `${when(e.t)} ${sh(e.p)} says in the match chat: “${e.text}”`, { p: e.p, quote: e.text }); break;
      case 'resign': i = F('resign', e.t, e.p, `${when(e.t)} ${sh(e.p)} resigns.`, { p: e.p }); break;
      case 'victory': {
        const w = e.winner;
        i = F('victory', e.t, w, w ? `${when(e.t)} ${sh(w)} wins by ${e.reason}. Game time ${clockOf(e.t)}.` : `${when(e.t)} The match ends without a winner (${e.reason}).`, { winner: w, reason: e.reason });
        break;
      }
      default: break;
    }
    if (i >= 0) { evFact.set(e.id, i); raw[i].data.eid = e.id; }
  }

  // ---- LLM decisions: the models' own notes (word for word) and notable orders ----
  const NOTABLE = /\battack\b|\bram\b|\bcatapult\b/;
  const decFact = new Map();
  for (const e of decisions) {
    if (e.t < 0) continue;
    const secs = e.latency_ms != null ? (e.latency_ms / 1000).toFixed(e.latency_ms < 10000 ? 1 : 0) : null;
    const meta = `${secs != null ? `Thought for ${secs} s` : ''}${e.completion_tokens != null ? `, ${e.completion_tokens} tokens` : ''}`;
    if (e.thought) {
      const i = F('note', e.t, e.p, `${when(e.t)} ${sh(e.p)} decision ${e.n}, note: “${e.thought}” Orders: ${plainOrders(e.summary) || 'none'}. ${meta}.`, { p: e.p, n: e.n, quote: e.thought, orders: e.summary, moment: momentIds.has(e.id) });
      decFact.set(e.id, i);
    } else if (e.summary && NOTABLE.test(e.summary)) {
      const i = F('orders', e.t, e.p, `${when(e.t)} ${sh(e.p)} decision ${e.n} (no note) orders: ${plainOrders(e.summary)}. ${meta}.`, { p: e.p, n: e.n, orders: e.summary });
      decFact.set(e.id, i);
    }
  }
  const sawFact = new Map();
  for (const m of moments) {
    const s = m.seen, ps = m.prev_seen;
    const bits = [];
    if (s) {
      bits.push(s.enemy_n > 0 ? `${s.enemy_n} enemy ${s.enemy_n === 1 ? 'unit' : 'units'} in view (${typeList(s.enemy)})` : 'no enemy unit in view');
      if (s.attacked) bits.push(`it was hit ${s.attacked.n === 1 ? 'once' : `${s.attacked.n} times`}`);
      if (ps && ps.army_value != null && s.army_value != null && ps.army_value !== s.army_value) bits.push(`its army value went from ${ps.army_value} to ${s.army_value}`);
      else if (s.army_value != null) bits.push(`its army value is ${s.army_value}`);
    }
    if (bits.length) sawFact.set(m.id, F('saw', m.t, m.p, `${when(m.t)} What ${sh(m.p)} saw when it decided: ${bits.join('; ')}.`, { p: m.p, enemy_n: s?.enemy_n ?? null, army_from: ps?.army_value ?? null, army_to: s?.army_value ?? null, attacked: s?.attacked?.n ?? null }));
  }

  // ---- closing facts ----
  const fin = ev.final || [];
  const finalBits = [];
  const winner = es.winner;
  const take = (k, label) => { const r = row(k); if (r && r.raw.every((x) => typeof x === 'number')) finalBits.push(`${label}: ${players.map((q, i) => `${q.short} ${Math.round(r.raw[i])}`).join(', ')}`); };
  take('kills', 'Kills'); take('kill_value', 'Value destroyed'); take('army_peak', 'Army value, peak'); take('army_final', 'Army value at the end');
  if (finalBits.length) F('final', ev.ticks, null, `Final numbers (${es.time}): ${finalBits.join('. ')}.${winner ? ` ${sh(winner)} wins by ${es.reason}.` : ''}`, { winner, time: es.time, kills: row('kills')?.raw, kill_value: row('kill_value')?.raw, army_peak: row('army_peak')?.raw, army_final: row('army_final')?.raw });

  // ---- number the facts in time order ----
  const order = raw.map((f, i) => i).sort((a, b) => (raw[a].tick ?? -1) - (raw[b].tick ?? -1) || raw[a].seq - raw[b].seq);
  const idOf = new Map();
  const facts = order.map((ri, k) => { idOf.set(ri, `f${k + 1}`); const f = raw[ri]; return { id: `f${k + 1}`, kind: f.kind, tick: f.tick, p: f.p, text: f.text, data: f.data }; });
  const factAt = (ri) => (ri == null ? null : idOf.get(ri));
  const byId = new Map(facts.map((f) => [f.id, f]));
  const addFact = (kind, tick, p, text, data = {}) => { const f = { id: `f${facts.length + 1}`, kind, tick, p, text, data }; facts.push(f); byId.set(f.id, f); return f.id; };

  // ---- subjects: what a beat is about (a unit group, a building, a base, a fight), from the log only ----
  const subjects = [];
  const labelOf = (r) => {
    if (r.kind === 'fight') return 'the fight';
    if (r.kind === 'place') return 'that spot of the map';
    if (r.kind === 'army') return `${poss(sh(r.owner))} army`;
    if (r.kind === 'units') return `${poss(sh(r.owner))} ${plural(r.type || 'unit', r.n > 1 ? 2 : 1)}`;
    return `${poss(sh(r.owner))} ${nice(r.type || 'building')}`;
  };
  const subId = (r) => {
    if (!r || !Number.isFinite(r.x) || !Number.isFinite(r.z)) return null;
    const key = `${r.kind}|${r.owner}|${r.type}|${r.bid ?? ''}|${Math.round(r.x / 8)}|${Math.round(r.z / 8)}`;
    let q = subjects.find((x) => x.key === key);
    if (!q) { q = { id: `s${subjects.length + 1}`, key, kind: r.kind, owner: r.owner ?? 0, type: r.type ?? null, n: r.n ?? 0, ids: r.ids || [], bid: r.bid ?? null, x: r.x, z: r.z, label: labelOf(r), role: r.role || null }; subjects.push(q); }
    return q.id;
  };
  const startOf = (p) => (ev.starts && ev.starts[p - 1] ? ev.starts[p - 1] : null);
  const baseRaw = (p) => { const st = startOf(p); return st ? { kind: 'building', owner: p, type: 'town_center', n: 1, x: st.tx, z: st.ty } : null; };
  const subjOfEvent = (e) => {
    const loc = e.loc;
    switch (e.type) {
      case 'first_contact': return loc ? [{ kind: isBuildingType(e.what) ? 'building' : 'units', owner: e.other, type: e.what, n: 1, x: loc[0], z: loc[1] }] : [];
      case 'key_building': case 'expansion': return loc ? [{ kind: 'building', owner: e.p, type: e.building || 'town_center', n: 1, x: loc[0], z: loc[1] }] : [];
      case 'tier_up': return [baseRaw(e.p)];
      case 'battle': return loc ? [{ kind: 'fight', owner: 0, type: 'battle', x: loc[0], z: loc[1] }] : [];
      case 'building_destroyed': return loc ? [...(e.src && e.by ? [{ kind: 'units', owner: e.by, type: e.src, n: 1, x: loc[0], z: loc[1] }] : []), { kind: 'building', owner: e.p, type: e.building, n: 1, x: loc[0], z: loc[1] }] : [];
      case 'base_destroyed': return loc ? [{ kind: 'building', owner: e.p, type: 'town_center', n: 1, x: loc[0], z: loc[1] }] : [];
      case 'wonder_started': case 'wonder_warning': case 'wonder_destroyed': case 'wonder_completed': return loc && e.p ? [{ kind: 'building', owner: e.p, type: 'wonder', n: 1, x: loc[0], z: loc[1] }] : [];
      case 'llm_decision': return (e.subjects || []).filter((x) => x.kind !== 'place' || x.role === 'target').map((x) => ({ ...x }));
      default: return [];
    }
  };
  // what a decision is about, as one fact (the casters may state it)
  const aimFact = (e) => {
    const subs = (e.subjects || []).filter((x) => x.kind !== 'place');
    if (!subs.length) return null;
    const say = (r) => labelOf(r);
    const parts = [];
    for (const r of subs.slice(0, 3)) {
      if (r.role === 'note') parts.push(`its note names ${say(r)}`);
      else if (r.role === 'target') parts.push(`its attack order is aimed at ${say(r)}`);
      else if (r.role === 'saw') parts.push(`it had seen ${say(r)}`);
      else if (r.role === 'actors') parts.push(`the order goes to ${say(r)}`);
      else if (r.role === 'site') parts.push(`its order involves ${say(r)}${r.planned ? ' (a new one)' : ''}`);
    }
    return parts.length ? addFact('aim', e.t, e.p, `${when(e.t)} What ${poss(sh(e.p))} decision ${e.n} is about: ${parts.join('; ')}.`, { p: e.p, n: e.n }) : null;
  };

  // ---- story cut: the beats follow the story plan (tools/story.mjs), not the importance of single events ----
  if (plan.story && !plan.story.teaser) {
    const beats = storyBeats({ ev, plan, tl, players, sh, facts, addFact, factAt, evFact, decFact, sawFact, subId, subjOfEvent, aimFact, baseRaw, duration });
    addRulesFact();
    // RTS_EVSUBJ=1 (08.11., Koordinator): every event with a place becomes a camera subject of the beat it falls into (appended after the others, so the ids of the others stay), so a line about an event can be shown at its place
    if (process.env.RTS_EVSUBJ === '1') for (const b of beats) for (const e of ev.events || []) {
      if (!(e.t >= (b.tick ?? 0) - 40 && e.t <= (b.tick_end || ev.ticks))) continue;
      for (const r of (subjOfEvent(e) || [])) { const id = r ? subId(r) : null; if (id && !b.subjects.includes(id)) b.subjects.push(id); }
    }
  // 07.11. (owner): earlier matches of the tournament as facts (file RTS_BACKSTORY, one fact per line); appended last so no fact id shifts
  if (process.env.RTS_BACKSTORY) { try { for (const line of readFileSync(process.env.RTS_BACKSTORY, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)) addFact('meta', null, null, line); } catch { /* no backstory file */ } }
    return { sheet: { game: GAME_NAME, cls: opts.cls || '', seed: ev.seed, players, facts, casters: CASTERS, subjects: subjects.map(({ key, ...q }) => q), result: { winner: es.winner, reason: es.reason, time: es.time }, story: { chapters: plan.story.chapters.map((c) => ({ id: c.id, title: c.title, o0: c.o0, o1: c.o1 })), total_s: plan.story.total_s, units: plan.story.units.map((u) => ({ id: u.id, kind: u.kind, chapter: u.chapter, tick: u.tick, label: u.label })) } }, beats, duration_s: duration };
  }
  // ---- candidate beats ----
  const cand = [];
  const mandatory = [];
  const out = (tick) => tl.outAt(Math.max(win[0], Math.min(win[1], tick)));
  const inWin = (t) => t >= win[0] && t <= win[1];
  const push = (kind, tick, imp, facts_, extra = {}) => cand.push({ kind, tick, imp, facts: facts_.filter(Boolean), ...extra });
  for (const e of ev.events) {
    if (!inWin(e.t)) continue;
    const f = factAt(evFact.get(e.id));
    if (!f) continue;
    const sb = subjOfEvent(e);
    if (e.type === 'first_contact') push('first_contact', e.t, IMPORTANCE.first_contact, [f], { sub: sb });
    else if (e.type === 'tier_up') push('tier_up', e.t, IMPORTANCE.tier_up, [f], { sub: sb });
    else if (e.type === 'key_building') push('key', e.t, ['siege_workshop', 'tower', 'stables'].includes(e.building) ? IMPORTANCE.key_big : IMPORTANCE.key, [f], { sub: sb });
    else if (e.type === 'expansion') push('key', e.t, IMPORTANCE.key_big, [f], { sub: sb });
    else if (e.type === 'battle') push('battle', e.t, 30 + Math.min(40, e.value / 60), [f], { peak: e.peak_tick, sub: sb });
    else if (e.type === 'building_destroyed') push('razed', e.t, PROD.has(e.building) ? IMPORTANCE.razed_prod : IMPORTANCE.razed, [f], { sub: sb });
    else if (e.type === 'base_destroyed') mandatory.push({ kind: 'base', tick: e.t, imp: IMPORTANCE.base, facts: [f], sub: sb });
    else if (e.type === 'wonder_started' || e.type === 'wonder_destroyed' || e.type === 'wonder_completed') mandatory.push({ kind: 'wonder', tick: e.t, imp: IMPORTANCE.wonder, facts: [f], sub: sb });
    else if (e.type === 'wonder_warning') push('wonder', e.t, IMPORTANCE.wonder - 20, [f], { sub: sb });
    else if (e.type === 'control_point_captured' || e.type === 'control_victory') push('shrine', e.t, IMPORTANCE.shrine, [f], { sub: [] });
    else if (e.type === 'momentum_swing') push('first_contact', e.t, 50, [f], { sub: [] });
    else if (e.type === 'chat') push('say', e.t, IMPORTANCE.say, [f], { sub: [baseRaw(e.p)].filter(Boolean) });
    else if (e.type === 'caravan_raid') push('caravan', e.t, IMPORTANCE.caravan, [f], { sub: e.loc ? [{ kind: 'units', owner: 0, type: 'caravan', n: 1, x: e.loc[0], z: e.loc[1] }] : [] });
    else if (e.type === 'naval_battle') push('sea', e.t, IMPORTANCE.sea + Math.min(30, e.value / 60), [f], { sub: e.loc ? [{ kind: 'fight', owner: 0, type: 'battle', x: e.loc[0], z: e.loc[1] }] : [] });
    else if (e.type === 'weather_change' && e.t > 0) push('weather', e.t, IMPORTANCE.weather, [f], { sub: [] });
  }
  for (const e of decisions) {
    if (!inWin(e.t) || momentIds.has(e.id)) continue;
    const fi = decFact.get(e.id);
    if (fi == null) continue;
    if (!e.thought && NOTABLE.test(e.summary || '')) push('orders', e.t, IMPORTANCE.orders, [factAt(fi)], { sub: subjOfEvent(e), ev: e });
    else if (e.thought && (e.subjects || []).length) push('chat', e.t, IMPORTANCE.chat + (MOMENTS.keyword.test(e.thought) ? 8 : 0) + Math.min(6, (e.completion_tokens || 0) / 1500), [factAt(fi)], { sub: subjOfEvent(e).slice(0, 2), ev: e });
  }
  for (const m of moments) {
    const w = momentWindows(m, tl);
    const e = decisions.find((d) => d.id === m.id);
    mandatory.push({ kind: 'decision', tick: m.t, imp: IMPORTANCE.decision, facts: [factAt(decFact.get(m.id)), factAt(sawFact.get(m.id))].filter(Boolean), w, p: m.p, sub: e ? subjOfEvent(e) : [], ev: e });
  }
  const vic = ev.events.find((e) => e.type === 'victory' && e.t <= win[1]);
  const finalFact = facts.find((f) => f.kind === 'final');
  const outOf = (c) => (c.kind === 'decision' ? c.w.land : out(c.tick));
  const fell = ev.events.find((e) => e.type === 'base_destroyed');
  mandatory.push({ kind: 'open', tick: win[0], imp: IMPORTANCE.open, facts: facts.filter((f) => ['meta', 'player'].includes(f.kind)).map((f) => f.id), fixedOut: 0.4, sub: [baseRaw(1), baseRaw(2)].filter(Boolean) });
  if (vic) {
    mandatory.push({ kind: 'victory', tick: vic.t, imp: IMPORTANCE.victory, facts: [factAt(evFact.get(vic.id))], sub: fell ? subjOfEvent(fell) : [] });
    mandatory.push({ kind: 'close', tick: ev.ticks, imp: IMPORTANCE.close, facts: [finalFact?.id, ...facts.filter((f) => f.kind === 'think' || f.kind === 'notes').map((f) => f.id)].filter(Boolean), fixedOut: Math.min(duration - 3, out(vic.t) + OVERLAY.end_delay_s), sub: [baseRaw(es.winner || 1), baseRaw(es.winner === 1 ? 2 : 1)].filter(Boolean) });
  } else mandatory.push({ kind: 'close', tick: ev.ticks, imp: IMPORTANCE.close, facts: [], /* the final numbers (the scoreboard) belong to the real end of the match: a cut that stops before the victory never says them */ fixedOut: Math.max(1, duration - 8), sub: [baseRaw(1), baseRaw(2)].filter(Boolean) });

  const chosen = [...mandatory];
  for (const c of chosen) c.out = c.fixedOut ?? outOf(c);
  const maxBeats = Math.max(8, Math.floor(duration / (opts.beat_s || 4.3)));
  for (const c of cand.sort((a, b) => b.imp - a.imp || a.tick - b.tick)) {
    if (chosen.length >= maxBeats) break;
    const o = out(c.tick);
    const fastAt = (x) => tl.speedAtOut(Math.min(x, tl.body_s)) > 4;
    const gap = (x) => (x.kind === 'decision' ? 7.5 : x.kind === 'open' ? 7 : x.kind === 'close' ? 4 : Math.max(fastAt(o) ? 1 : 0, fastAt(x.out) ? 1 : 0) ? 4.2 : MIN_GAP_S);
    if (chosen.some((x) => Math.abs(x.out - o) < gap(x))) continue;
    if (o > duration - 2.5 || o < 0.8) continue;
    c.out = o;
    chosen.push(c);
  }
  chosen.sort((a, b) => a.out - b.out || b.imp - a.imp);
  for (const c of chosen) if (c.ev && ['decision', 'chat', 'orders'].includes(c.kind)) { const id = aimFact(c.ev); if (id) c.facts.push(id); }

  // ---- lulls: a long 1x stretch without any beat gets a stats beat ----
  const lullSeed = [];
  for (let i = 0; i + 1 < chosen.length; i++) {
    const a = chosen[i], b = chosen[i + 1];
    const gapStart = a.out + (a.kind === 'decision' ? 4.5 : 3), gapEnd = (b.kind === 'decision' ? b.w.o0 : b.out - (LEAD_S[b.kind] ?? 0.5)) - 1;
    if (gapEnd - gapStart < 6) continue;
    const mid = (gapStart + gapEnd) / 2;
    if (tl.speedAtOut(mid) > 2.5) continue;
    lullSeed.push({ kind: 'lull', out: mid, tick: Math.round(tl.tickAt(mid)) });
  }
  for (const l of lullSeed) {
    const arm = ev.series?.army;
    const s = Math.min((arm?.[0]?.length ?? 1) - 1, Math.floor(l.tick / TICK_HZ));
    const ids = [];
    if (arm && arm[0] && arm.every((q) => q[s] != null)) {
      ids.push(addFact('series', l.tick, null, `${when(l.tick)} Army value right now: ${players.map((q, i) => `${q.short} ${Math.round(arm[i][s])}`).join(', ')}.`, { army: players.map((q, i) => arm[i][s]) }));
    }
    const kills = fin.length ? null : null;
    void kills;
    const lead = arm && arm[0] ? (arm[0][s] >= arm[1][s] ? 1 : 2) : 1;
    const lb = baseRaw(lead);
    const lsub = [lb || { kind: 'army', owner: lead, type: 'army', n: 0, x: 1, z: 1 }];
    chosen.push({ ...l, imp: IMPORTANCE.lull, facts: ids, sub: lsub });
  }
  chosen.sort((a, b) => a.out - b.out || b.imp - a.imp);

  // ---- segments (where each beat may talk) ----
  const beats = [];
  chosen.forEach((c, i) => {
    const prev = beats[i - 1];
    const lead = c.kind === 'decision' ? c.out - c.w.o0 : LEAD_S[c.kind] ?? 0.5;
    let seg0 = c.out - lead;
    if (prev) seg0 = Math.max(seg0, prev.anchor + 0.6);
    seg0 = Math.max(0, seg0);
    beats.push({
      id: i + 1, kind: c.kind, anchor: +c.out.toFixed(2), seg0: +seg0.toFixed(2), seg1: 0, tick: Math.round(c.tick), tick_end: 0,
      speed: +tl.speedAtOut(Math.min(c.out, tl.body_s)).toFixed(2), fight: FIGHT.has(c.kind), role: roleOf(c.kind), facts: [...new Set(c.facts)], p: c.p ?? null,
      slow: c.w ? { from: +c.w.slow0.toFixed(2), to: +c.w.slow1.toFixed(2) } : null,
      subjects: [...new Set((c.sub || []).filter(Boolean).map((r) => (r.kind === 'army' ? subId({ ...r, x: r.x || 1, z: r.z || 1 }) : subId(r))).filter(Boolean))],
    });
  });
  beats.forEach((b, i) => {
    b.seg1 = +(i + 1 < beats.length ? beats[i + 1].seg0 : duration - 0.3).toFixed(2);
    if (b.seg1 < b.seg0 + 1) b.seg1 = +(b.seg0 + 1).toFixed(2);
    b.tick_end = Math.round(i + 1 < beats.length ? Math.max(b.tick, tl.tickAt(Math.min(b.seg1, tl.body_s))) : ev.ticks);
    if (b.kind === 'close' || b.kind === 'victory') b.tick_end = ev.ticks;
    b.budget_words = Math.max(0, Math.floor((b.seg1 - b.seg0 - 0.4) * 2.8));
    // numbers a line of this beat may use without citing: the clock and the speed badge shown on screen, the beat's own facts
    b.clock = clockOf(b.tick);
  });
  addRulesFact();
  return { sheet: { game: GAME_NAME, cls: opts.cls || '', seed: ev.seed, players, facts, casters: CASTERS, subjects: subjects.map(({ key, ...q }) => q), result: { winner: es.winner, reason: es.reason, time: es.time } }, beats, duration_s: duration };
}

// text form of the beats for the prompt
const STORY_KIND = {
  open: 'OPENING', lead: 'RUN-UP: the game runs at 1x toward a key decision, the screen shows the deciding model\'s fog of war view', hold: 'FREEZE FRAME: the game is paused, the screen shows the note(s) and orders of the decision(s)',
  compare: 'FREEZE FRAME: the game is paused, the screen shows a side by side table of both players (tier race)', after: 'CONSEQUENCE: the game runs on after the decision', build: 'FAST FORWARD: narrate strategy and economy of both sides',
  battle: 'ACTION: a battle', razed: 'ACTION: a building is destroyed', base: 'ACTION: the base falls', tier_up: 'TIER UP', first_contact: 'FIRST CONTACT of scouts', victory: 'VICTORY: the final call', close: 'RECAP: why it was won, over the end screen',
};
export function describeBeat(b, sheet = null) {
  if (b.chapter) {
    const ch = sheet?.story?.chapters?.find((c) => c.id === b.chapter)?.title ?? b.chapter;
    const parts = [`beat ${b.id} (${b.kind}) [chapter ${ch}]`, STORY_KIND[b.kind] || b.kind, `video ${b.seg0.toFixed(1)}-${b.seg1.toFixed(1)} s`, `game clock ${b.clock}`, b.speed === 0 ? 'game paused' : `playback speed ${b.speed < 0.95 ? +b.speed.toFixed(2) : +b.speed.toFixed(1)}x`];
    parts.push(b.role === 'action' ? 'Dex calls it in a run of two or three short sentences, Juno follows up with what it means' : b.role === 'open' ? 'Dex hype welcome (a short run), then Juno' : 'Juno leads with the explanation; Dex still speaks in this beat (a question, a short reaction or a hand-over), so the two alternate and Dex ends up with at least 30 percent of the words');
    parts.push(`room for about ${b.budget_words} words`);
    if (b.facts.length) parts.push(`facts ${b.facts.join(', ')}`);
    if (b.subjects?.length) parts.push(`subjects ${b.subjects.map((id) => `${id} = ${sheet?.subjects?.find((q) => q.id === id)?.label ?? id}`).join(', ')}`);
    return parts.join('; ');
  }
  const parts = [`beat ${b.id} (${b.kind})`, `video ${b.seg0.toFixed(1)}-${b.seg1.toFixed(1)} s, event at ${b.anchor.toFixed(1)} s`, `game clock ${b.clock}`, `playback speed ${b.speed < 0.95 ? +b.speed.toFixed(2) : Math.round(b.speed)}x`];
  parts.push(b.role === 'action' ? 'ACTION beat: Dex calls it, Juno may add one short reaction or explanation' : b.role === 'open' ? 'OPENING beat: Dex hype welcome, then Juno introduces the players' : 'CALM beat: Juno leads with the explanation, Dex still speaks (a question, a short reaction or a hand-over); the two alternate');
  if (b.slow) parts.push('slow motion at the key decision');
  parts.push(`room for about ${b.budget_words} words`);
  if (b.facts.length) parts.push(`main facts ${b.facts.join(', ')}`);
  if (b.subjects?.length) parts.push(`subjects (the camera shows the one a line names) ${b.subjects.map((id) => `${id} = ${sheet?.subjects?.find((q) => q.id === id)?.label ?? id}`).join(', ')}`);
  return parts.join('; ');
}
