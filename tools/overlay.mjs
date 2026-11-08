// On-screen state that depends on the event log: LLM decision cards ("thought" shown big for ~2 s near the player panel),
// the event ticker, the end banner and the per-player think stats. Pure function of (output time, game tick).
import { WEIGHTS } from './highlight-weights.mjs';
import { poss } from './lib/names.mjs';
import { plainOrders } from './plain-orders.mjs';
import { TICK_HZ } from '../sim/util.mjs';
import { decisionImportance, momentCard, momentWindows, endScreen, MOMENTS } from './commentary.mjs';
import { StoryOverlay } from './story-overlay.mjs';
import { displayName } from '../render/theme/display-name.mjs';
import { thingWord } from './lib/theme-words.mjs';

export const OVERLAY = {
  card_s: 2.2, card_in: 0.18, card_out: 0.3,
  ticker_s: 3.0, ticker_in: 0.2, ticker_out: 0.35,
  banner_in: 0.5,
  max_wait_s: 0.0,       // a card never waits for the previous one; it replaces it when more important (see schedule)
  replace_after_s: 0.9,  // a visible card is cut short by a more important one only after this long
  feed_s: 5.5, feed_in: 0.2, feed_out: 0.6, feed_lines: 3, // action feed: how long a line stays, how many lines at most
  end_delay_s: 2.4,      // the end screen comes this long after the winner banner
  end_in: 0.6, end_banner_out: 0.4,
  moment_in: 0.45, moment_out: 0.6, fog_in: 0.5, fog_out: 0.6,
  cap_in: 0.12, cap_out: 0.18, cap_hold: 0.1, cap_max: 2, // burned-in captions of the casters
};

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const mmss = (tick) => { const s = Math.floor(tick / TICK_HZ); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const nice = (s) => displayName('any', s); // R1: the theme decides the words (default classic = the old underscore-to-space text)
const tcWord = () => thingWord('town center', 'building', 'town_center'); // C1: the fixed word "town center" of the feed and the ticker follows the theme

export { decisionImportance };

// greedy single-lane schedule: items sorted by start; an item that starts while another is visible replaces it
// only if it is more important and the visible one had its minimum time; otherwise it is dropped.
function schedule(items, dur, replaceAfter) {
  const out = [];
  let cur = null;
  for (const it of items.sort((a, b) => a.s0 - b.s0 || b.imp - a.imp)) {
    if (cur && it.s0 < cur.s1) {
      if (it.imp > cur.imp && it.s0 - cur.s0 >= replaceAfter) cur.s1 = it.s0 + 0.0; else continue;
    }
    cur = { ...it, s1: it.s0 + dur };
    out.push(cur);
  }
  return out;
}

// Speed badge text. Sampled 6 times a second so the number does not flicker during a ramp; always shown, highlighted when not 1x.
export function speedBadge(timeline, outT) {
  const q = Math.floor(outT * 6) / 6;
  if (timeline.speedAtOut(outT) === 0) return { label: 'PAUSED', on: true, hold: true, speed: 0 }; // freeze frame of the story cut
  const sp = timeline.speedAtOut(Math.min(outT, q));
  if (sp < 0.95) return { label: `${(Math.round(sp * 20) / 20).toFixed(2).replace(/0$/, '')}x`, on: true, slow: true, speed: +sp.toFixed(3) }; // slow motion at a key decision
  const n = Math.round(sp);
  return { label: `${Math.max(1, n)}x`, on: n >= 2, speed: +sp.toFixed(3) };
}

// the part in brackets tells long model names apart ("Qwen3.8-27B EXL3 (Zoe kit TP2)" -> "Zoe kit TP2")
// a part in brackets too long for a label: the part in front ("DeepSeek-V4.1-Flash (Bob's TensorFold Metal recipe)" -> "DeepSeek-V4.1-Flash")
export const shortOf = (n) => { const m = /\(([^)]{2,24})\)\s*$/.exec(n); if (m) return m[1]; const f = /^(.+?)\s*\([^)]*\)\s*$/.exec(n); return f ? f[1] : n; };
// the word in front of a model code: "Qwen3.8-27B" -> "Qwen", "DeepSeek-V4.1-Flash" -> "DeepSeek"; anything else stays as it is
export const brandOf = (m) => (/^([A-Za-z]{2,})(?=[-\d])/.exec(m) || [null, m])[1];
// the names as the casters say them, for labels in the picture: "Qwen", "DeepSeek". Two models of the same brand keep their short names apart.
export const spokenNames = (names) => {
  const s = shortNames(names), b = s.map(brandOf);
  return new Set(b).size === b.length ? b : s;
};
// the short names of all players of one match: when two share the part in brackets ("Probe A (mock)", "Probe B (mock)"), the part in front tells them apart
export const shortNames = (names) => {
  const front = names.map((n) => String(n ?? '').replace(/\s*\([^)]*\)\s*$/, ''));
  // different models: the model tells them apart, the bracket only matters between two setups of the same model
  const model = front.map((f) => f.split(/\s+/)[0]);
  if (names.length > 1 && model.every((m, i) => /[-\d]/.test(m) && model.indexOf(m) === i) && new Set(model.map(brandOf)).size === model.length) return model;
  const s = names.map((n) => shortOf(String(n ?? '')));
  const dup = (a, i) => a.some((x, j) => j !== i && x === a[i]);
  return s.map((x, i) => (!dup(s, i) ? x : front[i] && !dup(front, i) ? front[i] : String(names[i] ?? x)));
};
const plural = (n, t) => `${n}x ${nice(t)}`;
const typeList = (types, n = 3) => Object.entries(types).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([t, c]) => plural(c, t)).join(', ');

