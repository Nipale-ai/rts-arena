// Sound logic shared by the live page (render/audio.mjs, WebAudio) and the offline broadcast mix (tools/audio-mix.mjs):
// snapshot -> sound triggers, deterministic variant / pitch choice, distance shaping, voice limits, tension, ambience weights.
// Pure functions and small classes, no DOM, no WebAudio, no Math.random, no clock: the same snapshots always give the same
// triggers. Sound never feeds back into the sim (this module only reads snapshots).

import { GAITS, TICK_HZ, MIN_SPEED, newState, pickGait, advance, beatsIn, riderScale } from './gait.mjs';
import { themeMelee } from './theme/shot-theme.mjs'; // package C6: the hit sound of a melee type from the theme

export const hash32 = (...v) => { let h = 2166136261 >>> 0; for (const x of v) { h = Math.imul(h ^ (x | 0), 16777619) >>> 0; h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995) >>> 0; } return (h ^ (h >>> 15)) >>> 0; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------------------------------------------------------------- mapping tables
export const GATHER = { // what a stationary worker is doing -> event, period in ticks
  wood: ['chop', 13], gold: ['mine', 15], stone: ['mine', 15], food_node: ['berry_pick', 20], farm: ['farm_hoe', 22], fish: ['fish_splash', 30], build: ['construct_hammer', 17],
};
export const DROP = { food: 'drop_food', wood: 'drop_wood', stone: 'drop_stone', gold: 'drop_gold' };
export const TRAINED = { worker: 'unit_trained_worker', infantry: 'unit_trained_infantry', ranged: 'unit_trained_ranged', cavalry: 'unit_trained_cavalry', siege: 'unit_trained_siege' };
const STONE_B = new Set(['tower', 'wall', 'gate', 'blacksmith', 'town_center', 'siege_workshop', 'castle', 'wonder']);
const NAVAL = new Set(['fishing_boat', 'war_boat', 'transport']);
const BIG_B = new Set(['town_center']);
export const buildingClass = (t) => (BIG_B.has(t) ? 'big' : STONE_B.has(t) ? 'stone' : 'timber');
// The classic clip of a death / place / complete / collapse cue: one place for the director, for the live finale (render/audio.mjs collapseAt) and for the theme sounds of a type
// (render/theme/sound-theme.mjs), which carry this id as their fallback and take their settings from it.
export const unitDeathId = (name, cls) => (name === 'wolf' ? 'death_animal' : cls === 'cavalry' ? 'death_horse' : cls === 'siege' ? 'collapse_small' : 'death_human');
export const collapseId = (name, size) => (name === 'tower' ? 'tower_collapse' : size >= 3 ? 'collapse_large' : 'collapse_small');
export const placeId = (name) => 'place_' + buildingClass(name);
export const completeId = (name) => (name === 'castle' ? 'castle_complete' : 'complete_' + buildingClass(name));
// The type of a row of s.dead: server/spectate.mjs sends the NAME, the lines of the classic director read it as an index of init.units / init.buildings (which gives undefined for a real row: every unit
// death then plays death_human, a tower falls as collapse_small; the classic pin freezes that). A theme sound is looked up by the real name; a caller that hands in the index is read too.
export const typeName = (list, t) => (typeof t === 'string' ? t : list[t]);
// A death or a collapse (what feeds the tension of the music): a themed cue is counted by the classic clip it stands in for (trigger.alt). A tower that falls counts as a collapse, too: the classic
// director never made that cue from a real row (see typeName), but a themed tower collapse does, and it must weigh as much as the collapse_small of the classic tower.
export const isDeathCue = (tr) => { const id = tr.alt || tr.id; return id.startsWith('death') || id.startsWith('collapse') || id === 'tower_collapse'; };
export const EVENT_SOURCES = [ // every sim-facing event type the director reacts to -> the clip ids it may use (checked against the manifest by a test)
  ['unit trained', Object.values(TRAINED)], ['gather', ['chop', 'mine', 'berry_pick', 'farm_hoe', 'fish_splash', 'construct_hammer']], ['tree felled', ['tree_falls']], ['drop-off', Object.values(DROP)],
  ['melee swing', ['hit_sword_flesh', 'hit_sword_shield', 'hit_sword_armour', 'hit_sword_clash', 'hit_spear', 'building_hit_stone', 'building_hit_wood', 'ram_thud_wood', 'ram_thud_stone', 'hunt_hit']],
  ['projectile shot', ['bow_shot', 'javelin_throw', 'catapult_release', 'arrow_whoosh', 'ballista_bolt']], ['projectile landed', ['arrow_hit_flesh', 'arrow_hit_wood', 'arrow_hit_stone', 'catapult_impact']],
  ['unit died', ['death_human', 'death_horse', 'death_animal', 'collapse_small']], ['building died', ['collapse_small', 'collapse_large', 'tower_collapse']],
  ['building placed', ['place_timber', 'place_stone', 'place_big']], ['building built', ['complete_timber', 'complete_stone', 'complete_big']], ['tier', ['fanfare_tier2', 'fanfare_tier3']], ['tech', ['tech_chime']],
  ['alerts', ['alert_base_attack', 'alert_unit_attack', 'alert_building_lost', 'alert_enemy_tier', 'alert_idle_workers', 'alert_pop_cap']], ['wildlife', ['wolf_howl', 'wolf_growl']], ['end', ['sting_victory', 'sting_defeat']],
  ['hoof', ['hoof_light', 'hoof_heavy']],
  ['loops', ['fire_loop', 'forge_loop', 'mill_loop']],
  ['caravan', ['caravan_loop', 'caravan_arrive', 'market_trade']], ['ships', ['ship_wake_loop']], ['market', ['market_loop', 'market_trade']], ['shrines', ['shrine_hum_loop', 'shrine_capture']], ['castle', ['castle_complete']], ['wonder', ['wonder_bell']], ['weather', ['thunder_clap', 'thunder_far']],
['ambient', ['amb_meadow', 'amb_forest', 'amb_shore', 'amb_town', 'amb_battle_bed']], ['music', ['music_calm_1', 'music_calm_2', 'music_tension_1', 'music_tension_2', 'music_battle_1', 'music_battle_2']],
];
// thunder after a lightning flash (render/lightning.mjs): the same cue on the live page and in the broadcast mix
export const thunderCue = (close, n) => ({ id: close ? 'thunder_clap' : 'thunder_far', x: 0, y: 0, vol: close ? 0.9 : 0.7, ent: n, big: true, global: true });
export const thunderDelay = (n) => 0.25 + (hash32(n, 3) % 100) / 100;

