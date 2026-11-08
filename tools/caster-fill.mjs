// Gap filler of the commentary. The writer (an LLM or the template) talks about the events; between the events, and during the long stretches of a
// story (a freeze frame of 36 seconds, a fast-forward of 43 seconds) nothing is said. A real analyst keeps talking in those stretches: where the economy
// stands, how many decisions each model made, how long they think, what a model wrote earlier. This module adds such lines AFTER the lines are placed,
// into the silences only, so a line of the writer never moves.
//   fillGaps({ placed, beats, sheet, ctx, ev, tl, world, duration, seed }) -> { fills, added_facts, rejected }
// Every fill line is made from facts of the match log, as new facts of the sheet (army value, tier, workers, decisions and units lost up to that
// second, the think times, the notes), cites them, and passes the same strict checker as any other line. Juno speaks them (Dex stays silent in calm
// stretches). No sentence is said twice in a video: sentences already in the placed lines are never repeated.
import { TICK_HZ } from '../sim/util.mjs';
import { poss, withArticle } from './lib/names.mjs';
import { StoryData, clockOf, nice } from './story-data.mjs';
import { estimateDuration, sentencesOf, wordsOf } from './caster-place.mjs';
import { checkLine, HEDGE } from './caster-check.mjs';
import { validateTag } from './show-tags.mjs';
import { hwSay } from './caster-template.mjs';
import { classWord, thingWord } from './lib/theme-words.mjs';

export const FILL = {
  min_gap_s: 2.2,    // a silence shorter than this is a natural breath and stays
  pad_before_s: 0.3, // after the line before the gap
  between_s: 0.4,    // between two fill lines
  pad_after_s: 0.45, // before the line after the gap (a late voice take must not push it)
};