// Action feed lines of the broadcast: kills, buildings, tier-ups, expansions, contact, momentum, God mode. tag = short label shown
// in front of the line, p = the player the line is about (colour dot).
export function feedLine(e, name) {
  switch (e.type) {
    case 'losses': return { tag: 'KILLS', p: e.by || 0, imp: 1 + Math.min(2, e.value / 400), text: e.by ? `${name(e.by)} kills ${typeList(e.types)}` : `${name(e.p)} loses ${typeList(e.types)}` };
    case 'building_destroyed': return { tag: 'RAZED', p: e.by || e.p, imp: 2, text: `${name(e.p)} loses ${nice(e.building)}` };
    case 'base_destroyed': return { tag: 'BASE', p: e.by || e.p, imp: 5, text: `${poss(name(e.p))} ${tcWord()} falls` };
    case 'key_building': return { tag: 'BUILD', p: e.p, imp: 1, text: `${name(e.p)} builds ${nice(e.building)}` };
    case 'expansion': return { tag: 'EXPAND', p: e.p, imp: 3, text: `${name(e.p)} expands` };
    case 'tier_up': return { tag: 'TIER', p: e.p, imp: 3, text: `${name(e.p)} reaches tier ${e.tier}` };
    case 'first_contact': return { tag: 'CONTACT', p: e.p, imp: 4, text: `${name(e.p)} spots ${poss(name(e.other))} ${nice(e.what)}` };
    case 'momentum_swing': return { tag: 'SWING', p: e.to, imp: 4, text: `${name(e.to)} takes the lead` };
    case 'resign': return { tag: 'RESIGN', p: e.p, imp: 5, text: `${name(e.p)} resigns` };
    case 'god': return { tag: 'GOD', p: e.p || 0, imp: 6, text: e.text };
    default: return null;
  }
}

