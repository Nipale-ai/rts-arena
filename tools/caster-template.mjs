// Deterministic template commentary (no LLM). Used when no model is plugged in and as the repair for lines the checker rejects.
// It follows the rule book (BROADCAST-RULES.md): Dex speaks in runs of two or three short sentences and only in action beats, Juno carries the story
// (setup, economy, intent, doubt, answers), every event gets a follow-up, AI players are "it", and every line carries the show tag of the thing it talks about.
// Every line is built from the data of the facts it cites, so it passes the same checker as an LLM line (tools/caster-check.mjs); numbers are written the way
// the checker reads them. Variants are picked by a hash of (seed, beat), never by a clock or random number, and a variant whose sentences were already said
// in this video is skipped while another one is left (a viewer never hears the same sentence twice). Gaps between the beats are filled afterwards (tools/caster-fill.mjs).
// Voices: Dex = young British football-style play-by-play, Juno = Canadian woman, about 30, engaged and warm, quick and melodic analyst.
import { nice } from './caster-facts.mjs';
import { poss, withArticle } from './lib/names.mjs';
import { estimateDuration, sentencesOf } from './caster-place.mjs';
import { HEDGE } from './caster-check.mjs';
import { validateTag } from './show-tags.mjs';
import { classWord, thingWord, buildingIdOfName, themeActive } from './lib/theme-words.mjs';
import { plainOrders } from './plain-orders.mjs';

