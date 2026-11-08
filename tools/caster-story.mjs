// Beats of the story cut (w3-h round 2): the video is told chapter by chapter, so the beats are not picked by importance but follow the
// story plan (tools/story.mjs): every key decision is a run-up (what the model saw), a freeze frame (its note word for word, its orders)
// and a consequence stretch; the fast-forward stretches between are narrated with the strategy and the economy of both sides.
// Facts are the same as in the highlight cut plus: econ (tier, workers, army, buildings at a tick), conseq (what happened after a
// decision), why (how the match was decided). Everything is computed from the match log.
import { withoutFinalWipe } from './commentary.mjs';
import { plainOrders } from './plain-orders.mjs';
import { TICK_HZ } from '../sim/util.mjs';
import { poss } from './lib/names.mjs';
import { displayPlural } from '../render/theme/display-name.mjs';
import { classWord } from './lib/theme-words.mjs';
import { StoryData, clockOf, typeList, nice, crumbled } from './story-data.mjs';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ACTION = new Set(['battle', 'razed', 'base', 'victory']);
const minuteOf = (tick) => Math.floor(tick / TICK_HZ / 60);
const when = (tick) => `[${clockOf(tick)}, minute ${minuteOf(tick)}]`;
const plural = (t, n) => (n === 1 ? nice(t) : displayPlural('any', t)); // the plural of the theme (classic: the regular plural, the one pluralOf makes)

// the army value series of a side without its last value when that value only drops because the side is out
export { withoutFinalWipe };

