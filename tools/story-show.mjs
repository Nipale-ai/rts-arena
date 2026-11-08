// "Show what is said" layer of the story cut: every caster line gets the picture it talks about, while it is spoken.
// Rule (BROADCAST-RULES.md): the picture must show what the caster says at that moment. Telling without showing is the bug.
//
// Where the picture comes from: the structured SHOW TAGS of each line (tools/show-tags.mjs: view, fog, follow, building, place, versus, inset, event).
// The script writer (LLM or template) fills them; the checker validates them against the log; a line without a valid tag goes through the generic
// inferrer (keywords and entities of the line). Nothing here matches the text of one particular script.
//
// Per line the tags become one or more PARTS. A part is a window of output time with
//   cam    a camera spec that the Director (tools/camera.mjs, showShot) turns into a smooth shot: a low view from one base across the
//          map, a push-in on a building, a follow of a group of units, a wide view on the middle between two armies, the fight
//   fog    the player whose fog of war is switched on in the 3D view (what that player can see / has explored)
//   view   the banner of a fog view: whose eyes (side colour, name), what bright / grey / dark mean, how many enemy units that player sees (render/fog-banner.mjs)
//   tag    a chip at the top of the view that names what is shown ("MINIMAX ARMY"); in a fog view the banner says whose view it is, the chip leaves
//   marks  highlights (rings around units or buildings, a label) that are found live, so they follow the units
//   versus two bars that compare a number of both players (army value, time per decision)
//   inset  the decision view: the whole map with the plan cards left up (A1, 05.11.: the small map of what a model saw is off)
// Everything is read from the match log and the replay (a pre-pass re-simulates the replay once), nothing is invented.
// The hand-written rules of the approved s101 script live on as a regression fixture only (test-support/s101-show-rules.mjs).
import '../server/local-env.mjs'; // RTS_* defaults from local-env.json
import { StoryData, clockOf } from './story-data.mjs';
import { ReplaySim } from './lib/replay.mjs';
import { mainGroup, GROUP_LINK_TILES } from '../render/mark-hull.mjs';
import { UNITS, BUILDINGS } from '../sim/data.mjs';
import { WILD_UNITS } from '../sim/world-data.mjs';
import { World, validateShow, inferShow, tagKind, playerAliases, aliasesOfName } from './show-tags.mjs';
import { displayName } from '../render/theme/display-name.mjs';
import { isThemed, labelPlural } from './lib/theme-words.mjs';

const clamp01 = (v) => Math.max(0, Math.min(1, v));
export const UN = [...Object.keys(UNITS), ...WILD_UNITS];
export const BN = Object.keys(BUILDINGS);
const isArmy = (i) => UN[i] !== 'worker' && !WILD_UNITS.includes(UN[i]) && UNITS[UN[i]]?.cls !== 'naval' && UN[i] !== 'scout';
export const FADE = 0.4; // fade of the fog, the banner and the highlights at the edges of a part (s)
export const SWAP = 0.2; // two fog views of different sides in a row: each veil fades over this long, the banner changes side in the 2 x SWAP around the cut (s)

// the fog of war in a story video comes from the line that is spoken and from nothing else. In the short gaps between two lines
// the show has no state (null), and the overlay's key-decision fog came through there as a dark flash of a few frames.
export const showFog = (sh) => (sh && sh.fog && sh.fog.a > 0 ? sh.fog : null);
const PANEL_SLACK = 150; // ticks: a line may name what comes right after ("goes from 350 to 490"), so its panel may lead the picture by 15 s of game time; the panel names its own clock
const LEAD = 1.2; // the camera starts moving this long before the line is spoken
const nice = (s) => displayName('any', s); // R1: the theme decides the words (default classic = the old underscore-to-space text)

// units of a snapshot that a selection names: { ids } | { t:'army', o } | { t:'type', o, ty } , optional near: [x, z, radius]
// where the name of a group stands: on its biggest part (the middle of a split army is empty ground)
export function labelSpot(us) {
  const g = mainGroup(us.map((u) => [u[3], u[4]]), GROUP_LINK_TILES), mid = (k) => g.map((p) => p[k]).sort((a, b) => a - b)[g.length >> 1];
  return [mid(0), mid(1)];
}