const hash = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
const WORD = ['zero', 'one', 'two', 'three', 'four'];
// "1x RTX 5090 32 GB" -> "one RTX 5090"; anything else is said as it stands in the log
export const hwSay = (hw) => { const m = /^(\d+)x\s+(RTX\s+\d{4}(?:\s+Ti)?)/.exec(hw); return m && +m[1] < 5 ? `${WORD[+m[1]]} ${m[2]}${+m[1] > 1 ? ' cards' : ''}` : hw; };
// the checker allows the playback speed of a beat rounded to two decimals; the template says it rounded to a whole number after "about" (within 10 percent)
const speedSay = (b) => `about ${Math.max(1, Math.round(b.speed))}x`;
// roles (README, casters): action beats are Dex's, the opening is Dex's hype welcome plus Juno's introduction, every other beat is Juno's alone.
// A template line that Dex has in a calm beat moves to Juno (hype becomes engaged), Dex interjections there are dropped.
export function castRoles(b, lines) {
  if (b.role !== 'calm') return lines;
  return lines.filter((x) => !(x.speaker === 'pbp' && x.interject)).map((x) => (x.speaker === 'pbp' ? { ...x, speaker: 'ana', delivery: x.delivery === 'hype' ? 'calm' : x.delivery } : x));
}
// an opinion line always sounds like one
const hedged = (text) => (HEDGE.test(text) ? text : `I think ${text.charAt(0).toLowerCase()}${text.slice(1)}`);
// every sentence starts with a capital letter (a name or a fallback never opens a sentence in lower case); text inside quotation marks stays word for word
const capSentences = (t) => String(t).split(/([“"][^”"]*[”"])/).map((part, i) => (i % 2 ? part : part.replace(/(^|[.!?…]\s+)([a-z])/g, (m, a, c) => a + c.toUpperCase()))).join('').replace(/^([a-z])/, (c) => c.toUpperCase());
const L = (beat, speaker, when, delivery, text, facts = [], extra = {}) => ({ beat, speaker, when, delivery, text: capSentences(extra.opinion && delivery !== 'question' ? hedged(text) : text), facts, subject: null, opinion: false, interject: false, ...extra });

// what a finished building tells about the plan (intent), and what losing it costs
// C1: the unit words of these sentences are the theme's (classic: rams, archers, cavalry as they always were); a thing the theme does not rename keeps its classic word.
// The cavalry of the stables is the light cavalry of the theme (its plural), the rams are the rams, the archers the archers.
const RAMS = () => classWord('rams', 'unit', 'ram'), ARCHERS = () => classWord('archers', 'unit', 'archer'), CAVALRY = () => classWord('cavalry', 'unit', 'light_cavalry'), WORKERS = () => classWord('workers', 'unit', 'worker');
const TC = () => thingWord('town center', 'building', 'town_center');
const intentOf = (building) => ({
  siege_workshop: `That looks like preparation for ${RAMS()}.`, archery_range: 'Ranged units are coming, I think.', stables: `It is going for ${CAVALRY()}, I think.`,
  blacksmith: 'That means upgrades for the army, I think.', barracks: 'Now it can train soldiers.', tower: 'A tower: it wants to hold its ground, I think.',
})[building];
const lossOf = (building) => ({ barracks: 'new soldiers', archery_range: `new ${ARCHERS()}`, stables: `new ${CAVALRY()}`, siege_workshop: `new ${RAMS()}`, blacksmith: 'upgrades', mill: 'its food', farm: 'its food', lumber_camp: 'its wood', mining_camp: 'its gold' })[building];
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function templateLines(sheet, beats, opts = {}) {
  const seed = opts.seed ?? 0, world = opts.world ?? null;
  const F = new Map(sheet.facts.map((f) => [f.id, f]));
  const SUB = new Map((sheet.subjects || []).map((s) => [s.id, s]));
  const P = sheet.players;
  const S = (p) => P[p - 1]?.say ?? P[p - 1]?.short ?? 'the player';
  const out = [];
  const first = P.map((q) => q.name.split(/\s+/)[0]);
  const fam = P.length === 2 && first[0] === first[1] && /\d/.test(first[0]) ? first[0] : null;
  const only = opts.only ?? null;
  const onHw = (p) => (P[p - 1]?.hw && !/no model|mock/i.test(P[p - 1].hw) ? ` on ${hwSay(P[p - 1].hw)}` : '');
  const tl = opts.tl ?? null;
  const decisionsSeen = [];
  // what was said already (sentences of three words or more, normalised) and which economy statements were made: nothing is said twice
  const said = new Set(), told = { tier: null, built: new Set(), workers: null };
  const normS = (t) => String(t).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const sentsOf = (t) => sentencesOf(t).map(normS).filter((x) => x.split(' ').length >= 3);
  const textsOf = (v) => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : x?.text)).filter(Boolean) : v?.text ? [v.text] : []);
  const fresh = (v) => textsOf(v).every((t) => sentsOf(capSentences(t)).every((x) => !said.has(x)));
  // composed lines (an opener, the numbers, a closer): the option that was used least so far, ties by hash; nothing repeats until every option was used once
  const uses = new Map();
  const lruOf = (options, salt) => { const h = hash(`${seed}:${salt}`) % options.length; let best = 0, bestN = Infinity, bestR = Infinity; options.forEach((o, i) => { const n = uses.get(normS(o.t ?? o)) ?? 0, r = (i - h + options.length) % options.length; if (n < bestN || (n === bestN && r < bestR)) { best = i; bestN = n; bestR = r; } }); const o = options[best]; uses.set(normS(o.t ?? o), bestN + 1); return o; };
  const remember = (lines) => { for (const x of lines) for (const k of sentsOf(x.text)) said.add(k); };
  const byKind = (b, k) => b.facts.map((id) => F.get(id)).find((f) => f && f.kind === k);
  const allOf = (b, k) => b.facts.map((id) => F.get(id)).filter((f) => f && f.kind === k);
  const firstOf = (b, kinds) => b.facts.map((id) => F.get(id)).find((f) => f && kinds.includes(f.kind));
  const other = (p) => (p === 1 ? 2 : 1);
  for (const b of beats) {
    const pick = (arr, salt = '') => { const h = hash(`${seed}:${b.id}:${b.kind}:${salt}`) % arr.length; for (let k = 0; k < arr.length; k++) { const v = arr[(h + k) % arr.length]; if (fresh(v)) return v; } return arr[h]; };
    // the second a thing that happened at a tick is on screen (inside this beat), for a line that must not come at the start of a long stretch
    const atS = (tick) => { if (!tl || tick == null) return null; const o = tl.outAt(tick) + 0.3; return o >= b.seg0 && o <= b.seg1 - 1.5 ? +o.toFixed(2) : null; };
    const sid = (...roles) => { for (const r of roles) { const s = b.subjects?.map((i) => SUB.get(i)).find((x) => x && x.role === r); if (s) return s.id; } return b.subjects?.[0] ?? null; };
    // show tags: the first candidate that is true in the log at the end of this moment (the checker would drop a wrong one; a template never writes one)
    const tag = (...cands) => { for (const c of cands) if (c && (!world || validateTag(c, world, b.tick_end ?? b.tick).tag)) return c; return null; };
    const shows = (...tags) => { const t = tags.filter(Boolean); return t.length ? (t.length === 1 ? t[0] : t) : null; };
    const evTag = (f) => (f && f.data?.eid != null ? { event: { id: f.data.eid } } : null);
    const bldTag = (p, type) => ({ building: { player: p, type } });
    const base = (p) => ({ place: { base: p } });
    const l = (speaker, when, delivery, text, facts = [], extra = {}) => L(b.id, speaker, when, delivery, text, facts, { subject: sid(), ...extra });
    const emit = (lines) => { if (only == null || only === b.id) { const ls = castRoles(b, lines.filter(Boolean)); out.push(...ls); remember(ls); } };
    const mf = firstOf(b, ['first_contact', 'key_building', 'tier_up', 'swing', 'battle', 'razed', 'base', 'victory', 'orders', 'series', 'final']);
    // the economy of both sides in a stretch of the story (facts "econ"): who is where, what it built, what that means. Nothing is told twice: a tier
    // pair, a worker pair or a building that was told before is left out, so a long stretch of the match never repeats "both sides are on tier 2".
    const econ = () => {
      const e = [1, 2].map((p) => allOf(b, 'econ').find((f) => f.data.p === p));
      if (!e[0] || !e[1]) return [];
      const d = [e[0].data, e[1].data], ids = [e[0].id, e[1].id];
      const lines = [];
      const add = (when, delivery, text, cites, extra = {}) => lines.push(l('ana', when, delivery, text, cites, extra));
      const tkey = `${d[0].tier}/${d[1].tier}`;
      if (told.tier !== tkey) {
        told.tier = tkey;
        const same = d[0].tier === d[1].tier;
        const t = same ? `Both sides are on tier ${d[0].tier}.` : `${S(1)} is on tier ${d[0].tier}, ${S(2)} on tier ${d[1].tier}.`;
        add('at', 'calm', pick([t, `The state of play: ${t}`, same ? `Tier ${d[0].tier} for both sides so far.` : `${S(1)} sits on tier ${d[0].tier}, and ${S(2)} on tier ${d[1].tier}.`, same ? `Nobody has stepped up to a higher tier yet. It is tier ${d[0].tier} on both sides.` : `On the tier ladder it is ${d[0].tier} for ${S(1)} against ${d[1].tier} for ${S(2)}.`], 'a'), ids, { subject: sid('base') });
      }
      // intent: a building that was finished in this stretch (said when it happens), or the newest key building of the side that has more of them
      const kb = firstOf(b, ['key_building']);
      const who = kb ? kb.data.p : d[0].built.length >= d[1].built.length ? 1 : 2;
      const lastB = kb ? nice(kb.data.building) : d[who - 1].built[d[who - 1].built.length - 1];
      const type = lastB ? buildingIdOfName(lastB) : null; // the id behind the display name (classic: the old spaces-to-underscores)
      const bkey = `${who}:${type}`;
      if (lastB && intentOf(type) && !told.built.has(bkey)) {
        told.built.add(bkey);
        const txt = kb ? pick([`${S(who)} finishes its first ${lastB} here. ${intentOf(type)}`, `There it is: the first ${lastB} for ${S(who)}. ${intentOf(type)}`], 'b') : pick([`${S(who)} already has ${withArticle(lastB)}. ${intentOf(type)}`, `${withArticle(lastB).replace(/^a/, 'A')} is up for ${S(who)} by now. ${intentOf(type)}`], 'b');
        add(lines.length ? 'after' : 'at', 'calm', txt, [kb ? kb.id : e[who - 1].id], { subject: sidOwner(who), show: shows(kb ? evTag(kb) : null, tag(bldTag(who, type)), tag(base(who))), ...(kb && atS(kb.tick) != null && !lines.length ? { at_s: atS(kb.tick), when: 'at', filler: true } : {}) });
      } else if (!lines.length && (d[0].built.length || d[1].built.length) && told.built.size < 6 && !told.built.has(`idle${who}`)) {
        told.built.add(`idle${who}`);
        add('at', 'calm', pick([`${S(who)} keeps building up. I think it is preparing something.`, `${S(who)} is still adding to its base. I think something is brewing.`, `Quiet on the surface, but ${S(who)} keeps building. I think a plan is taking shape.`], 'b'), [e[who - 1].id], { opinion: true, show: shows(tag(base(who))) });
      }
      // workers on the field right now (from the replay); said again only after a real change
      const wnow = d[0].workers != null && d[1].workers != null ? [d[0].workers, d[1].workers] : null;
      if (wnow && (!told.workers || Math.abs(told.workers[0] - wnow[0]) >= 3 || Math.abs(told.workers[1] - wnow[1]) >= 3)) {
        told.workers = wnow;
        add(lines.length ? 'after' : 'at', 'calm', pick([`${S(1)} has ${wnow[0]} ${WORKERS()}, ${S(2)} ${wnow[1]}.`, `On ${WORKERS()} it is ${wnow[0]} for ${S(1)} and ${wnow[1]} for ${S(2)}.`, `${thingWord('Worker', 'unit', 'worker')} count right now: ${wnow[0]} for ${S(1)}, ${wnow[1]} for ${S(2)}.`], 'w'), ids, { subject: sid('base'), show: shows(tag(base(wnow[0] >= wnow[1] ? 1 : 2))) });
      }
      // follow-up: who leads, and will it last
      if (d[0].army_value != null && d[1].army_value != null && d[0].army_value !== d[1].army_value && lines.length < 3) {
        const lead = d[0].army_value > d[1].army_value ? 1 : 2, hi = d[lead - 1].army_value, lo = d[other(lead) - 1].army_value;
        add(lines.length ? 'after' : 'at', 'question', pick([
          `Army value is ${hi} against ${lo}, so ${S(lead)} is ahead. Can ${S(other(lead))} catch up?`,
          `${S(lead)} leads on army value, ${hi} to ${lo}. Does that last?`,
          `On army value it is ${S(lead)} with ${hi} and ${S(other(lead))} with ${lo}. Can the gap close?`,
          `${hi} against ${lo} in army value: ${S(lead)} holds the edge. Is that enough?`,
        ], 'c'), ids, { opinion: true, show: shows(tag({ versus: { metric: 'army' } })) });
      }
      return lines.slice(0, 3);
    };
    const sidOwner = (p) => b.subjects?.map((i) => SUB.get(i)).find((x) => x && x.owner === p)?.id ?? sid();
    switch (b.kind) {
      case 'open': {
        const meta = b.facts.filter((id) => F.get(id)?.kind === 'meta'), pl = b.facts.filter((id) => F.get(id)?.kind === 'player');
        const howto = byKind(b, 'howto');
        const s1 = b.subjects?.[0] ?? null, s2 = b.subjects?.[1] ?? s1;
        const lines = pick([
          [l('pbp', 'at', 'hype', "Good evening, and welcome to RTS Arena! I'm Dex Harlan.", meta, { subject: s1, show: shows(tag(base(1))) }),
           l('ana', 'after', 'calm', `Juno Quill alongside. In the one corner ${S(1)}${onHw(1)}, in the other ${S(2)}${onHw(2)}.${fam ? ` Two builds of ${fam}, so it's all about the kit.` : ''}`, pl, { alts: [`Juno Quill alongside. It's ${S(1)} against ${S(2)}.`], subject: s2, show: shows(tag(base(1)), tag({ ...base(2), at: 'in the other' })) })],
          [l('pbp', 'at', 'hype', "Hello, hello, you're watching RTS Arena and I'm Dex Harlan! No humans touching a thing today!", meta, { subject: s1, show: shows(tag(base(2))) }),
           l('ana', 'after', 'calm', `Juno Quill here. Today it's ${S(1)} against ${S(2)}${fam ? `, both ${fam}` : ''}${sheet.cls ? `, class ${sheet.cls}` : ''}.`, [...meta, ...pl], { subject: s2, show: shows(tag(base(1)), tag({ ...base(2), at: 'against' })) })],
        ]);
        if (howto) lines.push(l('ana', 'after', 'calm', `The goal is simple: build an economy, build an army, and destroy the other side's ${TC()}.`, [howto.id], { trim_first: true, subject: s2, show: shows(tag(base(1)), tag({ ...base(2), at: 'destroy' })) }));
        emit(lines);
        break;
      }
      case 'first_contact': {
        const f = byKind(b, 'first_contact') || mf;
        if (f?.kind === 'first_contact') {
          const p = f.data.p, o = f.data.other, what = nice(f.data.what);
          emit(pick([
            [l('ana', 'at', 'calm', `First contact! ${S(p)} spots ${poss(S(o))} ${what}.`, [f.id], { show: shows(evTag(f)) }),
             l('ana', 'after', 'question', `Now ${S(p)} knows where to look, and ${S(o)} may know it is being watched. Does a rush follow?`, [f.id], { opinion: true, show: shows(tag(base(o))) })],
            [l('ana', 'at', 'calm', `There it is: ${S(p)} has eyes on ${poss(S(o))} ${what}.`, [f.id], { show: shows(evTag(f)) }),
             l('ana', 'after', 'calm', 'No more guessing, I think. From here on both sides can plan against what they have seen.', [f.id], { opinion: true, show: shows(tag({ fog: { player: p } })) })],
            [l('ana', 'at', 'calm', `${S(p)} finds ${poss(S(o))} ${what}. The scouts have done their job.`, [f.id], { show: shows(evTag(f)) }),
             l('ana', 'after', 'question', `What does ${S(p)} do with that knowledge?`, [f.id], { opinion: true, show: shows(tag({ fog: { player: p } })) })],
          ]));
        } else if (f?.kind === 'swing') emit([l('ana', 'at', 'calm', `And the lead flips to ${S(f.data.to)}! Army value ${f.data.army[0]} against ${f.data.army[1]}.`, [f.id], { show: shows(tag({ versus: { metric: 'army' } })) }), l('ana', 'after', 'question', 'Is that a real turn, or just a moment?', [f.id], { opinion: true })]);
        break;
      }
      case 'key': {
        const f = byKind(b, 'key_building') || byKind(b, 'expansion');
        if (!f) break;
        const bn = f.kind === 'expansion' ? `second ${TC()}` : nice(f.data.building);
        const intent = f.kind === 'key_building' ? intentOf(f.data.building) : `More ${WORKERS()} and more income, I think.`;
        emit(pick([
          [l('ana', 'at', 'calm', f.kind === 'expansion' ? `${S(f.data.p)} is expanding, a second ${TC()}!` : `${S(f.data.p)} finishes its first ${bn}.`, [f.id], { show: shows(evTag(f)) }), l('ana', 'after', 'calm', intent || 'That opens up new options for it, I think.', [f.id], { opinion: true })],
          [l('ana', 'at', 'calm', `First ${bn} for ${S(f.data.p)}.`, [f.id], { show: shows(evTag(f)) }), l('ana', 'after', 'calm', intent || 'A step up for its plan, I think.', [f.id], { opinion: true })],
          [l('ana', 'at', 'calm', `${S(f.data.p)} has its ${bn} up and running.`, [f.id], { show: shows(evTag(f)) }), l('ana', 'after', 'calm', intent || 'That gives it more to work with, I think.', [f.id], { opinion: true })],
        ]));
        break;
      }
      case 'tier_up': {
        const f = byKind(b, 'tier_up');
        if (!f) break;
        const ec = byKind(b, 'econ');
        emit(pick([
          [l('ana', 'at', 'calm', `${S(f.data.p)} reaches tier ${f.data.tier}.`, [f.id], { show: shows(evTag(f)) }), l('ana', 'after', 'calm', "Bigger toys unlocked, I think. Whether it pays off, we'll see.", [f.id], { opinion: true })],
          [l('ana', 'at', 'calm', `Tier ${f.data.tier} for ${S(f.data.p)}.`, [f.id], { show: shows(evTag(f)) }), l('ana', 'after', 'question', ec && ec.data.army_value != null ? `With an army value of ${ec.data.army_value}, what does it do with the new options?` : 'What does it do with the new options?', ec ? [f.id, ec.id] : [f.id], { opinion: true })],
          [l('ana', 'at', 'calm', `${S(f.data.p)} moves up to tier ${f.data.tier}.`, [f.id], { show: shows(evTag(f)) }), l('ana', 'after', 'question', 'Is it ready to use what that unlocks?', [f.id], { opinion: true })],
        ]));
        break;
      }
      case 'orders': {
        const f = byKind(b, 'orders');
        if (!f) break;
        const tgt = sid('target', 'site');
        emit(pick([
          [l('ana', 'at', 'question', `${S(f.data.p)} orders: ${themeActive() ? plainOrders(f.data.orders) : f.data.orders}. Is that the right call?` /* C1: the raw order words ("train 3x ram") are classic; a theme reads them in plain words with its names */, [f.id], { subject: tgt, show: shows(tag({ follow: { sel: { t: 'army', o: f.data.p } } }), tag(base(f.data.p))) }), l('ana', 'after', 'tense', "We'll find out soon enough.", [], { subject: tgt })],
          [l('ana', 'at', 'calm', `Look at that order from ${S(f.data.p)}: ${f.data.orders}.`, [f.id], { subject: tgt, show: shows(tag({ follow: { sel: { t: 'army', o: f.data.p } } }), tag(base(f.data.p))) }), l('ana', 'after', 'question', "Hm, what's the plan there?", [f.id], { opinion: true, subject: tgt })],
        ]));
        break;
      }
      case 'chat': {
        const f = byKind(b, 'note');
        if (!f) break;
        const q = String(f.data.quote).split(/;| — | - /)[0].split(/\s+/).slice(0, 12).join(' ').replace(/[.!?,]+$/, '');
        if (q.split(/\s+/).length < 3 || q.length < 8) break;
        emit(pick([
          [l('ana', 'at', 'calm', `${poss(S(f.data.p))} plan here: “${q}”.`, [f.id], { show: shows(tag(base(f.data.p))) }), l('ana', 'after', 'question', 'Fair enough, but will it work?', [f.id], { opinion: true })],
          [l('ana', 'at', 'calm', `And ${S(f.data.p)} writes: “${q}”.`, [f.id], { show: shows(tag(base(f.data.p))) }), l('ana', 'after', 'question', 'Is that enough of a plan?', [f.id], { opinion: true })],
        ]));
        break;
      }
      case 'say': {
        const f = byKind(b, 'say');
        if (!f) break;
        const q = String(f.data.quote).replace(/[.!?,]+$/, '');
        if (q.split(/\s+/).length < 3 || q.length < 8) break;
        emit(pick([
          [l('ana', 'at', 'calm', `${S(f.data.p)} says in the chat: “${q}”.`, [f.id], { show: shows(tag(base(f.data.p))) }), l('ana', 'after', 'question', 'Is that a bluff, or does it mean it?', [f.id], { opinion: true })],
          [l('ana', 'at', 'calm', `And ${S(f.data.p)} types: “${q}”.`, [f.id], { show: shows(tag(base(f.data.p))) }), l('ana', 'after', 'question', 'A bit of trash talk, or a real warning?', [f.id], { opinion: true })],
        ]));
        break;
      }
      case 'weather': {
        const f = byKind(b, 'weather');
        if (!f) break;
        emit([l('ana', 'at', 'calm', `The weather turns to ${f.data.kind}, for both sides alike.`, [f.id]), l('ana', 'after', 'calm', 'Same sky for everyone, so nobody can blame the weather.', [f.id])]);
        break;
      }
      case 'caravan': {
        const f = byKind(b, 'caravan');
        if (!f) break;
        emit(f.data.raid
          ? [l('ana', 'at', 'calm', `${S(f.data.p)} raids a caravan, ${f.data.gold} gold!`, [f.id], { show: shows(tag(base(f.data.p))) }), l('ana', 'after', 'calm', 'Free money, if the soldiers can be spared.', [f.id], { opinion: true })]
          : [l('ana', 'at', 'calm', 'A trade caravan reaches its post, and the escorts get paid.', [f.id]), l('ana', 'after', 'calm', 'A nice little bonus for whoever kept the road safe.', [f.id])]);
        break;
      }
      case 'sea': {
        const f = byKind(b, 'sea');
        if (!f) break;
        emit([l('pbp', 'at', 'hype', `Sea battle! ${f.data.value} value sunk! Ships going down everywhere!`, [f.id]), l('ana', 'after', 'calm', 'Whoever owns the water gets the fish and the shore, I think.', [f.id], { opinion: true })]);
        break;
      }
      case 'battle': {
        const f = byKind(b, 'battle');
        if (!f) break;
        const d = f.data, parts = Object.entries(d.participants).map(([p, q]) => ({ p: +p, n: q.lost_units, v: q.lost_value, b: q.lost_buildings || 0 }));
        // big / small by lost units first (the lines below talk about units), value only breaks ties: a side that lost only buildings is not "hardly a unit lost" for the other
        const big = parts.slice().sort((x, y) => y.n - x.n || y.v - x.v)[0], small = parts.slice().sort((x, y) => x.n - y.n || x.v - y.v)[0];
        const bl = parts.slice().sort((x, y) => y.b - x.b)[0], walls = bl && bl.b ? `No units lost, but ${S(bl.p)} loses ${plural(bl.b, 'building')}.` : null; // no unit fell, but buildings did
        const quick = b.speed >= 4, one = big && small && big.p !== small.p && small.n === 0 && big.n > 0;
        const lossL = big && big.n ? `${S(big.p)} loses ${plural(big.n, 'unit')} there, and that hurts. ${one ? `${S(small.p)} loses none, so it is mop-up time.` : 'I think the fight decides who has the upper hand now.'}` : walls || 'A short, sharp fight with no real damage. Nothing decided yet.';
        const open = lruOf([{ t: 'Here they come, here they come!', d: 'hype' }, { t: 'Armies are closing in!', d: 'tense' }, { t: 'And the armies collide!', d: 'hype' }, { t: 'Steel on steel!', d: 'tense' }, { t: 'It is all kicking off!', d: 'hype' }, { t: 'Contact! Contact!', d: 'tense' }, { t: 'Here comes the clash!', d: 'hype' }, { t: 'And here we go!', d: 'hype' }, { t: 'This is getting serious!', d: 'tense' }, { t: 'They are at each other now!', d: 'hype' }], `${b.id}:bo`);
        const stat = lruOf([`${plural(d.kills, 'kill')}, ${d.value} value destroyed in ${plural(d.dur, 'second')}.`, `${plural(d.kills, 'kill')}, ${d.value} value gone.`, `${d.value} value destroyed, ${plural(d.kills, 'kill')}.`, `${plural(d.kills, 'kill')} in this fight, ${d.value} value up in smoke.`], `${b.id}:bs`);
        const close = lruOf(['What a scrap!', 'Absolute chaos!', 'Absolutely wild!', 'Unbelievable scenes!', 'What a brawl!', 'Pure mayhem!', 'What a fight!', 'Carnage!'], `${b.id}:bc`);
        const follow = pick([
          l('ana', 'after', 'calm', lossL, [f.id], { opinion: true }),
          l('ana', 'after', 'calm', quick ? `That fight just flew by at ${speedSay(b)}, but ${d.value} value is gone. Who can afford that?` : `${d.value} value destroyed. ${big && big.n ? `${S(big.p)} takes the heavy losses, and I think it will feel that for a while.` : walls || 'Nobody took a real beating, I think.'}`, [f.id], { opinion: true }),
          l('ana', 'after', 'calm', big && big.n ? `${S(big.p)} is hit hardest, ${plural(big.n, 'unit')} down. ${one ? `${S(small.p)} comes out clean.` : 'I think the other side has the upper hand now.'}` : walls || 'Plenty of noise, but no real damage. Is the real fight still to come?', [f.id], { opinion: true }),
          l('ana', 'after', 'question', big && big.n ? `${plural(big.n, 'unit')} lost on ${poss(S(big.p))} side. Can it afford that?` : walls || 'Hardly a unit lost. Was that all?', [f.id], { opinion: true }),
          l('ana', 'after', 'calm', quick ? `At ${speedSay(b)} it is over in a blink, with ${d.value} value gone.` : `${d.value} value gone in ${plural(d.dur, 'second')}. I think that fight shifts the balance.`, [f.id], { opinion: true }),
          l('ana', 'after', 'calm', big && big.n ? `${S(big.p)} paid for that one, ${plural(big.n, 'unit')} gone. I think it changes how the next fight looks.` : walls || 'Hardly any damage there. I think the real fight is still ahead.', [f.id], { opinion: true }),
          l('ana', 'after', 'tense', `After ${plural(d.kills, 'kill')} in one fight, I think both sides will be careful with the next one.`, [f.id], { opinion: true }),
          l('ana', 'after', 'question', `That is ${d.value} value off the board. Who gets the better of the next clash?`, [f.id], { opinion: true }),
        ], 'f');
        emit([l('pbp', 'at', open.d, `${open.t} ${stat} ${close}`, [f.id], { show: shows(evTag(f)), alts: [`${open.t} ${stat}`, stat] }), follow]);
        break;
      }
      case 'razed': {
        const f = byKind(b, 'razed');
        if (!f) break;
        const bn = nice(f.data.building), loss = lossOf(f.data.building);
        if (f.data.crumble) { // sudden death: no attacker, nobody to name
          emit(pick([
            [l('pbp', 'at', 'hype', `${poss(S(f.data.p))} ${bn} crumbles away! No attacker needed!`, [f.id], { show: shows(evTag(f)) }), l('ana', 'after', 'calm', `That is sudden death: every building keeps losing hit points.${loss ? ` No ${bn} means no ${loss} for ${S(f.data.p)}.` : ''}`, [f.id])],
            [l('pbp', 'at', 'hype', `And down goes ${poss(S(f.data.p))} ${bn}, all on its own! The bases are crumbling!`, [f.id], { show: shows(evTag(f)) }), l('ana', 'after', 'question', `With nobody able to rebuild or repair, how long can ${S(f.data.p)} hold on?`, [f.id], { opinion: true })],
          ]));
          break;
        }
        const evt = lruOf([`${S(f.data.by)} razes ${poss(S(f.data.p))} ${bn}!`, `And there goes the ${bn}! ${S(f.data.by)} is tearing through!`, `Down it comes! ${S(f.data.by)} flattens ${poss(S(f.data.p))} ${bn}!`, `${S(f.data.by)} takes out ${poss(S(f.data.p))} ${bn}!`, `And down goes ${poss(S(f.data.p))} ${bn}, with ${S(f.data.by)} not slowing down!`, `${S(f.data.by)} brings down ${poss(S(f.data.p))} ${bn}!`], `${b.id}:re`);
        const cl = lruOf(['Gone!', 'That is a proper blow!', 'What a push!', 'Brutal!', 'What a hit!', 'Just like that!', 'That one hurts!', 'No mercy!'], `${b.id}:rc`);
        const fol = pick([
          l('ana', 'after', 'calm', loss ? `No ${bn} means no ${loss} for ${S(f.data.p)}. I think that changes the plan.` : `Every building that falls is production the other side loses. I think ${S(f.data.p)} has to answer quickly.`, [f.id], { opinion: true }),
          l('ana', 'after', 'question', loss ? `Without ${loss}, can ${S(f.data.p)} still fight back?` : `Can ${S(f.data.p)} stop the bleeding?`, [f.id], { opinion: true }),
          l('ana', 'after', 'calm', loss ? `That is ${loss} gone for ${S(f.data.p)}. I think it needs an answer fast.` : `One building less for ${S(f.data.p)}. Can it rebuild in time?`, [f.id], { opinion: true }),
          l('ana', 'after', 'question', loss ? `${S(f.data.p)} is without ${loss} now. How does it fight on?` : `Losing ${withArticle(bn)} hurts. Does ${S(f.data.p)} have an answer?`, [f.id], { opinion: true }),
        ], 'f');
        emit([l('pbp', 'at', 'hype', `${evt} ${cl}`, [f.id], { show: shows(evTag(f)), alts: [evt] }), fol]);
        break;
      }
      case 'base': {
        const f = byKind(b, 'base');
        if (!f) break;
        const prior = decisionsSeen.find((d) => d.p === f.data.p);
        const lines = [l('pbp', 'at', 'hype', f.data.crumble
          ? pick([`${poss(S(f.data.p))} ${TC()} crumbles away, with nobody to blame! Is this the end?`, `${poss(S(f.data.p))} base crumbles all on its own! Is the match slipping away?`], 'x')
          : pick([`The base falls! ${S(f.data.by)} takes down ${poss(S(f.data.p))} ${TC()}! Is this the end?`, `That is the ${TC()} gone! ${S(f.data.by)} has broken through! Is the match slipping away from ${S(f.data.p)}?`], 'x'), [f.id], { show: shows(evTag(f)), optional: false }), l('ana', 'react', 'calm', pick(['And there it is.', 'Oh, that is the big one.', 'There it goes.'], 'y'), [])];
        if (prior) lines.push(l('ana', 'after', 'calm', `So, was that push the right call for ${S(f.data.p)}? I think the ${TC()} answers it.`, [f.id], { opinion: true }));
        else lines.push(l('ana', 'after', 'calm', `No ${TC()}, no more ${WORKERS()}. I think that hurts more than anything before.`, [f.id], { opinion: true }));
        emit(lines);
        break;
      }
      case 'decision': case 'hold': {
        const note = byKind(b, 'note'), saw = byKind(b, 'saw'), aim = byKind(b, 'aim'), ord = byKind(b, 'orders');
        if (!note) {
          if (ord) emit([l('ana', 'at', 'question', `${S(ord.data.p)} gives orders without a note. What is the plan?`, [ord.id], { opinion: true, show: shows(tag({ inset: { player: ord.data.p, decision: ord.data.n } }), tag({ fog: { player: ord.data.p } })) })]);
          break;
        }
        const s = S(note.data.p);
        decisionsSeen.push({ p: note.data.p, beat: b.id });
        const sawS = sid('saw', 'note'), noteS = sid('note', 'target'), tgtS = sid('target', 'note');
        const drop = saw && saw.data.army_from != null && saw.data.army_to != null && saw.data.army_from !== saw.data.army_to;
        const q = String(note.data.quote).split(/;| — | - /)[0].split(/\s+/).slice(0, 12).join(' ').replace(/[.!?,]+$/, '');
        const inset = tag({ inset: { player: note.data.p, decision: note.data.n } }), fog = tag({ fog: { player: note.data.p } });
        const quote = q.split(/\s+/).length >= 3 && q.length >= 8 ? l('ana', 'at', 'calm', `${poss(s)} plan here: “${q}”.`, [note.id], { subject: noteS, show: shows(inset || fog) }) : null;
        const af = aim ? [aim.id] : [];
        const mkSaw = (txt, cites = saw ? [saw.id] : [], extra = {}) => l('ana', 'before', extra.delivery || 'tense', txt, cites, { subject: sawS, show: shows(fog), filler: !cites.length, ...extra });
        const dropTxt = drop ? `${poss(s)} army value just went from ${saw.data.army_from} to ${saw.data.army_to}. So what does it do now?` : null;
        const variants = [
          [drop ? mkSaw(dropTxt, undefined, { alts: [`What does ${s} do now?`] }) : mkSaw(`Big decision coming from ${s}. What will it do with what it can see?`, saw ? [saw.id] : [], { opinion: true }), quote, l('ana', 'after', 'question', "Is that the right call? We'll see.", [note.id, ...af], { opinion: true, subject: tgtS })],
          [mkSaw(saw && saw.data.enemy_n ? `${saw.data.enemy_n} enemy ${saw.data.enemy_n === 1 ? 'unit' : 'units'} in view. What does ${s} make of that?` : `What does ${s} make of this?`, undefined, { delivery: 'question' }), quote, l('ana', 'after', 'question', 'Was that the right decision? I am not sure yet.', [note.id, ...af], { opinion: true, subject: tgtS })],
          [mkSaw('Watch this order.'), quote, drop ? l('ana', 'after', 'calm', `I think the army value says it all: ${saw.data.army_from} down to ${saw.data.army_to}.`, [saw.id], { opinion: true, subject: tgtS }) : l('ana', 'after', 'question', 'Is that going to work?', [note.id, ...af], { opinion: true, subject: tgtS })],
          [mkSaw(`Here comes the next move from ${s}.`), quote, l('ana', 'after', 'question', `Does ${s} know what it is doing here?`, [note.id, ...af], { opinion: true, subject: tgtS })],
          [mkSaw(`Time to see what ${s} makes of its position.`), quote, drop ? l('ana', 'after', 'tense', `${poss(s)} army value went ${saw.data.army_from} to ${saw.data.army_to} before this. I think it had to react.`, [saw.id], { opinion: true, subject: tgtS }) : l('ana', 'after', 'calm', 'That is a plan with a clear idea behind it, I think. Whether it holds, we will see.', [note.id, ...af], { opinion: true, subject: tgtS })],
        ].map((ls) => ls.filter(Boolean));
        const lines = pick(variants, 'h');
        emit(lines);
        break;
      }
      case 'lead': case 'build': case 'compare': emit(econ()); break;
      case 'after': {
        const c = byKind(b, 'conseq');
        if (!c) { emit(econ()); break; }
        const d = c.data, lines = [];
        const [a0, a1] = [d.army0, d.army1];
        if (a0.every((x) => x != null) && a1.every((x) => x != null) && [...a0, ...a1].some((x) => x > 0)) lines.push(l('ana', 'at', 'calm', pick([`Since the decision ${poss(S(1))} army value went from ${a0[0]} to ${a1[0]}, and ${poss(S(2))} from ${a0[1]} to ${a1[1]}.`, `Look at the numbers since then: ${S(1)} moved from ${a0[0]} to ${a1[0]} in army value, ${S(2)} from ${a0[1]} to ${a1[1]}.`, `In army value, ${S(1)} went ${a0[0]} to ${a1[0]} since the decision, and ${S(2)} ${a0[1]} to ${a1[1]}.`], 'a'), [c.id], { show: shows(tag({ versus: { metric: 'army' } })) }));
        const worst = d.lost.map((x, i) => ({ p: i + 1, n: x.n })).sort((x, y) => y.n - x.n)[0];
        if (worst && worst.n > 0) lines.push(l('ana', 'after', 'calm', pick([`${S(worst.p)} lost ${plural(worst.n, 'unit')} in that stretch. I think that answers the question from before.`, `${plural(worst.n, 'unit')} down on ${poss(S(worst.p))} side since then. I think we have our answer.`, `${S(worst.p)} is ${plural(worst.n, 'unit')} lighter after that stretch. I think the decision shows in the numbers.`], 'b'), [c.id], { opinion: true, show: shows(tag({ follow: { sel: { t: 'army', o: other(worst.p) } } })) }));
        else lines.push(l('ana', 'after', 'question', pick(['Nobody lost a unit. So is the real test still to come?', 'Not a single unit lost. Was that a quiet stretch, or the calm before something?', 'No losses on either side since then. Who blinks first?', 'Everyone is still alive out there. How long does that last?'], 'b'), [c.id], { opinion: true }));
        emit(lines);
        break;
      }
      case 'victory': {
        const f = byKind(b, 'victory');
        if (!f) break;
        const w = f.data.winner;
        emit(w
          ? [l('pbp', 'at', 'hype', `That's it! ${S(w)} wins the match! What a finish!`, [f.id], { show: shows(tag(base(other(w)))), optional: false, keep: true, alts: [`That's it! ${S(w)} wins the match!`] })]
          : [l('ana', 'at', 'calm', 'And that is the end of the match.', [f.id])]);
        break;
      }
      case 'close': {
        const f = byKind(b, 'final'), why = allOf(b, 'why')[0];
        const lines = [];
        if (why && why.data.winner && why.data.src && why.data.n != null && why.data.of != null) lines.push(l('ana', 'at', 'calm', `So how was it won? ${poss(S(why.data.winner))} ${nice(why.data.src)}s destroyed ${why.data.n} of the ${why.data.of} buildings ${S(why.data.loser)} lost.`, [why.id], { show: shows(tag({ versus: { metric: 'lost' } })) }));
        if (f && f.data.kills && f.data.kill_value) {
          lines.push(l('ana', why ? 'after' : 'at', 'calm', `The scoreboard: kills ${f.data.kills[0]} to ${f.data.kills[1]}, value destroyed ${f.data.kill_value[0]} against ${f.data.kill_value[1]}.`, [f.id], { alts: [`The scoreboard: kills ${f.data.kills[0]} to ${f.data.kills[1]}.`], show: shows(tag({ versus: { metric: 'units_lost' } }), tag({ versus: { metric: 'army' } })) }));
          lines.push(l('pbp', 'after', 'hype', 'What a match! Thanks for watching, see you next time!', [], { ...(b.seg1 - b.seg0 > 14 ? { at_s: +(b.seg1 - 4.6).toFixed(2), when: 'at' } : {}), alts: ['What a match! Thanks for watching!', 'What a match!'] }));
        } else lines.push(l('pbp', 'at', 'hype', 'What a match! Thanks for watching!', []));
        emit(lines);
        break;
      }
      case 'lull': {
        const f = byKind(b, 'series');
        if (!f) break;
        const [a, c] = f.data.army, hi = Math.max(a, c), lo = Math.min(a, c);
        const lead = a >= c ? 1 : 2;
        if (Math.round(a) === 0 && Math.round(c) === 0) { emit([l('ana', 'at', 'question', pick(['Neither side has an army yet. Who gets soldiers out first?', 'No army on either side so far. Who commits first?'], 'a'), [f.id], { opinion: true })]); break; }
        const lines = [l('ana', 'at', 'calm', pick([`Army value right now: ${Math.round(a)} for ${S(1)}, ${Math.round(c)} for ${S(2)}.`, `Checking the numbers: ${S(1)} has ${Math.round(a)} in army value, ${S(2)} has ${Math.round(c)}.`, `Army value stands at ${Math.round(a)} for ${S(1)} and ${Math.round(c)} for ${S(2)}.`], 'a'), [f.id], { show: shows(tag({ versus: { metric: 'army' } })) })];
        lines.push(lo * 3 < hi ? l('ana', 'after', 'question', pick(['That gap is huge. Is there any way back?', `${S(lead)} is far ahead. Can ${S(other(lead))} still turn this around?`], 'b'), [f.id], { opinion: true }) : l('ana', 'after', 'calm', pick(['Still close, I think.', 'Close enough that one good fight could swing it, I think.'], 'b'), [f.id], { opinion: true }));
        emit(lines);
        break;
      }
      default: break;
    }
  }
  // keep every beat inside its window: first the longest line that has a shorter version is shortened (its own alts, else its first sentence), then the last lines of an over-long beat go
  const byBeat = new Map(beats.map((b) => [b.id, b]));
  const res = [];
  for (const id of [...new Set(out.map((x) => x.beat))]) {
    const b = byBeat.get(id);
    let ls = out.filter((x) => x.beat === id).map((x) => ({ ...x }));
    const dur = (q) => estimateDuration(q.text, q.speaker, b.fight);
    const total = (x) => x.reduce((a, q) => a + dur(q) + 0.2, 0);
    const room = b.seg1 - b.seg0 + 0.6;
    // a line the writer marks trim_first (an explanation the gap-fill can say later) goes before any other line is made shorter
    while (ls.length > 1 && total(ls) > room && ls.some((q) => q.trim_first)) ls = ls.filter((q, i) => i !== ls.findIndex((z) => z.trim_first));
    for (let guard = 0; guard < 12 && ls.length && total(ls) > room; guard++) {
      const cand = ls.map((q, i) => ({ q, i, short: (q.alts || [])[0] ?? (sentencesOf(q.text).length > 1 ? sentencesOf(q.text)[0] : null) })).filter((c) => c.short && !c.q.interject).sort((x, y) => dur(y.q) - dur(x.q))[0];
      if (!cand) break;
      const rest = (cand.q.alts || []).slice(1);
      ls[cand.i] = { ...cand.q, text: cand.short, alts: rest, opinion: cand.q.opinion && HEDGE.test(cand.short) };
    }
    while (ls.length > 1 && total(ls) > room) { const k = ls.findLastIndex((q) => !q.interject); ls = ls.filter((_, i) => i !== (k < 0 ? ls.length - 1 : k)); }
    res.push(...ls);
  }
  return res;
}