// ---------------------------------------------------------------- director: snapshot stream -> triggers
export class SoundDirector {
  // init = the 'init' message of the spectator server (terrain strings, node list, unit / building names and defs)
  constructor(init, opts = {}) {
    this.init = init; this.N = init.size;
    this.units = init.units; this.buildings = init.buildings; this.res = init.resources || ['food', 'wood', 'stone', 'gold'];
    this.cls = (name) => init.unitDefs?.[name]?.cls || 'infantry';
    this.opts = { alerts: opts.alerts || ['base', 'unit', 'building_lost', 'tier', 'idle', 'popcap'], ...opts };
    this.shooters = opts.shooters || null; // theme: a ShooterTable (render/shooter-theme.mjs) that names the shot and hit sound of a shooter type; none = bow and arrow for every shooter, as before
    this.sounds = opts.sounds || null; // theme: a SoundTheme (render/theme/sound-theme.mjs): the event table and the death / place / complete / collapse sound of a type; none = the classic clips, the same triggers as before
    this.nodeAt = new Map();
    for (const n of init.nodes || []) for (let dx = 0; dx < n[4]; dx++) for (let dy = 0; dy < n[4]; dy++) this.nodeAt.set((n[3] + dy) * this.N + n[2] + dx, n[1]);
    this.terr = init.terrain || [];
    this.prevUnits = new Map(); this.prevBld = new Map(); this.prevProj = new Map(); this.prevT = null; this.first = true;
    this.cacheKind = new Map(); this.lastAlert = new Map(); this.idleSince = new Map(); this.lastWolf = -9999; this.doneEnd = false; this.prevPop = {};
    this.farms = []; this.gaits = new Map(); this.riderScale = this.opts.riderScale || riderScale; // gait state of every rider (render/gait.mjs)
    this.rolling = new Map(); // caravans and ships: unit id -> last tick it moved (the rolling / wake loop holds a second over a short stop)
  }
  terrainAt(x, y) { const r = this.terr[Math.floor(y)]; return r ? r[Math.floor(x)] : '#'; }
  gatherKind(x, y) { // nearest thing a stationary worker is working on
    const k = ((x | 0) + ',' + (y | 0));
    if (this.cacheKind.has(k)) return this.cacheKind.get(k);
    let best = null, bd = 99;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const tx = (x | 0) + dx, ty = (y | 0) + dy; if (tx < 0 || ty < 0 || tx >= this.N || ty >= this.N) continue;
      const d = Math.hypot(dx, dy), nd = this.nodeAt.get(ty * this.N + tx);
      let kind = null;
      if (nd) kind = nd === 'gold' ? 'gold' : nd === 'stone' ? 'stone' : nd === 'wood' ? 'wood' : 'food_node';
      else if (this.terrainAt(tx, ty) === 'f') kind = 'wood'; else if (this.terrainAt(tx, ty) === '~' && d > 0.5) kind = 'fish';
      if (kind && d < bd) { bd = d; best = kind; }
    }
    if (!best) for (const f of this.farms) if (Math.hypot(f[0] - x, f[1] - y) < f[2] / 2 + 2) { best = 'farm'; break; }
    this.cacheKind.set(k, best);
    return best;
  }
  // theme profile (render/shooter-theme.mjs) of the shooter of projectile row q: a unit type (q[7] >= 0) or a building (q[8] = its id, looked up in `bld`, a Map id -> row); null = classic
  shooterOf(q, bld) {
    if (!this.shooters) return null;
    if (q[7] >= 0) return this.shooters.get(false, this.units[q[7]]);
    const b = bld.get(q[8]);
    return b ? this.shooters.get(true, this.buildings[b[2]]) : null;
  }
  // [trigger id, extra] of a cue of one type (slot: death, place, complete, collapse; `type` = its name or its index): the theme's own sound of that type, which names the classic clip of the type
  // as its fallback (`alt`), else `classic`, the clip the classic code chose, as it is
  cue(isBuilding, type, slot, classic, extra) {
    const name = typeName(isBuilding ? this.buildings : this.units, type), th = this.sounds && this.sounds.typeSound(isBuilding, name, slot);
    return th ? [th.id, { ...extra, alt: this.classicId(isBuilding, name, slot) }] : [classic, extra];
  }
  // the cue of a building that falls without a snapshot event of its own (the finale of the live page, render/audio.mjs collapseAt): { id, alt? }
  collapseCue(name, size) { const [id, extra] = this.cue(true, name, 'collapse', collapseId(name, size), undefined); return { id, ...extra }; }
  // the classic clip that a cue of this type and slot plays (the template of its theme sound)
  classicId(isBuilding, name, slot) {
    if (!isBuilding) return slot === 'death' ? unitDeathId(name, this.cls(name)) : null;
    return slot === 'place' ? placeId(name) : slot === 'complete' ? completeId(name) : slot === 'collapse' ? collapseId(name, this.init.buildingDefs?.[name]?.size ?? 2) : null;
  }
  // The events a theme adds to the manifest or replaces in it: the file sounds of the shooters (render/shooter-theme.mjs) and the sound theme (event table, sounds of a type).
  // `events` = the classic manifest events; the live engine and the mix merge the result over them, the same table in both.
  // `pack` (the skin has its own sound pack, packOf): the manifest IS the event table of the skin, so the event table of the theme (theme.json event_sounds) is not merged over it; the shot / hit
  // files of the shooters and the sounds of a type (which have their own trigger ids) still are.
  soundEvents(events, { pack = false } = {}) {
    const out = this.shooters ? this.shooters.soundEvents(events) : {};
    if (this.sounds) {
      const o = this.sounds.events(events, (isBuilding, name, slot) => this.classicId(isBuilding, name, slot));
      if (pack) for (const id of this.sounds.eventFiles.keys()) delete o[id];
      Object.assign(out, o);
    }
    return out;
  }
  // returns { triggers, emitters, fighting: [[x,y],...], tick, units_by_owner }
  feed(s) {
    const T = s.t, dt = this.prevT === null ? 1 : Math.max(1, T - this.prevT), out = [], first = this.first;
    const trig = (id, x, y, owner, ent, vol = 1, extra) => out.push({ id, x, y, owner, ent, t: T, vol, ...extra });
    this.farms = [];
    const curB = new Map(); for (const b of s.buildings) { curB.set(b[0], b); if (this.buildings[b[2]] === 'farm') this.farms.push([b[3] + 1, b[4] + 1, 2]); }
    const curU = new Map(); for (const u of s.units) curU.set(u[0], u);
    const bAtTile = (tx, ty) => { for (const b of s.buildings) { const sz = this.init.buildingDefs[this.buildings[b[2]]].size; if (tx >= b[3] - 0.5 && tx <= b[3] + sz + 0.5 && ty >= b[4] - 0.5 && ty <= b[4] + sz + 0.5) return this.buildings[b[2]]; } return null; };
    const fighting = []; let idle = {};
    for (const u of s.units) {
      const [id, owner, ti, x, y, hp, act, tgt, carry, cd] = u, type = this.units[ti], cls = this.cls(type), pu = this.prevUnits.get(id);
      if (act === 4) fighting.push([x, y, owner]);
      if (!pu) { if (!first && owner > 0 && TRAINED[cls] && T > 5) trig(TRAINED[cls], x, y, owner, id, 0.8); if (!first && owner === 0 && type === 'wolf' && T - this.lastWolf > 200) { this.lastWolf = T; trig('wolf_howl', x, y, 0, id, 1, { big: true }); } continue; }
      if (GAITS[type]) this.hoofs(trig, u, pu, type, dt, T);
      const moved = Math.hypot(x - pu[3], y - pu[4]) > 0.045 * dt;
      // melee swing: cooldown restarted
      if (act === 4 && cd > (pu[9] || 0) && cd > 0) {
        const tb = curB.get(tgt), tu = curU.get(tgt), r = hash32(id, T, 11) % 100, n0 = out.length;
        if (type === 'wolf') { if (r < 35) trig('wolf_growl', x, y, 0, id, 0.8); }
        else if (cls === 'siege' && type === 'ram') { const bt = tb ? this.buildings[tb[2]] : 'house'; trig(STONE_B.has(bt) ? 'ram_thud_stone' : 'ram_thud_wood', x, y, owner, id); }
        else if (cls === 'ranged' || type === 'catapult') { /* sound comes with the projectile */ }
        else if (tb) trig(STONE_B.has(this.buildings[tb[2]]) ? 'building_hit_stone' : 'building_hit_wood', x, y, owner, id, 0.9);
        else if (tu && this.units[tu[2]] === 'wolf' && owner > 0 && cls === 'worker') trig('hunt_hit', x, y, owner, id);
        else trig(type === 'spearman' && r < 45 ? 'hit_spear' : r < 58 ? 'hit_sword_flesh' : r < 78 ? 'hit_sword_shield' : r < 94 ? 'hit_sword_armour' : 'hit_sword_clash', x, y, owner, id, cls === 'cavalry' ? 1 : 0.9);
        if (this.shooters) themeMelee(this.shooters, type, out, n0); // theme: the hit sound of this melee type takes the place of the classic one (the classic id stays as `alt`)
      }
      if (act === 2 || act === 3) {
        if (!moved) {
          const kind = act === 3 ? 'build' : this.gatherKind(x, y), g = kind && GATHER[kind];
          if (g) { const ph = (id * 7) % g[1]; if (Math.floor((T + ph) / g[1]) > Math.floor((this.prevT + ph) / g[1])) trig(g[0], x, y, owner, id, 0.8); }
        }
        if ((pu[8] || 0) > 0 && !carry) trig(DROP[this.res[pu[8] - 1]] || 'drop_food', x, y, owner, id, 0.8);
      }
      if (act === 0 && cls === 'worker' && owner > 0) idle[owner] = (idle[owner] || 0) + 1;
    }
    // projectiles: new = shot, gone = landed
    const keyOf = (q) => q[2] + ',' + q[3] + ',' + q[4];
    const curP = new Map(); for (const q of s.proj) { const k = keyOf(q); (curP.get(k) || curP.set(k, []).get(k)).push(q); }
    for (const [k, list] of curP) { const pl = this.prevProj.get(k)?.length || 0; for (let i = pl; i < list.length; i++) { const q = list[i], big = q[6] === 1, d = Math.hypot(q[2] - q[0], q[3] - q[1]); if (big) trig('catapult_release', q[0], q[1], q[4], hash32(q[0] * 10, q[1] * 10), 1); else { const th = this.shooterOf(q, curB); if (th && th.shotSound) trig(th.shotSound, q[0], q[1], q[4], hash32(Math.round(q[0] * 10), T), 0.8, { alt: 'bow_shot' }); /* theme: its own shot sound, no whoosh */ else { const r = hash32(Math.round(q[0] * 10), Math.round(q[1] * 10), T) % 100; trig(r < 12 ? 'javelin_throw' : 'bow_shot', q[0], q[1], q[4], hash32(Math.round(q[0] * 10), T), 0.8); if (d > 6 && r > 60) trig('arrow_whoosh', q[0], q[1], q[4], hash32(Math.round(q[1] * 10), T), 0.5); } } } }
    for (const [k, list] of this.prevProj) { const cl = curP.get(k)?.length || 0; for (let i = cl; i < list.length; i++) { const q = list[i]; if (q[6] === 1) trig('catapult_impact', q[2], q[3], q[4], hash32(Math.round(q[2] * 10), T), 1); else { const bt = bAtTile(q[2], q[3]), cl = bt ? (STONE_B.has(bt) ? 'arrow_hit_stone' : 'arrow_hit_wood') : 'arrow_hit_flesh', th = this.shooterOf(q, this.prevBld); if (th && th.hitSound) trig(th.hitSound, q[2], q[3], q[4], hash32(Math.round(q[3] * 10), T), 0.8, { alt: cl }); else trig(cl, q[2], q[3], q[4], hash32(Math.round(q[3] * 10), T), 0.8); } } }
    // deaths
    for (const d of s.dead || []) {
      const [kind, owner, type, x, y, size] = d;
      if (kind === 1) { const name = this.units[type], [cid, ex] = this.cue(false, type, 'death', unitDeathId(name, this.cls(name))), c = ex ? this.cls(typeName(this.units, type)) : this.cls(name); trig(cid, x, y, owner, hash32(Math.round(x * 10), Math.round(y * 10)), c === 'siege' ? 0.7 : 1, ex); }
      else if (kind === 2) { const name = this.buildings[type], [cid, ex] = this.cue(true, type, 'collapse', collapseId(name, size), { big: true }); trig(cid, x + size / 2, y + size / 2, owner, hash32(x, y), 1, ex);
        if (this.opts.alerts.includes('building_lost') && !first) this.alert(out, T, 'bl' + owner, 'alert_building_lost', owner, x, y, 60); }
    }
    // trees whose wood ran out: the fall with its crack and thud, but only when a worker was gathering near the tile (the renderer lets such a tree fall; with nobody at work it shows a stump at once and nothing is heard).
    // A long list (the first snapshot of a viewer, a jump) is old news.
    if (!first && s.tg && s.tg.length <= 4 && T - (this.prevT ?? T) <= 60) for (const tile of s.tg) if (this.choppedAt(s, tile)) trig('tree_falls', (tile % this.N) + 0.5, Math.floor(tile / this.N) + 0.5, 0, hash32(tile), 0.9);
    // buildings: placed, damaged (base alert), completion via ev
    const emitters = [];
    for (const b of s.buildings) {
      const [id, owner, ti, tx, ty, hp, prog] = b, name = this.buildings[ti], size = this.init.buildingDefs[name].size, pb = this.prevBld.get(id), cx = tx + size / 2, cy = ty + size / 2;
      if (!pb && !first && prog < 100 && name !== 'wall') { const [cid, ex] = this.cue(true, name, 'place', placeId(name)); trig(cid, cx, cy, owner, id, 0.9, ex); }
      if (pb && hp < pb[5] && prog >= 100 && this.opts.alerts.includes('base')) this.alert(out, T, 'ba' + owner, 'alert_base_attack', owner, cx, cy, 300);
      if (prog >= 100) { if (hp < 45 && name !== 'wall') emitters.push({ key: 'f' + id, id: 'fire_loop', x: cx, y: cy, owner }); else if (name === 'blacksmith') emitters.push({ key: 'g' + id, id: 'forge_loop', x: cx, y: cy, owner }); else if (name === 'mill') emitters.push({ key: 'm' + id, id: 'mill_loop', x: cx, y: cy, owner }); else if (name === 'market') emitters.push({ key: 'k' + id, id: 'market_loop', x: cx, y: cy, owner }); }
    }
    // the living world: a caravan on the road (wheels, harness), a ship under way (wake), the hum of each relic shrine (louder while it is being taken)
    for (const u of s.units) {
      const type = this.units[u[2]], ship = this.cls(type) === 'naval' || NAVAL.has(type);
      if (type !== 'caravan' && !ship) continue;
      const pu = this.prevUnits.get(u[0]);
      if (pu && Math.hypot(u[3] - pu[3], u[4] - pu[4]) > 0.02 * dt) this.rolling.set(u[0], T);
      if (T - (this.rolling.get(u[0]) ?? -99) <= 10) emitters.push({ key: (ship ? 'w' : 'c') + u[0], id: ship ? 'ship_wake_loop' : 'caravan_loop', x: u[3], y: u[4], owner: u[1] });
    }
    for (const p of s.vic?.points || []) emitters.push({ key: 's' + p.id, id: 'shrine_hum_loop', x: p.x + 1, y: p.y + 1, owner: 0, vol: p.cand ? 1 : 0.6 });
    for (const u of s.units) { const pu = this.prevUnits.get(u[0]); if (pu && u[5] < pu[5] && u[1] > 0 && this.opts.alerts.includes('unit')) this.alert(out, T, 'ua' + u[1], 'alert_unit_attack', u[1], u[3], u[4], 400); }
    for (const o in idle) { if (idle[o] >= 3 && this.opts.alerts.includes('idle')) { const since = this.idleSince.get(o) ?? T; this.idleSince.set(o, since); if (T - since > 150) this.alert(out, T, 'id' + o, 'alert_idle_workers', +o, 0, 0, 600); } else this.idleSince.delete(o); }
    for (const p of s.players || []) { if (this.opts.alerts.includes('popcap') && p.pop >= p.cap && p.cap > 0 && (this.prevPop[p.id] ?? 0) < p.cap && !first) this.alert(out, T, 'pc' + p.id, 'alert_pop_cap', p.id, 0, 0, 600); this.prevPop[p.id] = p.pop; }
    for (const e of s.ev || []) {
      const st = this.init.starts?.[e.p - 1] ?? [this.N / 2, this.N / 2], x = st[0] ?? this.N / 2, y = st[1] ?? this.N / 2;
      if (e.k === 'tier' && e.tier >= 2) { trig(e.tier >= 3 ? 'fanfare_tier3' : 'fanfare_tier2', x, y, e.p, e.t, 1, { big: true, global: true }); if (this.opts.alerts.includes('tier')) for (const q of s.players || []) if (q.id !== e.p && !first) { this.alert(out, T + 0.01, 'et' + q.id, 'alert_enemy_tier', q.id, x, y, 100); break; } }
      else if (e.k === 'tech') trig('tech_chime', x, y, e.p, e.t, 0.7, { global: true });
      else if (e.k === 'built') { const bb = [...s.buildings].reverse().find((b) => this.buildings[b[2]] === e.b && b[1] === e.p); const sz = this.init.buildingDefs[e.b]?.size ?? 2; if (e.b === 'castle') { const [cid, ex] = this.cue(true, e.b, 'complete', completeId(e.b), { big: true, alt: 'complete_stone' }); trig(cid, bb ? bb[3] + sz / 2 : x, bb ? bb[4] + sz / 2 : y, e.p, e.t, 1, ex); } else if (e.b !== 'wall') { const [cid, ex] = this.cue(true, e.b, 'complete', completeId(e.b)); trig(cid, bb ? bb[3] + sz / 2 : x, bb ? bb[4] + sz / 2 : y, e.p, e.t, 0.9, ex); } }
      else if (e.k === 'ann' && e.a === 'control_point_captured') trig('shrine_capture', (e.x ?? x) + 1, (e.y ?? y) + 1, e.p, e.t, 1, { big: true });
      else if (e.k === 'ann' && e.a === 'wonder_completed') trig('wonder_bell', e.x ?? x, e.y ?? y, e.p, e.t, 1, { big: true, global: true });
      else if (e.k === 'ann' && e.a === 'wonder_started') trig('wonder_bell', e.x ?? x, e.y ?? y, e.p, e.t, 0.6, { big: true });
      else if (e.k === 'mkt') { const mb = s.buildings.find((b) => b[1] === e.p && this.buildings[b[2]] === 'market'); trig('market_trade', mb ? mb[3] + 1.5 : x, mb ? mb[4] + 1.5 : y, e.p, e.t, 0.9); }
      else if (e.k === 'caravan') { trig('caravan_arrive', e.x, e.y, 0, e.t, 1); trig('market_trade', e.x, e.y, 0, e.t + 0.5, 0.7); }
    }
    if (s.over && !this.doneEnd) { this.doneEnd = true; trig(s.over.winnerTeam ? 'sting_victory' : 'sting_defeat', this.N / 2, this.N / 2, 0, 1, 1, { big: true, global: true }); }
    if (this.gaits.size) for (const id of this.gaits.keys()) if (!curU.has(id)) this.gaits.delete(id);
    if (this.rolling.size) for (const id of this.rolling.keys()) if (!curU.has(id)) this.rolling.delete(id);
    this.prevUnits = curU; this.prevBld = curB; this.prevProj = curP; this.prevT = T; this.first = false;
    return { triggers: out, emitters, fighting, tick: T };
  }
  // Hoof beats of a rider: the same gait model as the animation (render/gait.mjs: clip, stride per cycle, ground contacts per cycle) run on the tick
  // positions, so a beat lands in the tick where the hoof of the model lands. `f` = where in the tick (0..1) the hoof lands, `at` = that moment in ticks.
  hoofs(trig, u, pu, type, dt, T) {
    const id = u[0], g = this.gaits.get(id) || this.gaits.set(id, newState(id)).get(id);
    const dist = Math.hypot(u[3] - pu[3], u[4] - pu[4]), sp = dist * TICK_HZ / dt;
    if (sp > 16) return; // a jump (teleport), not a ride
    const sc = this.riderScale(type, id);
    g.gait = pickGait(type, sp, sc, g.gait);
    const cyc = advance(g, type, sc, dist);
    if (sp < MIN_SPEED) return;
    const ev = GAITS[type].heavy ? 'hoof_heavy' : 'hoof_light';
    beatsIn(g.gait, g.from, cyc, (f, loud, puff, j) => trig(ev, pu[3] + (u[3] - pu[3]) * f, pu[4] + (u[4] - pu[4]) * f, u[1], hash32(id, T, j), loud, { hoof: true, f, at: T - dt + f * dt }));
  }
  // was a worker gathering within about three tiles of the tile in this or the last snapshot? (same idea as Chopped.cutterNear in the renderer)
  choppedAt(s, tile) {
    const cx = (tile % this.N) + 0.5, cy = Math.floor(tile / this.N) + 0.5;
    const near = (u) => u[6] === 2 && u[1] > 0 && Math.hypot(u[3] - cx, u[4] - cy) <= 3.5;
    for (const u of s.units) if (near(u)) return true;
    for (const u of this.prevUnits.values()) if (near(u)) return true;
    return false;
  }
  alert(out, T, key, id, owner, x, y, cdTicks) { // per-key cooldown in game ticks
    const last = this.lastAlert.get(key); if (last !== undefined && T - last < cdTicks) return;
    this.lastAlert.set(key, T); out.push({ id, x, y, owner, ent: owner, t: T, vol: 1, alert: true });
  }
}

