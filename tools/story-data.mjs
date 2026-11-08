// Data of the story cut that is shown on screen AND told by the casters (one source, so the cards and the facts never disagree).
// Everything is read from the match log (events.json): the models' notes and orders word for word, the observation each model got
// (workers, army, tier), the buildings it finished and the army value series.
import { plainOrders } from './plain-orders.mjs';
import { TICK_HZ } from '../sim/util.mjs';
import { BUILDINGS } from '../sim/data.mjs';
import { displayName, displayPlural } from '../render/theme/display-name.mjs';
import { isThemed, labelPlural } from './lib/theme-words.mjs';

export const nice = (s) => displayName('any', s); // R1: the theme decides the words (default classic = the old underscore-to-space text)
// a building that fell with no killer and no weapon: it crumbled in sudden death, no player destroyed it (sim/game.mjs suddenDeathStep)
export const crumbled = (e) => !e.by && !e.src;
export const clockOf = (tick) => { const s = Math.floor(tick / TICK_HZ); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const plural = (t, n) => (n === 1 ? nice(t) : displayPlural('any', t)); // the plural of the theme (classic: the regular plural, the one pluralOf makes)
export const typeList = (m, n = 3) => Object.entries(m || {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([t, c]) => `${c} ${plural(t, c)}`).join(', ');

export class StoryData {
  constructor(ev) {
    this.ev = ev;
    this.dec = [[], []];
    for (const e of ev.events) if (e.type === 'llm_decision') this.dec[e.p - 1].push(e);
    for (const l of this.dec) l.sort((a, b) => a.t - b.t);
    this.tiers = ev.events.filter((e) => e.type === 'tier_up');
    this.keys = ev.events.filter((e) => e.type === 'key_building');
  }
  // newest decision of player p (1-based) up to tick, optionally only those with a note / with any content
  last(p, tick, want = 'any') {
    const l = this.dec[p - 1];
    for (let i = l.length - 1; i >= 0; i--) {
      const e = l[i];
      if (e.t > tick) continue;
      if (want === 'note' && !e.thought) continue;
      if (want === 'content' && !(e.thought || e.summary)) continue;
      return e;
    }
    return null;
  }
  tier(p, tick) { return 1 + this.tiers.filter((e) => e.p === p && e.t <= tick).length; }
  army(p, tick) { const a = this.ev.series?.army?.[p - 1]; if (!a) return null; return Math.round(a[Math.min(a.length - 1, Math.max(0, Math.floor(tick / TICK_HZ)))]); }
  // the real state on the field at a tick, from the replay (never a model's report: that one is a whole decision old)
  workers(p, tick) { const a = this.ev.series?.workers?.[p - 1]; return a && a.length ? a[Math.min(a.length - 1, Math.max(0, Math.floor(tick / TICK_HZ)))] : null; }
  armyNow(p, tick) { const a = this.ev.series?.army_types?.[p - 1]; return a && a.length ? a[Math.min(a.length - 1, Math.max(0, Math.floor(tick / TICK_HZ)))] : null; }
  built(p, tick) { const seen = []; for (const e of this.keys) if (e.p === p && e.t <= tick && !seen.includes(e.building)) seen.push(e.building); return seen; }
  // what the strategy card of a player shows at a tick
  card(p, tick) {
    const note = this.last(p, tick, 'note'), last = this.last(p, tick, 'content'), any = this.last(p, tick, 'any');
    const seen = (any && any.seen) || null;
    return {
      p, tier: this.tier(p, tick),
      plan: note ? { text: note.thought.replace(/\.?\s*<tool[\s\S]*$/i, '\u2026'), at: clockOf(note.t), t: note.t, n: note.n } : null,
      orders: last && last.summary ? { text: plainOrders(last.summary), at: clockOf(last.t), t: last.t, n: last.n } : null,
      army: seen && seen.own_army_n ? { text: typeList(seen.own, 3), at: clockOf(any.t), t: any.t } : null,
      changed: Math.max(note ? note.t : -1, last ? last.t : -1),
    };
  }
  // side by side numbers at a tick (tier race)
  compare(p, tick) {
    const built = this.built(p, tick), army = this.armyNow(p, tick);
    return { p, tier: this.tier(p, tick), workers: this.workers(p, tick), army_value: this.army(p, tick), army: army && Object.keys(army).length ? typeList(army, 3) : null, built: built.map(nice) };
  }
  // the on-screen rows of the tier race
  compareRows(tick) {
    const c = [1, 2].map((p) => this.compare(p, tick));
    const rows = [
      { label: 'TIER', vals: c.map((x) => String(x.tier)) },
      { label: isThemed('unit', 'worker') ? labelPlural('unit', 'worker') : 'WORKERS', vals: c.map((x) => (x.workers != null ? String(x.workers) : '-')) },
      { label: 'ARMY VALUE', vals: c.map((x) => (x.army_value != null ? String(x.army_value) : '-')) },
      { label: 'ARMY', vals: c.map((x) => x.army || 'none') },
      { label: 'BUILT', vals: c.map((x) => (x.built.length ? x.built.join(', ') : 'nothing yet')) },
    ];
    return { rows, data: c };
  }
}

export const BUILDING_NAMES = Object.keys(BUILDINGS);