// what a panel of army values shows against what the line says and what the picture shows. Each fault stops the render before its first frame.
export function panelFaults({ line, text, rows, tick, seen }) {
  const out = [], vals = rows.map((r) => r.val);
  const spoken = [...String(text).replace(/\b\d{1,2}:\d{2}\b/g, ' ').replace(/\b(5090|5060)(?:['’]s)?\b/g, ' ').matchAll(/\b\d{3,6}\b/g)].map((m) => +m[0]);
  if (spoken.length && !spoken.some((n) => vals.includes(n))) out.push(`${line}: the line says ${spoken.join(', ')}, the panel shows ${vals.join(', ')}`);
  if (tick > seen + PANEL_SLACK) out.push(`${line}: the panel at ${clockOf(tick)} runs ahead of the picture at ${clockOf(seen)}`);
  return out;
}

// what the viewer of a fog view may be told about the other side, from the very state that is on screen: how many units of the other side(s) there are
// (the wild animals are nobody's) and how many of them stand on ground the player sees right now (the same sight the model's observation is cut by)
export function sightOf(snap, game, pid) {
  const vis = game.players?.[pid]?.vis, W = game.W;
  if (!vis || !snap.units) return null;
  let n = 0, total = 0;
  for (const u of snap.units) {
    if (u[1] === pid || u[1] <= 0 || WILD_UNITS.includes(UN[u[2]])) continue;
    total++;
    if (vis[Math.floor(u[4]) * W + Math.floor(u[3])]) n++;
  }
  return { n, total };
}

export function selectUnits(snap, sel) {
  const out = [], ids = sel.ids ? new Set(sel.ids) : null;
  for (const u of snap.units) {
    if (ids) { if (!ids.has(u[0])) continue; }
    else if (sel.t === 'army') { if (u[1] !== sel.o || !isArmy(u[2])) continue; }
    else if (sel.t === 'type') { if (u[1] !== sel.o || UN[u[2]] !== sel.ty) continue; }
    else if (sel.t === 'workers') { if (u[1] !== sel.o || UN[u[2]] !== 'worker') continue; }
    else continue;
    if (sel.near && Math.hypot(u[3] - sel.near[0], u[4] - sel.near[1]) > sel.near[2]) continue;
    if (sel.act != null && u[6] !== sel.act) continue;
    out.push(u);
  }
  return out;
}

// ---------------------------------------------------------------- pre-pass: facts that need the simulation (ids of units, what a model saw)
// insets: [{ key, p, tick }] the state a model saw when it decided; contacts: [{ id, t, p, loc }] first contacts (which unit was the scout)
export function prepass(rep, ev, { insets = [], contacts = [], ticks = [] }) {
  const sim = new ReplaySim(rep), g = sim.game;
  const out = { starts: g.starts.map((s) => ({ x: s.tx + 1.5, z: s.ty + 1.5 })), scouts: {}, insets: {} };
  const plan = [
    ...contacts.map((q) => ({ t: q.t, f: () => { let best = null; for (const u of g.units.values()) { if (u.dead || u.owner !== q.p) continue; const d = Math.hypot(u.x / 1000 - q.loc[0], u.y / 1000 - q.loc[1]); if (d < 20 && (!best || d < best.d)) best = { id: u.id, d }; } out.scouts[q.id] = best ? best.id : null; } })),
    ...insets.map((q) => ({ t: q.tick, f: () => {
      const vis = g.players[q.p].vis, expl = g.players[q.p].expl, W = g.W, f8 = new Uint8Array(W * g.H);
      for (let i = 0; i < f8.length; i++) f8[i] = vis[i] ? 2 : expl[i] ? 1 : 0;
      const enemy = [], own = [];
      for (const u of g.units.values()) {
        if (u.dead || u.owner === 0) continue;
        if (u.owner === q.p) own.push([Math.round(u.x / 100) / 10, Math.round(u.y / 100) / 10]);
        else if (vis[Math.floor(u.y / 1000) * W + Math.floor(u.x / 1000)]) enemy.push([Math.round(u.x / 100) / 10, Math.round(u.y / 100) / 10, u.type === 'worker' ? 1 : 0]);
      }
      let x0 = W, z0 = g.H, x1 = 0, z1 = 0;
      for (let i = 0; i < f8.length; i++) if (f8[i]) { const x = i % W, z = Math.floor(i / W); if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; }
      for (const u of [...own, ...enemy]) { x0 = Math.min(x0, u[0]); x1 = Math.max(x1, u[0]); z0 = Math.min(z0, u[1]); z1 = Math.max(z1, u[1]); }
      const m = 3; x0 = Math.max(0, x0 - m); z0 = Math.max(0, z0 - m); x1 = Math.min(W, x1 + m); z1 = Math.min(g.H, z1 + m);
      const sp = Math.max(x1 - x0, z1 - z0, 24), cxm = (x0 + x1) / 2, czm = (z0 + z1) / 2;
      out.insets[q.key] = { p: q.p, tick: q.tick, size: W, box: [Math.max(0, cxm - sp / 2), Math.max(0, czm - sp / 2), sp], fog: Buffer.from(f8).toString('base64'), own, enemy, n: enemy.length, workers: enemy.filter((e) => e[2]).length };
    } })),
    ...ticks.map((t) => ({ t, f: () => {} })),
  ].sort((a, b) => a.t - b.t);
  for (const s of plan) { sim.stepTo(s.t); s.f(); }
  return out;
}

// ---------------------------------------------------------------- tags -> parts
// c: { starts, names, world, pre, ev }; every part has f:[0,1] (relative to the slot of its tag)
const up = (s) => nice(s).toUpperCase();
// The chip of a followed group. Classic keeps the old text word for word ("ARCHERS", also the wrong plurals "SWORDSMANS" and "LIGHT CAVALRYS": changing them would move the classic video);
// a theme that renames the unit speaks its own plural ("ARC GUNNERS"), so no "+ S" is ever put behind a theme word.
const classicPlural = (ty) => { const u = up(ty); return /CAVALRY$/.test(u) ? u : /MAN$/.test(u) ? u.replace(/MAN$/, 'MEN') : `${u}S`; }; // 07.11. (owner): SPEARMEN, SWORDSMEN, LIGHT CAVALRY instead of the wrong "+ S"
const unitChip = (ty) => (isThemed('unit', ty) ? labelPlural('unit', ty) : classicPlural(ty));
const workersChip = () => (isThemed('unit', 'worker') ? labelPlural('unit', 'worker') : 'WORKERS');
// RTS_CHIP_NAMES="Mac|Spark" (07.11.): the chips carry the short side names the commentary uses; the team labels keep the long names
export function tagParts(tag, c, tick) {
  const B = c.starts, nm = c.names.map((n, i) => String((process.env.RTS_CHIP_NAMES || '').split('|')[i] || n).toUpperCase()), side = (o) => (o === 1 ? 1 : -1), W = c.world;
  const other = (p) => (p === 1 ? 2 : 1);
  const tc = (o) => ({ k: 'bld', x: B[o - 1].x, z: B[o - 1].z, d0: 52, d1: 30, side: side(o) });
  // the chip of a fog view: the banner (render/fog-banner.mjs) already says whose view it is, so the page shows this one only without a banner
  const viewTag = (p, text) => ({ p, text: text || `${nm[p - 1]}'S VIEW  FOG OF WAR`, viewOnly: true });
  const look = (from, fog, text) => ({ f: [0, 1], cam: { k: 'look', from, to: other(from), rot: 12, lateral: from === 1 ? -9 : 9 }, ...(fog ? { fog: from } : {}), tag: fog ? viewTag(from, text) : { p: from, text: text || `${nm[from - 1]}'S VIEW` } });
  const kind = tagKind(tag);
  const fogP = tag.fog && kind !== 'fog' ? tag.fog.player : null;
  const withFog = (part) => (fogP ? { ...part, fog: fogP, tag: viewTag(fogP) } : part);
  const bldPart = (p, type, x, z, size, label, d0 = 36, d1 = 24) => withFog({ f: [0, 1], cam: type === 'town_center' ? tc(p) : { k: 'bld', x, z, d0, d1, side: side(p) }, tag: { p, text: `${nm[p - 1]}  ${label || up(type)}` }, marks: [{ bld: { x, z, size }, o: p, label: label || up(type) }] });
  switch (kind) {
    case 'view': return [look(tag.view.player, false)];
    case 'fog': { // from above the fog of war reads at once: the whole map, dark where this player cannot see; low views of it stay with follow, building, place
      const p = tag.fog.player;
      // every ring has a name: the base ("MINIMAX BASE") and an army of 3 or more ("ARMY 7"); a group of one or two units gets neither ring nor label
      return [{ f: [0, 1], clean: true, cam: { k: 'map' }, fog: p, tag: viewTag(p), marks: [{ bld: { x: B[p - 1].x, z: B[p - 1].z, size: 3 }, o: p, label: `${nm[p - 1]} BASE` }, { sel: { t: 'army', o: p }, o: p, label: 'ARMY {n}', labelFrom: 3, minUnits: 3 }] }];
    }
    case 'follow': {
      const s = tag.follow.sel, o = s.o, lab = s.t === 'army' ? 'ARMY' : s.t === 'workers' ? workersChip() : unitChip(s.ty);
      return [withFog({ f: [0, 1], cam: { k: 'grp', sel: s, dist: s.t === 'workers' ? 28 : 34, side: side(o) }, tag: { p: o, text: `${nm[o - 1]}  ${lab}` }, marks: [{ sel: s, o, label: `${lab} {n}` }] })];
    }
    case 'building': {
      const { player: p, type, nth } = tag.building, s = W.structure(p, type, tick, nth || 1);
      if (!s) return [];
      return [bldPart(p, type, s.x, s.z, s.size)];
    }
    case 'place': {
      if (tag.place.base) { const p = tag.place.base; return [withFog({ f: [0, 1], cam: tc(p), tag: { p, text: `${nm[p - 1]}  HOME BASE` }, marks: [{ bld: { x: B[p - 1].x, z: B[p - 1].z, size: 3 }, o: p, label: c.names[p - 1] }] })]; }
      return [withFog({ f: [0, 1], cam: { k: 'crane', x: tag.place.x, z: tag.place.z, side: 1 } })];
    }
    case 'map': { // zoomed far out: both bases in the picture; under fog only what that player owns gets a ring
      const os = (fogP ? [fogP] : [1, 2]);
      return [withFog({ f: [0, 1], clean: !(tag.map && tag.map.cards), cam: { k: 'map' }, tag: { text: 'THE WHOLE MAP' }, marks: [...os.map((o) => ({ bld: { x: B[o - 1].x, z: B[o - 1].z, size: 3 }, o, label: fogP ? `${nm[o - 1]} BASE` : c.names[o - 1] })), ...os.map((o) => ({ sel: { t: 'army', o }, o, label: 'ARMY {n}', labelFrom: 3, minUnits: 3 }))] })];
    }
    case 'versus': {
      const asOf = tag.versus.tick ?? tick, v = W.versus(tag.versus.metric, asOf, c.names);
      if (!v) return [];
      const armies = ['army', 'units_lost'].includes(tag.versus.metric);
      const big = v.rows.reduce((a, r) => (r.val > a.val ? r : a), v.rows[0]);
      const fo = tag.versus.focus, cam = armies && fo ? { k: 'grp', sel: { t: 'army', o: fo }, dist: 34, side: side(fo) } : armies ? { k: 'mid', a: { t: 'army', o: 1 }, b: { t: 'army', o: 2 }, side: 1, wide: true } : { k: 'crane', x: B[big.o - 1].x, z: B[big.o - 1].z, side: side(other(big.o)) };
      return [{ f: [0, 1], cam, versus: v, ...(tag.versus.metric === 'army' ? { asOf: { tick: asOf, auto: tag.versus.tick == null } } : {}), marks: tag.versus.metric === 'army' ? [1, 2].map((o) => ({ sel: { t: 'army', o }, o, label: 'ARMY {n}' })) : [] }];
    }
    case 'inset': { // A1 (05.11.): no small map any more. A line about a decision shows the whole map (zoomed out) and leaves the plan cards (#sc0/#sc1) up: not `clean`
      const { player: p, decision: n } = tag.inset;
      return [{ f: [0, 1], cam: { k: 'map' }, tag: { p, text: `${nm[p - 1]}  DECISION ${n}` }, marks: [{ bld: { x: B[p - 1].x, z: B[p - 1].z, size: 3 }, o: p, label: c.names[p - 1] }] }];
    }
    case 'event': return eventParts(W.byId.get(tag.event.id), c, look, bldPart, nm);
    default: return [];
  }
}

function eventParts(e, c, look, bldPart, nm) {
  if (!e) return [];
  const B = c.starts, sz = (t) => BUILDINGS[t]?.size || 3, tx = (l, t) => ({ x: l[0] + sz(t) / 2, z: l[1] + sz(t) / 2 });
  switch (e.type) {
    case 'key_building': { const q = tx(e.loc, e.building); return [bldPart(e.p, e.building, q.x, q.z, sz(e.building))]; }
    case 'expansion': { const q = tx(e.loc, 'town_center'); return [bldPart(e.p, 'town_center', q.x, q.z, 4, 'EXPANSION')]; }
    case 'tier_up': return [bldPart(e.p, 'town_center', B[e.p - 1].x, B[e.p - 1].z, 3, `TIER ${e.tier}`)];
    case 'building_destroyed': case 'base_destroyed': {
      const type = e.type === 'base_destroyed' ? 'town_center' : e.building, loc = e.loc ? { x: e.loc[0], z: e.loc[1] } : { x: B[e.p - 1].x, z: B[e.p - 1].z };
      const by = e.by && e.src && UNITS[e.src] ? [{ sel: { t: 'type', o: e.by, ty: e.src, near: [loc.x, loc.z, 25] }, o: e.by, label: up(e.src) }] : [];
      const part = bldPart(e.p, type, loc.x, loc.z, sz(type), `${up(type)} FALLS`, 34, 20);
      return [{ ...part, marks: [...part.marks, ...by] }];
    }
    case 'first_contact': {
      const loc = e.loc ? { x: e.loc[0], z: e.loc[1] } : B[e.other - 1];
      const what = UNITS[e.what] ? [{ sel: { t: 'type', o: e.other, ty: e.what, near: [loc.x, loc.z, 18] }, o: e.other, label: up(e.what) }] : BUILDINGS[e.what] ? [{ bld: { x: loc.x, z: loc.z, size: sz(e.what) }, o: e.other, label: up(e.what) }] : [];
      const scout = c.pre.scouts[e.id];
      return [{ f: [0, 1], cam: { k: 'look', from: e.p, to: loc, ahead: 'to', lateral: e.p === 1 ? -8 : 8, rot: 18, elev: 15, d0: 44, d1: 36, drift: 0, sweep: 6 }, fog: e.p, tag: { p: e.p, text: `${nm[e.p - 1]}'S SCOUT  ENEMY ${up(e.what)} FOUND` }, marks: [...(scout ? [{ sel: { ids: [scout] }, o: e.p, label: 'SCOUT' }] : []), ...what] }];
    }
    case 'battle': {
      const x = e.loc ? e.loc[0] : null, z = e.loc ? e.loc[1] : null, near = (o) => (x == null ? { t: 'army', o } : { t: 'army', o, near: [x, z, 32] });
      // the picture stays on the fight: no side near the spot counts as the spot itself, never as its army far away
      const spot = (o) => (x == null ? { t: 'army', o } : { t: 'at', x, z });
      if (x != null && (process.env.RTS_FIGHTCRANE_IDS || '').split(',').includes(String(e.id))) return [{ f: [0, 1], cam: { k: 'crane', x, z, side: 1 }, tag: { text: 'THE FIGHT' }, marks: [1, 2].map((o) => ({ sel: near(o), o, label: 'ARMY {n}', labelFrom: 3 })) }]; // the fight place itself, close
      return [{ f: [0, 1], cam: { k: 'mid', a: [near(1), spot(1)], b: [near(2), spot(2)], weighted: true, side: 1, minDist: 44 }, tag: { text: 'THE FIGHT' }, marks: [1, 2].map((o) => ({ sel: near(o), o, label: 'ARMY {n}', labelFrom: 3 })) }];
    }
    case 'momentum_swing': {
      const v = c.world.versus('army', e.t, c.names);
      return [{ f: [0, 1], cam: { k: 'mid', a: { t: 'army', o: 1 }, b: { t: 'army', o: 2 }, side: 1, wide: true }, ...(v ? { versus: v } : {}), marks: [1, 2].map((o) => ({ sel: { t: 'army', o }, o, label: 'ARMY {n}' })) }];
    }
    default: return [];
  }
}

// ---------------------------------------------------------------- the show
export class Show {
  // lines: the caster lines with real start/end (output time of the main part), each with an optional `show` tag; beats (optional): the beats of the script, to know the match time of a line
  // returns the parts in time order
  constructor({ rep, ev, lines, names, plan, tl, beats = null, template = false }) {
    this.ev = ev;
    this.names = names;
    this.data = new StoryData(ev);
    const world = this.world = new World(ev);
    this.extra = playerAliases(ev.players || []);
    const tickOf = (l) => { const b = beats && beats.find((x) => x.id === l.beat); return b ? b.tick_end : ev.ticks; };
    const sorted = [...lines].sort((a, b) => a.start - b.start);
    // 1. the tags of every line: its own (validated against the log) or, when it has none that is valid, what the generic inferrer reads from the text
    const res = sorted.map((l) => {
      const tick = tickOf(l), v = validateShow(l.show, world, tick), text = String(l.text);
      let tags = v.tags.map((tag, i) => {
        let ci = tag.at ? text.toLowerCase().indexOf(tag.at.toLowerCase()) : -1;
        if (ci < 0) ci = Math.floor((i / v.tags.length) * text.length);
        return { tag, ci };
      }), source = 'tag';
      if (!tags.length) { tags = inferShow(text, world, { names, tick, extra: this.extra }).map((q) => ({ tag: q.tag, ci: Math.floor(q.at * text.length) })); source = tags.length ? 'inferred' : 'none'; }
      tags.sort((a, b) => a.ci - b.ci);
      if (tags.length) tags[0].ci = 0;
      return { l, tick, tags, source, invalid: v.reasons };
    });
    // 2. what the replay must tell us: the state a model saw (inset), the unit that was the scout of a first contact
    const insets = [], contacts = [];
    for (const r of res) for (const { tag } of r.tags) {
      if (tag.inset) { const d = world.decision(tag.inset.player, tag.inset.decision, r.tick), key = `p${tag.inset.player}d${tag.inset.decision}`; if (d && !insets.some((q) => q.key === key)) insets.push({ key, p: tag.inset.player, tick: d.start_tick }); }
      if (tag.event) { const e = world.byId.get(tag.event.id); if (e && e.type === 'first_contact' && e.loc && !contacts.some((q) => q.id === e.id)) contacts.push({ id: e.id, t: e.t, p: e.p, loc: e.loc }); }
    }
    this.pre = prepass(rep, ev, { insets, contacts });
    const pre = this.pre;
    const c = this.ctx = { starts: pre.starts, names, world, pre, ev };
    this.parts = [];
    this.lineMap = [];
    this.faults = []; // panels that contradict the line: the author of the script fixes them, the render stops
    this.panelsDropped = []; // the same in a template script: nobody can rewrite those lines, so the panel goes and no wrong number reaches the screen
    const pictureAt = (o) => (tl ? Math.floor(tl.tickAt(o)) : Infinity); // the game tick the picture shows at an output time

    // 08.11. (owner): every line has a camera subject, also without an event. A line that names a model and a thing (tier/base, workers, army) goes to exactly that
    // (the model's Landing Core, its workers, its army); a line without a model goes where the most is going on (the stronger army), the whole map only when nothing is going on.
    const SUBJ = process.env.RTS_SUBJCAM !== '0';
    const fightSet0 = new Set((beats || []).filter((b) => b.fight || ['battle', 'razed', 'first_contact', 'base', 'victory'].includes(b.kind)).map((b) => b.id));
    const al0 = names.map((n, i) => [...new Set([...aliasesOfName(n, names), ...((this.extra && this.extra[i]) || [])])].sort((a, b) => b.length - a.length));
    const escRx = (a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const mentioned = (text) => { const low = String(text).replace(/’/g, "'").toLowerCase(), hit = []; al0.forEach((list, i) => { for (const a of list) { const m = new RegExp(`\\b${escRx(a)}(?:'s)?\\b`).exec(low); if (m) { hit.push({ p: i + 1, i: m.index }); break; } } }); return hit.sort((a, b) => a.i - b.i).map((h) => h.p); }; // regex-safe: escRx escapes every alias
    const THING = [['base', /\b(tiers?|tier-up|landing core|home base|its base|upgrade|techs?)\b/], ['workers', /\b(workers?|convoy hands?|hands|gather\w*|wood|stone|timber|miners?)\b/], ['army', /\b(armies|army|units?|gunners?|guards?|riders?|rams?|archers?|cavalry|spearm\w+|soldiers?|troops?|fights?|fighting|attack\w*|waves?|pikes?)\b/]];
    const strongerArmy = (tick) => { const v = world.versus('army', tick, names); const rows = (v && v.rows) || []; const big = rows.reduce((a, r) => (!a || r.val > a.val ? r : a), null); return big && big.val > 0 ? big.o : null; };
    const okTag = (tag, tick) => { const v = validateShow(tag, world, tick); return v.tags[0] || null; };
    const subjTag = (text, tick) => {
      const ms = mentioned(text), low = String(text).toLowerCase();
      let thing = null; for (const [k, rx] of THING) if (rx.test(low)) { thing = k; break; }
      const mk = (p, th) => (th === 'workers' ? { follow: { sel: { t: 'workers', o: p } } } : th === 'army' ? { follow: { sel: { t: 'army', o: p } } } : { place: { base: p } });
      if (ms.length) return okTag(mk(ms[0], thing || 'base'), tick) || okTag(mk(ms[0], 'base'), tick);
      if (/\b(fights?|fighting|battle|clash\w*|feeding the fight)\b/.test(low)) { // a line about the fight: the place of the fight that is going on
        const bt = (ev.events || []).filter((e) => e.type === 'battle' && e.loc && e.t <= tick && tick <= (e.t_end ?? e.t) + 400).sort((x, y) => y.t - x.t)[0];
        if (bt) { const tg = okTag({ place: { x: bt.loc[0], z: bt.loc[1] } }, tick); if (tg) return tg; }
      }
      const big = strongerArmy(tick);
      return big ? (okTag(mk(big, 'army'), tick) || okTag(mk(big, 'base'), tick)) : okTag({ map: {} }, tick);
    };
    const subjParts = (text, tick) => { const tg = subjTag(text, tick); return tg ? tagParts(tg, c, tick).filter((x) => x.cam).map((x) => ({ ...x, f: [0, 1] })) : []; };
    sorted.forEach((l, i) => {
      const r = res[i], next = sorted[i + 1], prev = sorted[i - 1];
      const t0 = l.start - (prev && prev.end > l.start - LEAD ? 0.2 : LEAD), t1 = next ? Math.max(l.end + 0.3, next.start - LEAD + 0.1) : l.end + 0.5;
      const span = (t1 - t0), text = String(l.text);
      // where in the line (as a fraction of the output window) a tag starts: the cue that holds its first character
      const fracOf = (ci) => {
        if (ci <= 0) return 0;
        let off = 0;
        for (const q of l.cues || []) {
          const len = String(q.text).length + 1;
          if (ci < off + len) return clamp01((q.s0 + ((ci - off) / len) * (q.s1 - q.s0) - 0.45 - t0) / span);
          off += len;
        }
        return clamp01(ci / Math.max(1, text.length));
      };
      const ps = [];
      r.tags.forEach(({ tag, ci }, k) => {
        const lo = k === 0 ? 0 : fracOf(ci), hi = k === r.tags.length - 1 ? 1 : fracOf(r.tags[k + 1].ci);
        for (const q of tagParts(tag, c, r.tick).filter((x) => x.cam || x.fog || x.marks || x.versus || x.inset || x.tag)) ps.push({ ...q, ...(process.env.RTS_EVSUBJ === '1' && tag.event ? { evt: true, evT: world.byId.get(tag.event.id)?.t, evType: world.byId.get(tag.event.id)?.type } : {}), f: [lo + q.f[0] * (hi - lo), lo + q.f[1] * (hi - lo)] });
      });

      const onlyMap = r.tags.length > 0 && r.tags.every((t) => t.tag.map && !t.tag.map.cards) && l.start > 25 && mentioned(text).length === 1; // a plain whole map on a line about one model: that model's subject instead (whole map only where nothing is going on)
      if (SUBJ && !fightSet0.has(l.beat) && !r.tags.some((t) => t.tag.event || t.tag.inset || (t.tag.map && !onlyMap) || t.tag.fog || t.tag.view || t.tag.follow || t.tag.building || t.tag.place)) {
        const alt = subjParts(text, r.tick);
        if (alt.length) {
          const own = (l.end - l.start) >= 2.8 && mentioned(text).length === 1 && !(process.env.RTS_NOSUBJ_LINES || '').split(',').includes(l.id);   // 08.11.: a line of 3 s or more keeps its own subject shot (shorter lines stand in the shot of their answer)
          if (!ps.length) ps.push(...alt.map((x) => ({ ...x, ...(own ? { subj: true } : {}) })));
          else for (const q of ps) if (q.versus || (q.cam && (q.cam.k === 'mid' || q.cam.k === 'crane' || (onlyMap && q.cam.k === 'map')) && !q.fog && !q.inset)) { q.cam = alt[0].cam; q.marks = alt[0].marks; if (!q.versus) q.tag = alt[0].tag; if (own) q.subj = true; }
        }
      }
      if (SUBJ && (l.end - l.start) >= 2.8 && !fightSet0.has(l.beat) && mentioned(text).length === 1 && !(process.env.RTS_NOSUBJ_LINES || '').split(',').includes(l.id)) for (const q of ps) if (q.cam && (q.cam.k === 'grp' || q.cam.k === 'bld') && !q.evt && !q.fog && !q.inset) q.subj = true; // the own subject shot of a line of 2.8 s or more (follow, building, base) is not merged into its neighbour
      ps.forEach((p, k) => {
        const o0 = t0 + p.f[0] * span, o1 = t0 + p.f[1] * span;
        const part = { ...p, line: l.id, key: `${l.id}.${k}`, o0: +o0.toFixed(3), o1: +o1.toFixed(3) };
        if (p.asOf) { // a comparison panel never runs ahead of the picture: without its own clock it shows the moment the picture has reached when the part ends
          const seen = pictureAt(o1), tick = p.asOf.auto ? Math.min(p.asOf.tick, seen) : p.asOf.tick;
          part.asOf = { ...p.asOf, tick, seen };
          part.versus = world.versus('army', tick, names) || p.versus;
          const faults = panelFaults({ line: l.id, text, rows: part.versus.rows, tick, seen });
          if (faults.length && template) { delete part.versus; delete part.asOf; this.panelsDropped.push(...faults); } else this.faults.push(...faults);
        }
        this.parts.push(part);
      });
      this.lineMap.push({ id: l.id, text: l.text, start: l.start, end: l.end, parts: ps.length, source: r.source, tags: r.tags.map((q) => q.tag), invalid: r.invalid });
    });
    this.parts.sort((a, b) => a.o0 - b.o0);
    // 07.11. (owner): a shot lasts at least 4 s (special views: fog, view, decision, whole map: 6 s), except in the fights. A short shot is lengthened by taking in the
    // parts after it (same side, no panel); a line without a motive of its own keeps the previous shot. Equal neighbours (same camera, same chip) are one shot.
    {
      const MIN_SHOT = +(process.env.RTS_MIN_SHOT || 4.25), MIN_SPECIAL = +(process.env.RTS_MIN_SPECIAL || 6.25);
      const fightBeat = new Set((beats || []).filter((b) => b.fight || ['battle', 'razed', 'first_contact', 'base', 'victory'].includes(b.kind)).map((b) => b.id));
      const beatOf = new Map(lines.map((l) => [l.id, l.beat]));
      const inFight = (q) => fightBeat.has(beatOf.get(q.line));
      const freezeBeat = new Set((beats || []).filter((b) => b.freeze && b.kind === 'compare').map((b) => b.id)); // only the tier race table must stay in the picture
      const frozen = (q) => freezeBeat.has(beatOf.get(q.line));
      const special = (q) => !!(q.fog || q.inset || (q.cam && q.cam.k === 'map') || /VIEW|DECISION|FOG|WHOLE MAP/.test(String(q.tag?.text ?? q.tag ?? '')));
      const panel = (q) => !!(q.versus || q.inset || q.asOf);
      const sideOf = (q) => q.tag?.p ?? q.fog ?? null;
      const compatible = (a, b) => { const x = sideOf(a), y = sideOf(b); return x == null || y == null || x === y; };
      const droppable = (q) => !panel(q) && !inFight(q) && !frozen(q) && !q.evt && !q.subj; // 08.11.: the camera part of an event line (show tag "event") is never merged away (Koordinator 13:25 c)
      const sameShot = (a, b) => !panel(b) && JSON.stringify([a.cam, a.tag, a.fog, a.clean]) === JSON.stringify([b.cam, b.tag, b.fog, b.clean]) && b.o0 - a.o1 < 0.45;
      this.parts.forEach((q) => { q.cmp = frozen(q); });
      let k = 0;
      while (k < this.parts.length) {
        const q = this.parts[k];
        const nx = this.parts[k + 1];
        if (nx && sameShot(q, nx)) { q.o1 = Math.max(q.o1, nx.o1); this.parts.splice(k + 1, 1); continue; }
        const need = special(q) ? MIN_SPECIAL : MIN_SHOT;
        { const cap = nx ? (q.clean && frozen(nx) ? nx.o0 - 4.5 : nx.o0) : Infinity; if (!inFight(q) && !(q.clean && frozen(q)) && q.o1 - Math.max(q.o0, 0) < need && cap - q.o1 > 0.05) q.o1 = +Math.min(cap, Math.max(q.o0, 0) + need).toFixed(3); } // a gap behind it: the shot (and its chip) simply stays; before the tier race table a clean shot stops 4.5 s ahead of its line
        const endOf = () => { const n2 = this.parts[k + 1]; return n2 && n2.o0 - q.o1 <= 6 ? n2.o0 : q.o1; }; // the camera holds a shot until the next part only over gaps up to 6 s
        if (inFight(q) || Math.max(endOf(), q.o1) - Math.max(q.o0, 0) >= need) { k++; continue; }
        while (this.parts[k + 1] && Math.max(endOf(), q.o1) - Math.max(q.o0, 0) < need && droppable(this.parts[k + 1]) && (special(q) || (!special(this.parts[k + 1]) && compatible(q, this.parts[k + 1]))) && !inFight(this.parts[k + 1])) { q.o1 = Math.max(q.o1, this.parts[k + 1].o1); this.parts.splice(k + 1, 1); }
        if (Math.max(endOf(), q.o1) - Math.max(q.o0, 0) < need && k > 0 && droppable(q) && !special(q) && compatible(this.parts[k - 1], q)) { this.parts[k - 1].o1 = Math.max(this.parts[k - 1].o1, q.o1); this.parts.splice(k, 1); continue; }
        if (Math.max(endOf(), q.o1) - Math.max(q.o0, 0) < need && !special(q) && !inFight(q) && droppable(q) && this.parts[k + 1] && droppable(this.parts[k + 1]) && !inFight(this.parts[k + 1])) { // two sides alternate too fast: one wide shot of both bases carries them (neutral chip, no wrong side)
          const mp = tagParts({ map: {} }, c, 0).find((x) => x.cam);
          if (mp) {
            Object.assign(q, { cam: mp.cam, tag: mp.tag, marks: mp.marks, clean: false }); delete q.fog; delete q.versus; delete q.inset;
            while (this.parts[k + 1] && Math.max(endOf(), q.o1) - Math.max(q.o0, 0) < need && droppable(this.parts[k + 1]) && !inFight(this.parts[k + 1])) { q.o1 = Math.max(q.o1, this.parts[k + 1].o1); this.parts.splice(k + 1, 1); }
          }
        }
        { // still short: a special view after it takes over its time (same side), or a special view takes over the short shot before it
          const nz = this.parts[k + 1], pv = this.parts[k - 1];
          if (Math.max(endOf(), q.o1) - Math.max(q.o0, 0) < need && !special(q) && nz && special(nz) && droppable(q) && compatible(q, nz) && !panel(nz)) { nz.o0 = q.o0; this.parts.splice(k, 1); continue; }
          if (Math.max(endOf(), q.o1) - Math.max(q.o0, 0) < need && special(q) && pv && droppable(pv) && !special(pv) && (pv.o1 - pv.o0) + (q.o1 - q.o0) >= need && Math.abs(pv.o1 - q.o0) < 0.5) { q.o0 = pv.o0; this.parts.splice(k - 1, 1); continue; }
        }
        { // still short: start it a little early (at most 1.5 s, a special view 4 s) with the time the shot before has to spare
          const prv = this.parts[k - 1], deficit = need - (Math.max(endOf(), q.o1) - Math.max(q.o0, 0));
          if (prv && deficit > 0 && !inFight(prv) && !inFight(q) && (!frozen(prv) || !q.clean) && prv.o1 >= q.o0 - 0.05) {
            const spare = (prv.o1 - Math.max(prv.o0, 0)) - ((special(prv) ? MIN_SPECIAL : MIN_SHOT) - 0.2), d = Math.min(deficit, special(q) ? 4 : 1.5, Math.max(0, spare));
            if (d > 0.05) { q.o0 = +(q.o0 - d).toFixed(3); prv.o1 = q.o0; }
          } else if (prv && deficit > 0 && !inFight(q) && !(q.clean && frozen(q)) && prv.o1 < q.o0 - 0.05) { // a gap before it that the camera does not hold: the shot may start early inside the gap
            const d = Math.min(deficit, special(q) ? 4 : 1.5, q.o0 - prv.o1);
            if (d > 0.05) q.o0 = +(q.o0 - d).toFixed(3);
          }
        }
        { // still a little short: the part after it, if it has time to spare, starts a little later (at most 0.8 s)
          const nz = this.parts[k + 1], left = need - (q.o1 - Math.max(q.o0, 0));
          if (nz && left > 0.01 && left <= 0.8 && Math.abs(nz.o0 - q.o1) < 0.05 && !inFight(q) && !inFight(nz) && !panel(nz) && !(q.clean && frozen(q)) && (nz.o1 - nz.o0) - left >= (special(nz) ? 6.05 : 4.05)) { q.o1 = +(q.o1 + left).toFixed(3); nz.o0 = q.o1; }
        }
        k++;
      }
      // last pass over everything: a part still under its minimum borrows time from the part after it (not a panel by more than 0.5 s), or, if it is no panel, from the part before it
      for (let pass = 0; pass < 3; pass++) for (let j = 0; j < this.parts.length; j++) {
        const q = this.parts[j], nz = this.parts[j + 1], pv = this.parts[j - 1];
        if (inFight(q) || (q.clean && frozen(q))) continue;
        const effEnd = nz && nz.o0 - q.o1 <= 6 ? nz.o0 : q.o1, need = special(q) ? 6.1 : 4.05;
        let deficit = need - (effEnd - Math.max(q.o0, 0));
        if (deficit <= 0.02) continue;
        if (process.env.RTS_DBG_SHOW && special(q)) console.error('DBG-SHOW', j, q.line, q.o0, q.o1, 'deficit', deficit.toFixed(2), 'nz', nz && [nz.line, nz.o0, nz.o1, inFight(nz), frozen(nz), panel(nz)], 'nn', this.parts[j + 2] && [this.parts[j + 2].line, inFight(this.parts[j + 2]), frozen(this.parts[j + 2]), panel(this.parts[j + 2])]);
        if (nz && Math.abs(nz.o0 - q.o1) < 0.05 && !inFight(nz) && !(q.clean && frozen(nz))) {
          const spare = (nz.o1 - nz.o0) - (special(nz) ? 6.1 : 4.05), d = Math.min(deficit, spare, panel(nz) ? 0.5 : 3);
          if (d > 0.02) { q.o1 = +(q.o1 + d).toFixed(3); nz.o0 = q.o1; deficit -= d; }
        }
        // 08.11. cascade: the next part cannot give time, but the one after it can: move both boundaries later (the middle part keeps its length)
        if (deficit > 0.02 && nz && Math.abs(nz.o0 - q.o1) < 0.5 && !inFight(nz) && !(q.clean && frozen(nz))) {
          const nn = this.parts[j + 2];
          if (nn && Math.abs(nn.o0 - nz.o1) < 0.5 && !inFight(nn) && !frozen(nn) && !panel(nn)) {
            const need2 = need - (nz.o0 - Math.max(q.o0, 0)), spare = (nn.o1 - nn.o0) - (special(nn) ? 6.1 : 4.05), d = Math.min(need2, spare, 3);
            if (d > 0.02) { q.o1 = +(nz.o0 + d).toFixed(3); nz.o0 = q.o1; nz.o1 = +(nz.o1 + d).toFixed(3); nn.o0 = nz.o1; deficit = 0; }
          }
        }
        if (deficit > 0.02 && !panel(q) && pv && Math.abs(pv.o1 - q.o0) < 0.05 && !inFight(pv) && !frozen(pv) && !panel(pv)) {
          const spare = (pv.o1 - pv.o0) - (special(pv) ? 6.1 : 4.05), d = Math.min(deficit, spare, 3);
          if (d > 0.02) { q.o0 = +(q.o0 - d).toFixed(3); pv.o1 = q.o0; }
        }
      }
      // 08.11. (Koordinator 14:53): a falling building is on screen from 1.5 s before it falls (the shot starts earlier, taking the time from the shot before it)
      if (process.env.RTS_EVSUBJ === '1' && tl) for (let j = 1; j < this.parts.length; j++) {
        const q = this.parts[j], pv = this.parts[j - 1];
        if (process.env.RTS_DBG_EVT && q.evt) console.error('DBG-EVT', q.line, q.o0, q.evT, q.evType, !!tl);
        if (!q.evt || q.evT == null || !['building_destroyed', 'base_destroyed'].includes(q.evType) || panel(q)) continue;
        const want = tl.outAt(q.evT) - 3.5; // 1.5 s before the fall plus the flight of the camera
        if (!(want < q.o0 - 0.05) || q.o0 - want > 4 || Math.abs(pv.o1 - q.o0) > 0.5 || panel(pv)) continue;
        const spare = (pv.o1 - Math.max(pv.o0, 0)) - (inFight(pv) ? 1.5 : special(pv) ? 6.1 : 4.05), d = Math.min(q.o0 - want, Math.max(0, spare));
        if (d > 0.05) { q.o0 = +(q.o0 - d).toFixed(3); pv.o1 = q.o0; }
      }
    }
    // a far flight (two bases are about 120 tiles apart, a flight takes about 3.5 s) starts earlier, so the camera has arrived when the line is spoken
    const where = (p) => { const c = p.cam; if (!c) return null; if (c.k === 'bld' && Number.isFinite(c.x)) return [c.x, c.z]; if (c.k === 'look') return [pre.starts[c.from - 1].x, pre.starts[c.from - 1].z]; const sel = Array.isArray(c.sel) ? c.sel[0] : c.sel; if (c.k === 'grp' && sel && sel.o) return [pre.starts[sel.o - 1].x, pre.starts[sel.o - 1].z]; if (c.k === 'crane') return [c.x, c.z]; if (c.k === 'mid') return [(pre.starts[0].x + pre.starts[1].x) / 2, (pre.starts[0].z + pre.starts[1].z) / 2]; return null; };
    this.parts.sort((a, b) => a.o0 - b.o0);
    for (let i = 1; i < this.parts.length; i++) {
      const a = this.parts[i - 1], b = this.parts[i], pa = where(a), pb = where(b);
      if (!pa || !pb || Math.abs(a.o1 - b.o0) > 0.5) continue;
      const far = Math.hypot(pa[0] - pb[0], pa[1] - pb[1]);
      if (far < 50) continue;
      let shift = Math.min(0.4 * (a.o1 - a.o0), (far / 100) * 2.0);
      { const keep = (a.cam === 'map' || /VIEW|DECISION|FOG|WHOLE MAP/.test(String(a.tag?.text ?? a.tag ?? ''))) ? 6.05 : 4.05; shift = Math.min(shift, Math.max(0, b.o0 - a.o0 - keep)); } // the flight must not cut the shot before it under its minimum
      b.o0 = +(b.o0 - shift).toFixed(3); a.o1 = b.o0;
    }
    // no gaps: the camera holds its shot until the next part starts (a gap would hand the camera to the old subject logic and send it on a detour);
    // only a long stretch (the fights, the end) is left to the normal director
    for (let i = 0; i + 1 < this.parts.length; i++) { const a = this.parts[i], b = this.parts[i + 1], gap = b.o0 - a.o1; if (gap > 0 && gap <= 6 && !(a.clean && b.cmp)) { if (!(a.clean && b.clean)) a.tEnd = a.o1; a.o1 = b.o0; } }
    // parts never overlap: a part ends where the next one starts
    for (let i = 0; i + 1 < this.parts.length; i++) if (this.parts[i].o1 > this.parts[i + 1].o0) this.parts[i].o1 = this.parts[i + 1].o0;
    { // 07.11. second minimum pass AFTER the flights and the gap closing, which move part borders again (HC-3: decision view 5.0 s, whole map 5.7 s)
      const fightBeat2 = new Set((beats || []).filter((b) => b.fight || ['battle', 'razed', 'first_contact', 'base', 'victory'].includes(b.kind)).map((b) => b.id));
      const beatOf2 = new Map(lines.map((l) => [l.id, l.beat]));
      const freezeBeat2 = new Set((beats || []).filter((b) => b.freeze && b.kind === 'compare').map((b) => b.id));
      const inFight = (q) => fightBeat2.has(beatOf2.get(q.line)), frozen = (q) => freezeBeat2.has(beatOf2.get(q.line));
      const special = (q) => !!(q.fog || q.inset || (q.cam && q.cam.k === 'map') || /VIEW|DECISION|FOG|WHOLE MAP/.test(String(q.tag?.text ?? q.tag ?? '')));
      const panel = (q) => !!(q.versus || q.inset || q.asOf);
      for (let pass = 0; pass < 3; pass++) for (let j = 0; j < this.parts.length; j++) {
        const q = this.parts[j], nz = this.parts[j + 1], pv = this.parts[j - 1];
        if (inFight(q) || (q.clean && frozen(q))) continue;
        const effEnd = nz && nz.o0 - q.o1 <= 6 ? nz.o0 : q.o1, need = special(q) ? 6.15 : 4.1;
        let deficit = need - (effEnd - Math.max(q.o0, 0));
        if (deficit <= 0.02) continue;
        if (nz && Math.abs(nz.o0 - q.o1) < 0.05 && !inFight(nz) && !(q.clean && frozen(nz))) {
          const spare = (nz.o1 - nz.o0) - (special(nz) ? 6.01 : 4.01), d = Math.min(deficit, spare, panel(nz) ? 0.5 : 3);
          if (d > 0.02) { q.o1 = +(q.o1 + d).toFixed(3); nz.o0 = q.o1; deficit -= d; }
        }
        if (deficit > 0.02 && !panel(q) && pv && Math.abs(pv.o1 - q.o0) < 0.05 && !inFight(pv) && !frozen(pv) && !panel(pv)) {
          const spare = (pv.o1 - pv.o0) - (special(pv) ? 6.01 : 4.01), d = Math.min(deficit, spare, 3);
          if (d > 0.02) { q.o0 = +(q.o0 - d).toFixed(3); pv.o1 = q.o0; }
        }
      }
    }

    // 08.11. (owner): no shot is longer than 10 s (special views: map, fog, decision: 12 s). A longer shot is cut into equal pieces; every second piece goes to another
    // subject of the same model (its base, army or workers) or, for a generic shot, to where the most is going on. The shot key is the one G8 uses: camera kind + chip text.
    if (process.env.RTS_CAP !== '0') {
      const CAP = +(process.env.RTS_CAP_S || 10), CAPS = +(process.env.RTS_CAP_SPECIAL || 12);
      const fightB = new Set((beats || []).filter((b) => b.fight || ['battle', 'razed', 'first_contact', 'base', 'victory'].includes(b.kind)).map((b) => b.id));
      const beatOfC = new Map(lines.map((l) => [l.id, l.beat]));
      const freezeB = new Set((beats || []).filter((b) => b.freeze && b.kind === 'compare').map((b) => b.id));
      const kOf = (q) => `${q.cam && q.cam.k}|${q.tag?.text ?? q.tag ?? ''}`;
      const isSp = (q) => !!(q.fog || q.inset || (q.cam && q.cam.k === 'map') || /VIEW|DECISION|FOG|WHOLE MAP/.test(String(q.tag?.text ?? q.tag ?? '')));
      const locked = (q) => fightB.has(beatOfC.get(q.line)) || (q.clean && freezeB.has(beatOfC.get(q.line)));
      const hasEv = (q, a, b) => !!(q.evt && q.evT != null && tl && a - 0.3 <= tl.outAt(q.evT) && tl.outAt(q.evT) <= b + 0.3); // the piece that shows the event keeps its camera
      const pic = (o) => (tl ? Math.floor(tl.tickAt(o)) : Infinity);
      const startsC = this.pre.starts;
      const altTag = (q, tick) => {
        const cm = q.cam || {}, sel = Array.isArray(cm.sel) ? cm.sel[0] : cm.sel, ow = q.tag?.p ?? (sel && sel.o) ?? null;
        const mk = (p, th) => (th === 'workers' ? { follow: { sel: { t: 'workers', o: p } } } : th === 'army' ? { follow: { sel: { t: 'army', o: p } } } : { place: { base: p } });
        const cand = [];
        if (cm.k === 'grp' && sel && sel.o) cand.push(mk(sel.o, 'base'), mk(sel.o, sel.t === 'army' ? 'workers' : 'army'));
        else if (cm.k === 'bld' && ow && Math.abs(cm.x - startsC[ow - 1].x) < 1 && Math.abs(cm.z - startsC[ow - 1].z) < 1) cand.push(mk(ow, 'army'), mk(ow, 'workers'));
        else if (cm.k === 'bld' && ow) cand.push(mk(ow, 'base'), mk(ow, 'army'));
        const big = strongerArmy(tick); if (big) cand.push(mk(big, 'army'), mk(big, 'base'));
        cand.push(mk(1, 'base'), mk(2, 'base'), { map: {} });
        for (const t of cand) { const tg = okTag(t, tick); if (!tg) continue; const ps2 = tagParts(tg, c, tick).filter((x) => x.cam); if (ps2.length && kOf(ps2[0]) !== kOf(q)) return ps2[0]; }
        return null;
      };
      // the piece that replaces a part of a long shot shows what the line spoken at that time is about (its model and thing), else another subject of the same model
      const altFor = (q, a, b) => {
        let best = null, bo = 0; for (const l of sorted) { const o = Math.min(b, l.end) - Math.max(a, l.start); if (o > bo) { bo = o; best = l; } }
        if (best && !fightB.has(best.beat)) { const tg = subjTag(best.text, pic((a + b) / 2)); if (tg) { const p2 = tagParts(tg, c, pic((a + b) / 2)).filter((x) => x.cam); if (p2.length && kOf(p2[0]) !== kOf(q)) return p2[0]; } }
        return altTag(q, pic((a + b) / 2));
      };
      const shots = [];
      for (const q of this.parts) { const sh = shots[shots.length - 1]; if (sh && sh.key === kOf(q) && q.o0 <= sh.o1 + 0.3) { sh.o1 = Math.max(sh.o1, q.o1); sh.parts.push(q); } else shots.push({ key: kOf(q), o0: q.o0, o1: q.o1, parts: [q] }); }
      const outP = [];
      for (const sh of shots) {
        const st = Math.max(sh.o0, 0), d = sh.o1 - st, sp = isSp(sh.parts[0]), plainMap = String(sh.parts[0].tag?.text ?? sh.parts[0].tag ?? '') === 'THE WHOLE MAP' && sh.parts[0].cam && sh.parts[0].cam.k === 'map' && st > 25, lim = plainMap ? 10 : sp ? CAPS : CAP; // the whole map only where nothing is going on: 8 s (the intro map 12 s)
        if (d <= lim || sh.parts.every(locked)) { outP.push(...sh.parts); continue; }
        const wins = sh.parts.filter((q) => q.evt && q.evT != null && tl).map((q) => [tl.outAt(q.evT) - 3.5, tl.outAt(q.evT) + 0.5]).sort((x, y) => x[0] - y[0]);
        if (wins.length >= 2 && sh.parts.every((q) => !locked(q))) {   // several events in one shot: the other subject goes into the largest gap between the event windows
          let best = null, prevEnd = st; for (const w of [...wins, [sh.o1, sh.o1]]) { const gs = Math.max(prevEnd, st), ge = Math.min(w[0], sh.o1); if (ge - gs >= 4.3 && (!best || ge - gs > best[1] - best[0])) best = [gs, ge]; prevEnd = Math.max(prevEnd, w[1]); }
          if (best) {
            const mid = (best[0] + best[1]) / 2, half = Math.min((best[1] - best[0]) / 2 - 0.1, 3.2), A0 = mid - half, A1 = mid + half, al = altFor(sh.parts[0], A0, A1);
            if (al && A1 - A0 >= 4.1) {
              for (const q of sh.parts) {
                const cuts = [q.o0, ...[A0, A1].filter((t) => t > q.o0 + 0.2 && t < q.o1 - 0.2), q.o1];
                for (let u = 0; u + 1 < cuts.length; u++) { const a_ = cuts[u], b_ = cuts[u + 1], inAlt = (a_ + b_) / 2 > A0 && (a_ + b_) / 2 < A1; const piece = { ...q, o0: +a_.toFixed(3), o1: +b_.toFixed(3), key: `${q.key}g${u}` }; if (inAlt) { piece.cam = al.cam; piece.marks = al.marks; piece.tag = al.tag; piece.clean = al.clean; delete piece.evt; delete piece.fog; delete piece.inset; delete piece.tEnd; } outP.push(piece); }
              }
              continue;
            }
          }
        }
        if (process.env.RTS_DBG_CAP) console.error('DBG-CAP', sh.key, st.toFixed(1), sh.o1.toFixed(1), 'wins', JSON.stringify(wins.map((w) => w.map((x) => +x.toFixed(1)))), sh.parts.map((q) => q.line + ':' + (q.evt ? 'E' : '-') + (locked(q) ? 'L' : '')).join(','));
        const n = Math.ceil(d / (lim - 1.0)), L = d / n, altOf = new Map();   // margin: the minimum passes after this one may lengthen a piece by up to about a second
        const evIn = (k) => sh.parts.some((q) => hasEv(q, Math.max(q.o0, st + k * L), Math.min(q.o1, st + (k + 1) * L)) && q.o0 < st + (k + 1) * L && q.o1 > st + k * L);
        let par = 1; { const okp = (pp) => { for (let k = 0; k < n; k++) if (k % 2 === pp && k > 0 - (pp === 0 ? 1 : 0) && !evIn(k)) return true; return false; }; if (!okp(1) && okp(0)) par = 0; }
        for (const q of sh.parts) {
          const cuts = [q.o0]; for (let k = 1; k < n; k++) { const t = st + k * L; if (t > q.o0 + 0.2 && t < q.o1 - 0.2) cuts.push(t); } cuts.push(q.o1);
          for (let u = 0; u + 1 < cuts.length; u++) {
            const a = cuts[u], b = cuts[u + 1], idx = Math.min(n - 1, Math.max(0, Math.floor(((a + b) / 2 - st) / L)));
            const piece = { ...q, o0: +a.toFixed(3), o1: +b.toFixed(3), key: `${q.key}c${idx}` };
            if (idx % 2 === par && !locked(q) && !evIn(idx)) {
              if (!altOf.has(idx)) altOf.set(idx, altFor(q, st + idx * L, st + (idx + 1) * L));
              const al = altOf.get(idx);
              if (al) { piece.cam = al.cam; piece.marks = al.marks; piece.tag = al.tag; delete piece.fog; delete piece.inset; delete piece.tEnd; piece.clean = al.clean; if (!q.versus) { delete piece.versus; delete piece.asOf; } }
            }
            outP.push(piece);
          }
        }
      }
      this.parts = outP.sort((a, b) => a.o0 - b.o0);
      for (let i = 0; i + 1 < this.parts.length; i++) if (this.parts[i].o1 > this.parts[i + 1].o0) this.parts[i].o1 = this.parts[i + 1].o0;
      // a new subject can leave a shot under its minimum (4 s, special 6 s): it takes the missing time from the shot after it (or before it) when that one has it to spare
      for (let pass = 0; pass < 30; pass++) {
        const sh2 = [];
        for (const q of this.parts) { const sh = sh2[sh2.length - 1]; if (sh && sh.key === kOf(q) && q.o0 <= sh.o1 + 0.3) { sh.o1 = Math.max(sh.o1, q.o1); sh.parts.push(q); } else sh2.push({ key: kOf(q), o0: q.o0, o1: q.o1, parts: [q] }); }
        let moved = false;
        for (let i = 0; i < sh2.length; i++) {
          const sh = sh2[i], need = isSp(sh.parts[0]) ? 6.1 : 4.05, dur = sh.o1 - Math.max(sh.o0, 0), d = need - dur + 0.02;
          if (d <= 0 || sh.parts.every((q) => fightB.has(beatOfC.get(q.line)))) continue;
          const nx = sh2[i + 1], pv = sh2[i - 1], last = sh.parts[sh.parts.length - 1], first = sh.parts[0];
          if (nx && Math.abs(nx.o0 - sh.o1) < 0.3 && !nx.parts[0].versus && (nx.o1 - nx.o0) - (isSp(nx.parts[0]) ? 6.1 : 4.05) >= d && (nx.parts[0].o1 - nx.parts[0].o0) > d + 0.3) { last.o1 = +(last.o1 + d).toFixed(3); nx.parts[0].o0 = last.o1; moved = true; }
          else if (pv && Math.abs(pv.o1 - sh.o0) < 0.3 && (pv.o1 - pv.o0) - (isSp(pv.parts[0]) ? 6.1 : 4.05) >= d && (pv.parts[pv.parts.length - 1].o1 - pv.parts[pv.parts.length - 1].o0) > d + 0.3) { first.o0 = +(first.o0 - d).toFixed(3); pv.parts[pv.parts.length - 1].o1 = first.o0; moved = true; }
        }
        {   // nobody has time to spare: a shot that is still too short is taken over by the shot before it (that shot stays under its maximum)
          for (let i = 1; i < sh2.length; i++) {
            const sh = sh2[i], pv = sh2[i - 1], need = isSp(sh.parts[0]) ? 6.1 : 4.05;
            if (process.env.RTS_DBG_CAP && sh.o1 - Math.max(sh.o0, 0) < need) console.error('DBG-FB', sh.key, sh.o0.toFixed(1), sh.o1.toFixed(1), 'fight', sh.parts.every((q) => fightB.has(beatOfC.get(q.line))), 'evt/inset', sh.parts.some((q) => q.evt || q.inset), 'gap', Math.abs(pv.o1 - sh.o0).toFixed(2), 'pvinsetfog', pv.parts.some((q) => q.inset || q.fog), 'len', (sh.o1 - pv.o0).toFixed(1), pv.key);
            if (sh.o1 - Math.max(sh.o0, 0) >= need || sh.parts.every((q) => fightB.has(beatOfC.get(q.line))) || sh.parts.some((q) => q.evt || q.inset) || Math.abs(pv.o1 - sh.o0) > 0.3 || pv.parts.some((q) => q.inset || q.fog)) continue;
            if ((sh.o1 - pv.o0) > (isSp(pv.parts[0]) ? CAPS : CAP)) continue;
            const m = pv.parts[pv.parts.length - 1]; for (const q of sh.parts) { q.cam = m.cam; q.tag = m.tag; q.marks = m.marks; q.clean = m.clean; delete q.fog; moved = true; } break;
          }
        }
        if (!moved) break;
      }
    }

    if (process.env.RTS_DBG_SUBJ) for (const id of process.env.RTS_DBG_SUBJ.split(',')) console.error('DBG-SUBJ', id, JSON.stringify(this.parts.filter((q) => q.line === id).map((q) => [q.o0, q.o1, q.cam && q.cam.k, q.tag?.text ?? q.tag, !!q.subj, !!q.versus])), JSON.stringify(res.filter((r_) => r_.l.id === id).map((r_) => [r_.source, r_.tags.map((t_) => Object.keys(t_.tag)[0]), r_.l.start, r_.l.end])));
    // 08.11.: subject lead pass. A line of 2.8 s or more that names one model must show that model for at least half of its time. When the shot of that model
    // starts late inside the line, its start moves earlier (the shot before it gives the time while it stays above its minimum; if not enough, the shot before that gives it too).
    if (SUBJ && process.env.RTS_LEAD !== '0') {
      const NM = names.map((n) => String(n).toUpperCase().split(/[\s\-_.0-9]/)[0]);
      const P = this.parts, startsB = this.pre.starts, fightB3 = new Set((beats || []).filter((b) => b.fight || ['battle', 'razed', 'first_contact', 'base', 'victory'].includes(b.kind)).map((b) => b.id));
      const special3 = (q) => !!(q.fog || q.inset || (q.cam && q.cam.k === 'map') || /VIEW|DECISION|FOG|WHOLE MAP/.test(String(q.tag?.text ?? q.tag ?? '')));
      const minOf = (q) => (special3(q) ? 6.1 : 4.1);
      const hit = (q, pl) => { const tg = String(q.tag?.text ?? q.tag ?? '').toUpperCase(), cm = q.cam || {}, sl = Array.isArray(cm.sel) ? cm.sel[0] : cm.sel; return (tg.includes(NM[pl - 1]) && NM[pl - 1].length > 1) || (sl && sl.o === pl) || (cm.k === 'bld' && Number.isFinite(cm.x) && Math.hypot(cm.x - startsB[pl - 1].x, cm.z - startsB[pl - 1].z) < 4); };
      const shiftEarlier = (j, d, depth) => {
        const q = P[j], pv = P[j - 1];
        if (!pv || Math.abs(pv.o1 - q.o0) > 0.3 || pv.evt || pv.inset || pv.versus || pv.cmp || fightB3.has(beatOfC2.get(pv.line))) return false;
        const spare = (pv.o1 - Math.max(pv.o0, 0)) - minOf(pv);
        if (spare >= d) { q.o0 = +(q.o0 - d).toFixed(3); pv.o1 = q.o0; return true; }
        if (depth < 3 && spare > -5 && shiftEarlier(j - 1, d - Math.max(0, spare), depth + 1)) { q.o0 = +(q.o0 - d).toFixed(3); pv.o1 = q.o0; return true; }
        return false;
      };
      var beatOfC2 = new Map(lines.map((l) => [l.id, l.beat]));
      for (const l of sorted) {
        const dur = l.end - l.start; if (dur < 2.8 || fightB3.has(l.beat)) continue;
        const ms = mentioned(String(l.text)); if (new Set(ms).size !== 1) continue;
        const pl = ms[0], cov = () => P.reduce((a, q) => a + (hit(q, pl) ? Math.max(0, Math.min(q.o1, l.end) - Math.max(q.o0, l.start)) : 0), 0);
        if (cov() >= 0.55 * dur) continue;
        const j = P.findIndex((q) => hit(q, pl) && q.o0 > l.start + 0.05 && q.o0 < l.end - 0.5);
        if (j > 0) { const q = P[j]; const d = Math.min(q.o0 - l.start, 0.58 * dur - cov()); if (d > 0.05) shiftEarlier(j, d + 0.05, 0); }
      }
    }
  }

  partAt(outT) { for (const p of this.parts) if (outT >= p.o0 && outT < p.o1) return p; return null; }

  // what the page needs at this output time: fog, tag, highlights, comparison, inset (null outside the parts)
  at(outT, snap, game = null) {
    const p = this.partAt(outT);
    if (!p || !snap) return null;
    if (p.tEnd != null && outT >= p.tEnd) return null; // only the camera holds after the part; tag, highlights and fog end with it
    const idx = this.parts.indexOf(p), prev = this.parts[idx - 1], next = this.parts[idx + 1];
    // two whole-map parts in a row are one picture: between two lines the dark ground and the cleared panels must not dip, or the game view flashes up
    const oneShot = (q) => q.line === p.line || (q.clean && p.clean);
    const inA = prev && !prev.tEnd && Math.abs(prev.o1 - p.o0) < 0.05 && oneShot(prev) ? 1 : clamp01((outT - p.o0) / FADE);
    const outA = next && !p.tEnd && Math.abs(next.o0 - p.o1) < 0.05 && oneShot(next) ? 1 : clamp01(((p.tEnd ?? p.o1) - outT) / FADE);
    const a = +(inA * outA).toFixed(3);
    // fog veil and banner. A veil is continuous across parts of the same player. Two views of different sides in a row: the first veil fades out and the
    // second in (SWAP each) while the banner changes side (name and colour) in the 2 x SWAP around the cut. The banner itself stays up as long as any fog view runs.
    let fa = 0, view = null;
    if (p.fog) {
      const joined = (x, y) => !!(x && y && x.fog && y.fog && !x.tEnd && Math.abs(x.o1 - y.o0) < 0.05);
      const jp = joined(prev, p), jn = joined(p, next), end = p.tEnd ?? p.o1, sameP = jp && prev.fog === p.fog, sameN = jn && next.fog === p.fog;
      fa = +((sameP ? 1 : clamp01((outT - p.o0) / (jp ? SWAP : FADE))) * (sameN ? 1 : clamp01((end - outT) / (jn ? SWAP : FADE)))).toFixed(3);
      const ba = (jp ? 1 : clamp01((outT - p.o0) / FADE)) * (jn ? 1 : clamp01((end - outT) / FADE));
      const nameOf = (o) => ({ p: o, name: this.names?.[o - 1] ?? `P${o}` });
      let swap = null;
      if (jn && !sameN && end - outT < SWAP) swap = { from: nameOf(p.fog), to: nameOf(next.fog), x: +(0.5 * (1 - (end - outT) / SWAP)).toFixed(3) };
      else if (jp && !sameP && outT - p.o0 < SWAP) swap = { from: nameOf(prev.fog), to: nameOf(p.fog), x: +(0.5 + 0.5 * ((outT - p.o0) / SWAP)).toFixed(3) };
      view = { ...nameOf(p.fog), a: +ba.toFixed(3), swap, seen: game && snap.units && !p.inset ? sightOf(snap, game, p.fog) : null }; // not beside the map of what a model saw when it decided: that count is of another moment (it has its own line)
    }
    const marks = [], labels = [];
    for (const m of p.marks || []) {
      if (m.bld) { marks.push({ k: 'b', x: m.bld.x, z: m.bld.z, o: m.o, r: m.bld.size || 3 }); if (m.label) labels.push({ x: m.bld.x, z: m.bld.z, o: m.o, text: m.label, h: 4.2 }); continue; }
      let us = selectUnits(snap, m.sel);
      // with a player's fog of war on, only what that player can see is marked (a scout reveals the enemy worker through its fog)
      if (p.fog && game) { const vis = game.players[p.fog].vis, W = game.W; us = us.filter((u) => u[1] === p.fog || vis[Math.floor(u[4]) * W + Math.floor(u[3])]); }
      if (!us.length || us.length < (m.minUnits || 0)) continue;
      for (const u of us) marks.push({ k: 'u', x: u[3], z: u[4], o: m.o });
      if (m.label && us.length >= (m.labelFrom || 1)) {
        const [x, z] = labelSpot(us);
        labels.push({ x, z, o: m.o, text: m.label.replace('{n}', String(us.length)), h: 3.2 });
      }
    }
    const inset = p.inset ? this.pre.insets[p.inset] : null;
    return { a, clean: !!p.clean, fog: p.fog ? { p: p.fog, a: fa } : null, view, tag: p.tag || null, marks, labels, versus: p.versus || null, inset: inset ? { key: p.inset, ...inset } : null, line: p.line };
  }
}