// ---------------------------------------------------------------- shaping
// listener = { x, y, ref } in tiles (ref > 1 when the camera is far away: more of the map counts as near). Returns null when inaudible.
export function shape(trig, entry, L, rightX = 1, rightY = 0) {
  if (trig.global || entry.spatial === false) return { gain: trig.vol, pan: trig.alert ? (trig.owner === 1 ? -0.5 : trig.owner === 2 ? 0.5 : 0) : 0, lp: 20000 };
  const ref = (entry.ref_dist || 14) * (L.ref || 1), dx = trig.x - L.x, dy = trig.y - L.y, d = Math.hypot(dx, dy);
  if (d > ref * 6) return null;
  const g = Math.pow(ref / Math.max(d, ref), 1.25) * trig.vol, pan = clamp(((dx * rightX + dy * rightY) / (ref * 1.8)) * 0.85, -0.85, 0.85);
  return { gain: g, pan, lp: clamp(18000 / (1 + (d / ref) * 1.6), 1800, 18000) };
}
// Hoof beats of one snapshot (`list` = triggers with .hoof): a few of the nearest only, quieter the more riders there are. A charge of sixty riders is
// a rumble, not sixty single clops, and far riders drop out first (shape() = distance gain). Returns [{ tr, k }] with k = extra gain, loudest first.
export const HOOF_MAX = 3;
export function limitHoofs(list, man, L, max = HOOF_MAX) {
  const scored = [];
  for (const tr of list) { const e = man[tr.id]; if (!e) continue; const sh = shape(tr, e, L, L.rx ?? 1, L.ry ?? 0); if (sh && sh.gain >= 0.02) scored.push({ tr, g: sh.gain }); }
  scored.sort((a, b) => b.g - a.g || a.tr.ent - b.tr.ent);
  const k = Math.min(1, Math.pow(max / Math.max(1, scored.length), 0.35));
  return scored.slice(0, max).map((q) => ({ tr: q.tr, k }));
}
export function pickVariant(entry, seedParts) {
  const h = hash32(...seedParts), n = entry.files.length, lo = entry.pitch?.[0] ?? 1, hi = entry.pitch?.[1] ?? 1;
  return { index: h % n, rate: lo + (hi - lo) * (((h >>> 8) % 1000) / 999) };
}
export function minPriorityForSpeed(speed) { return speed <= 2.01 ? 0 : speed <= 4.01 ? 4 : speed <= 8.01 ? 6 : 8; }

