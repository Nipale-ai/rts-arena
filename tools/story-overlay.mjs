// On-screen layer of the story cut (pure function of output time and game tick): a timeline bar with the chapters, one strategy card per
// player (updated whenever the plan changes: the model's note word for word, its latest orders, the army it saw), the split view of the
// decisions at a freeze frame (what the model saw, its note, its orders; two columns when both players decide close together) and the
// tier race table. Text comes from tools/story-data.mjs, the same source the casters' facts use.
import { StoryData, clockOf } from './story-data.mjs';
import { momentCard } from './commentary.mjs';
import { plainOrders } from './plain-orders.mjs';

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const SHOW = { in: 0.45, out: 0.5, card_in: 0.6, flash_s: 1.8, split_in: 0.4, split_out: 0.5 };

export class StoryOverlay {
  constructor({ ev, plan, timeline, players, nameOf }) {
    this.ev = ev; this.tl = timeline; this.S = plan.story; this.players = players;
    this.data = new StoryData(ev);
    this.nameOf = nameOf || ((p) => players[p - 1]?.name ?? `P${p}`);
    const byId = new Map(ev.events.filter((e) => e.type === 'llm_decision').map((e) => [e.id, e]));
    // freeze frames: output window of every story unit
    this.holds = (this.S.units || []).map((u) => ({ u, o0: timeline.outAt(u.tick), o1: timeline.outAfterHold(u.tick), decs: u.decs.map((id) => byId.get(id)).filter(Boolean) }));
    const total = this.S.total_s;
    this.bar = this.S.chapters.map((c) => ({ id: c.id, title: c.title, o0: c.o0 + this.S.offset_s, o1: c.o1 + this.S.offset_s }));
    if (this.S.teaser_s && !this.S.teaser) this.bar.unshift({ id: 'cold', title: 'COLD OPEN', o0: 0, o1: this.S.teaser_s });
    if (this.S.teaser) { // the cold open clip: chapters of the main part start after it
      this.bar = [{ id: 'cold', title: 'COLD OPEN', o0: 0, o1: this.S.teaser_s }, ...this.S.chapters.map((c) => ({ id: c.id, title: c.title, o0: c.o0 + this.S.teaser_s, o1: c.o1 + this.S.teaser_s }))];
    }
    this.total = total;
    this.endAt = (this.S.chapters.find((c) => c.id === 'recap')?.o0 ?? 1e9);
    this.mom = new Map((plan.moments || []).map((m) => [m.id, m]));
  }

  at(outT, tick) {
    const S = this.S, off = S.teaser ? 0 : S.offset_s;
    const g = outT + off; // time in the finished video
    let cur = 0;
    this.bar.forEach((c, i) => { if (g >= c.o0) cur = i; });
    const bar = { p: +clamp01(g / this.total).toFixed(4), cur, items: (S.no_bar ? [] : this.bar).map((c) => ({ t: c.title, w: +((c.o1 - c.o0) / this.total).toFixed(4) })) };
    const out = { bar, tag: S.teaser ? `LATER IN THIS MATCH  ${clockOf(tick)}` : null, cards: null, split: null };
    if (S.teaser) return out;
    // strategy cards: from the first second until the end screen
    const showCards = outT >= 0.4 && outT < this.endAt - 0.2;
    const ca = showCards ? clamp01((outT - 0.4) / SHOW.card_in) * clamp01((this.endAt - outT) / SHOW.out) : 0;
    if (ca > 0) {
      out.cards = [1, 2].map((p) => {
        const c = this.data.card(p, tick);
        const o = c.changed >= 0 ? this.tl.outAt(c.changed) : -1e9;
        return { ...c, name: this.nameOf(p), flash: +clamp01(1 - (outT - o) / SHOW.flash_s).toFixed(3), a: +ca.toFixed(3) };
      });
    }
    // the split view at a freeze frame (and a little while after the game runs on, while the explanation goes on)
    for (const h of this.holds) {
      const o1 = h.o1 + (h.u.kind === 'compare' ? 0.5 : 3.2); // the tier race table goes with the freeze: the next line is about the battle
      if (outT < h.o0 - 0.1 || outT > o1) continue;
      const a = clamp01((outT - h.o0 + 0.1) / SHOW.split_in) * clamp01((o1 - outT) / SHOW.split_out);
      out.split = this.splitFor(h, a);
      break;
    }
    return out;
  }

  splitFor(h, a) {
    const u = h.u;
    if (u.kind === 'compare') {
      const cr = this.data.compareRows(u.tick);
      return { a: +a.toFixed(3), kind: 'compare', title: 'TIER RACE', clock: clockOf(u.tick), names: [1, 2].map((p) => this.nameOf(p)), rows: cr.rows, cols: [] };
    }
    const cols = h.decs.map((e) => {
      const m = this.mom.get(e.id);
      const pl = this.players;
      const card = m ? momentCard(m, pl.map((q) => ({ ...q, name: q.short || q.name }))) : null;
      const meta = [];
      if (e.latency_ms != null) meta.push(`thought for ${(e.latency_ms / 1000).toFixed(e.latency_ms < 10000 ? 1 : 0)} s`);
      if (e.completion_tokens != null) meta.push(`${e.completion_tokens} tokens`);
      return { p: e.p, name: this.nameOf(e.p), n: e.n, at: clockOf(e.t), saw: card ? card.saw.slice(0, 2) : [], note: e.thought ? e.thought.replace(/\.?\s*<tool[\s\S]*$/i, '\u2026') : null, ordered: plainOrders(e.summary), meta: meta.join(' · ') };
    });
    return { a: +a.toFixed(3), kind: 'decisions', title: u.kind === 'open' ? 'OPENING PLANS' : cols.length > 1 ? 'TWO DECISIONS' : 'KEY DECISION', clock: clockOf(u.tick), names: [], rows: [], cols };
  }
}
