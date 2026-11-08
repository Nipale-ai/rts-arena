// Finale: the match is decided, so every building the loser still has falls, one after the other (a wave out from the middle of
// each base). Pure functions, no THREE and no clock: render/app.mjs plans the finale from the snapshot that carries `over` (live,
// replay, late joiner) and plays it with its own collapse animation. The delays come from a hash of the building id (never
// Math.random), so broadcast frames stay exact.
import { cluster } from './cinema.mjs';

// start spread (s) = spread[0] + per * buildings, at most spread[1]; fall = length of the collapse animation; lead = pause before the
// first fall; tail = pause before the end banner; group_d = bases closer than this (tiles) are one base
export const FIN = { spread: [1.6, 5.0], per: 0.12, fall: 2.4, lead: 0.5, tail: 0.9, group_d: 24 };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export const hash01 = (n) => { let h = Math.imul(n | 0, 0x9e3779b1) ^ 0x85ebca6b; h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d); h = Math.imul(h ^ (h >>> 12), 0x297a2d39); return ((h ^ (h >>> 15)) >>> 0) / 4294967296; };

// buildings: Map or array of [id, { owner, tx, ty, size }]; over: the `over` block of the snapshot ({ winnerTeam, reason, godMode });
// teamOf(owner) -> team. Returns null when there is no finale (no decided base war, or nothing of the loser left), else
// { t0: null, items: [{ id, o, cx, cz, at }] sorted by start time (s), next: 0, groups: [{ cx, cz, r, a, list }], over, end }.
export function planFinale({ buildings, over, teamOf, opts = {} }) {
  const F = { ...FIN, ...opts };
  if (!over || over.godMode || /^(time limit|cutoff)/.test(over.reason || '')) return null; // only a decided base war, not a win on score
  const lost = (o) => !over.winnerTeam || teamOf(o.owner) !== over.winnerTeam;
  const byOwner = new Map();
  for (const [id, o] of buildings) if (lost(o)) { if (!byOwner.has(o.owner)) byOwner.set(o.owner, []); byOwner.get(o.owner).push([id, o]); }
  const mid = (o) => [o.tx + o.size / 2, o.ty + o.size / 2];
  const groups = []; // one per base (owners with bases close together share one)
  for (const owner of [...byOwner.keys()].sort((a, b) => a - b)) {
    const list = byOwner.get(owner), c = cluster(list.map(([, o]) => mid(o)));
    const g = groups.find((q) => Math.hypot(q.cx - c.x, q.cz - c.z) < F.group_d);
    if (g) g.list.push(...list); else groups.push({ list, cx: c.x, cz: c.z });
  }
  if (!groups.length) return null;
  for (const g of groups) { const c = cluster(g.list.map(([, o]) => mid(o))); g.cx = c.x; g.cz = c.z; g.r = c.r; }
  groups.sort((a, b) => b.list.length - a.list.length || a.cx - b.cx);
  const n = groups.reduce((s, g) => s + g.list.length, 0), k = groups.length;
  const S = clamp(F.spread[0] + F.per * n, F.spread[0], F.spread[1]), w = k > 1 ? (S / k) * 1.3 : S;
  const items = [];
  groups.forEach((g, i) => {
    g.a = F.lead + (k > 1 ? (i * (S - w)) / (k - 1) : 0); // bases fall one after the other (a little overlap)
    let far = 1;
    for (const [, o] of g.list) { const [x, z] = mid(o); far = Math.max(far, Math.hypot(x - g.cx, z - g.cz)); }
    for (const [id, o] of g.list) {
      const [x, z] = mid(o), d = Math.hypot(x - g.cx, z - g.cz) / far;
      items.push({ id, o, cx: x, cz: z, at: Math.max(F.lead, g.a + w * (0.06 + 0.86 * Math.pow(d, 0.85)) + (hash01(id) - 0.5) * 0.3) });
    }
  });
  items.sort((a, b) => a.at - b.at || a.id - b.id);
  return { t0: null, items, next: 0, groups, over, end: items[items.length - 1].at + F.fall, tail: F.tail };
}

// camera shot (render/cinema.mjs 'finale') at e seconds after the start: one shot per base, the last one is held when everything is down
export function finaleShot(plan, e) {
  const gs = plan.groups;
  let i = 0;
  while (i + 1 < gs.length && e >= gs[i + 1].a - 0.4) i++;
  const g = gs[i], b = i + 1 < gs.length ? gs[i + 1].a : plan.end + plan.tail;
  return { kind: 'finale', key: `fin${i}`, x: g.cx, z: g.cz, r: g.r, len: Math.max(3, b - g.a) };
}
