// Readable intent: what each player is doing, in words (action feed) and as map markers (arrows, labels, ghosts, task icons).
// Everything is derived from the deterministic sim state and the validated commands, never from the model text, so a replay
// reproduces exactly the same feed and markers. Not part of the state hash; only read by spectators and the broadcast.
import { POP_MAX } from './data.mjs';

const nice = (s) => String(s).replace(/_/g, ' ');
const plural = (type, n) => { const w = nice(type); return n === 1 ? `1 ${w}` : `${n} ${w}${/(s|x)$/.test(w) ? 'es' : 's'}`.replace('cavalrys', 'cavalry').replace('swordsmans', 'swordsmen').replace('spearmans', 'spearmen'); };
const COMPASS = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];

function dirWord(dx, dy) {
  const a = Math.atan2(dy, dx); // y grows downwards (south)
  return COMPASS[((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8];
}

// A place in words: "near forest NE", "near gold", "the centre treasure", "at base"
export function whereWords(g, p, tx, ty) {
  const home = g.starts[p.id - 1], hx = home.tx + 2, hy = home.ty + 2, c = g.W / 2;
  if (Math.hypot(tx - c, ty - c) < 11 && g.rules.treasure) return 'the centre treasure';
  let feat = null, bd = 9;
  for (const n of g.nodes.values()) {
    const d = Math.hypot(n.tx + n.size / 2 - tx, n.ty + n.size / 2 - ty);
    if (d < bd) { bd = d; feat = { berries: 'berries', herd: 'the herd', gold: 'gold', stone: 'stone' }[n.res]; }
  }
  if (!feat) {
    let f = 0;
    for (let j = -4; j <= 4; j++) for (let i = -4; i <= 4; i++) { const x = tx + i, y = ty + j; if (x >= 0 && y >= 0 && x < g.W && y < g.H && g.terrain[y * g.W + x] === 1) f++; }
    if (f >= 8) feat = 'forest';
  }
  const dist = Math.hypot(tx - hx, ty - hy);
  const dir = dist < 12 ? '' : ' ' + dirWord(tx - hx, ty - hy);
  if (feat) return `near ${feat}${dir}`;
  return dist < 12 ? 'at base' : `${dirWord(tx - hx, ty - hy)} of base`;
}

function targetWords(g, p, t) {
  const enemyStart = (() => { let best = null; for (const q of g.players) if (q && q.team !== p.team) best = g.starts[q.id - 1]; return best; })();
  let tx, ty;
  if (Array.isArray(t)) { tx = Math.floor(+t[0]); ty = Math.floor(+t[1]); }
  else { const e = g.get(+t); if (!e) return 'the target'; if (e.kind === 2 && g.team[e.owner] !== p.team) return `enemy ${nice(e.type)}`; if (e.kind === 1) { tx = Math.floor(e.x / 1000); ty = Math.floor(e.y / 1000); } else { tx = e.tx; ty = e.ty; } }
  if (enemyStart && Math.hypot(tx - enemyStart.tx - 2, ty - enemyStart.ty - 2) < 12) return 'enemy base';
  const home = g.starts[p.id - 1];
  if (Math.hypot(tx - home.tx - 2, ty - home.ty - 2) < 14) return 'home base';
  return whereWords(g, p, tx, ty);
}

export function isDefence(g, p, xy) {
  const home = g.starts[p.id - 1];
  return Math.hypot(xy[0] - home.tx - 2, xy[1] - home.ty - 2) < 22;
}

// -> {text, kind} or null
export function describeCommand(g, p, name, a, res) {
  switch (name) {
    case 'train': { const b = g.buildings.get(+a.building_id); return { text: `Training ${plural(res.unit_type, res.queued)} at ${nice(b?.type || 'building')}`, kind: 'train' }; }
    case 'build': return { text: `Building ${nice(a.building_type)} ${whereWords(g, p, res.at[0], res.at[1])}`, kind: 'build' };
    case 'gather': return { text: `${res.assigned} worker${res.assigned === 1 ? '' : 's'} to ${res.resource}`, kind: 'gather' };
    case 'attack_move': {
      const xy = Array.isArray(res.target) ? res.target : null;
      const def = xy && isDefence(g, p, xy);
      const tw = targetWords(g, p, xy || a.target);
      return def ? { text: `Defend: ${res.units} unit${res.units === 1 ? '' : 's'} at ${tw}`, kind: 'defend' } : { text: `Attack: ${res.units} unit${res.units === 1 ? '' : 's'} -> ${tw}`, kind: 'attack' };
    }
    case 'move': return { text: `Moving ${res.units} unit${res.units === 1 ? '' : 's'} ${targetWords(g, p, res.to)}`, kind: 'move' };
    case 'research': return { text: `Researching ${nice(a.tech)}`, kind: 'tech' };
    case 'advance_tier': return { text: `Advancing to tier ${res.tier}`, kind: 'tier' };
    case 'trade': return { text: `Market: ${res.sold} ${res.sold_resource} -> ${res.got} ${res.got_resource}`, kind: 'trade' };
    case 'tribute': return { text: `Tribute: ${res.sent} ${res.resource} to player ${res.to}`, kind: 'trade' };
    case 'scout': return { text: `Scouting ${res.to ? whereWords(g, p, res.to[0], res.to[1]) : ''}`.trim(), kind: 'scout' };
    case 'auto_train': return { text: `Standing: keep training ${nice(a.unit_type)}`, kind: 'standing' };
    case 'attack_wave': return { text: `Standing: attack wave at ${a.min_army ?? 10} units`, kind: 'standing' };
    case 'auto_build_houses': return { text: a.on === false ? 'Standing: houses off' : 'Standing: auto houses', kind: 'standing' };
    case 'resign': return { text: 'Resigned', kind: 'end' };
    default: return null;
  }
}

export function installIntent(Game) {
  Game.prototype.noteIntent = function (p, text, kind) {
    if (!text) return;
    p.intents.push({ t: this.t, text, kind });
    if (p.intents.length > 8) p.intents.shift();
  };
}

export const feedOf = (g, p, n = 4) => p.intents.slice(-n).map((i) => ({ text: i.text, kind: i.kind, age: Math.round((g.t - i.t) / 10) }));

// ---- map markers: [key, kind, owner, x, z, x2, z2, n, label] in tile coordinates ----
const TASK = { wood: 'axe', stone: 'pick', gold: 'pick', food: 'basket' };

export function markersOf(g) {
  const out = [];
  for (const p of g.players) {
    if (!p || !p.alive) continue;
    const mine = [];
    // army groups by destination
    const groups = new Map();
    let scout = null;
    for (const u of g.units.values()) {
      if (u.owner !== p.id || u.dead || u.type === 'worker') continue;
      const o = u.ord;
      if (o.t === 'move' && o.scout) { scout = scout || u; continue; }
      let tx, ty;
      if (o.t === 'amove') { tx = Math.floor((o.tgx ?? o.x) / 1000); ty = Math.floor((o.tgy ?? o.y) / 1000); } // tgx/tgy: the formation goal, not the unit's own slot
      else if (o.t === 'attack' && !o.auto) { const e = g.get(o.id); if (!e) continue; tx = e.kind === 2 ? e.tx : Math.floor(e.x / 1000); ty = e.kind === 2 ? e.ty : Math.floor(e.y / 1000); }
      else continue;
      const key = `${Math.floor(tx / 8)},${Math.floor(ty / 8)}`;
      let gr = groups.get(key);
      if (!gr) groups.set(key, (gr = { n: 0, sx: 0, sy: 0, tx, ty }));
      gr.n++; gr.sx += u.x / 1000; gr.sy += u.y / 1000;
    }
    const gl = [...groups.entries()].filter(([, v]) => v.n >= 2).sort((a, b) => b[1].n - a[1].n || (a[0] < b[0] ? -1 : 1)).slice(0, 2);
    for (const [k, v] of gl) {
      const def = isDefence(g, p, [v.tx, v.ty]);
      mine.push([`atk|${p.id}|${k}`, def ? 'defend' : 'attack', p.id, +(v.sx / v.n).toFixed(1), +(v.sy / v.n).toFixed(1), v.tx + 0.5, v.ty + 0.5, v.n, def ? 'DEFEND' : 'ATTACK']);
    }
    if (scout) mine.push([`scout|${scout.id}`, 'scout', p.id, +(scout.x / 1000).toFixed(1), +(scout.y / 1000).toFixed(1), Math.floor(scout.ord.x / 1000) + 0.5, Math.floor(scout.ord.y / 1000) + 0.5, 1, 'SCOUT']);
    // fresh build orders (ghost) and rally lines
    for (const gh of p.ghosts) {
      const b = g.buildings.get(gh.id);
      if (!b || g.t - gh.t > 60) continue;
      mine.push([`ghost|${gh.id}`, 'ghost', p.id, b.tx + b.size / 2, b.ty + b.size / 2, b.size, 0, 1, nice(b.type)]);
    }
    for (const b of g.buildings.values()) {
      if (b.owner !== p.id || !b.rally || b.rallyT === undefined || g.t - b.rallyT > 80) continue;
      mine.push([`rally|${b.id}`, 'rally', p.id, b.tx + b.size / 2, b.ty + b.size / 2, b.rally.x / 1000, b.rally.y / 1000, 1, '']);
    }
    // worker task icons: biggest clusters
    const wk = new Map();
    for (const u of g.units.values()) {
      if (u.owner !== p.id || u.dead || u.type !== 'worker') continue;
      const o = u.ord;
      const icon = o.t === 'gather' ? TASK[o.res] : o.t === 'build' ? 'hammer' : null;
      if (!icon) continue;
      const key = `${icon}|${Math.floor(u.x / 6000)},${Math.floor(u.y / 6000)}`;
      let c = wk.get(key);
      if (!c) wk.set(key, (c = { icon, n: 0, sx: 0, sy: 0 }));
      c.n++; c.sx += u.x / 1000; c.sy += u.y / 1000;
    }
    const wl = [...wk.entries()].filter(([, v]) => v.n >= 2).sort((a, b) => b[1].n - a[1].n || (a[0] < b[0] ? -1 : 1)).slice(0, 3);
    for (const [k, v] of wl) mine.push([`work|${p.id}|${k}`, 'work', p.id, +(v.sx / v.n).toFixed(1), +(v.sy / v.n).toFixed(1), 0, 0, v.n, v.icon]);
    out.push(...mine.slice(0, 6));
  }
  return out;
}
void POP_MAX;