export function storyBeats(env) {
  const { ev, plan, tl, sh, facts, addFact, factAt, evFact, decFact, sawFact, subId, subjOfEvent, aimFact, baseRaw, duration, players } = env;
  const S = plan.story, D = new StoryData(ev);
  const byId = new Map(ev.events.filter((e) => e.type === 'llm_decision').map((e) => [e.id, e]));
  const body = tl.body_s;
  const tickAt = (o) => Math.round(tl.tickAt(clamp(o, 0, body)));
  const N = players.length;

  // ---- fact helpers ----
  const econCache = new Map();
  const econFact = (p, tick) => {
    const k = `${p}:${tick}`;
    if (econCache.has(k)) return econCache.get(k);
    const c = D.compare(p, tick);
    const bits = [`tier ${c.tier}`];
    if (c.workers != null) bits.push(`${c.workers} ${classWord('workers', 'unit', 'worker')}`);
    if (c.army_value != null) bits.push(`army value ${c.army_value}`);
    if (c.army) bits.push(`army: ${c.army}`);
    bits.push(c.built.length ? `finished key buildings so far: ${c.built.join(', ')}` : 'no key building finished yet');
    const id = addFact('econ', tick, p, `${when(tick)} Side by side, ${sh(p)}: ${bits.join('; ')}.`, { p, ...c });
    econCache.set(k, id);
    return id;
  };
  const metaOf = (e) => { const secs = e.latency_ms != null ? (e.latency_ms / 1000).toFixed(e.latency_ms < 10000 ? 1 : 0) : null; return `${secs != null ? `Thought for ${secs} s` : ''}${e.completion_tokens != null ? `, ${e.completion_tokens} tokens` : ''}`; };
  const decOf = (e) => {
    if (decFact.has(e.id)) return factAt(decFact.get(e.id));
    if (!e.summary && !e.thought) return null;
    return addFact('orders', e.t, e.p, `${when(e.t)} ${sh(e.p)} decision ${e.n} (no note, orders only): ${plainOrders(e.summary) || 'none'}. ${metaOf(e)}.`, { p: e.p, n: e.n, orders: e.summary });
  };
  const sawOf = (e) => (sawFact.has(e.id) ? factAt(sawFact.get(e.id)) : null);
  // what happened in a stretch after a decision: army value of both sides at the start and the end, units lost by each side
  const conseqCache = new Map();
  const conseq = (t0, t1) => {
    const k = `${t0}:${t1}`;
    if (conseqCache.has(k)) return conseqCache.get(k);
    const lost = Array.from({ length: N }, () => ({ n: 0, v: 0 }));
    for (const e of ev.events) if (e.type === 'losses' && e.t >= t0 && e.t <= t1) { lost[e.p - 1].n += e.n || 0; lost[e.p - 1].v += e.value || 0; }
    const a0 = players.map((q) => D.army(q.p, t0)), a1 = players.map((q) => D.army(q.p, t1));
    const parts = players.map((q, i) => `${poss(sh(q.p))} army value ${a0[i]} -> ${a1[i]}, ${lost[i].n} units lost (value ${lost[i].v})`);
    const id = addFact('conseq', t1, null, `${when(t0)} to ${clockOf(t1)}: ${parts.join('; ')}.`, { t0, t1, army0: a0, army1: a1, lost });
    conseqCache.set(k, id);
    return id;
  };
  const evFactsIn = (t0, t1, types) => ev.events.filter((e) => types.includes(e.type) && e.t >= t0 && e.t <= t1).map((e) => factAt(evFact.get(e.id))).filter(Boolean);
  const notesIn = (t0, t1, max = 3) => ev.events.filter((e) => e.type === 'llm_decision' && e.t >= t0 && e.t <= t1 && decFact.has(e.id)).sort((a, b) => (b.thought ? b.thought.length : 0) - (a.thought ? a.thought.length : 0)).slice(0, max).sort((a, b) => a.t - b.t).map((e) => factAt(decFact.get(e.id)));

  // ---- the match in one view, for the recap ----
  const vic = ev.events.find((e) => e.type === 'victory');
  const fall = ev.events.find((e) => e.type === 'base_destroyed');
  const loser = fall ? fall.p : vic && vic.winner ? (vic.winner === 1 ? 2 : 1) : null;
  const winner = loser ? (loser === 1 ? 2 : 1) : null;
  let whyIds = [];
  if (loser && winner) {
    const lostB = ev.events.filter((e) => (e.type === 'building_destroyed' || e.type === 'base_destroyed') && e.p === loser);
    const bySrc = {};
    const crumbledN = lostB.filter((e) => crumbled(e)).length; // fell in sudden death: nobody destroyed these
    for (const e of lostB) if (!crumbled(e)) bySrc[e.src || 'unit'] = (bySrc[e.src || 'unit'] || 0) + 1;
    const top = Object.entries(bySrc).sort((a, b) => b[1] - a[1])[0];
    if (top) {
      const names = lostB.filter((e) => !crumbled(e) && (e.src || 'unit') === top[0]).map((e) => (e.type === 'base_destroyed' ? nice('town_center') : nice(e.building)));
      whyIds.push(addFact('why', ev.ticks, winner, `How ${poss(sh(loser))} base fell: ${poss(sh(winner))} ${plural(top[0], 2)} destroyed ${top[1]} of the ${lostB.length} buildings ${sh(loser)} lost (${names.join(', ')}).${crumbledN ? ` ${crumbledN === 1 ? 'One more' : `${crumbledN} more`} crumbled in sudden death.` : ''}`, { winner, loser, src: top[0], n: top[1], of: lostB.length, crumbled: crumbledN }));
    }
    // the biggest drop of the loser's army value inside 40 s, with the winner's army value at the same two moments
    const arr = ev.series?.army, la = arr?.[loser - 1], wa = arr?.[winner - 1];
    if (la && wa) {
      let best = null;
      const fought = withoutFinalWipe(la);
      for (let s = 0; s + 40 < fought.length; s++) { const d = fought[s] - fought[s + 40]; if (!best || d > best.d) best = { d, s }; }
      if (fought.length < la.length && fought.at(-1) > 0) whyIds.push(addFact('why', ev.ticks, loser, `${poss(sh(loser))} army was still standing when the match ended: army value ${Math.round(fought.at(-1))} at ${clockOf((fought.length - 1) * TICK_HZ)}, one second before the end. A side is out when it has no town center and no building that can train units, whatever army it still has.`, { loser }));
      if (best && best.d > 300) whyIds.push(addFact('why', ev.ticks, loser, `The biggest swing: within 40 s from ${clockOf(best.s * TICK_HZ)} to ${clockOf((best.s + 40) * TICK_HZ)}, ${poss(sh(loser))} army value fell from ${Math.round(la[best.s])} to ${Math.round(la[best.s + 40])}, while ${poss(sh(winner))} went from ${Math.round(wa[best.s])} to ${Math.round(wa[best.s + 40])}.`, { loser, winner, from: Math.round(la[best.s]), to: Math.round(la[best.s + 40]) }));
    }
    const qs = ev.events.filter((e) => e.type === 'llm_decision' && e.p === winner && /\bram\b/.test(e.summary || '')).sort((a, b) => a.t - b.t)[0];
    if (qs) { const m = /train (\d+)x ram/.exec(qs.summary); whyIds.push(addFact('why', ev.ticks, winner, `${when(qs.t)} ${sh(winner)} first queued rams in decision ${qs.n}${m ? ` (${m[1]} rams)` : ''}; the order list was: ${qs.summary}.`, { winner, n: qs.n, t: qs.t })); }
  }

  // ---- segments of the output timeline ----
  let segs = [];
  let cur = 0;
  for (const u of S.units) {
    const lead0 = u.kind === 'open' ? 0 : u.o_lead;
    if (lead0 > cur + 0.05) segs.push({ kind: 'span', o0: cur, o1: lead0 });
    if (u.o_hold0 > lead0 + 0.05) segs.push({ kind: u.kind === 'open' ? 'open' : 'lead', o0: lead0, o1: u.o_hold0, unit: u });
    segs.push({ kind: u.kind === 'compare' ? 'compare' : 'hold', o0: u.o_hold0, o1: u.o_hold1, unit: u });
    segs.push({ kind: 'after', o0: u.o_hold1, o1: u.o_after1, unit: u });
    cur = u.o_after1;
  }
  if (cur < body - 0.05) segs.push({ kind: 'span', o0: cur, o1: body });
  const oVic = vic ? tl.outAt(vic.t) : body;
  // action windows are cut out of the after / span stretches (never out of a run-up or a freeze frame)
  const wins = [];
  const addWin = (kind, o0, o1, e) => wins.push({ kind, o0, o1, e, oe: tl.outAt(e.t) });
  for (const e of ev.events) {
    const o = tl.outAt(e.t);
    if (o < 0.5 || o > body + 0.1) continue;
    if (e.type === 'battle' && (e.kills >= 8 || ev.events.some((f) => f.type === 'momentum_swing' && f.t >= e.t && f.t <= (e.t_end ?? e.t) + 150))) addWin('battle', o - 1.2, o + Math.min(9, 4 + (tl.outAt(e.t_end) - o)), e);
    else if (e.type === 'base_destroyed') addWin('base', o - 2.5, o + 5.0, e);
    else if (e.type === 'building_destroyed' && (e.src === 'ram' || ['barracks', 'archery_range', 'stables', 'siege_workshop', 'town_center'].includes(e.building))) addWin('razed', o - 0.8, o + 6.2, e);
    else if (e.type === 'tier_up') addWin('tier_up', o - 0.5, o + 4.0, e);
    else if (e.type === 'first_contact') addWin('first_contact', o - 0.5, o + 4.0, e);
  }
  const prio = { base: 5, battle: 4, razed: 3, tier_up: 2, first_contact: 2 };
  wins.sort((a, b) => prio[b.kind] - prio[a.kind] || a.o0 - b.o0);
  const used = [];
  for (const w of wins) {
    if (used.some((x) => w.o0 < x.o1 + 0.4 && w.o1 > x.o0 - 0.4)) continue;
    const okHost = (s) => (s.kind === 'after' || s.kind === 'span');
    let host = segs.find((s) => okHost(s) && w.o0 + 0.8 >= s.o0 && w.o0 < s.o1);
    if (host && Math.min(host.o1, w.o1) - Math.max(host.o0, w.o0) < 2.4) host = segs.find((s) => okHost(s) && w.oe >= s.o0 && w.oe < s.o1 && Math.min(s.o1, w.o1) - Math.max(s.o0, w.o0) >= 2.4) || host; // the event itself sits just behind the end of the stretch that held its run-up
    if (!host) continue;
    const a = Math.max(host.o0, w.o0), b = Math.min(host.o1, w.o1);
    if (b - a < 2.0) continue;
    used.push({ ...w, o0: a, o1: b });
    const i = segs.indexOf(host);
    const parts = [];
    if (a - host.o0 >= 1.8) parts.push({ ...host, o1: a });
    parts.push({ kind: w.kind, o0: a, o1: b, e: w.e, unit: host.unit });
    if (host.o1 - b >= 1.8) parts.push({ ...host, o0: b });
    else if (parts.length) parts[parts.length - 1].o1 = host.o1;
    segs.splice(i, 1, ...parts);
  }
  segs.sort((a, b) => a.o0 - b.o0);
  // the tail: banner, then the end screen
  const recap0 = Math.min(duration - 3, oVic + 2.4);
  segs = segs.filter((s) => s.o0 < body - 0.05);
  segs[segs.length - 1].o1 = Math.min(segs[segs.length - 1].o1, body);
  if (vic) segs.push({ kind: 'victory', o0: Math.max(segs.at(-1).o1, oVic - 0.2), o1: recap0, e: vic });
  segs.push({ kind: 'close', o0: recap0, o1: duration - 0.3 });
  // contiguous, no piece shorter than 1.8 s
  for (let i = 1; i < segs.length; i++) segs[i].o0 = Math.max(segs[i].o0, segs[i - 1].o0 + 0.01);
  const merged = [];
  for (const s of segs) {
    const l = merged[merged.length - 1];
    if (l && s.o1 - s.o0 < 1.8 && !['hold', 'compare', 'close', 'victory'].includes(s.kind)) { l.o1 = Math.max(l.o1, s.o1); continue; }
    merged.push({ ...s });
  }
  for (let i = 0; i + 1 < merged.length; i++) merged[i].o1 = merged[i + 1].o0;
  merged[merged.length - 1].o1 = duration - 0.3;

  // ---- the beats ----
  const chapterAt = (o) => [...S.chapters].reverse().find((c) => o >= c.o0)?.id ?? S.chapters[0].id;
  const beats = [];
  let prevUnit = null;
  merged.forEach((s, i) => {
    const mid = (s.o0 + s.o1) / 2, t0 = tickAt(s.o0), t1 = tickAt(Math.min(s.o1, body)), tm = tickAt(mid);
    const u = s.unit || null;
    if (u) prevUnit = u;
    const decs = u ? u.decs.map((id) => byId.get(id)).filter(Boolean) : [];
    let ids = [], sub = [];
    const subsOf = (list) => list.flatMap((e) => subjOfEvent(e)).filter(Boolean);
    switch (s.kind) {
      case 'open': ids = facts.filter((f) => ['meta', 'player', 'show', 'spec', 'bench', 'howto', 'think'].includes(f.kind)).map((f) => f.id); sub = [baseRaw(1), baseRaw(2)]; break;
      case 'lead': ids = decs.length ? [...decs.map(sawOf), ...decs.map((e) => aimFact(e)), econFact(u.p || decs[0].p, Math.max(1, t0))] : [econFact(1, Math.max(1, t0)), econFact(2, Math.max(1, t0))]; sub = decs.length ? subsOf(decs) : [baseRaw(1), baseRaw(2)]; break;
      case 'hold': ids = [...decs.map(decOf), ...decs.map(sawOf), ...decs.map((e) => aimFact(e))]; sub = subsOf(decs); break;
      case 'compare': ids = [econFact(1, u.tick), econFact(2, u.tick), ...evFactsIn(0, u.tick, ['tier_up'])]; sub = [baseRaw(1), baseRaw(2)]; break;
      case 'after': if (u.kind === 'open') { ids = [econFact(1, u.tick + 40), econFact(2, u.tick + 40)]; sub = [baseRaw(1), baseRaw(2)]; break; }
        ids = [conseq(u.tick, Math.min(ev.ticks, Math.max(u.tick + 20, t1))), ...evFactsIn(u.tick, t1, ['battle', 'building_destroyed', 'base_destroyed', 'tier_up', 'key_building'])].slice(0, 6); sub = decs.length ? subsOf(decs) : [baseRaw(1), baseRaw(2)]; break;
      case 'span': ids = [...(prevUnit && s.o0 - prevUnit.o_after1 < 0.4 && prevUnit.kind !== 'open' ? [conseq(prevUnit.tick, Math.max(prevUnit.tick + 20, t0))] : []), econFact(1, tm), econFact(2, tm), ...evFactsIn(t0, t1, ['key_building', 'tier_up', 'first_contact', 'expansion', 'battle']), ...notesIn(t0, t1, 3)]; sub = [baseRaw(1), baseRaw(2)]; break;
      case 'battle': case 'razed': case 'base': ids = [factAt(evFact.get(s.e.id))]; sub = subjOfEvent(s.e); break;
      case 'tier_up': case 'first_contact': ids = [factAt(evFact.get(s.e.id)), econFact(s.e.p, s.e.t)]; sub = subjOfEvent(s.e); break;
      case 'victory': ids = [factAt(evFact.get(vic.id))]; sub = fall ? subjOfEvent(fall) : [baseRaw(winner || 1)]; break;
      case 'close': ids = [facts.find((f) => f.kind === 'final')?.id, ...whyIds, ...facts.filter((f) => ['think', 'notes', 'bench'].includes(f.kind)).map((f) => f.id)]; sub = [baseRaw(winner || 1), baseRaw(loser || 2)]; break;
      default: break;
    }
    const subjects = [...new Set(sub.filter(Boolean).slice(0, 8).map((r) => subId(r)).filter(Boolean))];
    const kind = s.kind === 'span' ? 'build' : s.kind;
    if (u && u.kind === 'open' && s.kind !== 'span') ids = [...ids, ...facts.filter((f) => ['meta', 'player', 'show', 'spec', 'bench', 'howto', 'think'].includes(f.kind)).map((f) => f.id)]; // the whole intro (show, contestants, how to win) is told around the first freeze frame
    const spd = tl.speedAtOut(Math.min(mid, body));
    beats.push({
      id: i + 1, kind, chapter: chapterAt(mid), anchor: +(s.o0 + 0.25).toFixed(2), seg0: +s.o0.toFixed(2), seg1: +s.o1.toFixed(2), tick: tm, tick_end: kind === 'close' || kind === 'victory' ? ev.ticks : t1,
      speed: +spd.toFixed(2), fight: ACTION.has(kind), role: ACTION.has(kind) ? 'action' : kind === 'open' ? 'open' : 'calm', facts: [...new Set(ids.filter(Boolean))], p: u && u.p ? u.p : null,
      slow: null, subjects, flow: true, unit: u ? u.id : null, unit_kind: u ? u.kind : null, freeze: kind === 'hold' || kind === 'compare',
      budget_words: Math.max(0, Math.floor((s.o1 - s.o0 - 0.4) * 2.8)), clock: clockOf(tm),
    });
  });
  return beats;
}
