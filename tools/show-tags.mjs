import '../server/local-env.mjs'; // RTS_* defaults from local-env.json
import fs from 'fs';
// Show tags: what the picture shows while a caster line is spoken. General, not tied to one script.
//   every script line may carry  show: <tag> | [<tag>, ...]   (the LLM and the template writer fill it, see SHOW_SCHEMA)
//   validateShow(show, world, tick)  -> { tags, reasons }   each tag is checked against the match log (the thing exists at that time, the player and the metric are known)
//   inferShow(text, world, opts)     -> [{ tag, at }]        the generic inferrer: a keyword and entity matcher over the line (unit and building names from sim/data.mjs,
//                                                            player names, "fog", "sees", "army", "rams" ...). Runs when a line has no valid tag. Not script specific.
//   tools/story-show.mjs turns the tags into camera, fog, rings, labels, bars and the decision view (whole map, plan cards stay).
import { UNITS, BUILDINGS } from '../sim/data.mjs';
import { WILD_UNITS } from '../sim/world-data.mjs';
import { TICK_HZ } from '../sim/util.mjs';
import { endScreen } from './commentary.mjs';
import { displayName } from '../render/theme/display-name.mjs';
import { themeAlternation } from './lib/theme-words.mjs';

export const SHOW_KEYS = ['view', 'fog', 'follow', 'building', 'place', 'map', 'versus', 'inset', 'event'];
export const METRICS = ['army', 'think', 'lost', 'notes', 'units_lost', 'speed', 'memory', 'knowledge', 'code'];
// the measured numbers of the two recipes (bench.json next to the log, same numbers as their pages on the website)
const BENCH_BARS = { speed: ['decode_tok_s', 'TOKENS PER SECOND, MEASURED'], memory: ['peak_gib', 'MEMORY IN USE, GIB, MEASURED'], knowledge: ['knowledge', 'KNOWLEDGE TEST, MEASURED'], code: ['code', 'CODE TEST, MEASURED'] };
export const SEL_TYPES = ['army', 'workers', 'type'];
export const SHOWABLE_EVENTS = ['key_building', 'building_destroyed', 'base_destroyed', 'tier_up', 'first_contact', 'battle', 'momentum_swing', 'expansion'];
const SLACK = 30; // ticks: a line may show what happens at the very end of its moment
const UN = [...Object.keys(UNITS), ...WILD_UNITS];
export const isArmyType = (ty) => ty !== 'worker' && ty !== 'scout' && !WILD_UNITS.includes(ty) && UNITS[ty] && UNITS[ty].cls !== 'naval';
const tickOfClock = (s) => { const m = /^(\d{1,2}):([0-5]\d)$/.exec(String(s)); return m ? (+m[1] * 60 + +m[2]) * TICK_HZ : null; };
const clockOf = (tick) => { const s = Math.floor(tick / TICK_HZ); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

export const SHOW_SCHEMA = `SHOW TAGS (what the picture shows while the line is spoken)
Every line has an optional "show" field: one tag, or a list of up to 3 tags in the order the line talks about them. Exactly one of:
  {"view":{"player":2}}                         a low view from player 2's corner, looking across the map
  {"fog":{"player":1}}                          the whole map from above through player 1's eyes (fog of war): light = sees now, grey = saw before, dark = never seen; a banner names the side
  {"follow":{"sel":{"t":"army","o":2}}}         follow a group live and ring it: {"t":"army"|"workers","o":player} or {"t":"type","o":player,"ty":"ram"}
  {"building":{"player":2,"type":"siege_workshop"}}   push-in on that player's building (optional "nth": 2 = its second one)
  {"place":{"base":1}} or {"place":{"x":52,"z":70}}   a base (its town center) or a spot of the map
  {"map":{}}                                    zoom far out: the whole map with both bases and both armies; with "fog":{"player":1} what player 1 knows of the whole map; {"map":{"cards":true}} keeps the plan cards up (a line about a card or a decision)
  {"versus":{"metric":"army","clock":"11:48"}}  two bars that compare both players; "clock" (army only, optional) is the moment the line talks about, without it the bars show the moment the picture has reached: army | think (thinking time per decision) | lost (buildings lost) | notes | units_lost | measured before the match, if the fact sheet has them: speed | memory | knowledge | code
  {"inset":{"player":1,"decision":54}}          the decision view: the whole map, zoomed out, with the plan cards of that decision left up (no small map any more; decision number, or "latest")
  {"event":{"id":35}}                           a log event shown where it happened (the fact lists its event id)
Fog can be combined with a group, a building or the map: {"follow":{"sel":{"t":"army","o":1}},"fog":{"player":1}} (the army walks blind).
Optional "at":"first words of the phrase" starts the tag at that phrase of a longer line; without it the tags share the line evenly.
Only tag what the line really talks about, only things that exist at that moment of the match (the beat's facts tell you). Types: units ${Object.keys(UNITS).join(', ')}; buildings ${Object.keys(BUILDINGS).join(', ')}.
Examples:
  "QuartzRT's view is just as empty. Two blind armies."  -> "show":[{"follow":{"sel":{"t":"army","o":1}},"fog":{"player":1}}]
  "Zoe's kit finishes a siege workshop. That looks like preparation for rams." -> "show":{"building":{"player":2,"type":"siege_workshop"}}
  "The armies show it: 2455 for Zoe's kit, 1225 for QuartzRT." -> "show":{"versus":{"metric":"army"}}
  "Through QuartzRT's eyes: 39 enemy units in view." -> "show":{"inset":{"player":1,"decision":"latest"}}
  "Three rams head for the base." -> "show":{"follow":{"sel":{"t":"type","o":2,"ty":"ram"}}}`;

// ---------------------------------------------------------------- the world: what the match log says exists when
export class World {
  constructor(ev) {
    this.ev = ev;
    this.N = ev.players.length;
    this.structures = ev.structures || null; // old logs lack them: the checks fall back to the key buildings in the event list
    this.roster = ev.roster || null;
    this.byId = new Map(ev.events.map((e) => [e.id, e]));
    this.decisions = ev.events.filter((e) => e.type === 'llm_decision').sort((a, b) => a.t - b.t);
    this.starts = (ev.starts || []).map((s) => ({ x: s.tx + 1.5, z: s.ty + 1.5 }));
  }
  hasPlayer(p) { return Number.isInteger(p) && p >= 1 && p <= this.N; }
  // the n-th (1 = first, -1 = latest) building of a type that player p had finished by the tick; { x, z, size, t0, t1 }
  structure(p, type, tick, nth = 1) {
    let list = [];
    if (this.structures) list = this.structures.filter((s) => s.p === p && s.type === type && s.t0 <= tick + SLACK);
    else {
      for (const e of this.ev.events) {
        if (e.p !== p || e.t > tick + SLACK || !e.loc) continue;
        if ((e.type === 'key_building' && e.building === type) || (e.type === 'building_destroyed' && e.building === type)) list.push({ tx: e.loc[0], ty: e.loc[1], size: BUILDINGS[type]?.size || 3, t0: e.t, t1: null });
      }
      if (type === 'town_center' && this.starts[p - 1]) list.unshift({ tx: this.starts[p - 1].x - 1.5, ty: this.starts[p - 1].z - 1.5, size: 3, t0: 0, t1: null });
    }
    list.sort((a, b) => a.t0 - b.t0);
    const s = nth === -1 ? list[list.length - 1] : list[Math.max(0, nth - 1)];
    return s ? { x: s.tx + s.size / 2, z: s.ty + s.size / 2, size: s.size, t0: s.t0, t1: s.t1, n: list.length } : null;
  }
  // does a group of player p's units exist near the tick? (a unit type lived at some time between 10 s before the tick and the tick)
  unitsExist(p, sel, tick) {
    if (!this.roster) return sel.t !== 'type' || UN.includes(sel.ty);
    const r = this.roster[p] || {};
    const types = sel.t === 'army' ? Object.keys(r).filter(isArmyType) : sel.t === 'workers' ? ['worker'] : [sel.ty];
    return types.some((ty) => (r[ty] || []).some(([a, b]) => a <= tick + SLACK && b >= tick - 200));
  }
  // the comparison bars of a metric up to the tick (null when the log has no data for it)
  versus(metric, tick, names) {
    const ev = this.ev, rows = (vals, label) => ({ rows: vals.map((v, i) => ({ o: i + 1, name: names[i], val: v, label: label(v, i) })) });
    if (this.N !== 2) return null;
    if (metric === 'army') {
      const a = ev.series?.army; if (!a) return null;
      const s = Math.min(a[0].length - 1, Math.max(0, Math.floor(tick / TICK_HZ))), v = [0, 1].map((i) => Math.round(a[i][s]));
      return { title: `ARMY VALUE  ${clockOf(tick)}`, ...rows(v, (x) => String(x)) };
    }
    if (metric === 'think') {
      let lat = null;
      try { lat = endScreen(ev, ev.players).rows.find((r) => r.key === 'latency'); } catch { /* no decisions in this log */ }
      if (!lat || !lat.raw.every((x) => x > 0)) return null;
      const v = lat.raw.map((x) => x / 1000);
      return { title: 'THINKING TIME PER DECISION (MEDIAN)', ...rows(v, (x) => `${x.toFixed(1)} s`) };
    }
    if (metric === 'lost') {
      const v = [1, 2].map((p) => ev.events.filter((e) => (e.type === 'building_destroyed' || e.type === 'base_destroyed') && e.p === p && e.t <= tick + SLACK).length);
      return v[0] + v[1] ? { title: 'BUILDINGS LOST', pos: 'low', ...rows(v, (x) => String(x)) } : null;
    }
    if (metric === 'units_lost') {
      const v = [1, 2].map((p) => ev.events.filter((e) => e.type === 'losses' && e.p === p && e.t <= tick + SLACK).reduce((a, e) => a + (e.n || 0), 0));
      return v[0] + v[1] ? { title: 'UNITS LOST', pos: 'low', ...rows(v, (x) => String(x)) } : null;
    }
    if (BENCH_BARS[metric]) {
      const [key, title] = BENCH_BARS[metric], b = (p) => ev.bench?.players?.find((q) => q.p === p)?.[key];
      if (!(b(1) > 0 && b(2) > 0)) return null;
      return { title, ...rows([b(1), b(2)], (x) => String(x)) };
    }
    if (metric === 'notes') {
      const n = [1, 2].map((p) => this.decisions.filter((e) => e.p === p && e.t <= tick + SLACK)), w = n.map((l) => l.filter((e) => e.thought).length);
      return n[0].length + n[1].length ? { title: 'DECISIONS WITH A WRITTEN NOTE', pos: 'low', rows: [1, 2].map((p) => ({ o: p, name: names[p - 1], val: w[p - 1] / Math.max(1, n[p - 1].length), label: `${w[p - 1]} of ${n[p - 1].length}` })) } : null;
    }
    return null;
  }
  decision(p, n, tick) {
    const l = this.decisions.filter((e) => e.p === p && e.t <= tick + SLACK && e.start_tick != null);
    if (n === 'latest' || n == null) return l.filter((e) => e.thought || e.summary).slice(-1)[0] || l.slice(-1)[0] || null;
    return l.find((e) => e.n === n) || null;
  }
}

// ---------------------------------------------------------------- validation
const isSel = (s) => s && typeof s === 'object' && SEL_TYPES.includes(s.t);
export function validateTag(item, world, tick) {
  const reasons = [];
  if (!item || typeof item !== 'object' || Array.isArray(item)) return { tag: null, reasons: ['a show tag is an object like {"fog":{"player":1}}'] };
  const keys = Object.keys(item).filter((k) => k !== 'at');
  const unknown = keys.filter((k) => !SHOW_KEYS.includes(k));
  if (unknown.length) return { tag: null, reasons: [`unknown show tag "${unknown[0]}" (use ${SHOW_KEYS.join(', ')})`] };
  const main = keys.filter((k) => k !== 'fog');
  if (main.length > 1) return { tag: null, reasons: [`one show tag per item, not ${main.join(' + ')}`] };
  const k = main[0] ?? 'fog', v = item[k], bad = (r) => reasons.push(`${k}: ${r}`);
  const player = (x, what = 'player') => { if (!world.hasPlayer(x)) { bad(`${what} ${JSON.stringify(x)} is not a player of this match (1 to ${world.N})`); return false; } return true; };
  const out = {};
  if (item.fog !== undefined && k !== 'fog') {
    if (!['follow', 'building', 'place', 'map'].includes(k)) bad('fog can only be combined with follow, building, place or map');
    else if (item.fog && player(item.fog.player)) out.fog = { player: item.fog.player };
    else if (!item.fog) bad('fog needs {"player":n}');
  }
  if (!v || typeof v !== 'object') { reasons.push(`${k} needs an object`); return { tag: null, reasons }; }
  switch (k) {
    case 'view': case 'fog': if (player(v.player)) out[k] = { player: v.player }; break;
    case 'follow': {
      const s = v.sel;
      if (!isSel(s) || !player(s.o, 'sel.o')) { if (!isSel(s)) bad('sel.t must be army, workers or type'); break; }
      if (s.t === 'type' && !UN.includes(s.ty)) { bad(`unit type "${s.ty}" does not exist (${Object.keys(UNITS).join(', ')})`); break; }
      if (!world.unitsExist(s.o, s, tick)) { bad(`player ${s.o} has no ${s.t === 'type' ? displayName('unit', s.ty) : s.t} at ${clockOf(tick)}`); break; }
      out.follow = { sel: s.t === 'type' ? { t: 'type', o: s.o, ty: s.ty } : { t: s.t, o: s.o } };
      break;
    }
    case 'building': {
      if (!player(v.player)) break;
      if (!BUILDINGS[v.type]) { bad(`building type "${v.type}" does not exist (${Object.keys(BUILDINGS).join(', ')})`); break; }
      const nth = Number.isInteger(v.nth) ? v.nth : 1;
      if (!world.structure(v.player, v.type, tick, nth)) { bad(`player ${v.player} has no finished ${displayName('building', v.type)}${nth !== 1 ? ` number ${nth}` : ''} at ${clockOf(tick)}`); break; }
      out.building = { player: v.player, type: v.type, ...(nth !== 1 ? { nth } : {}) };
      break;
    }
    case 'place': {
      if (v.base !== undefined) { if (player(v.base, 'base')) out.place = { base: v.base }; break; }
      if (Number.isFinite(v.x) && Number.isFinite(v.z)) {
        if (v.x < 0 || v.z < 0 || v.x > 400 || v.z > 400) { bad('x/z are outside any map'); break; }
        out.place = { x: v.x, z: v.z };
      } else bad('needs {"base":n} or {"x":..,"z":..}');
      break;
    }
    case 'map': out.map = item.map && item.map.cards ? { cards: true } : {}; break;
    case 'versus': {
      if (!METRICS.includes(v.metric)) { bad(`unknown metric "${v.metric}" (${METRICS.join(', ')})`); break; }
      if (!world.versus(v.metric, tick, ['', '']) ) { bad(`the log has no data for the metric "${v.metric}" at ${clockOf(tick)}`); break; }
      out.versus = { metric: v.metric };
      if (v.clock != null) {
        const at = tickOfClock(v.clock);
        if (at == null) { bad(`clock "${v.clock}" is not mm:ss`); delete out.versus; break; }
        if (v.metric !== 'army') { bad(`only the army metric has a moment, "${v.metric}" has none`); delete out.versus; break; }
        out.versus = { metric: v.metric, clock: v.clock, tick: at };
      }
      if (v.focus != null) { // army metric only: the camera stays with this player's army (the line talks about that side), the bars still show both
        if (v.metric !== 'army' || (v.focus !== 1 && v.focus !== 2)) { bad('"focus" is 1 or 2 and only the army metric has it'); delete out.versus; break; }
        out.versus.focus = v.focus;
      }
      break;
    }
    case 'inset': {
      if (!player(v.player)) break;
      const n = v.decision === 'latest' || v.decision == null ? 'latest' : Number(v.decision);
      const d = world.decision(v.player, n, tick);
      if (!d) { bad(`player ${v.player} has no decision ${n === 'latest' ? 'yet' : n} at ${clockOf(tick)}`); break; }
      out.inset = { player: v.player, decision: d.n };
      break;
    }
    case 'event': {
      const e = world.byId.get(v.id);
      if (!e) { bad(`event ${v.id} is not in the log`); break; }
      if (!SHOWABLE_EVENTS.includes(e.type)) { bad(`event ${v.id} is a ${e.type}; showable: ${SHOWABLE_EVENTS.join(', ')}`); break; }
      if (e.t > tick + SLACK) { bad(`event ${v.id} happens at ${clockOf(e.t)}, after this moment (${clockOf(tick)})`); break; }
      out.event = { id: e.id };
      break;
    }
    default: break;
  }
  if (reasons.length) return { tag: null, reasons };
  if (typeof item.at === 'string' && item.at.trim()) out.at = item.at.trim();
  return { tag: out, reasons: [] };
}

export function validateShow(show, world, tick) {
  const items = show == null ? [] : Array.isArray(show) ? show : [show];
  const tags = [], reasons = [];
  if (items.length > 3) reasons.push('at most 3 show tags per line');
  items.slice(0, 3).forEach((it, i) => { const r = validateTag(it, world, tick); if (r.tag) tags.push(r.tag); else for (const x of r.reasons) reasons.push(`show[${i}] ${x}`); });
  return { tags, reasons };
}
export const tagKind = (t) => SHOW_KEYS.find((k) => k !== 'fog' && t[k] !== undefined) || 'fog';

// ---------------------------------------------------------------- the generic inferrer
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The words are searched in the text of a caster line. Phase 1: that text is classic (templates and the writer model use classic words), so 'classic' on purpose.
// A themed caster text (templates call displayName) needs the theme words here as well.
const plurals = (name) => { const n = displayName('any', name, 'classic'); return [n, n + 's', n + 'es', n.replace(/man$/, 'men'), n.replace(/y$/, 'ies')].filter((v, i, a) => a.indexOf(v) === i); };
const UNIT_RES = Object.keys(UNITS).filter((t) => !['worker'].includes(t)).map((ty) => ({ ty, re: new RegExp(`\\b(?:${plurals(ty).map(esc).join('|')})\\b`, 'gi') }));
const BLD_RES = [
  ...Object.keys(BUILDINGS).map((ty) => ({ ty, re: new RegExp(`\\b(?:${plurals(ty).map(esc).join('|')})\\b`, 'gi') })),
  { ty: 'town_center', re: /\b(?:tc|town centre)\b/gi },
  { ty: 'siege_workshop', re: /\b(?:workshop|siege shop)\b/gi },
  { ty: 'archery_range', re: /\b(?:archery|shooting range)\b/gi },
];
const ARMY_RE = /\b(?:armies|army|troops|soldiers|force|fighters|push|attackers|defenders)\b/gi;
const WORKER_RE = /\b(?:workers?|villagers?|gatherers?)\b/gi;
const FOG_RE = /\b(?:fog|fog of war|blind|in sight|in view|can see|sees?|seen|spots?|spotted|view|eyes|visible|explored|scouts?|scouting|found)\b/i;
const VERSUS_CUES = [
  ['think', /\b(?:per decision|thinking time|think time|thinks? (?:slower|faster)|as long per|slower to decide|faster to decide|seconds? per decision)\b/i],
  ['notes', /\bnotes?\b.*\b\d+\b|\bwrote \d+|\bwritten notes?\b/i],
  ['lost', /\bbuildings?\b.*\b(?:lost|fell|destroyed)\b|\blost\b.*\bbuildings?\b/i],
  ['units_lost', /\b(?:units? (?:lost|fell|gone)|losses|lost (?:\d+|\w+) units)\b/i],
  ['army', /\b(?:army value|armies show|army lead|bigger army|smaller army|army advantage|value in army|in value)\b|\barmy\b.*\b(?:\d{3,}|against|versus|vs)\b/i],
];
const BASE_RE = /\b(?:base|corner|home|town center|tc)\b/i;
// C1: the words of the ACTIVE theme, in addition to the classic ones above (the patterns above are the classic ones and stay as they are). Built for every call of inferShow,
// because a theme can be set after this module was loaded; for classic there is nothing to add, so every list below stays what it was.
// The text of a themed caster line says "Arc Gunners", "Settlers", "Landing Core": without these words no line of such a script would find its picture.
function themedPatterns() {
  const pat = (kind, ty) => { const alt = themeAlternation(kind, ty); return alt ? new RegExp(`\\b(?:${alt})\\b`, 'gi') : null; }; // regex-safe: themeAlternation escapes every word (tools/lib/theme-words.mjs esc) [C8 integration: test/regex-escape.test.mjs]
  const unitRes = [], bldRes = [];
  for (const ty of Object.keys(UNITS)) if (ty !== 'worker') { const re = pat('unit', ty); if (re) unitRes.push({ ty, re }); }
  for (const ty of Object.keys(BUILDINGS)) { const re = pat('building', ty); if (re) bldRes.push({ ty, re }); }
  const tcAlt = themeAlternation('building', 'town_center');
  return { unitRes, bldRes, workerRe: pat('unit', 'worker'), baseRe: tcAlt ? new RegExp(`\\b(?:base|corner|home|town center|tc|${tcAlt})\\b`, 'i') : BASE_RE }; // regex-safe: themeAlternation escapes every word (tools/lib/theme-words.mjs esc) [C8 integration: test/regex-escape.test.mjs]
}
const MAP_RE = /\b(?:whole map|entire map|zoom(?:ing)? (?:all the way )?out|pull(?:ing)? (?:all the way )?back)\b/i;
const BOTH_RE = /\b(?:both sides|both bases|both players|both models|together|who is (?:really )?ahead|side by side|the race)\b/i;

export function aliasesOfName(name, all) {
  const n = String(name).toLowerCase(), set = new Set([n, n.replace(/['’]s\b/, ''), n.replace(/['’]s\b/, '').replace(/\s+/g, ' ')]);
  const first = n.split(/\s+/)[0].replace(/['’]s$/, '');
  if (first.length >= 3 && all.filter((x) => String(x).toLowerCase().split(/\s+/)[0].replace(/['’]s$/, '') === first).length === 1) set.add(first);
  return [...set].filter(Boolean).sort((a, b) => b.length - a.length);
}
// Extra words by which the casters call a player: the hardware ("the Mac", "the Spark", "the 5090", "the 16 GB") and the model family ("GLM", "DeepSeek"), only when they tell the two players apart.
export function playerAliases(players) {
  let fileAl = []; try { fileAl = process.env.RTS_ALIASES_FILE ? JSON.parse(fs.readFileSync(process.env.RTS_ALIASES_FILE, 'utf8')) : []; } catch { fileAl = []; } // per player: more words the commentary uses ("quartzrt", "zoe kit")
  const raw = players.map((p, pi) => {
    const set = new Set([...(Array.isArray(p.aliases) ? p.aliases : []), ...(fileAl[pi] || [])].map((a) => String(a).toLowerCase()));
    const hw = String(p.hardware || '').toLowerCase().replace(/^\d+x\s*/, '').replace(/\b(?:nvidia|geforce)\b/g, '').trim();
    if (hw) { set.add(hw); const w = hw.split(/\s+/); if (w[0] && !/^(?:rtx|dgx)$/.test(w[0]) && !/^\d/.test(w[0])) set.add(w[0]); if (w[0] === 'dgx' && w[1]) set.add(w[1]); if (w[0] === 'rtx' && w[1]) { set.add(w[1]); set.add(`rtx ${w[1]}`); } const g = /(\d+) ?gb/.exec(hw); if (g && /rtx/.test(hw)) set.add(`${g[1]} gb`); }
    const m = String(p.model || '').toLowerCase();
    const fam = /^(glm|deepseek|minimax|qwen|kimi|llama|gpt|mistral)/.exec(m.replace(/^[^a-z]*/, ''));
    if (fam && !/qwen3\.8-27b/.test(m)) set.add(fam[1]);
    if (/flash-next/.test(m)) { set.add('flash-next'); set.add('flash next'); }
    return [...set];
  });
  return raw.map((list, i) => list.filter((a) => a.length >= 3 && !raw.some((o, j) => j !== i && o.includes(a))));
}
function matchAll(re, t) { const out = []; for (const m of t.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))) out.push({ i: m.index, s: m[0] }); return out; } // regex-safe: re is a finished regex

// text: the line; opts: { names: [name of player 1, ...], aliases?: [[...], ...], tick }
export function inferShow(text, world, opts) {
  const { names, tick } = opts;
  const T = themedPatterns();
  const al = opts.aliases || names.map((n, i) => [...new Set([...aliasesOfName(n, names), ...((opts.extra && opts.extra[i]) || [])])].sort((a, b) => b.length - a.length));
  const t = String(text).replace(/’/g, "'");
  const low = t.toLowerCase();
  const playerAt = [];
  al.forEach((list, i) => { for (const a of list) for (const m of matchAll(new RegExp(`\\b${esc(a)}(?:'s)?\\b`, 'gi'), low)) if (!playerAt.some((q) => Math.abs(q.i - m.i) < a.length)) playerAt.push({ i: m.i, p: i + 1 }); });
  playerAt.sort((a, b) => a.i - b.i);
  // sentences with offsets
  const sents = [];
  const re = /[^.!?…]+[.!?…]*\s*/g;
  for (const m of low.matchAll(re)) if (m[0].trim()) sents.push({ i: m.index, s: m[0] });
  const out = [];
  let carry = null; // the player of the previous sentence
  const push = (tag, at) => {
    const v = validateTag(tag, world, tick);
    if (!v.tag) return false;
    const last = out[out.length - 1];
    if (last && JSON.stringify(last.tag) === JSON.stringify(v.tag)) return true;
    out.push({ tag: v.tag, at: Math.max(0, at) / Math.max(1, low.length) });
    return true;
  };
  for (const S of sents) {
    const s = S.s, inS = (x) => x.i >= S.i && x.i < S.i + s.length;
    const ps = playerAt.filter(inS);
    const owner = ps.length ? ps[0].p : carry;
    if (ps.length) carry = ps[0].p;
    const other = (p) => (p === 1 ? 2 : 1);
    // 1. a decision of a model
    const dm = /\bdecision (\d+)\b/.exec(s);
    const eyes = /\bthrough \S+(?: \S+)?'s eyes\b|\bwhat (?:it|\S+) (?:saw|could see)\b|\bwhen it decided\b/.test(s);
    if ((dm || eyes) && owner && push({ inset: { player: owner, decision: dm ? Number(dm[1]) : 'latest' } }, S.i)) continue;
    // 2. a comparison
    const vc = VERSUS_CUES.find(([, r]) => r.test(s));
    const nums = (s.match(/\b\d[\d,.]*\b/g) || []).length;
    if (vc && (nums >= 1 || ps.length >= 2 || BOTH_RE.test(s)) && push({ versus: { metric: vc[0] } }, S.i)) continue;
    // 3. clock: "at 12:14" names an event or a building finished then
    const clocks = [...s.matchAll(/\b(\d{1,2}):(\d{2})\b/g)].map((m) => (+m[1] * 60 + +m[2]) * TICK_HZ);
    // 4. buildings and units mentioned
    const blds = []; for (const { ty, re: r } of BLD_RES) for (const m of matchAll(r, s)) if (!blds.some((b) => Math.abs(b.i - m.i) < 3)) blds.push({ ty, i: S.i + m.i });
    // the theme names of a building; a theme name that contains the classic word of the same building ("Berm Gate") is one mention, not two: it takes the place of the classic match inside it
    for (const { ty, re: r } of T.bldRes) for (const m of matchAll(r, s)) {
      const same = blds.find((b) => b.ty === ty && b.i >= S.i + m.i && b.i < S.i + m.i + m.s.length);
      if (same) same.i = S.i + m.i; else if (!blds.some((b) => Math.abs(b.i - (S.i + m.i)) < 3)) blds.push({ ty, i: S.i + m.i });
    }
    blds.sort((a, b) => a.i - b.i);
    const units = []; for (const { ty, re: r } of UNIT_RES) for (const m of matchAll(r, s)) units.push({ sel: { t: 'type', ty }, i: S.i + m.i });
    for (const { ty, re: r } of T.unitRes) for (const m of matchAll(r, s)) {
      const same = units.find((u) => u.sel.ty === ty && u.i >= S.i + m.i && u.i < S.i + m.i + m.s.length);
      if (same) same.i = S.i + m.i; else units.push({ sel: { t: 'type', ty }, i: S.i + m.i });
    }
    for (const m of matchAll(ARMY_RE, s)) units.push({ sel: { t: 'army' }, i: S.i + m.i });
    for (const m of matchAll(WORKER_RE, s)) units.push({ sel: { t: 'workers' }, i: S.i + m.i });
    if (T.workerRe) for (const m of matchAll(T.workerRe, s)) units.push({ sel: { t: 'workers' }, i: S.i + m.i });
    units.sort((a, b) => a.i - b.i);
    const fog = FOG_RE.test(s) && /\b(?:fog|blind|in sight|view|eyes|can see|sees?|seen|spots?|explored|visible)\b/.test(s);
    // unit groups first when fog is on: "x's view is empty, two blind armies" follows the army with the fog on
    const ownerOf = (x, pos) => { const near = playerAt.filter((q) => q.i <= pos && q.i >= S.i).pop(); return near ? near.p : owner; };
    if (fog && owner && !blds.length) {
      const u = units.find((q) => q.sel.t === 'army' || q.sel.t === 'type');
      if (u) { const o = /\b(?:enemy|their)\b/.test(s.slice(0, u.i - S.i)) && !ps.length ? other(owner) : owner; if (push({ follow: { sel: { ...u.sel, o } }, fog: { player: owner } }, S.i)) continue; }
      if (push({ fog: { player: owner } }, S.i)) continue;
    }
    if (blds.length) {
      let did = 0;
      for (const b of blds.slice(0, 2)) {
        const o = ownerOf(b, b.i);
        const cands = o ? [o] : [1, 2];
        let best = null;
        for (const p of cands) {
          // with a clock in the sentence, the building finished closest to that time
          const list = (world.structures || []).filter((q) => q.p === p && q.type === b.ty && q.t0 <= tick + SLACK);
          const nthIdx = clocks.length && list.length ? list.map((q, k) => [Math.abs(q.t0 - clocks[0]), k]).sort((x, y) => x[0] - y[0])[0][1] : 0;
          const tag = { building: { player: p, type: b.ty, ...(nthIdx ? { nth: nthIdx + 1 } : {}) } };
          if (validateTag(tag, world, tick).tag && !best) best = tag;
        }
        if (best && push(fog && owner ? { ...best, fog: { player: owner } } : best, b.i)) did++;
      }
      if (did) continue;
    }
    if (units.length) {
      const u = units[0], o = ownerOf(u, u.i);
      let sel = null;
      for (const p of o ? [o] : [1, 2]) { const c = { ...u.sel, o: p }; if (validateTag({ follow: { sel: c } }, world, tick).tag) { sel = c; break; } }
      if (sel && push({ follow: { sel } }, u.i)) continue;
    }
    if (clocks.length) {
      const e = world.ev.events.filter((q) => SHOWABLE_EVENTS.includes(q.type) && Math.abs(q.t - clocks[0]) <= 3 * TICK_HZ && (!owner || q.p === owner || q.by === owner)).sort((a, b) => Math.abs(a.t - clocks[0]) - Math.abs(b.t - clocks[0]))[0];
      if (e && push({ event: { id: e.id } }, S.i)) continue;
    }
    if (owner && T.baseRe.test(s) && push({ place: { base: owner } }, S.i)) continue;
    if (MAP_RE.test(s) && push({ map: {} }, S.i)) continue;
    if (BOTH_RE.test(s) && world.N === 2 && push({ versus: { metric: 'army' } }, S.i)) continue;
    if (fog && owner && push({ fog: { player: owner } }, S.i)) continue;
    if (owner && /\b(?:scout|opened|plan|writes|wrote|note|orders?|ordered)\b/.test(s) && push({ place: { base: owner } }, S.i)) continue;
  }
  return out.slice(0, 3);
}
