// Compact, fog-limited observation for one player. This is exactly what an LLM (or scripted bot) sees.
// Pure function of the game state: it never mutates the game.
import { idsToString } from './util.mjs';
import { standingObs } from './standing.mjs';
import { TICK_HZ } from './util.mjs';
import { RESOURCES, TIERS, mergedFaction, GATHER, POP_MAX } from './data.mjs';
import { resolveRules } from './rules.mjs';

const CRITICAL = new Set(['town_center', 'barracks', 'archery_range', 'stables', 'siege_workshop', 'tower', 'blacksmith']);

function orderLabel(u) {
  const o = u.ord;
  switch (o.t) {
    case 'idle': return 'idle';
    case 'move': return o.scout ? 'scout' : 'move';
    case 'amove': return 'attack_move';
    case 'attack': return 'attack';
    case 'gather': return 'gather:' + o.res;
    case 'build': return 'build';
  }
  return o.t;
}

export function observe(game, pid, opts = {}) {
  const p = game.players[pid];
  const since = opts.sinceTick ?? -1;
  const W = game.W;
  const tx = (v) => game.tileMilli(pid, v); // tile of a milli coordinate, mirror safe on exact tile edges
  // Grouping cells are laid out in the observer's own frame (player 2 sees the map rotated), so that mirrored
  // positions fall into mirrored groups.
  const fr = game.sgn[pid] > 0 ? (v) => v : (v) => W * 1000 - v;
  const obs = {
    t: Math.floor(game.t / TICK_HZ), you: pid, team: p.team,
    res: { ...p.res },
    pop: { used: p.pop, cap: p.cap, max: POP_MAX },
    tier: p.tier,
  };
  if (game.rules && game.rules.preset && game.rules.preset !== 'classic') obs.preset = game.rules.preset; // scripted bots pick their cost tables from it
  // income per minute from sampled history
  const hist = p.income;
  if (hist.length) {
    const ref = hist[0];
    const dt = Math.max(1, (game.t - ref.t) / TICK_HZ);
    obs.income_per_min = {};
    for (const r of RESOURCES) obs.income_per_min[r] = Math.round(((p.gathered[r] - ref.g[r]) * 60) / dt);
  }
  if (p.advancing) {
    let eta = 0;
    for (const b of game.buildings.values()) if (b.owner === pid && b.research && b.research.kind === 'tier') eta = Math.ceil(b.research.t / TICK_HZ);
    obs.advancing = { to: p.advancing, eta };
  }
  if (p.techs.size) obs.techs = [...p.techs];

  // workers
  const wk = { n: 0, idle: 0, food: 0, wood: 0, stone: 0, gold: 0, build: 0, other: 0 };
  const idleIds = [];
  const groups = new Map();
  let armyValue = 0;
  for (const u of game.units.values()) {
    if (u.owner !== pid) continue;
    if (u.type === 'worker') {
      wk.n++;
      const o = u.ord;
      if (o.t === 'idle') { wk.idle++; idleIds.push(u.id); }
      else if (o.t === 'gather') wk[o.res]++;
      else if (o.t === 'build') wk.build++;
      else wk.other++;
      continue;
    }
    const key = u.type + ':' + Math.floor(fr(u.y) / 10000) * 100 + Math.floor(fr(u.x) / 10000);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { type: u.type, ids: [], sx: 0, sy: 0, hp: 0, maxhp: 0, acts: {} }));
    g.ids.push(u.id);
    g.sx += u.x;
    g.sy += u.y;
    g.hp += u.hp;
    g.maxhp += u.maxhp;
    const l = orderLabel(u);
    g.acts[l] = (g.acts[l] || 0) + 1;
    const c = p.faction.units[u.type].cost;
    for (const k in c) armyValue += c[k];
  }
  if (idleIds.length) wk.idle_ids = idleIds.length <= 40 ? idsToString(idleIds) : idsToString(idleIds.slice(0, 40)) + ',...';
  obs.workers = wk;
  obs.army_value = armyValue;
  obs.units = [...groups.values()]
    .sort((a, b) => b.ids.length - a.ids.length || a.type.localeCompare(b.type))
    .map((g) => {
      const n = g.ids.length;
      let act = '', best = 0;
      for (const [k, v] of Object.entries(g.acts)) if (v > best || (v === best && k < act)) { best = v; act = k; }
      return { type: g.type, n, xy: [tx(g.sx / n), tx(g.sy / n)], hp: Math.round((100 * g.hp) / g.maxhp), act, ids: idsToString(g.ids) };
    });

  // buildings
  const bl = [];
  const minor = {};
  for (const b of game.buildings.values()) {
    if (b.owner !== pid) continue;
    const d = p.faction.buildings[b.type];
    const xy = [b.tx, b.ty];
    if (d.train || d.attack || b.type === 'blacksmith' || b.type === 'mill' || b.type === 'lumber_camp' || b.type === 'mining_camp' || !b.built) {
      const e = { id: b.id, type: b.type, xy, hp: Math.round((100 * b.hp) / b.maxhp) };
      if (!b.built) e.build = Math.round((100 * b.prog) / (d.time * TICK_HZ * 1000));
      if (b.queue.length) {
        const q = {};
        for (const it of b.queue) q[it.type] = (q[it.type] || 0) + 1;
        e.queue = Object.entries(q).map(([k, v]) => `${k}x${v}`);
        e.next_in = Math.ceil(b.queue[0].t / TICK_HZ);
      }
      if (b.research) e.research = { [b.research.kind === 'tech' ? b.research.tech : 'tier' + b.research.tier]: Math.ceil(b.research.t / TICK_HZ) };
      if (b.rally) e.rally = [tx(b.rally.x), tx(b.rally.y)];
      bl.push(e);
    } else {
      const m = minor[b.type] || (minor[b.type] = { type: b.type, n: 0, ids: [] });
      m.n++;
      m.ids.push(b.id);
    }
  }
  obs.buildings = bl;
  obs.minor_buildings = Object.values(minor).map((m) => ({ type: m.type, n: m.n }));
  const researching = [];
  void researching;

  // visible foreign units
  const seen = new Map();
  const allies = {};
  for (const u of game.units.values()) {
    if (u.dead || u.owner === pid) continue;
    const ix = tx(u.x), iy = tx(u.y);
    if (!p.vis[iy * W + ix]) continue;
    if (game.team[u.owner] === p.team) {
      allies[u.type] = (allies[u.type] || 0) + 1;
      continue;
    }
    const key = u.owner + ':' + u.type + ':' + Math.floor(fr(u.y) / 8000) * 100 + Math.floor(fr(u.x) / 8000);
    let g = seen.get(key);
    if (!g) seen.set(key, (g = { owner: u.owner, type: u.type, ids: [], sx: 0, sy: 0, hp: 0, maxhp: 0 }));
    g.ids.push(u.id);
    g.sx += u.x;
    g.sy += u.y;
    g.hp += u.hp;
    g.maxhp += u.maxhp;
  }
  obs.enemy_units = [...seen.values()]
    .sort((a, b) => b.ids.length - a.ids.length || a.type.localeCompare(b.type))
    .map((g) => {
      const n = g.ids.length;
      const e = { type: g.type, n, xy: [tx(g.sx / n), tx(g.sy / n)], hp: Math.round((100 * g.hp) / g.maxhp), owner: g.owner };
      if (n <= 6) e.ids = idsToString(g.ids);
      return e;
    });
  if (Object.keys(allies).length) obs.ally_units_visible = allies;

  // a treasure chest (God mode event) is a normal visible object: only listed while its tile is in view
  if (game.chests.length) {
    const ch = game.chests.filter((c) => p.vis[tx(c.y) * W + tx(c.x)]).map((c) => ({ xy: [tx(c.x), tx(c.y)], reward: { ...c.reward } }));
    if (ch.length) obs.treasure_chests = ch;
  }

  // known foreign buildings
  const eb = [];
  const rest = {};
  for (const k of p.known.values()) {
    if (game.team[k.owner] === p.team) continue;
    if (CRITICAL.has(k.type)) {
      const e = { id: k.id, type: k.type, xy: [k.tx, k.ty], owner: k.owner, vis: k.vis };
      if (k.vis) e.hp = Math.round((100 * k.hp) / k.maxhp);
      else e.seen_ago = Math.floor((game.t - k.seen) / TICK_HZ);
      eb.push(e);
    } else {
      const m = rest[k.type + ':' + k.owner] || (rest[k.type + ':' + k.owner] = { type: k.type, owner: k.owner, n: 0, sx: 0, sy: 0, id: k.id });
      m.n++;
      m.sx += game.centreTile(pid, k.tx, game.players[k.owner].faction.buildings[k.type].size);
      m.sy += game.centreTile(pid, k.ty, game.players[k.owner].faction.buildings[k.type].size);
    }
  }
  obs.enemy_buildings = eb;
  obs.enemy_minor_buildings = Object.values(rest).map((m) => ({ type: m.type, n: m.n, xy: [game.symRound(m.sx / m.n), game.symRound(m.sy / m.n)], owner: m.owner, id: m.id }));

  // map knowledge
  const home = game.starts[pid - 1];
  const cl = [];
  for (const c of game.clusters) {
    if (!p.expl[c.cy * W + c.cx]) continue;
    const amt = game.clusterAmount(c);
    if (amt <= 0) continue;
    const d = Math.round(Math.sqrt((c.cx + 0.5 - (home.tx + 2)) ** 2 + (c.cy + 0.5 - (home.ty + 2)) ** 2)); // from the town centre middle
    cl.push({ id: c.id, res: c.res === 'wood' ? 'wood' : c.res, xy: [c.cx, c.cy], amt, d });
  }
  const perRes = {};
  const outCl = [];
  for (const c of cl.sort((a, b) => a.d - b.d || game.tieKey(pid, a.xy[0], a.xy[1]) - game.tieKey(pid, b.xy[0], b.xy[1]) || a.id - b.id)) {
    perRes[c.res] = (perRes[c.res] || 0) + 1;
    if (perRes[c.res] <= 4) {
      c.camp = game.dropDist(p, c.res === 'food' ? 'food' : c.res, c.xy[0] * 1000 + 500, c.xy[1] * 1000 + 500) <= (c.res === 'wood' ? 6 : 7);
      outCl.push(c);
    }
  }
  obs.resource_clusters = outCl;
  let explored = 0;
  for (let i = 0; i < p.expl.length; i++) explored += p.expl[i];
  obs.map = {
    size: game.W, explored_pct: Math.round((100 * explored) / (game.W * game.H)),
    start: [home.tx, home.ty],
    starts: game.starts.map((s, i) => ({ player: i + 1, xy: [s.tx, s.ty], rel: i + 1 === pid ? 'you' : game.team[i + 1] === p.team ? 'ally' : 'enemy' })),
    grid: coarseGrid(game, p),
  };
  if (p.standing.length) obs.standing_orders = standingObs(p);
  if (p.note) obs.note = p.note;
  const ev = p.events.filter((e) => e.t > since);
  if (ev.length) obs.events = ev.slice(-12).map((e) => ({ ...e, t: Math.floor(e.t / TICK_HZ) }));
  const rs = p.results.filter((r) => r.t >= since && since >= 0);
  if (rs.length) obs.results = rs.slice(-12).map((r) => ({ ...r, t: Math.floor(r.t / TICK_HZ) }));
  return obs;
}