// ---------------------------------------------------------------- voice limits (cooldown, per-event max, crowd cap)
export class VoiceBook {
  constructor({ maxVoices = 24, groupWindowMs = 100, groupMax = 8 } = {}) { this.max = maxVoices; this.win = groupWindowMs / 1000; this.gmax = groupMax; this.voices = []; this.lastById = new Map(); this.recent = []; }
  // t in seconds (any clock, monotonic). Returns { ok, steal } ; call commit() with the real end time after playing.
  admit(entry, id, prio, gain, t) {
    this.voices = this.voices.filter((v) => v.end > t);
    const last = this.lastById.get(id); if (last !== undefined && (t - last) * 1000 < entry.cooldown_ms) return { ok: false, why: 'cooldown' };
    const grp = entry.group; this.recent = this.recent.filter((r) => t - r.t < this.win);
    if (this.recent.filter((r) => r.g === grp).length >= this.gmax && prio < 8) return { ok: false, why: 'group' };
    const same = this.voices.filter((v) => v.id === id);
    let steal = null;
    if (same.length >= entry.max_voices) { const w = same.reduce((a, b) => (a.score <= b.score ? a : b)); if (w.score >= prio * 10 + gain) return { ok: false, why: 'voices' }; steal = w; }
    else if (this.voices.length >= this.max) { const w = this.voices.reduce((a, b) => (a.score <= b.score ? a : b)); if (w.score >= prio * 10 + gain) return { ok: false, why: 'full' }; steal = w; }
    return { ok: true, steal };
  }
  commit(entry, id, prio, gain, t, end, handle) { if (this.voices.length) { /* steal handled by caller */ } this.lastById.set(id, t); this.recent.push({ t, g: entry.group }); const v = { id, end, score: prio * 10 + gain, handle }; this.voices.push(v); return v; }
  drop(v) { this.voices = this.voices.filter((x) => x !== v); }
  crowd(t) { return this.voices.filter((v) => v.end > t).length; }
}