const hash = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
const norm = (t) => String(t).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
const sentKeys = (t) => sentencesOf(t).map(norm).filter((x) => x.split(' ').length >= 3);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const listOf = (a) => (a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a.at(-1)}`);
const minuteOf = (tick) => Math.floor(tick / TICK_HZ / 60);
const when = (tick) => `[${clockOf(tick)}, minute ${minuteOf(tick)}]`;

export function fillGaps({ placed, beats, sheet, ctx, ev, tl, world = null, duration, seed = 0, opts = {} }) {
  const F = { ...FILL, ...opts };
  const D = new StoryData(ev);
  const P = sheet.players, N = P.length;
  const S = (p) => P[p - 1]?.say ?? P[p - 1]?.short ?? 'the player';
  const other = (p) => (p === 1 ? 2 : 1);
  const sorted = [...placed].sort((a, b) => a.start - b.start);
  const added = [], rejected = [];
  const said = new Set(sorted.flatMap((l) => sentKeys(l.text)));
  const spokenText = sorted.map((l) => norm(l.text)).join(' | ');
  const usedKey = new Set(), uses = {};
  let lastTopic = null, hwUsed = 0;

  // ---- facts made on the way (cached by kind, player and tick) ----
  // a topic makes its facts while it looks for a line; the facts of every line that is not said are taken out again (ids only count up, so they never clash)
  const cache = new Map();
  let nextId = Math.max(0, ...sheet.facts.map((f) => +String(f.id).replace(/\D/g, '') || 0)) + 1;
  let trial = [];
  const addFact = (kind, tick, p, text, data = {}) => {
    const k = `${kind}:${p}:${tick}`;
    if (cache.has(k)) return cache.get(k);
    const f = { id: `f${nextId++}`, kind, tick, p, text, data };
    sheet.facts.push(f); ctx.facts.set(f.id, f); trial.push({ k, id: f.id });
    for (const w of String(text).split(/[\s,;:!?()“”"]+/)) { const t = w.replace(/^[^\w]+|[^\w+]+$/g, '').toLowerCase().replace(/['’]s$/, ''); if (t) ctx.vocab.add(t); }
    added.push(f); cache.set(k, f.id);
    return f.id;
  };
  const byKind = (k) => sheet.facts.filter((f) => f.kind === k);
  const thinkF = byKind('think'), notesF = byKind('notes')[0], showF = byKind('show')[0], howF = byKind('howto')[0];
  const specF = [1, 2].map((p) => sheet.facts.find((f) => f.kind === 'spec' && f.p === p));
  const specBoth = sheet.facts.find((f) => f.kind === 'spec' && f.p == null && f.data?.spec);
  const noteFacts = byKind('note').filter((f) => f.tick != null && f.data?.quote);
  const decisionsAt = (p, tick) => D.dec[p - 1].filter((e) => e.t <= tick).length;
  const lostAt = (tick) => { const l = [0, 0]; for (const e of ev.events) if (e.type === 'losses' && e.t <= tick && e.p >= 1 && e.p <= 2) l[e.p - 1] += e.n || 0; return l; };

  // ---- topics: each returns candidates { text, facts, key, show? } for the moment (video second t, game tick) ----
  const bits = (q) => { const m = /NVFP(\d)/i.exec(q || '') || /(\d+(?:\.\d+)?)\s*bpw/i.exec(q || ''); return m ? Math.round(Number(m[1])) : null; };
  const topics = {
    army(env) {
      const arm = ev.series?.army, s = Math.min((arm?.[0]?.length ?? 1) - 1, Math.floor(env.tick / TICK_HZ));
      if (!arm || !arm[0] || !arm.every((q) => q[s] != null) || N !== 2) return [];
      const a = Math.round(arm[0][s]), c = Math.round(arm[1][s]);
      const id = addFact('series', env.tick, null, `${when(env.tick)} Army value right now: ${P[0].short} ${a}, ${P[1].short} ${c}.`, { army: [arm[0][s], arm[1][s]] });
      const show = env.tag({ versus: { metric: 'army' } });
      if (a === 0 && c === 0) return [{ text: 'Neither side has any army yet. Who gets soldiers out first?', key: 'army-zero', facts: [id], show, opinion: true }];
      const out = [{ text: `Army value right now: ${a} for ${S(1)}, ${c} for ${S(2)}.`, key: 'army-a' }, { text: `Checking the numbers: ${S(1)} has ${a} in army value, ${S(2)} has ${c}.`, key: 'army-b' }, { text: `Army value stands at ${a} for ${S(1)} and ${c} for ${S(2)}.`, key: 'army-c' }];
      if (a !== c) {
        const lead = a > c ? 1 : 2, hi = Math.max(a, c), lo = Math.min(a, c);
        out.push({ text: `${S(lead)} is ahead on army value, ${hi} to ${lo}. Does that last?`, key: 'army-d' }, { text: `Right now ${S(lead)} holds the edge in army value, ${hi} to ${lo}. I think the next fight decides who keeps it.`, key: 'army-e' });
        if (lo * 3 < hi) out.push({ text: `That gap is big: ${hi} against ${lo}. Is there any way back for ${S(other(lead))}?`, key: 'army-f' });
        else out.push({ text: `${hi} against ${lo} in army value. That is close enough for one good fight to swing it, I think.`, key: 'army-g' });
      } else out.push({ text: `Army value is dead level at ${a} on both sides. Who gets the first real blow in?`, key: 'army-h' });
      return out.map((o) => ({ ...o, facts: [id], show }));
    },
    econ(env) {
      const out = [];
      for (const p of [1, 2]) {
        const c = D.compare(p, env.tick);
        const bitsT = [`tier ${c.tier}`];
        if (c.workers != null) bitsT.push(`${c.workers} ${classWord('workers', 'unit', 'worker')}`);
        if (c.army_value != null) bitsT.push(`army value ${c.army_value}`);
        bitsT.push(c.built.length ? `finished key buildings so far: ${c.built.join(', ')}` : 'no key building finished yet');
        const id = addFact('econ', env.tick, p, `${when(env.tick)} Side by side, ${P[p - 1].short}: ${bitsT.join('; ')}.`, { p, ...c });
        out.push({ text: `${S(p)} is on tier ${c.tier} now.`, key: `tier:${p}:${c.tier}`, facts: [id] }, { text: `Tier ${c.tier} for ${S(p)} at this point.`, key: `tier:${p}:${c.tier}`, facts: [id] });
        out.push({ text: `Tier ${c.tier} for ${S(p)}.`, key: `tier:${p}:${c.tier}`, facts: [id], short: true });
        if (c.workers != null) out.push({ text: `${S(p)} last reported ${c.workers} ${classWord('workers', 'unit', 'worker')}.`, key: `workers:${p}:${c.workers}`, facts: [id] }, { text: `${c.workers} ${classWord('workers', 'unit', 'worker')} for ${S(p)} at its last report.`, key: `workers:${p}:${c.workers}`, facts: [id] });
        if (c.built.length) {
          const list = listOf(c.built.slice(-3));
          out.push({ text: `On the building side, ${S(p)} has finished: ${list}.`, key: `built:${p}:${c.built.length}`, facts: [id] }, { text: `${poss(S(p))} key buildings so far: ${list}.`, key: `built:${p}:${c.built.length}`, facts: [id] });
        } else out.push({ text: `No key building finished yet for ${S(p)}. What is it waiting for?`, key: `built:${p}:0`, facts: [id], opinion: true });
      }
      const c1 = D.compare(1, env.tick), c2 = D.compare(2, env.tick);
      if (c1.tier !== c2.tier) out.push({ text: `Tier ${c1.tier} for ${S(1)}, tier ${c2.tier} for ${S(2)}.`, key: `tierlead:${c1.tier}/${c2.tier}`, facts: [addFact('econ', env.tick, null, `${when(env.tick)} Tiers side by side: ${P[0].short} tier ${c1.tier}, ${P[1].short} tier ${c2.tier}.`, { tier: [c1.tier, c2.tier] })], short: true });
      if (c1.tier !== c2.tier) { const hi = c1.tier > c2.tier ? 1 : 2; out.push({ text: `${S(hi)} is ahead on the tier ladder, tier ${Math.max(c1.tier, c2.tier)} against ${Math.min(c1.tier, c2.tier)}. Does it pay off?`, key: `tierlead:${c1.tier}/${c2.tier}`, facts: [cache.get(`econ:1:${env.tick}`), cache.get(`econ:2:${env.tick}`)], opinion: true }); }
      return out;
    },
    pace(env) {
      const n = [decisionsAt(1, env.tick), decisionsAt(2, env.tick)];
      if (N !== 2 || n[0] < 1 || n[1] < 1) return [];
      const id = addFact('pace', env.tick, null, `${when(env.tick)} Decisions made so far: ${P[0].short} ${n[0]}, ${P[1].short} ${n[1]}.`, { n });
      const out = [{ text: `Decisions so far: ${S(1)} ${n[0]}, ${S(2)} ${n[1]}.`, key: 'pace-a', facts: [id], short: true }, { text: `By now ${S(1)} has made ${plural(n[0], 'decision')}, ${S(2)} ${n[1]}.`, key: 'pace-a', facts: [id] }, { text: `Decision count so far: ${n[0]} for ${S(1)}, ${n[1]} for ${S(2)}.`, key: 'pace-b', facts: [id] }];
      if (n[0] !== n[1] && showF) { const more = n[0] > n[1] ? 1 : 2; out.push({ text: `${S(more)} has made more decisions so far, ${Math.max(...n)} to ${Math.min(...n)}. The game does not wait for anyone, so thinking time matters.`, key: 'pace-c', facts: [id, showF.id] }); }
      return out;
    },
    lost(env) {
      const l = lostAt(env.tick);
      if (N !== 2 || l[0] + l[1] < 1) return [];
      const id = addFact('lostsofar', env.tick, null, `${when(env.tick)} Units lost so far: ${P[0].short} ${l[0]}, ${P[1].short} ${l[1]}.`, { lost: l });
      const show = env.tag({ versus: { metric: 'units_lost' } });
      const out = [{ text: `Units lost: ${S(1)} ${l[0]}, ${S(2)} ${l[1]}.`, key: 'lost-a', facts: [id], show, short: true }, { text: `So far ${S(1)} has lost ${plural(l[0], 'unit')}, ${S(2)} ${l[1]}.`, key: 'lost-a', facts: [id], show }, { text: `Units lost so far: ${l[0]} for ${S(1)}, ${l[1]} for ${S(2)}.`, key: 'lost-b', facts: [id], show }];
      if (l[0] !== l[1]) { const worse = l[0] > l[1] ? 1 : 2; out.push({ text: `${S(worse)} has lost more units so far, ${Math.max(...l)} against ${Math.min(...l)}. I think that shows in the army.`, key: 'lost-c', facts: [id], show, opinion: true }); }
      return out;
    },
    think() {
      const t = thinkF[0], r = thinkF[1];
      if (!t || N !== 2 || !(t.data.lat?.[0] > 0 && t.data.lat?.[1] > 0)) return [];
      const l = t.data.lat.map((x) => (x / 1000).toFixed(1));
      const out = [{ text: `Median think time over the whole match: ${l[0]} s per decision for ${S(1)}, ${l[1]} s for ${S(2)}.`, key: 'think-a', facts: [t.id] }, { text: `Looking at the whole match, ${S(1)} thinks ${l[0]} s per decision on median, ${S(2)} ${l[1]} s.`, key: 'think-b', facts: [t.id] }];
      if (r) {
        const slow = r.data.slower, fast = other(slow), ratio = (Math.max(...t.data.lat) / Math.min(...t.data.lat)).toFixed(1);
        if (Number(ratio) >= 1.2) out.push({ text: `Over the whole match ${S(slow)} needs ${ratio}x as long to decide as ${S(fast)}, going by median think time.`, key: 'think-c', facts: [r.id] });
        const tk = t.data.tok, hiT = tk[0] > tk[1] ? 1 : 2, tr = (Math.max(...tk) / Math.min(...tk)).toFixed(1);
        if (Number(tr) >= 1.2) out.push({ text: `On raw speed, ${S(hiT)} generates ${tr}x as many tokens per second as ${S(other(hiT))}, averaged over the whole match.`, key: 'think-d', facts: [r.id] });
      }
      return out;
    },
    notes() {
      const f = notesF;
      if (!f || N !== 2 || !f.data.notes || !f.data.decisions) return [];
      const [n1, n2] = f.data.notes, [d1, d2] = f.data.decisions;
      return [{ text: `Over the whole match ${S(1)} wrote a note with ${n1} of its ${d1} decisions, ${S(2)} with ${n2} of ${d2}.`, key: 'notes-a', facts: [f.id] }, { text: `Notes are how we see what a model is thinking. ${S(1)} left ${n1} of ${d1}, ${S(2)} ${n2} of ${d2}, over the whole match.`, key: 'notes-b', facts: [f.id] }];
    },
    spec() {
      const out = [];
      for (const p of [1, 2]) {
        const f = specF[p - 1];
        if (!f) continue;
        const d = f.data, b = bits(d.quant);
        if (d.params && hwUsed < 2 && P[p - 1].hw) out.push({ text: `${S(p)} is ${withArticle(d.params)} model, running on ${hwSay(P[p - 1].hw)}.`, key: `spec-hw:${p}`, facts: [f.id], hw: true });
        if (d.params && b) out.push({ text: `${S(p)} is ${withArticle(d.params)} model, squeezed down to ${b} bits per weight.`, key: `spec-bits:${p}`, facts: [f.id] });
        if (d.plain && /speed-up trick/.test(d.plain)) out.push({ text: `${S(p)} also uses a speed-up trick that guesses several words ahead.`, key: `spec-mtp:${p}`, facts: [f.id] });
      }
      if (specBoth && specBoth.data.spec?.[0]?.params && specBoth.data.spec[0].params === specBoth.data.spec[1]?.params) {
        const sp = specBoth.data.spec, same = sp[0].plain && sp[0].plain === sp[1].plain;
        out.push({ text: same ? `Both are ${sp[0].params} models, squeezed the same way but in different formats.` : `Both are ${sp[0].params} models, but squeezed differently and run by different engines.`, key: 'spec-both', facts: [specBoth.id] });
      }
      return out;
    },
    noteq(env) {
      const out = [];
      const older = noteFacts.filter((f) => f.tick < env.tick - 150).sort((a, b) => b.tick - a.tick);
      for (const f of older) {
        const q = String(f.data.quote).split(/;| — | - /)[0].split(/\s+/).slice(0, 12).join(' ').replace(/[.!?,]+$/, '');
        if (q.split(/\s+/).length < 3 || q.length < 8 || spokenText.includes(norm(q))) continue;
        const p = f.data.p, clk = clockOf(f.tick);
        out.push({ text: `Earlier, ${S(p)} wrote: “${q}”. Did it stick to that?`, key: `noteq:${f.id}`, facts: [f.id], opinion: true }, { text: `Back at ${clk}, ${S(p)} wrote: “${q}”. Let us see if the army looks like it.`, key: `noteq:${f.id}`, facts: [f.id] });
        if (out.length >= 4) break;
      }
      return out;
    },
    clock(env) {
      const sp = env.speed >= 2 ? Math.round(env.speed) : null;
      const id = addFact('clock', env.tick, null, `${when(env.tick)} Game clock ${clockOf(env.tick)}${sp ? `; playback speed about ${sp}x` : ''}.`, { speed: sp });
      return [{ text: sp ? `The game clock reads ${clockOf(env.tick)} now, and this stretch plays at about ${sp}x.` : `The game clock reads ${clockOf(env.tick)} now.`, key: `clock:${clockOf(env.tick)}`, facts: [id] }];
    },
    howto() {
      const out = [];
      if (showF) out.push({ text: 'Remember, no human touches a thing here. Every move comes from the model itself.', key: 'show-a', facts: [showF.id] }, { text: 'The game never waits for a model, so a model that thinks faster gets more decisions.', key: 'show-b', facts: [showF.id] });
      if (howF) out.push({ text: `To win, you build an economy with ${classWord('workers', 'unit', 'worker')}, build an army, and destroy the other side's ${thingWord('town center', 'building', 'town_center')}.`, key: 'howto-a', facts: [howF.id] });
      return out;
    },
  };
  // fewer uses first; the bias keeps rarer topics (the numbers of the whole match, the once-only explanations) behind the live numbers
  const BIAS = { army: 0, econ: 0, noteq: 0.2, pace: 0.4, lost: 0.4, think: 1.0, notes: 1.0, spec: 1.4, howto: 1.2, clock: 1.8 };
  const beatAt = (t) => beats.find((b) => t >= b.seg0 && t < b.seg1) ?? (t < (beats[0]?.seg0 ?? 0) ? beats[0] : beats.at(-1));

  const fills = [];
  const prune = (keep) => {
    for (const x of trial) if (!keep.includes(x.id)) { const i = sheet.facts.findIndex((f) => f.id === x.id); if (i >= 0) sheet.facts.splice(i, 1); ctx.facts.delete(x.id); const j = added.findIndex((f) => f.id === x.id); if (j >= 0) added.splice(j, 1); cache.delete(x.k); }
    trial = [];
  };
  const tryFill = (t, room) => { const hit = tryFill0(t, room); prune(hit ? hit.line.facts : []); return hit; };
  const tryFill0 = (t, room) => {
    const b = beatAt(t);
    if (!b) return null;
    const tick = Math.round(tl.tickAt(Math.max(0, Math.min(t, tl.body_s ?? duration))));
    if (tick > b.tick_end + 20 || tick < 0) return null;
    const env = { tick, speed: tl.speedAtOut ? tl.speedAtOut(Math.min(t, tl.body_s ?? duration)) : 1, tag: (item) => (world && validateTag(item, world, b.tick_end ?? tick).tag ? item : null) };
    const names = Object.keys(topics).sort((x, y) => (uses[x] ?? 0) + (BIAS[x] ?? 1) + (x === lastTopic ? 0.9 : 0) - (hash(`${seed}:${t.toFixed(1)}:${x}`) % 100) / 400 - ((uses[y] ?? 0) + (BIAS[y] ?? 1) + (y === lastTopic ? 0.9 : 0) - (hash(`${seed}:${t.toFixed(1)}:${y}`) % 100) / 400));
    for (const name of names) {
      let cands;
      try { cands = topics[name](env); } catch { cands = []; }
      const start = hash(`${seed}:${t.toFixed(1)}:${name}`) % Math.max(1, cands.length);
      for (let k = 0; k < cands.length; k++) {
        const c = cands[(start + k) % cands.length];
        if (usedKey.has(c.key) || (c.hw && hwUsed >= 2)) continue;
        if (!sentKeys(c.text).every((x) => !said.has(x))) continue;
        const dur = estimateDuration(c.text, 'ana', false);
        if (dur > room || (c.short && room > 3.4)) continue;
        const line = { beat: b.id, speaker: 'ana', when: 'at', delivery: c.text.trim().endsWith('?') ? 'question' : 'calm', text: c.text, facts: c.facts.filter(Boolean), subject: null, opinion: !!(c.opinion || HEDGE.test(c.text)), interject: false, show: c.show ?? null, filler: true, fill: true };
        const r = checkLine(line, ctx);
        if (!r.ok) { rejected.push({ beat: b.id, text: c.text, reasons: r.reasons }); continue; }
        usedKey.add(c.key); uses[name] = (uses[name] ?? 0) + 1; lastTopic = name; if (c.hw) hwUsed++;
        for (const x of sentKeys(c.text)) said.add(x);
        return { line, dur };
      }
    }
    return null;
  };

  // ---- walk the silences between the lines (never after the last line: that is the sign-off) ----
  const gaps = [];
  for (let i = 0; i + 1 < sorted.length; i++) gaps.push({ g0: sorted[i].end, g1: sorted[i + 1].start });
  if (sorted.length && sorted[0].start > F.min_gap_s + F.pad_before_s) gaps.unshift({ g0: 0, g1: sorted[0].start, head: true });
  for (const g of gaps) {
    if (g.g1 - g.g0 < F.min_gap_s) continue;
    let t = g.g0 + (g.head ? 0.3 : F.pad_before_s);
    for (let guard = 0; guard < 12; guard++) {
      const room = g.g1 - F.pad_after_s - t;
      if (room < 1.5) break;
      const hit = tryFill(t + 0.01, room);
      if (!hit) break;
      fills.push({ ...hit.line, start: +t.toFixed(2), end: +(t + hit.dur).toFixed(2), dur: hit.dur, overlap: false });
      t += hit.dur + F.between_s;
    }
  }
  return { fills, added_facts: added.length, rejected };
}