// 16x16 overview, one char per block: ? unexplored, . open, f forest, ~ water, # cliff
function coarseGrid(game, p) {
  const W = game.W, B = Math.ceil(W / 16);
  const rows = [];
  for (let by = 0; by < 16; by++) {
    let row = '';
    for (let bx = 0; bx < 16; bx++) {
      let ex = 0, f = 0, w = 0, c = 0, n = 0;
      for (let y = by * B; y < Math.min(W, (by + 1) * B); y++)
        for (let x = bx * B; x < Math.min(W, (bx + 1) * B); x++) {
          const i = y * W + x;
          n++;
          ex += p.expl[i];
          const t = game.terrain[i];
          if (t === 1) f++;
          else if (t === 2) w++;
          else if (t === 3) c++;
        }
      if (ex * 4 < n) row += '?';
      else if (w * 3 > n) row += '~';
      else if (c * 4 > n) row += '#';
      else if (f * 3 > n) row += 'f';
      else row += '.';
    }
    rows.push(row);
  }
  return rows;
}

// Static rules summary (put it in the system prompt, not in every observation).
export function catalog(factionId = 'default', rules = resolveRules()) {
  const f = mergedFaction(factionId, rules);
  const units = {};
  for (const [k, u] of Object.entries(f.units))
    units[k] = {
      cls: u.cls, at: u.from, tier: u.tier, cost: u.cost, secs: u.time, pop: u.pop, hp: u.hp, atk: u.atk, dmg: u.dmg, range: u.range, speed: u.speed,
      armour: u.armour, bonus_pct_vs: u.bonus || undefined, only: u.only,
    };
  const buildings = {};
  for (const [k, b] of Object.entries(f.buildings))
    buildings[k] = {
      size: b.size, tier: b.buildTier || b.tier, cost: b.cost, secs: b.time, hp: b.hp, pop: b.pop, trains: b.train, drop_off: b.drop,
      attack: b.attack ? { atk: b.attack.atk, range: b.attack.range } : undefined,
    };
  const techs = {};
  for (const [k, t] of Object.entries(f.techs)) techs[k] = { at: t.at, tier: t.tier, cost: t.cost, secs: t.time, requires: t.req };
  return {
    time_limit_s: rules.timeLimitS, rules, pop_max: POP_MAX, tiers: TIERS, gather_rate_per_s: GATHER.rate, carry: GATHER.carry, units, buildings, techs,
    counters: 'spearman beats cavalry; archer beats infantry; skirmisher beats archer; light_cavalry beats archer and siege; ram/catapult beat buildings; melee and pierce armour reduce damage by 10% per point',
  };
}

export function observeJSON(game, pid, opts) {
  return JSON.stringify(observe(game, pid, opts));
}