// ---------------------------------------------------------------- sound packs (one manifest per skin)
// A skin may bring its own sound pack: a folder under render/assets/ with a manifest.json of the same format as render/assets/audio/manifest.json (files relative to that folder). The live page
// (render/audio.mjs) and the broadcast mix (tools/audio-mix.mjs) ask here which one to load; a skin without a pack, and every other theme, plays the classic pack.
export const SOUND_PACKS = { dustmoon: 'audio-dustmoon' };
export const CLASSIC_PACK = 'audio';
export const packOf = (theme) => (theme && !theme.isClassic && SOUND_PACKS[String(theme.id || '').split('-')[0]]) || CLASSIC_PACK;

// ---------------------------------------------------------------- variety: no clip twice in a row, pitch / level / onset spread per play
// Shots and hits of a big fight run dozens of times a second. The classic choice (pickVariant: a hash modulo the number of clips) repeats the same file right after itself in one of
// two to three plays; here the last clips of an event are left out, and every play gets its own pitch, level and a small onset offset (all from the same hash, so the same replay gives the same sound).
export const FIRE_SHOTS = new Set(['bow_shot', 'javelin_throw', 'arrow_whoosh', 'ballista_bolt', 'catapult_release', 'bolt_crossbow']);
export const FIRE_HITS = new Set(['arrow_hit_flesh', 'arrow_hit_wood', 'arrow_hit_stone', 'hit_sword_flesh', 'hit_sword_shield', 'hit_sword_armour', 'hit_sword_clash', 'hit_spear', 'building_hit_wood', 'building_hit_stone', 'hunt_hit']);
// 'shot' | 'hit' | null; a theme clip (theme_<type>_shot / _hit) counts by its classic clip (`alt`, or `entry.theme` of a themed event)
export const fireClass = (id) => (!id ? null : FIRE_SHOTS.has(id) ? 'shot' : FIRE_HITS.has(id) ? 'hit' : /^theme_[a-z0-9_]+_shot$/.test(id) ? 'shot' : /^theme_[a-z0-9_]+_hit$/.test(id) ? 'hit' : null);
export const FIRE_SPREAD = { pitch: [0.9, 1.1], gain_db: 2, delay_ms: 25 }; // minimum spread of a shot or a hit (a pack manifest may say more: pitch, gain_spread_db, delay_ms)
export function spreadOf(entry, id) {
  const fire = !!(fireClass(id) || fireClass(entry.theme)), pitch = entry.pitch || [1, 1];
  return {
    pitch: fire && entry.gain_spread_db === undefined ? [Math.min(pitch[0], FIRE_SPREAD.pitch[0]), Math.max(pitch[1], FIRE_SPREAD.pitch[1])] : pitch,
    gain_db: entry.gain_spread_db ?? (fire ? FIRE_SPREAD.gain_db : 0.6),
    delay_ms: entry.delay_ms ?? (fire ? FIRE_SPREAD.delay_ms : 0),
  };
}
export class VariantPicker {
  constructor() { this.hist = new Map(); } // event id -> the last played variant indexes (at most 3)
  // peek: { index, rate, k, delay } (k = linear level factor, delay in seconds); commit(id, index) once the clip is really played
  pick(entry, id, seedParts) {
    const h = hash32(...seedParts), n = entry.files.length, hist = this.hist.get(id) || [];
    const avoid = Math.min(hist.length, n >= 9 ? 3 : n >= 5 ? 2 : n >= 2 ? 1 : 0), banned = hist.slice(hist.length - avoid), pool = [];
    for (let i = 0; i < n; i++) if (!banned.includes(i)) pool.push(i);
    const u = (k) => (hash32(h, k, 91) % 1000) / 999, sp = spreadOf(entry, id);
    return { index: pool[h % pool.length], rate: sp.pitch[0] + (sp.pitch[1] - sp.pitch[0]) * u(1), k: Math.pow(10, ((u(2) * 2 - 1) * sp.gain_db) / 20), delay: (u(3) * sp.delay_ms) / 1000 };
  }
  commit(id, index) { const h = this.hist.get(id) || []; h.push(index); if (h.length > 3) h.shift(); this.hist.set(id, h); }
}