export class Overlay {
  constructor({ events, timeline, players, opts = {}, moments = [], ev = null, captions = null, story = null }) {
    this.O = { ...OVERLAY, ...opts };
    this.tl = timeline;
    this.players = players;
    const O = this.O;
    const name = (p) => players[p - 1]?.name ?? `P${p}`;
    const shorts = spokenNames(players.map((q) => q.name ?? ''));
    const shortName = (p) => shorts[p - 1] || name(p); // feed lines are narrow
    // ---- decision cards, one lane per player ----
    this.cards = players.map(() => []);
    this.decisions = players.map(() => []);
    for (const e of events) {
      if (e.type === 'llm_decision') this.decisions[e.p - 1].push(e); // all of them: the think stats count from the start
    }
    this.decisions.forEach((list, i) => {
      const items = list.filter((e) => (e.thought || e.summary) && e.t >= timeline.a && e.t <= timeline.b).map((e) => ({
        s0: timeline.outAt(e.t), imp: decisionImportance(e), e,
      }));
      this.cards[i] = schedule(items, O.card_s, O.replace_after_s);
    });
    // ---- ticker ----
    const T = [];
    const prod = new Set(['town_center', 'barracks', 'archery_range', 'stables', 'siege_workshop', 'blacksmith', 'tower']);
    for (const e of events) {
      if (e.t < timeline.a || e.t > timeline.b) continue;
      let text = null, imp = 0, p = e.p ?? 0;
      if (e.type === 'first_contact') { text = `First contact: ${shortName(e.p)} spots ${poss(shortName(e.other))} ${nice(e.what)}`; imp = 4; }
      else if (e.type === 'tier_up') { text = `${shortName(e.p)} reaches tier ${e.tier}`; imp = 3; }
      else if (e.type === 'expansion') { text = `${shortName(e.p)} expands`; imp = 3; }
      else if (e.type === 'key_building') { text = `${shortName(e.p)} builds ${nice(e.building)}`; imp = 1; }
      else if (e.type === 'momentum_swing') { text = `Momentum swing: ${shortName(e.to)} takes the lead`; imp = 4; p = e.to; }
      else if (e.type === 'building_destroyed' && prod.has(e.building)) { text = `${shortName(e.p)} loses ${nice(e.building)}`; imp = 2; }
      else if (e.type === 'base_destroyed') { text = `${poss(shortName(e.p))} ${tcWord()} is destroyed`; imp = 5; }
      else if (e.type === 'resign') { text = `${shortName(e.p)} resigns`; imp = 5; }
      else if (e.type === 'god') { text = `GOD: ${e.text}`; imp = 6; p = e.p || 0; }
      if (text) T.push({ s0: timeline.outAt(e.t), imp, text, p, e });
    }
    this.ticker = schedule(T, O.ticker_s, 1.2);
    // ---- action feed: every line is visible for feed_s; the newest feed_lines lines are shown ----
    this.feed = [];
    for (const e of events) {
      if (e.t < timeline.a || e.t > timeline.b) continue;
      const f = feedLine(e, shortName);
      if (f) this.feed.push({ ...f, s0: timeline.outAt(e.t), id: e.id });
    }
    this.feed.sort((a, b) => a.s0 - b.s0 || a.id - b.id);
    // ---- key decisions: panel text, slow motion and fog of war view ----
    this.moments = moments.map((m) => ({ m, w: momentWindows(m, timeline, this.O.moment || MOMENTS), card: momentCard(m, players.map((q, i) => ({ ...q, name: shorts[i] || q.name }))) }));
    // ---- captions of the two casters (cues from tools/casters.mjs); with casters the generic decision cards are off ----
    this.captions = captions ? [...captions].sort((a, b) => a.s0 - b.s0 || a.s1 - b.s1) : null;
    if (this.captions) this.cards = players.map(() => []);
    // ---- story cut (chapters bar, strategy cards, split view) ----
    this.story = story ? new StoryOverlay({ ev, plan: story, timeline, players, nameOf: (p) => shorts[p - 1] || name(p) }) : null;
    // ---- end screen ----
    this.end = null;
    const vic = events.find((e) => e.type === 'victory');
    if (ev && vic && vic.t <= timeline.b) this.end = { s0: timeline.outAt(vic.t) + O.end_delay_s, data: endScreen(ev, players) };
    // first intervention of the spectator: from then on the permanent GOD MODE badge is shown (also when the cut starts later)
    const g0 = events.find((e) => e.type === 'god');
    this.godAt = g0 ? g0.t : null;
    // ---- banner ----
    const v = events.find((e) => e.type === 'victory');
    this.banner = null;
    if (v && v.t <= timeline.b) {
      const win = v.winner ? players[v.winner - 1] : null;
      this.banner = { s0: timeline.outAt(v.t), p: v.winner || 0, title: win ? `${win.name} wins` : 'Draw', sub: `${v.reason} · ${mmss(v.t)}` };
    }
  }

