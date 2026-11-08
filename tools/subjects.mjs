// What a decision (or an event) is ABOUT, read from the log only: the observation the model was shown (io.jsonl: its unit
// groups with ids and positions, its buildings, the enemy units and buildings it could see), the orders it gave (log.jsonl:
// attack targets by building id or tile, the building a train / research order names, where a build order goes) and the
// words of its own note. Nothing is guessed: a subject exists only when the log names it.
//   resolveSubjects(user, cmds, p) -> [{ role, kind, owner, type, n, ids, bid, x, z }]   (primary subject first)
//   liveSubject(snap, subject, ctx) -> { x, z, r, n, found }                              (where it is in a snapshot of the match)
// kinds: 'units' (a group, followed by unit ids), 'building' (by id or tile), 'army' (all army units of an owner), 'place'.
// roles: 'note' (named in the note), 'target' (attack target), 'actors' (units that were ordered), 'saw' (enemy group it saw),
// 'site' (building that trains / researches / is being built).
import { cluster } from '../render/cinema.mjs';
import { displayName } from '../render/theme/display-name.mjs';
import { themeAlternation } from './lib/theme-words.mjs';

const THREAT = ['ram', 'catapult', 'trebuchet', 'siege_tower', 'light_cavalry', 'cavalry', 'knight', 'swordsman', 'archer', 'skirmisher', 'spearman'];
const SYN = { tc: 'town_center', 'town centre': 'town_center', 'town center': 'town_center', rax: 'barracks', range: 'archery_range', cavalry: 'light_cavalry' };
// These words are searched in the NOTE a model wrote. In phase 1 the model sees and writes classic words (the prompt does not know the theme),
// so this asks for 'classic' on purpose. Phase 2 (theme names in the prompt) must match the theme words as well: C1 adds the words of the ACTIVE theme (name and plural)
// as further alternatives. For classic (nothing active) they are empty and every pattern below is the old one.
const typeWords = (t) => displayName('any', t, 'classic');
const themeAlt = (t) => { const a = themeAlternation('any', t); return a ? `|${a}` : ''; };
const mentions = (note, type) => {
  const w = typeWords(type);
  return new RegExp(`\\b${w}(?:s|es)?\\b`, 'i').test(note) || (themeAlt(type) !== '' && new RegExp(`\\b(?:${themeAlt(type).slice(1)})\\b`, 'i').test(note)) || (w === 'swordsman' && /\bswordsmen\b/i.test(note)) || (w === 'town center' && /\b(tc|town cent(?:er|re))\b/i.test(note)); // regex-safe: w comes from the game's own type names
};
const ids = (s) => (s ? String(s).split(',').map(Number).filter(Number.isFinite) : []);
const xyOf = (o) => (Array.isArray(o.xy) ? o.xy : null);

export function parseObs(user) {
  try { return typeof user === 'string' ? JSON.parse(user) : user; } catch { return null; }
}

// The compact observation (rts-llm-1.9) leaves out `owner` of enemy entries in a two-player match: the one opponent is the other id.
const enemyDefault = (p) => (p === 1 ? 2 : p === 2 ? 1 : 0);