// ---------------------------------------------------------------- density of fire: a few single clips, the rest becomes a carpet
// In a big fight the director offers dozens of shots and hits per second; played one by one they are a machine gun. FireControl keeps about `shots` / `hits` clips per second (fewer the farther the
// camera, `zoom` >= 1: the sound of one rifle is lost in the din anyway), thins the rest by a deterministic draw, and carpetWeight() turns the density that was offered into the level of a continuous
// firefight bed (pack event fire_carpet, else the classic battle bed) that takes over from the single clicks.
export class FireControl {
  constructor({ shots = 9, hits = 12, window = 1 } = {}) { this.cap = { shot: shots, hit: hits }; this.win = window; this.offered = { shot: [], hit: [] }; this.kept = { shot: [], hit: [] }; }
  admit(cls, t, zoom, u) { // t seconds on the output clock, u in [0, 1) a draw from the trigger
    const off = this.offered[cls], kept = this.kept[cls];
    while (off.length && t - off[0] > this.win) off.shift();
    while (kept.length && t - kept[0] > this.win) kept.shift();
    off.push(t);
    const cap = this.cap[cls] / Math.sqrt(Math.max(1, zoom)), p = Math.min(1, cap / off.length);
    if (u >= p || kept.length >= Math.ceil(cap * 1.4)) return false;
    kept.push(t); return true;
  }
}
export const CARPET_FROM = 12, CARPET_SPAN = 36; // offered shots + hits per second: the carpet starts at 12 and is full at 48
export const carpetWeight = (rate) => { const x = clamp((rate - CARPET_FROM) / CARPET_SPAN, 0, 1); return x * x * (3 - 2 * x); };
export const carpetId = (events) => (events.fire_carpet ? 'fire_carpet' : 'amb_battle_bed'); // the pack's own carpet, else the classic battle bed (a little quiet: CARPET_GAIN)
export const CARPET_GAIN = { fire_carpet: 1, amb_battle_bed: 1.6 };