  at(outT, tick) {
    const O = this.O;
    const cards = [];
    this.cards.forEach((lane, i) => {
      for (const c of lane) {
        if (outT < c.s0 || outT >= c.s1 + 0.0) continue;
        const a = clamp01((outT - c.s0) / O.card_in) * clamp01((c.s1 - outT) / O.card_out);
        const e = c.e;
        const meta = [];
        if (e.latency_ms != null) meta.push(`thought for ${(e.latency_ms / 1000).toFixed(e.latency_ms < 10000 ? 1 : 0)} s`);
        if (e.completion_tokens != null) meta.push(`${e.completion_tokens} tokens`);
        if (e.tok_s != null) meta.push(`${Math.round(e.tok_s)} tok/s`);
        cards.push({ p: e.p, text: e.thought || `Orders: ${plainOrders(e.summary)}`, thought: !!e.thought, meta: meta.join(' · '), a: +a.toFixed(3), n: e.n, kind: e.thought ? 'thought' : 'orders' });
        break;
      }
    });
    let ticker = null;
    for (const c of this.ticker) {
      if (outT >= c.s0 && outT < c.s1) {
        ticker = { text: c.text, p: c.p, imp: c.imp, a: +(clamp01((outT - c.s0) / O.ticker_in) * clamp01((c.s1 - outT) / O.ticker_out)).toFixed(3) };
        break;
      }
    }
    let banner = null;
    if (this.banner && outT >= this.banner.s0) banner = { ...this.banner, a: +clamp01((outT - this.banner.s0) / O.banner_in).toFixed(3) };
    // think stats: the last decision that landed before this tick
    const stats = this.decisions.map((list) => {
      let lo = 0, hi = list.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (list[m].t <= tick) lo = m + 1; else hi = m; }
      const e = lo ? list[lo - 1] : null;
      return { decisions: lo, latency_ms: e?.latency_ms ?? null, tok_s: e?.tok_s ?? null, tokens: e?.completion_tokens ?? null };
    });
    // action feed: the newest lines that are still alive
    const alive = [];
    for (const f of this.feed) { if (f.s0 > outT) break; if (outT < f.s0 + O.feed_s) alive.push(f); }
    const feed = alive.slice(-O.feed_lines).map((f) => ({ tag: f.tag, p: f.p, text: f.text, a: +(clamp01((outT - f.s0) / O.feed_in) * clamp01((f.s0 + O.feed_s - outT) / O.feed_out)).toFixed(3) }));
    // key decision: the panel (saw -> note -> orders, shown in the order it happened) and the fog of war view of that player
    let moment = null, fog = null;
    for (const { m, w, card } of this.moments) {
      if (m.story) { // story cut: no panel (the split view and the cards tell the decision), but the deciding model's fog of war view: what it could see when it decided
        if (!fog && outT >= w.fog0 && outT <= w.fog1) fog = { p: m.p, a: +(clamp01((outT - w.fog0) / O.fog_in) * clamp01((w.fog1 - outT) / O.fog_out)).toFixed(3) };
        continue;
      }
      if (outT < w.o0 || outT > w.o1) continue;
      const a = clamp01((outT - w.o0) / O.moment_in) * clamp01((w.o1 - outT) / O.moment_out);
      moment = { p: m.p, a: +a.toFixed(3), story: !!m.story, card, thought_a: +clamp01((outT - w.land) / 0.3).toFixed(3), ordered_a: +clamp01((outT - w.land - 0.7) / 0.3).toFixed(3), slow: !m.story && outT >= w.slow0 && outT <= w.slow1 };
      fog = { p: m.p, a: +(clamp01((outT - w.fog0) / O.fog_in) * clamp01((w.fog1 - outT) / O.fog_out)).toFixed(3) };
      break;
    }
    if (moment) for (const c of cards) if (c.p === moment.p) c.a = 0; // the panel shows this player's note
    let end = null;
    // the winner banner fades out first, the table comes in only when the banner is gone (never both at once)
    if (this.end && outT >= this.end.s0) end = { ...this.end.data, a: +clamp01((outT - this.end.s0 - O.end_banner_out) / O.end_in).toFixed(3) };
    if (end && banner) banner.a = +Math.min(banner.a, clamp01(1 - (outT - this.end.s0) / O.end_banner_out)).toFixed(3);
    // casters: every cue that is being spoken (two at most, only an interjection overlaps another line)
    const captions = [];
    if (this.captions) {
      for (let k = 0; k < this.captions.length; k++) {
        const c = this.captions[k];
        if (c.s0 > outT) break;
        if (outT >= c.s1 + O.cap_hold) continue;
        // a line that has ended gives way at once when the next one has begun: two cards never cross-fade over each other (frame 630.97 s of Partie 10)
        if (outT >= c.s1 && this.captions.some((n, j) => j > k && n.s0 <= outT && n.s0 >= c.s1 - 0.15)) continue;
        // and the new line stands at full strength at once when it takes the place of one that was still fading (no dip, no double)
        const cut = this.captions.some((p, j) => j < k && p.s1 <= c.s0 + 0.15 && c.s0 < p.s1 + O.cap_hold + O.cap_out);
        const a = (cut ? 1 : clamp01((outT - c.s0) / O.cap_in)) * clamp01((c.s1 + O.cap_hold - outT) / O.cap_out);
        captions.push({ speaker: c.speaker, name: c.name, role: c.role ?? '', color: c.color, text: c.text, a: +a.toFixed(3), leaving: outT >= c.s1 });
      }
    }
    return { captions: captions.slice(-O.cap_max), cards, ticker, banner, feed, moment, fog, end, stats, clock: mmss(tick), badge: speedBadge(this.tl, outT), god: this.godAt !== null && tick >= this.godAt, story: this.story ? this.story.at(outT, tick) : null };
  }
}