export function resolveSubjects(user, cmds = [], p = 0) {
  const o = parseObs(user);
  if (!o || typeof o !== 'object') return [];
  const own = (o.units || []).filter((u) => xyOf(u)).map((u) => ({ ...u, ids: ids(u.ids), owner: p }));
  const foe = enemyDefault(p);
  const enemy = (o.enemy_units || []).filter((u) => xyOf(u)).map((u) => ({ ...u, ids: ids(u.ids), owner: u.owner ?? foe }));
  const bld = [...(o.buildings || []).map((b) => ({ ...b, owner: p })), ...(o.enemy_buildings || []).map((b) => ({ ...b, owner: b.owner ?? foe })), ...(o.enemy_minor_buildings || []).filter((b) => b.id).map((b) => ({ ...b, owner: b.owner ?? foe }))].filter((b) => xyOf(b));
  const note = String((cmds.find((c) => c.cmd === 'note') || {}).text || '');
  const out = [];
  const add = (s) => { if (!out.some((x) => x.kind === s.kind && x.type === s.type && x.owner === s.owner && Math.hypot(x.x - s.x, x.z - s.z) < 6)) out.push(s); };
  const unitSub = (g, role) => ({ role, kind: 'units', owner: g.owner, type: g.type, n: g.n, ids: g.ids.slice(0, 40), x: g.xy[0], z: g.xy[1] });
  const bldSub = (b, role) => ({ role, kind: 'building', owner: b.owner, type: b.type, n: b.n || 1, ids: [], bid: b.id ?? null, x: b.xy[0], z: b.xy[1] });
  // orders
  for (const c of cmds) {
    if (c.cmd === 'attack_move') {
      let tgt = null;
      if (Number.isFinite(c.target)) {
        const b = bld.find((x) => x.id === c.target);
        if (b) tgt = bldSub(b, 'target');
        else { const g = enemy.find((x) => x.ids.includes(c.target)); if (g) tgt = unitSub(g, 'target'); }
      } else if (Array.isArray(c.target)) {
        const [tx, tz] = c.target;
        const near = bld.filter((b) => b.owner !== p).map((b) => [Math.hypot(b.xy[0] - tx, b.xy[1] - tz), b]).sort((a, b) => a[0] - b[0])[0];
        const eg = enemy.map((g) => [Math.hypot(g.xy[0] - tx, g.xy[1] - tz), g]).sort((a, b) => a[0] - b[0])[0];
        if (near && near[0] < 6) tgt = bldSub(near[1], 'target');
        else if (eg && eg[0] < 8) tgt = unitSub(eg[1], 'target');
        else tgt = { role: 'target', kind: 'place', owner: 0, type: null, n: 0, ids: [], x: tx, z: tz };
      }
      if (tgt) add(tgt);
      const us = String(c.units || '');
      if (us === 'army') { if (own.length) { const cl = cluster(own.map((g) => g.xy)); if (cl) add({ role: 'actors', kind: 'army', owner: p, type: 'army', n: own.reduce((a, g) => a + g.n, 0), ids: [], x: cl.x, z: cl.z }); } }
      else { const want = ids(us); const gs = own.filter((g) => g.ids.some((i) => want.includes(i))); if (gs.length) add(unitSub(gs[0], 'actors')); }
    } else if ((c.cmd === 'train' || c.cmd === 'research') && Number.isFinite(c.building_id)) {
      const b = bld.find((x) => x.id === c.building_id);
      if (b) add({ ...bldSub(b, 'site'), unit: c.unit_type || c.tech || null });
    } else if (c.cmd === 'build' && Array.isArray(c.near)) {
      add({ role: 'site', kind: 'building', owner: p, type: c.building_type, n: 1, ids: [], bid: null, x: c.near[0], z: c.near[1], planned: true });
    }
  }
  // the enemy group it saw: the most dangerous kind first
  const rank = (t) => { const i = THREAT.indexOf(t); return i < 0 ? 99 : i; };
  const sawG = [...enemy].sort((a, b) => rank(a.type) - rank(b.type) || b.n - a.n)[0];
  if (sawG) add(unitSub(sawG, 'saw'));
  // what the note names (a unit or building type that exists in the observation)
  if (note) {
    const at = (type) => { const w = typeWords(type); const m = new RegExp(`\\b(${w}(?:s|es)?${w === 'swordsman' ? '|swordsmen' : ''}${w === 'town center' ? '|tc|town cent(?:er|re)' : ''}${themeAlt(type)})\\b`, 'i').exec(note); return m ? m.index : -1; }; // regex-safe: w comes from the game's own type names
    const enemyWord = (i) => /\b(enem(y|ies)'?s?|their)\W{0,3}$/i.test(note.slice(Math.max(0, i - 12), i));
    const cands = [];
    for (const g of [...enemy, ...own]) { const i = at(g.type); if (i >= 0) cands.push({ i, s: unitSub(g, 'note'), ex: g.owner !== p }); }
    for (const b of bld) { const i = at(b.type); if (i >= 0) cands.push({ i, s: bldSub(b, 'note'), ex: b.owner !== p }); }
    for (const x of out) if (x.planned) { const i = at(x.type); if (i >= 0) cands.push({ i, s: { ...x, role: 'note' }, ex: false }); }
    // "enemy TC" is the enemy one, a bare "TC" is the model's own; the earliest named thing wins
    // a bare "farm" is never the other side's (real case: "resolve held farm" named the enemy farm because its own is not in the list)
    const ok = cands.filter((c) => {
      if (c.s.kind !== 'building' || c.ex === enemyWord(c.i)) return true;
      return /^(town_center|barracks|archery_range|stables|siege_workshop|tower|blacksmith)$/.test(c.s.type) && !cands.some((d) => d.s.type === c.s.type && d.ex === enemyWord(c.i));
    });
    ok.sort((a, b) => a.i - b.i || (b.ex ? 1 : 0) - (a.ex ? 1 : 0));
    if (ok[0]) out.unshift(ok[0].s);
  }
  const order = { note: 0, target: 1, actors: 2, saw: 3, site: 4 };
  out.sort((a, b) => order[a.role] - order[b.role]);
  return out.slice(0, 4);
}

// compact entity lists for the digest (what the model could see), so subjects can be rebuilt from events.json alone
export function entitiesOf(o, p = o.you) {
  const g = (u) => ({ type: u.type, n: u.n, xy: u.xy, ids: u.ids || '', owner: u.owner });
  const ge = (u) => ({ ...g(u), owner: u.owner ?? enemyDefault(p) });
  return {
    own_groups: (o.units || []).filter(xyOf).slice(0, 14).map(g),
    enemy_groups: (o.enemy_units || []).filter(xyOf).slice(0, 14).map(ge),
  };
}

// Where a subject is in a snapshot ({units: [[id, owner, typeIdx, x, z, ...]], buildings: [[id, owner, typeIdx, tx, ty, ...]]}).
// ctx: { UN: unit type names by index, isArmy(idx), size(typeIdx) -> building size in tiles }
export function liveSubject(snap, s, ctx = {}) {
  const fb = { x: s.x, z: s.z, r: 5, n: 0, found: false };
  if (!snap) return fb;
  if (s.kind === 'building') {
    const bs = snap.buildings || [];
    let b = s.bid != null ? bs.find((x) => x[0] === s.bid) : null;
    if (!b) { let d = 5; for (const x of bs) { const dd = Math.hypot(x[3] - s.x, x[4] - s.z); if (dd < d && (s.owner === 0 || x[1] === s.owner)) { d = dd; b = x; } } }
    if (b) { const sz = ctx.size ? ctx.size(b[2]) : 3; return { x: b[3] + sz / 2, z: b[4] + sz / 2, r: 3 + sz, n: 1, found: true }; }
    return fb;
  }
  const pts = [];
  if (s.kind === 'units') {
    const want = new Set(s.ids || []);
    for (const u of snap.units) if (want.has(u[0])) pts.push([u[3], u[4]]);
    if (!pts.length) for (const u of snap.units) if (u[1] === s.owner && ctx.UN && ctx.UN[u[2]] === s.type && Math.hypot(u[3] - s.x, u[4] - s.z) < 30) pts.push([u[3], u[4]]);
  } else if (s.kind === 'army') {
    for (const u of snap.units) if (u[1] === s.owner && (!ctx.isArmy || ctx.isArmy(u[2]))) pts.push([u[3], u[4]]);
  }
  if (pts.length) { const c = cluster(pts); if (c) return { x: c.x, z: c.z, r: Math.max(4, c.r), n: pts.length, found: true }; }
  return fb;
}