// ---------------------------------------------------------------- tension (0..1) and ambience
export class Tension {
  constructor() { this.v = 0; this.target = 0; }
  // fightNear: fighting units near the listener; dt seconds. Fast attack, slow release.
  update(fightNear, deathsRecent, dt) {
    this.target = clamp(Math.pow(clamp((fightNear + deathsRecent * 1.5) / 14, 0, 1), 0.75), 0, 1);
    const k = this.target > this.v ? 1 - Math.exp(-dt / 1.6) : 1 - Math.exp(-dt / 7);
    this.v += (this.target - this.v) * k; return this.v;
  }
}
export function musicWeights(tension, maxTier) { // calm / tension / battle stems; tier-2 arrangement joins with progress or intensity
  const t = clamp(tension, 0, 1);
  const calm = clamp(1 - t / 0.45, 0, 1), tens = clamp(1 - Math.abs(t - 0.4) / 0.3, 0, 1), battle = clamp((t - 0.4) / 0.35, 0, 1);
  const n = Math.sqrt(calm * calm + tens * tens + battle * battle) || 1, up = clamp((maxTier - 1) * 0.55 + t * 0.6, 0, 1);
  const f = (w) => w / n;
  return { music_calm_1: f(calm) * (1 - 0.6 * up), music_calm_2: f(calm) * up, music_tension_1: f(tens) * (1 - 0.6 * up), music_tension_2: f(tens) * up, music_battle_1: f(battle) * (1 - 0.6 * up), music_battle_2: f(battle) * up };
}
export function ambientWeights(init, x, y, { tension = 0, buildingsNear = 0, weather = 0 } = {}) {
  const N = init.size, r = 16; let forest = 0, water = 0, tot = 0;
  for (let j = Math.max(0, Math.floor(y - r)); j < Math.min(N, y + r); j += 2) for (let i = Math.max(0, Math.floor(x - r)); i < Math.min(N, x + r); i += 2) { const c = init.terrain[j][i]; tot++; if (c === 'f') forest++; else if (c === '~') water++; }
  const f = tot ? forest / tot : 0, w = tot ? water / tot : 0, town = clamp(buildingsNear / 10, 0, 1);
  const wf = clamp(f / 0.35, 0, 1), ww = clamp(w / 0.12, 0, 1);
  const base = { amb_forest: wf, amb_shore: ww * (1 - wf * 0.5), amb_town: town * 0.8 * (1 - ww * 0.5), amb_meadow: 1 - 0.7 * Math.max(wf, ww, town * 0.8) };
  const s = Object.values(base).reduce((a, b) => a + b, 0) || 1;
  const o = {}; for (const k in base) o[k] = base[k] / s;
  o.amb_battle_bed = clamp((tension - 0.15) / 0.6, 0, 1) * 0.9;
  // living world: the wind of the map type, and the weather (kind index in sim/world-data.mjs: 0 clear 1 rain 2 fog 3 snow 4 storm) on top of the beds
  const mt = init.mapType;
  const quiet = weather === 1 || weather === 4 ? 0.45 : weather === 3 ? 0.6 : 1;
  for (const k in o) if (k !== 'amb_battle_bed') o[k] *= quiet;
  if (mt === 'desert') o.amb_desert_wind = (weather === 4 ? 1 : 0.35);
  if (mt === 'winter') o.amb_snow_wind = (weather === 3 ? 0.9 : 0.3);
  if (weather === 1) o.amb_rain = 0.75;
  if (weather === 4) { if (mt === 'desert') o.amb_desert_wind = 1; else { o.amb_rain = 1; o.amb_mountain = 0.45; } }
  if (weather === 3) o.amb_snow_wind = Math.max(o.amb_snow_wind || 0, 0.9);
  if (weather === 2) { for (const k in o) if (k !== 'amb_battle_bed') o[k] *= 0.7; }
  return o;
}

// ---------------------------------------------------------------- music playlists (several long variants per stem, joined by crossfades)
export const MUSIC_XF = 3; // seconds of crossfade between two variants of the same stem
// order of the variants: pure function of the stem id and the position, never the same file twice in a row
export function musicSequence(id, nFiles, count) {
  const out = []; let prev = -1;
  for (let k = 0; k < count; k++) { let i = nFiles === 1 ? 0 : hash32(id.length * 977 + id.charCodeAt(id.length - 1), k, 5) % nFiles; if (nFiles > 1 && i === prev) i = (i + 1) % nFiles; out.push(i); prev = i; }
  return out;
}
