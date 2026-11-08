// Shared machinery of the scripted bots. A bot only sees the JSON observation (sim/observe.mjs) and
// answers with commands of the public command API (sim/commands.mjs): the same interface an LLM gets.
import { catalog } from '../../sim/observe.mjs';
import { resolveRules } from '../../sim/rules.mjs';
import { stringToIds, idsToString } from '../../sim/util.mjs';
import { worldBehaviour } from './world-bot.mjs';

const CATALOGS = {};
const catalogFor = (preset) => (CATALOGS[preset || 'classic'] ||= catalog('default', resolveRules(preset || 'classic')));
let RULES = catalogFor('classic'); // the catalog of the rule preset the bot is playing (set from the observation)
const MIL_BUILDINGS = new Set(['barracks', 'archery_range', 'stables', 'siege_workshop', 'castle']);
// units that may be detached to hold a relic shrine (no siege, no support, no sappers)
export const SQUAD_TYPES = new Set(['spearman', 'swordsman', 'archer', 'skirmisher', 'light_cavalry', 'heavy_cavalry', 'bulwark']);
// Tuning hook for balance runs: TUNE='{"key": value}' overrides single bot parameters (default values are the shipped ones; unset in normal use).
const TUNE = process.env.TUNE ? JSON.parse(process.env.TUNE) : {};
export const tune = (k, d) => (k in TUNE ? TUNE[k] : d);
// Game-to-game variation. Two copies of one bot on a point-symmetric map play move for move alike, so they never decide a match:
// armies cancel out and both bases crumble in the same tick. Each game gets a seat-fair role (+1 / -1; see ingest) that scales the
// worker target by up to JITTER_WORKERS. tools/seat-bias.mjs switches it off for the symmetry checks (botOptions.roleJitter).
export const botOptions = { roleJitter: true };
const JITTER_WORKERS = 0.08;
const HELD_EVENTS_MAX = 200; // events kept across skipped turns (a long skip must not grow without bound)
const sumOf = (c) => Object.values(c || {}).reduce((a, b) => a + b, 0);

const dist = (a, b) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2);
const costOf = (c) => c || {};

export class ScriptedBot {
  constructor(profile) {
    this.profile = profile;
    this.name = profile.name;
    this.intent = '';
    this.s = {
      init: false, home: null, dir: [1, 0], perp: [0, 1], rally: null, rallied: new Set(), cool: {}, counters: {},
      state: 'build', launchValue: 0, launchT: 0, lastOrderT: -99, defendUntil: 0, enemyComp: null, enemyCompT: -999,
      wallDone: false, lastTarget: null, campsFor: {},
    };
  }

  // ---- budget helpers ----
  can(cost, keep) {
    for (const [r, v] of Object.entries(costOf(cost))) if (this.bud[r] - (keep ? keep[r] || 0 : 0) < v) return false;
    return true;
  }
  pay(cost) {
    for (const [r, v] of Object.entries(costOf(cost))) this.bud[r] -= v;
  }
  send(cmd) {
    this.cmds.push(cmd);
    return cmd;
  }
  cooled(key, o, secs) {
    if ((this.s.cool[key] || 0) > o.t) return false;
    this.s.cool[key] = o.t + secs;
    return true;
  }

  // Boundary coordinate (tile edges are integers) -> tile index. First seat: nearest tile corner, as always.
  // Second seat: the exact point mirror of what the first seat would pick for the mirrored coordinate, so every
  // position the bot picks is the mirror image of the other seat's pick.
  tile(v) {
    const n = this.s.size;
    return this.s.flip ? n - 1 - Math.round(n - v) : Math.round(v);
  }

  // tile containing the point v; exact mirror image from the other seat (tile() rounds, which differs on half tiles)
  tileOf(v) {
    const n = this.s.size;
    return this.s.flip ? n - 1 - Math.floor(n - v) : Math.floor(v);
  }

  // offset from the town centre middle along (ahead) the way to the enemy and (side) across it, in tiles
  pos(o, ahead, side) {
    const s = this.s;
    return [this.tile(s.home[0] + 2 + s.dir[0] * ahead + s.perp[0] * side), this.tile(s.home[1] + 2 + s.dir[1] * ahead + s.perp[1] * side)];
  }

  // Footprint tile of a building (top-left tile `xy`, given type) that lies nearest to our own base. It is a
  // corner tile, so it has a free neighbour and units can walk to it; and it is the same tile, seen from the
  // other seat, for the mirrored building (a fixed top-left corner would not be).
  cornerOf(xy, type) {
    const sz = RULES.buildings[type] ? RULES.buildings[type].size : 1, h = this.s.hc, f = this.s.flip;
    // exactly level with the middle: first seat takes the low corner, second seat the high one (mirror images)
    const pick = (hv, v) => {
      const mid = v + (sz - 1) / 2;
      return hv < mid || (hv === mid && !f) ? v : v + sz - 1;
    };
    return [pick(h[0], xy[0]), pick(h[1], xy[1])];
  }

  ingest(o) {
    const s = this.s;
    RULES = catalogFor(o.preset);
    if (!s.init) {
      s.init = true;
      s.size = o.map.size;
      s.home = o.map.start;
      const c = o.map.size / 2;
      let dx = c - s.home[0], dy = c - s.home[1];
      const enemyStarts = o.map.starts.filter((x) => x.rel === 'enemy');
      if (enemyStarts.length) {
        // direction to the nearest enemy start
        enemyStarts.sort((a, b) => dist(a.xy, s.home) - dist(b.xy, s.home));
        dx = enemyStarts[0].xy[0] - s.home[0];
        dy = enemyStarts[0].xy[1] - s.home[1];
      }
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      // second seat = the one whose start comes later in reading order (same rule as the simulation)
      const es = enemyStarts.length ? enemyStarts[0].xy : null;
      s.flip = !!es && (s.home[1] > es[1] || (s.home[1] === es[1] && s.home[0] > es[0]));
      // seat-fair role of this game: a hash of the resource clusters in sight at the start, in the frame of the first seat. The map is point
      // symmetric, so both bots compute the same hash (a hash of the start tiles would be the same in every game); the seats get opposite roles.
      let hsh = 0;
      for (const cl of o.resource_clusters || []) hsh = (hsh + Math.imul((s.flip ? o.map.size - 1 - cl.xy[0] : cl.xy[0]) * 131 + (s.flip ? o.map.size - 1 - cl.xy[1] : cl.xy[1]) * 7 + cl.amt, 2654435761)) | 0;
      s.role = ((hsh >>> 9) & 1 ? 1 : -1) * (s.flip ? -1 : 1);
      s.hc = [s.home[0] + 1.5, s.home[1] + 1.5]; // middle of the town centre in tile-index coordinates
      s.dir = [dx / len, dy / len];
      s.perp = [-s.dir[1], s.dir[0]];
      s.rally = this.pos(o, 12, 0);
    }
    // a tower order that failed for its spot (too close to another tower, no site): do not ask for that slot again
    if (s.towReq) for (const r of o.results || []) if (r.cmd === 'build' && !r.ok && (r.error === 'too_close' || r.error === 'no_site') && r.t >= s.towReq.t) {
      (s.badTower || (s.badTower = new Set())).add(s.towReq.pos);
      s.towReq = null;
      break;
    }
    const cnt = {}, total = {};
    for (const b of o.buildings) {
      total[b.type] = (total[b.type] || 0) + 1;
      if (b.build === undefined) cnt[b.type] = (cnt[b.type] || 0) + 1;
    }
    for (const m of o.minor_buildings) {
      cnt[m.type] = (cnt[m.type] || 0) + m.n;
      total[m.type] = (total[m.type] || 0) + m.n;
    }
    this.cnt = cnt;
    this.total = total;
    const have = {}, queued = {};
    for (const g of o.units) have[g.type] = (have[g.type] || 0) + g.n;
    let queuedWorkers = 0;
    for (const b of o.buildings)
      for (const q of b.queue || []) {
        const m = /^(.*)x(\d+)$/.exec(q);
        if (!m) continue;
        queued[m[1]] = (queued[m[1]] || 0) + +m[2];
      }
    queuedWorkers = queued.worker || 0;
    this.have = have;
    this.queued = queued;
    this.queuedWorkers = queuedWorkers;
    let armyN = 0;
    for (const g of o.units) armyN += g.n;
    // the shrine squad: detached soldiers that the army logic leaves alone
    const alive = new Set();
    for (const g of o.units) for (const id of stringToIds(g.ids) || []) alive.add(id);
    s.squad = new Set([...(s.squad || [])].filter((id) => alive.has(id)));
    let sqN = 0, sqV = 0;
    if (s.squad.size) for (const g of o.units) { const k = (stringToIds(g.ids) || []).filter((id) => s.squad.has(id)).length; sqN += k; sqV += k * sumOf(RULES.units[g.type]?.cost); }
    this.squadN = sqN;
    this.squadValue = sqV;
    // the landing party (agents/scripted/world-bot.mjs): soldiers on their way to a transport, aboard, or ashore at the enemy coast
    const aboard = new Set();
    for (const sh of o.ships || []) if (sh.cargo) for (const id of stringToIds(sh.cargo) || []) aboard.add(id);
    s.party = new Set([...(s.party || [])].filter((id) => alive.has(id) || aboard.has(id)));
    let pN = 0, pV = 0;
    if (s.party.size) for (const g of o.units) { const k = (stringToIds(g.ids) || []).filter((id) => s.party.has(id)).length; pN += k; pV += k * sumOf(RULES.units[g.type]?.cost); }
    this.partyN = pN;
    this.partyValue = pV;
    this.armyN = armyN - sqN - pN;
    // enemy composition memory
    if (o.enemy_units.length) {
      const c = {};
      let n = 0;
      for (const e of o.enemy_units) {
        c[e.type] = (c[e.type] || 0) + e.n;
        n += e.n;
      }
      s.enemyComp = c;
      s.enemyN = n;
      s.enemyCompT = o.t;
    } else if (o.t - s.enemyCompT > 90) s.enemyComp = null;
  }

  // Thinking rate (profile.thinkEvery, game seconds; the weaker solo levels). Between two decisions the bot only reads: ingest() above runs
  // for every observation, and the events of a skipped observation are kept for the next real decision (LiveMatch moves sinceTick on every
  // call, so an "attacked" or "building_lost" of a skipped turn would never be seen again). Returns the observation to decide on, or null.
  // A profile without thinkEvery (the four style bots) always decides on the observation as it came: nothing changes for them.
  gateThink(o) {
    const every = this.profile.thinkEvery, s = this.s;
    if (!every) return o;
    if (o.t < (s.nextThinkT || 0)) {
      const held = (s.heldEvents ||= []);
      held.push(...(o.events || []));
      if (held.length > HELD_EVENTS_MAX) held.splice(0, held.length - HELD_EVENTS_MAX);
      return null;
    }
    s.nextThinkT = o.t + every;
    if (!s.heldEvents || !s.heldEvents.length) return o;
    const merged = { ...o, events: [...s.heldEvents, ...(o.events || [])] };
    s.heldEvents = [];
    return merged;
  }

  think(o) {
    this.cmds = [];
    this.bud = { ...o.res };
    this.ingest(o);
    o = this.gateThink(o);
    if (!o) return this.cmds;
    const s = this.s;
    const P = this.profile;
    const sdS = tune("sd", RULES.sudden_death_s || 0); // the observation has no rules block: read the start of sudden death from the preset catalog
    s.sudden = !!(sdS && o.t >= sdS); // sudden death: no building, all-in
    this.reserve = {};
    worldBehaviour(this, o); // taunts, and the navy on coast maps (agents/scripted/world-bot.mjs)
    this.eco(o);
    this.scouting(o);
    this.infrastructure(o);
    this.advanceAndTech(o);
    this.wonderLogic(o); // before the army: it saves up for the wonder (reserve) first
    this.military(o);
    this.marketLogic(o);
    this.shrineLogic(o);
    this.control(o);
    void P;
    // short human readable intent (for spectator HUDs)
    const last = this.cmds.filter((c) => c.cmd !== 'set_rally' && c.cmd !== 'gather').pop();
    let what = s.state === 'attack' ? 'attacking the enemy base' : o.t < 60 ? 'opening build' : 'building economy and army';
    if (last) {
      if (last.cmd === 'build') what = `building ${last.building_type}`;
      else if (last.cmd === 'train') what = `training ${last.count > 1 ? last.count + ' ' : ''}${last.unit_type}`;
      else if (last.cmd === 'research') what = `researching ${last.tech}`;
      else if (last.cmd === 'advance_tier') what = `advancing to tier ${o.tier + 1}`;
      else if (last.cmd === 'attack_move') what = o.t < s.defendUntil ? 'defending the base' : 'attack wave';
    }
    this.intent = `${this.name}: ${what}`.slice(0, 120);
    return this.cmds;
  }

  // ---------------- economy ----------------
  eco(o) {
    const P = this.profile, s = this.s;
    const wk = o.workers;
    const target = Math.round(P.workers(o, this) * (1 + (botOptions.roleJitter ? s.role || 0 : 0) * tune("jk", JITTER_WORKERS)));
    // workers
    const tcs = o.buildings.filter((b) => b.type === 'town_center' && b.build === undefined);
    const wTotal = wk.n + this.queuedWorkers;
    let popFree = o.pop.cap - o.pop.used;
    let more = target - wTotal;
    for (const tc of tcs) {
      if (more <= 0 || popFree <= 0) break;
      const q = (tc.queue || []).reduce((n, x) => n + +(/x(\d+)$/.exec(x)?.[1] || 0), 0);
      if (q >= 3) continue;
      const n = Math.min(more, 2, popFree, Math.floor(this.bud.food / 50));
      if (n <= 0) break;
      this.pay({ food: 50 * n });
      this.send({ cmd: 'train', building_id: tc.id, unit_type: 'worker', count: n });
      more -= n;
      popFree -= n;
    }
    // houses
    const unbuiltHouses = o.buildings.filter((b) => b.type === 'house' && b.build !== undefined).length;
    const producers = (this.cnt.barracks || 0) + (this.cnt.archery_range || 0) + (this.cnt.stables || 0) + (this.cnt.siege_workshop || 0) + tcs.length;
    const slack = 4 + 2 * producers;
    if (o.pop.cap < o.pop.max && o.pop.cap - o.pop.used <= slack && unbuiltHouses < (slack > 10 ? 2 : 1) && this.can({ wood: 40 }) && wk.n > 0) {
      const k = this.total.house || 0;
      if (this.cooled('house', o, 6)) {
        this.pay({ wood: 40 });
        this.send({ cmd: 'build', building_type: 'house', near: this.pos(o, -9 - 3 * Math.floor(k / 5), ((k % 5) - 2) * 3.5), worker_ids: 'auto' });
      }
    }
    // resource infrastructure + allocation
    const ratio = { ...P.ratio(o, this) };
    for (const r of Object.keys(ratio)) ratio[r] = Math.max(ratio[r] > 0 ? 3 : 0, ratio[r] / (1 + o.res[r] / 1200));
    const clusters = o.resource_clusters;
    const bestCluster = (res) => {
      const all = clusters.filter((c) => c.res === res);
      const list = all.filter((c) => c.amt >= 250);
      return list.find((c) => c.camp) || list[0] || all[0] || null;
    };
    const want = {};
    const sum = Object.values(ratio).reduce((a, b) => a + b, 0) || 1;
    for (const r of ['food', 'wood', 'gold', 'stone']) want[r] = bestCluster(r) || (r === 'food' && this.total.farm) ? Math.round((wk.n * ratio[r]) / sum) : 0;
    // camps
    const camps = [['wood', 'lumber_camp'], ['gold', 'mining_camp'], ['stone', 'mining_camp']];
    for (const [res, camp] of camps) {
      const c = bestCluster(res);
      if (!c || c.camp || want[res] < 2 || c.d > 45) continue;
      if (o.buildings.some((b) => b.type === camp && b.build !== undefined)) continue;
      const built = (s.campsFor[c.id] = s.campsFor[c.id] || 0);
      if (built >= 2) continue;
      if (this.can({ wood: 60 }) && this.cooled('camp' + c.id, o, 90)) {
        s.campsFor[c.id]++;
        this.pay({ wood: 60 });
        this.send({ cmd: 'build', building_type: camp, near: c.xy, worker_ids: 'auto' });
      }
    }
    // mill near berries / farms near the town center or mill
    const food = bestCluster('food');
    if (P.mill && food && !food.camp && food.d > 8 && food.d < 40 && !this.total.mill && this.can({ wood: 80 }) && this.cooled('mill', o, 20)) {
      this.pay({ wood: 80 });
      this.send({ cmd: 'build', building_type: 'mill', near: food.xy, worker_ids: 'auto' });
    }
    const berryAmt = clusters.filter((c) => c.res === 'food' && c.d < 30).reduce((a, c) => a + c.amt, 0);
    const farmWanted = Math.max(0, want.food - (berryAmt > 500 ? 6 : berryAmt > 150 ? 3 : 0));
    const farms = this.total.farm || 0;
    if (farms < farmWanted && wk.n >= 5) {
      const unb = o.buildings.filter((b) => b.type === 'farm' && b.build !== undefined).length;
      for (let i = 0; i < 2 - unb && farms + i < farmWanted && this.can({ wood: 50 }); i++) {
        const k = farms + i;
        const ring = [[-5, -1], [5, -1], [-5, 4], [5, 4], [-1, -5], [4, -5], [-1, 8], [4, 8], [-8, 1], [8, 1], [-8, 6], [8, 6]];
        const off = ring[k % ring.length];
        const hub = this.s.home, f = this.s.flip ? -1 : 1; // offsets are in the first seat's frame
        this.pay({ wood: 50 });
        this.send({ cmd: 'build', building_type: 'farm', near: [this.tile(hub[0] + 2 + f * off[0]), this.tile(hub[1] + 2 + f * (off[1] + 2 * Math.floor(k / ring.length)))], worker_ids: 'auto' });
      }
    }
    // allocation
    const cur = { food: wk.food, wood: wk.wood, gold: wk.gold, stone: wk.stone };
    const campOk = (res) => {
      const c = bestCluster(res);
      return !!c && (c.camp || res === 'food' || res === 'wood' || c.d <= 14);
    };
    let idle = wk.idle;
    const deficits = Object.keys(cur)
      .filter((r) => want[r] > cur[r] && campOk(r))
      .sort((a, b) => want[b] - cur[b] - (want[a] - cur[a]) || (a < b ? -1 : 1));
    let cmdsLeft = 3;
    for (const r of deficits) {
      if (cmdsLeft <= 0) break;
      const c = bestCluster(r);
      let need = want[r] - cur[r];
      if (r === 'food' && !(c || this.cnt.farm)) continue;
      // idle first
      if (idle > 0) {
        const n = Math.min(idle, need);
        this.send({ cmd: 'gather', count: n, from: 'idle', resource: r, near: c ? c.xy : undefined });
        idle -= n;
        need -= n;
        cmdsLeft--;
      }
      // then take from the biggest surplus
      if (need > 0 && cmdsLeft > 0) {
        let from = null, bs = 1;
        for (const q of Object.keys(cur)) if (q !== r && cur[q] - want[q] >= bs) { bs = cur[q] - want[q]; from = q; }
        if (from) {
          const n = Math.min(need, bs);
          this.send({ cmd: 'gather', count: n, from, resource: r, near: c ? c.xy : undefined });
          cur[from] -= n;
          cmdsLeft--;
        }
      }
    }
    // idle workers with nothing to do: default to food or wood
    if (idle > 0 && cmdsLeft > 0) {
      const r = bestCluster('wood') ? 'wood' : 'food';
      const c = bestCluster(r);
      this.send({ cmd: 'gather', count: idle, from: 'idle', resource: r, near: c ? c.xy : undefined });
    }
  }

  // ---------------- scouting ----------------
  // One scout from the town center (profile.scouts = [first time, how many in total over the game], false = none); idle scouts
  // explore the nearest unexplored block. What they see feeds the counter logic of mixWeights.
  scouting(o) {
    const P = this.profile, s = this.s;
    const cfg = P.scouts === undefined ? [60, 2] : P.scouts;
    if (!cfg) return;
    const sc = o.scouts || [];
    for (const u of sc) if (u.act === 'idle' && this.cooled('scout' + u.id, o, 8)) this.send({ cmd: 'scout', unit_id: u.id });
    s.scoutsBought = s.scoutsBought || 0;
    if (o.t < cfg[0] || sc.length || (this.queued.scout || 0) || s.scoutsBought >= cfg[1] || o.pop.cap - o.pop.used < 1) return;
    const tc = o.buildings.find((b) => b.type === 'town_center' && b.build === undefined && (b.queue || []).length < 2);
    const d = RULES.units.scout;
    if (!tc || !this.can(d.cost, this.reserve) || !this.cooled('scoutbuy', o, 60)) return;
    s.scoutsBought++;
    this.pay(d.cost);
    o.pop.used += d.pop;
    this.send({ cmd: 'train', building_id: tc.id, unit_type: 'scout', count: 1 });
  }

  // ---------------- buildings ----------------
  infrastructure(o) {
    const P = this.profile, s = this.s;
    if (s.sudden) return; // nothing can be built any more
    const plan = P.buildings(o, this);
    const unbuiltMil = o.buildings.filter((b) => MIL_BUILDINGS.has(b.type) && b.build !== undefined).length;
    let started = unbuiltMil;
    for (const [type, n] of plan) {
      const d = RULES.buildings[type];
      if ((this.total[type] || 0) >= n) continue;
      if (d.tier > o.tier) continue;
      const caps = RULES.rules.towerCaps;
      if (type === 'tower' && caps && (this.total.tower || 0) >= caps[Math.min(o.tier, caps.length) - 1]) continue; // at the rule preset's tower limit
      const isMil = MIL_BUILDINGS.has(type);
      if (isMil && started >= (P.parallelBuilds || 1)) break;
      if (!this.can(d.cost, this.reserve)) break;
      if (!this.cooled('b' + type, o, 12)) continue;
      const k = this.total[type] || 0;
      let near;
      if (type === 'tower') { near = this.towerSpot(o, k); s.towReq = { pos: near.join(','), t: o.t }; }
      else if (type === 'blacksmith') near = this.pos(o, 2, 11);
      else if (type === 'siege_workshop') near = this.pos(o, 8, -12);
      else if (type === 'stables') near = this.pos(o, 8, 11);
      else if (type === 'town_center') near = this.pos(o, 18, 0);
      else if (type === 'castle') near = this.pos(o, 10, 0);
      else near = this.pos(o, 8, (k % 2 ? 1 : -1) * (3 + 4 * Math.floor(k / 2)));
      this.pay(d.cost);
      this.send({ cmd: 'build', building_type: type, near, worker_ids: 'auto' });
      if (isMil) started++;
      if (started > 1 && isMil) break;
    }
    void s;
    if (P.walls && !s.wallDone && o.tier >= 2 && (this.cnt.tower || 0) >= 2 && this.can({ stone: 160, wood: 20 }) && this.cooled('wall', o, 30)) {
      s.wallDone = true;
      const a = this.pos(o, 16, -10), b = this.pos(o, 16, 10), m = this.pos(o, 16, 0);
      this.pay({ stone: 20, wood: 20 });
      this.send({ cmd: 'build', building_type: 'gate', near: m, worker_ids: 'auto' });
      this.pay({ stone: 126 });
      this.send({ cmd: 'build', building_type: 'wall', near: a, to: b, worker_ids: 'auto' });
    }
  }

  // Next free tower slot: an arc in front of the base, slots spaced wider than the rule preset's minimum tower spacing
  // (a slot too close to an existing tower fails with "too_close"). Slots next to a lost tower are reused.
  towerSpot(o, k) {
    if (!RULES.rules.towerSpacing) return this.pos(o, 13, ((k % 6) - 2.5) * 5); // no spacing rule: the classic layout
    const gap = RULES.rules.towerSpacing + 1;
    const own = o.buildings.filter((b) => b.type === 'tower').map((b) => b.xy);
    let first = null;
    for (let i = 0; i < 12; i++) {
      const pos = this.pos(o, 12 + gap * Math.floor(i / 4), ((i % 4) - 1.5) * gap);
      if (!first) first = pos;
      // slots lie on a rotated grid and the site search may shift a tower by a tile, so keep a margin of one tile over the preset's spacing
      if ((this.s.badTower || (this.s.badTower = new Set())).has(pos.join(','))) continue; // the site search put it too close to another tower last time
      if (!own.some((q) => Math.max(Math.abs(q[0] - pos[0]), Math.abs(q[1] - pos[1])) < gap)) return pos;
    }
    return first;
  }

  advanceAndTech(o) {
    const P = this.profile;
    const tcFree = o.buildings.some((b) => b.type === 'town_center' && b.build === undefined && !b.research);
    if (o.tier < 3 && !o.advancing && P.advance(o, this)) {
      const cost = RULES.tiers[o.tier + 1].cost;
      if (tcFree && this.can(cost)) {
        this.pay(cost);
        this.send({ cmd: 'advance_tier' });
      } else for (const [r, v] of Object.entries(cost)) this.reserve[r] = Math.max(this.reserve[r] || 0, v);
    }
    let n = 0;
    const done = new Set(o.techs || []);
    const busy = new Set();
    for (const b of o.buildings) if (b.research) for (const k of Object.keys(b.research)) busy.add(k);
    // priority techs (profile.priority): buy as soon as possible, and save up for them when the bank is short
    for (const name of P.priority ? P.priority(o, this) : []) {
      const t = RULES.techs[name];
      if (!t || done.has(name) || busy.has(name) || t.tier > o.tier || (t.requires && !done.has(t.requires))) continue;
      if (!o.buildings.some((bb) => bb.type === t.at && bb.build === undefined && !bb.research)) continue;
      if (this.can(t.cost, this.reserve)) {
        if (!this.cooled('t' + name, o, 15)) continue;
        this.pay(t.cost);
        this.send({ cmd: 'research', tech: name });
        n++;
      } else for (const [r, v] of Object.entries(t.cost)) this.reserve[r] = Math.max(this.reserve[r] || 0, v);
    }
    for (const name of P.techs(o, this)) {
      if (n >= 2) break;
      if (done.has(name) || busy.has(name)) continue;
      const t = RULES.techs[name];
      if (!t || t.tier > o.tier || (t.requires && !done.has(t.requires))) continue;
      const free = o.buildings.some((b) => b.type === t.at && b.build === undefined && !b.research);
      if (!free || !this.can(t.cost, this.reserve)) continue;
      if (!this.cooled('t' + name, o, 15)) continue;
      this.pay(t.cost);
      this.send({ cmd: 'research', tech: name });
      n++;
    }
  }

  // ---------------- military production ----------------
  mixWeights(o) {
    const P = this.profile;
    const w = { ...P.mix(o, this) };
    // counter the enemy composition we currently see
    const ec = this.s.enemyComp;
    if (ec && this.s.enemyN >= 4) {
      const share = { cavalry: 0, ranged: 0, infantry: 0, siege: 0 };
      for (const [t, n] of Object.entries(ec)) {
        const u = RULES.units[t];
        if (u && share[u.cls] !== undefined) share[u.cls] += n / this.s.enemyN;
      }
      const boost = (type, f) => {
        if (w[type] !== undefined) w[type] *= f;
      };
      if (share.cavalry > 0.3) { boost('spearman', 2.5); boost('heavy_cavalry', 0.5); }
      if (share.ranged > 0.3) { boost('skirmisher', 2.5); boost('light_cavalry', 2); }
      if (share.infantry > 0.4) { boost('archer', 2); boost('catapult', 1.5); boost('bulwark', 0.6); }
      if (share.siege > 0.2) boost('light_cavalry', 2.5);
      if (share.ranged > 0.3) boost('bulwark', 2.5); // arrows barely hurt it
    }
    // fortified enemies (towers known): bring siege
    if (o.enemy_buildings.filter((b) => b.type === 'tower').length >= 2) {
      if (w.catapult !== undefined) w.catapult *= 3;
      if (w.ram !== undefined) w.ram *= 2.5;
      if (w.mortar !== undefined) w.mortar *= 3; // outranges the towers
      if (w.sapper !== undefined) w.sapper *= 1.5;
      if (w.bulwark !== undefined) w.bulwark *= 2; // walks a siege train through tower fire
    }
    // an enemy wonder is counting down: siege to bring it down fast
    if (this.enemyWonder(o)) {
      if (w.ram !== undefined) w.ram *= 2.5;
      if (w.catapult !== undefined) w.catapult *= 2;
      if (w.mortar !== undefined) w.mortar *= 2;
    }
    // enemy ranged units shoot sappers down: lean on the other tools
    if (this.s.enemyN >= 4 && ec) {
      const rg = Object.entries(ec).reduce((a, [t, n]) => a + (RULES.units[t]?.cls === 'ranged' ? n : 0), 0) / this.s.enemyN;
      if (rg > 0.45 && w.sapper !== undefined) w.sapper *= 0.5;
    }
    // units that need a tech are only built once it is done
    for (const u of Object.keys(w)) {
      const need = RULES.units[u]?.needs_tech;
      if (need && !(o.techs || []).includes(need)) w[u] = 0;
    }
    return w;
  }

  military(o) {
    const P = this.profile;
    if (!this.s.init) return;
    const w = this.mixWeights(o);
    const keep = this.reserve;
    const popFree = () => o.pop.cap - o.pop.used;
    let used = 0;
    const prod = o.buildings.filter((b) => MIL_BUILDINGS.has(b.type) && b.build === undefined);
    // order: spread over buildings by least queue
    const rank = { castle: 0, siege_workshop: 0, stables: 1, barracks: 2, archery_range: 3 };
    prod.sort((a, b) => rank[a.type] - rank[b.type] || (a.queue || []).length - (b.queue || []).length || a.id - b.id);
    // priority units (profile.priorityUnits -> [{unit, max}]): buy as soon as one can be paid and save up for it while the bank is short
    for (const { unit, max } of P.priorityUnits ? P.priorityUnits(o, this) : []) {
      const d = RULES.units[unit];
      if (!d || d.tier > o.tier || (d.needs_tech && !(o.techs || []).includes(d.needs_tech))) continue;
      if ((this.have[unit] || 0) + (this.queued[unit] || 0) >= max || o.pop.cap - o.pop.used < d.pop) continue;
      const pb = prod.find((b) => b.type === d.at && (b.queue || []).length < 2);
      if (!pb) continue;
      if (this.can(d.cost, keep)) {
        this.pay(d.cost);
        o.pop.used += d.pop;
        this.queued[unit] = (this.queued[unit] || 0) + 1;
        this.send({ cmd: 'train', building_id: pb.id, unit_type: unit, count: 1 });
      } else for (const [r, v] of Object.entries(d.cost)) keep[r] = Math.max(keep[r] || 0, v);
    }
    for (const b of prod) {
      if (!this.rallyOk(b)) continue;
      const qn = (b.queue || []).length;
      if (qn >= 3) continue;
      const opts = Object.keys(w).filter((u) => RULES.units[u] && RULES.units[u].at === b.type && RULES.units[u].tier <= o.tier && w[u] > 0);
      if (!opts.length) continue;
      // deficit pick: weight / (have + queued + 1); fall back to cheaper options when we cannot pay
      const ranked = opts
        .map((u) => ({ u, sc: w[u] / ((this.have[u] || 0) + (this.queued[u] || 0) + 1) }))
        .sort((x, y) => y.sc - x.sc || (x.u < y.u ? -1 : 1));
      for (const { u: best } of ranked) {
        const d = RULES.units[best];
        const n = Math.min(P.batch || 2, Math.floor(popFree() / d.pop));
        let done = false;
        for (let k = n; k >= 1 && !done; k--) {
          const cost = {};
          for (const [r, v] of Object.entries(d.cost)) cost[r] = v * k;
          if (this.can(cost, keep)) {
            this.pay(cost);
            o.pop.used += d.pop * k;
            this.queued[best] = (this.queued[best] || 0) + k;
            used++;
            this.send({ cmd: 'train', building_id: b.id, unit_type: best, count: k });
            done = true;
          }
        }
        if (done) break;
        // saving for a strongly preferred unit that we cannot afford yet: do not dribble cheap ones forever
        if (ranked[0].sc > 2 * (ranked.find((r) => r.u === best)?.sc || 1) && this.armyN > 6) break;
      }
    }
    void used;
  }

  rallyOk(b) {
    const s = this.s;
    if (!s.rallied.has(b.id)) {
      s.rallied.add(b.id);
      this.send({ cmd: 'set_rally', building_id: b.id, xy: s.rally });
    }
    return true;
  }

  // ---------------- army control ----------------
  control(o) {
    const P = this.profile, s = this.s;
    if (!this.armyN) {
      if (s.state === 'attack') s.state = 'build';
      return;
    }
    // defence
    const threats = o.enemy_units.filter((e) => dist(e.xy, s.hc) < (P.defendRadius || 26));
    const attacked = (o.events || []).some((e) => e.type === 'attacked' && dist([e.x, e.y], s.hc) < 30);
    if ((threats.length || attacked) && (s.state !== 'attack' || P.alwaysDefend)) {
      if (o.t - s.lastOrderT >= 4) {
        let tgt = null;
        if (threats.length) {
          const N = s.size, sk = (t) => (s.flip ? [N - t.xy[0], N - t.xy[1]] : t.xy);
          threats.sort((a, b) => Math.round(100 * dist(a.xy, s.hc)) - Math.round(100 * dist(b.xy, s.hc)) || sk(a)[0] - sk(b)[0] || sk(a)[1] - sk(b)[1]);
          tgt = threats[0].xy;
        } else {
          const N = s.size, ek = (x) => (s.flip ? [N - x.x, N - x.y] : [x.x, x.y]);
          // the hit closest to the base (ties: same order from both seats); the order of the events is not the same for both seats
          const e = (o.events || []).filter((x) => x.type === 'attacked').sort((a, b) => Math.round(100 * dist([a.x, a.y], s.hc)) - Math.round(100 * dist([b.x, b.y], s.hc)) || ek(a)[0] - ek(b)[0] || ek(a)[1] - ek(b)[1])[0];
          // something hits us and nobody is in sight: a mortar shells from beyond view range, so sally out toward the enemy past the damaged building
          const mx = o.map.size - 1;
          tgt = [Math.max(0, Math.min(mx, this.tile(e.x + 0.5 + s.dir[0] * 9))), Math.max(0, Math.min(mx, this.tile(e.y + 0.5 + s.dir[1] * 9)))];
        }
        s.lastOrderT = o.t;
        s.defendUntil = o.t + 12;
        this.send({ cmd: 'attack_move', units: this.armyArg(o), target: tgt });
      }
      return;
    }
    this.sapperControl(o);
    const armyValue = o.army_value - this.squadValue - this.partyValue;
    const ew = this.enemyWonder(o), mine = this.ownWonder(o);
    if (s.state === 'build') {
      if (o.t > s.defendUntil && o.t - s.lastOrderT >= 10) {
        // gather at the rally point
        const loose = this.freeGroups(o).filter((g) => g.act === 'idle' && dist(g.xy, s.rally) > 10);
        if (loose.length) {
          s.lastOrderT = o.t;
          this.send({ cmd: 'move', units: loose.map((g) => g.ids).join(','), to: s.rally });
        }
      }
      const maxedOut = o.pop.used >= o.pop.max - 6 && armyValue > 1500;
      // an enemy wonder counts down: go for it with a decent army, or with whatever there is when time runs short
      const wonderGo = !!ew && armyValue > 300 && (armyValue >= tune('wgr', 0.15) * P.waveValue(o, this) || ew.secs_left <= tune('wgs', 260));
      // while our own wonder counts down the army stays home and defends it
      const shr = o.victory && o.victory.shrines;
      // the enemy is running away on shrine points: take the shrines back with the army before it is too late
      const shrineGo = P.shrineGo !== false && tune('sgo', 1) && !!shr && shr.vp.enemy >= 0.5 * shr.target && shr.vp.enemy > shr.vp.yours + 100 && armyValue >= tune('sgr', 0.8) * P.waveValue(o, this) && shr.points.some((p) => p.holder === 'enemy');
      const holdHome = !!mine && !ew;
      if (!holdHome && (s.sudden || (armyValue >= P.waveValue(o, this) && o.t >= (P.earliestAttack ? P.earliestAttack(o, this) : 0)) || maxedOut || wonderGo || shrineGo)) { // sudden death: everything attacks
        s.state = 'attack';
        s.launchValue = armyValue;
        s.launchT = o.t;
        s.lastOrderT = o.t;
        const t = this.pickTarget(o);
        s.lastTarget = t;
        this.send({ cmd: 'attack_move', units: this.armyArg(o), target: t });
      }
      return;
    }
    // attacking: keep idle units moving toward the current target; fall back when the wave is spent
    if (armyValue < s.launchValue * (P.retreatRatio || 0.25) && !(ew && ew.secs_left < 200)) {
      s.state = 'build';
      s.lastOrderT = o.t;
      this.send({ cmd: 'move', units: this.armyArg(o) || 'army', to: s.rally });
      return;
    }
    if (o.t - s.lastOrderT >= 8) {
      const idleG = this.freeGroups(o).filter((g) => g.act === 'idle' && g.type !== 'sapper');
      if (idleG.length) {
        s.lastOrderT = o.t;
        const t = this.pickTarget(o);
        s.lastTarget = t;
        this.send({ cmd: 'attack_move', units: idleG.map((g) => g.ids).join(','), target: t });
      }
    }
  }

  // The army without the sappers: sappers are glass cannons that die in field fights, so they stay home until the wave reaches
  // the enemy base (sapperControl) and then run straight at a building.
  armyArg(o) {
    const g = this.freeGroups(o).filter((u) => u.type !== 'sapper');
    const det = this.s.squad.size || this.s.party.size;
    if (g.length === o.units.length && !det) return 'army';
    return g.map((u) => u.ids).join(',') || (det ? '' : 'army');
  }

  // our unit groups without the soldiers of the shrine squad and the landing party
  freeGroups(o) {
    const sq = this.s.squad, pa = this.s.party;
    if ((!sq || !sq.size) && (!pa || !pa.size)) return o.units;
    const out = [];
    for (const g of o.units) {
      const ids = (stringToIds(g.ids) || []).filter((id) => !(sq && sq.has(id)) && !(pa && pa.has(id)));
      if (ids.length) out.push(ids.length === g.n ? g : { ...g, ids: idsToString(ids), n: ids.length });
    }
    return out;
  }

  // ---------------- victory paths ----------------
  // shrines nearest to our base first; ties in an order that looks the same from both seats
  sortedPoints(sh) {
    const s = this.s, N = s.size;
    const sk = (p) => (s.flip ? [N - p.xy[0], N - p.xy[1]] : p.xy);
    return [...sh.points].sort((a, b) => Math.round(dist(a.xy, s.hc)) - Math.round(dist(b.xy, s.hc)) || sk(a)[0] - sk(b)[0] || sk(a)[1] - sk(b)[1]);
  }

  enemyWonder(o) {
    const w = o.victory && o.victory.wonder;
    return w ? w.running.find((x) => x.owner === 'enemy') || null : null;
  }
  ownWonder(o) {
    const w = o.victory && o.victory.wonder;
    return w ? w.running.find((x) => x.owner === 'you') || null : null;
  }

  // The market: build one when a resource we need is short while another piles up, then swap the surplus.
  marketLogic(o) {
    if (this.s.sudden) return;
    const P = this.profile, s = this.s;
    if (P.market === false || tune('nomk_' + P.name, 0) || o.tier < 2 || o.t < 240) return;
    const bud = this.bud, res = this.reserve;
    const have = (this.total.market || 0) > 0;
    const short = { gold: Math.max(res.gold || 0, o.tier >= 2 ? 100 : 0) - bud.gold, stone: (res.stone || 0) - bud.stone, food: (res.food || 0) - bud.food, wood: (res.wood || 0) - bud.wood };
    const keep = { food: 400, wood: 400, stone: 200, gold: 300 };
    const surplus = {};
    for (const r of ['food', 'wood', 'stone', 'gold']) surplus[r] = bud[r] - Math.max(res[r] || 0, keep[r]);
    if (!have) {
      const lim = P.marketPile || 450;
      const pile = surplus.food > lim || surplus.wood > lim || surplus.stone > lim - 50;
      const d = RULES.buildings.market;
      if (d && pile && (short.gold > 0 || short.stone > 0) && this.can(d.cost, res) && this.cooled('market', o, 45) && !o.buildings.some((b) => b.type === 'market')) {
        this.pay(d.cost);
        this.send({ cmd: 'build', building_type: 'market', near: this.pos(o, -3, -12), worker_ids: 'auto' });
      }
      return;
    }
    if (!o.market || !this.cooled('trade', o, 10)) return;
    const need = ['gold', 'stone', 'food', 'wood'].filter((r) => short[r] > 20).sort((a, b) => short[b] - short[a])[0];
    if (!need) return;
    const from = ['food', 'wood', 'stone', 'gold'].filter((r) => r !== need && !(r === 'gold') && surplus[r] >= 150 && o.market.price_index[r] >= 600).sort((a, b) => surplus[b] - surplus[a])[0];
    if (!from) return;
    const rate = o.market.sell100[from][need]; // units of `need` for 100 of `from`
    if (!rate) return;
    let amt = Math.ceil((short[need] / rate) * 100 * 1.06);
    amt = Math.max(100, Math.min(1000, surplus[from], Math.ceil(amt / 10) * 10));
    amt = Math.floor(amt / 10) * 10;
    if (amt < 100) return;
    bud[from] -= amt;
    bud[need] += Math.floor((amt / 100) * rate);
    this.send({ cmd: 'trade', sell: from, buy: need, amount: amt });
  }

  // A wonder (profile.wonder): save up for it and build it behind the base once the army can guard it.
  wonderLogic(o) {
    if (this.s.sudden) return;
    const P = this.profile;
    if (!P.wonder || !o.victory || !o.victory.wonder || this.total.wonder || o.tier < 3) return;
    if (!P.wonder(o, this) || this.ownWonder(o)) return;
    const d = RULES.buildings.wonder;
    if (!d) return;
    if (this.can(d.cost) && this.cooled('wonder', o, 30)) {
      this.pay(d.cost);
      this.send({ cmd: 'build', building_type: 'wonder', near: this.pos(o, -7, -10), worker_ids: 'auto' });
    } else for (const [r, v] of Object.entries(d.cost)) this.reserve[r] = Math.max(this.reserve[r] || 0, v);
  }

  // Relic shrines: a squad of soldiers walks to the nearest shrine that is not ours (or is contested) and stands there; the
  // defensive bots also raise an outpost next to a shrine they hold. The squad runs when a much bigger force shows up.
  shrineLogic(o) {
    const P = this.profile, s = this.s;
    const sh = o.victory && o.victory.shrines;
    if (!sh || !P.shrineSquad) return;
    const cfg = P.shrineSquad(o, this);
    if (!cfg) return;
    const pts = this.sortedPoints(sh);
    const behind = sh.vp.enemy > sh.vp.yours + 40;
    const want = cfg.size * (behind ? 2 : 1);
    const lost = (p) => p.holder !== 'you' || p.units_near.enemy > 0;
    const avoid = (s.avoid ||= {});
    if ((s.lastSquad || 0) > 0 && this.squadN === 0) s.squadBan = o.t + (cfg.ban ?? 100); // the squad is gone: do not feed the next one straight in
    s.lastSquad = this.squadN;
    const targets = pts.filter((p) => lost(p) && (avoid[p.id] || 0) <= o.t && p.units_near.enemy < 2 * want);
    // recruit idle soldiers while the main army is not out attacking
    if (this.squadN < want && o.t >= cfg.from && o.t >= (s.squadBan || 0) && (s.state === 'attack' || o.army_value - this.squadValue >= (cfg.minArmy || 0)) && targets.length && this.cooled('squadrecruit', o, 10)) {
      // whole groups only, in an order that looks the same from both seats (single ids would pick different units for a mirrored player)
      const pick = [];
      const key = (g) => (s.flip ? [this.s.size - g.xy[0], this.s.size - g.xy[1]] : g.xy);
      const cand = this.freeGroups(o).filter((g) => SQUAD_TYPES.has(g.type) && g.act === 'idle').sort((x, y) => (x.type < y.type ? -1 : x.type > y.type ? 1 : key(x)[0] - key(y)[0] || key(x)[1] - key(y)[1]));
      for (const g of cand) {
        const ids = stringToIds(g.ids) || [];
        if (pick.length + ids.length <= want - this.squadN + (pick.length ? 0 : 2)) pick.push(...ids);
      }
      if (pick.length >= Math.min(3, want - this.squadN)) {
        for (const id of pick) s.squad.add(id);
        const t = targets[0];
        this.send({ cmd: 'attack_move', units: idsToString(pick), target: [this.tileOf(t.xy[0]), this.tileOf(t.xy[1])] });
        this.squadN += pick.length;
        this.armyN -= pick.length;
      }
    }
    if (s.squad.size && this.cooled('squadcmd', o, 8)) {
      // where is the squad: weighted centre of the groups that contain its members
      let cx = 0, cy = 0, n = 0;
      for (const g of o.units) {
        const k = (stringToIds(g.ids) || []).filter((id) => s.squad.has(id)).length;
        if (k) { cx += g.xy[0] * k; cy += g.xy[1] * k; n += k; }
      }
      if (!n) return;
      const c = [cx / n, cy / n];
      const near = pts.filter((p) => dist(p.xy, c) < 7).sort((a, b) => dist(a.xy, c) - dist(b.xy, c))[0];
      const ids = idsToString([...s.squad]);
      if (near && near.units_near.enemy >= Math.max(4, 2 * n)) { // outnumbered: pull back, stay away for a while
        avoid[near.id] = o.t + 90;
        this.send({ cmd: 'move', units: ids, to: s.rally });
        for (const id of [...s.squad]) s.squad.delete(id);
        return;
      }
      if (!near || near.holder === 'you') {
        const t = targets.find((p) => !near || p.id !== near.id);
        if (t && (!near || near.units_near.enemy === 0)) this.send({ cmd: 'attack_move', units: ids, target: [this.tileOf(t.xy[0]), this.tileOf(t.xy[1])] });
        else if (!near && !t) this.send({ cmd: 'move', units: ids, to: s.rally });
      }
    }
    // an outpost next to a held shrine
    if (P.outposts !== false && o.t > 420) {
      const held = pts.find((p) => p.holder === 'you' && !(s.outposts || (s.outposts = new Set())).has(p.id));
      const d = RULES.buildings.outpost;
      if (held && d && this.can(d.cost, this.reserve) && this.cooled('outpost', o, 40)) {
        s.outposts.add(held.id);
        this.pay(d.cost);
        const f = s.flip ? -1 : 1;
        this.send({ cmd: 'build', building_type: 'outpost', near: [this.tileOf(held.xy[0] + f * 3), this.tileOf(held.xy[1])], worker_ids: 'auto' });
      }
    }
  }

  sapperControl(o) {
    const s = this.s;
    const sap = o.units.filter((g) => g.type === 'sapper' && g.act !== 'attack');
    if (!sap.length || s.state !== 'attack' || o.t - s.launchT < 25 || !this.cooled('sapper', o, 6)) return;
    const army = o.units.filter((g) => g.type !== 'sapper' && g.type !== 'healer');
    if (!army.length) return;
    let cx = 0, cy = 0, n = 0;
    for (const g of army) { cx += g.xy[0] * g.n; cy += g.xy[1] * g.n; n += g.n; }
    const c = [cx / n, cy / n];
    let best = null, bs = Infinity;
    for (const b of o.enemy_buildings) {
      const sc = dist(b.xy, c) - (b.type === 'tower' ? 6 : b.type === 'town_center' || MIL_BUILDINGS.has(b.type) ? 3 : 0);
      if (b.type !== 'wall' && b.type !== 'gate' && sc < bs) { bs = sc; best = b; }
    }
    if (!best || dist(best.xy, c) > 24) return;
    this.send({ cmd: 'attack_move', units: sap.map((g) => g.ids).join(','), target: best.id });
  }

  pickTarget(o) {
    const s = this.s;
    const ew = this.enemyWonder(o);
    if (ew) return this.cornerOf([ew.xy[0], ew.xy[1]], 'wonder'); // a counting wonder beats everything else
    const shr = o.victory && o.victory.shrines;
    if (shr && shr.vp.enemy >= 0.4 * shr.target && shr.vp.enemy > shr.vp.yours) {
      const held = this.sortedPoints(shr).filter((p) => p.holder === 'enemy');
      if (held.length) return [this.tileOf(held[0].xy[0]), this.tileOf(held[0].xy[1])]; // they are winning on points: take their shrine
    }
    const fg = this.freeGroups(o);
    let c = s.hc; // centre of mass of the free army (does not depend on the order of the groups)
    if (fg.length) { let n = 0, cx = 0, cy = 0; for (const g of fg) { n += g.n; cx += g.xy[0] * g.n; cy += g.xy[1] * g.n; } c = [cx / n, cy / n]; }
    // ties must pick the same building from both seats (mirror-safe key in seat 1 frame, like the defence sorts)
    const N1 = o.map.size, tk = (b) => { const q = this.s.flip ? [N1 - b.xy[0], N1 - b.xy[1]] : b.xy; return q[0] * 4096 + q[1]; };
    const crit = o.enemy_buildings.map((b) => ({ ...b, xy: this.cornerOf(b.xy, b.type) })).sort((a, b) => dist(a.xy, c) - dist(b.xy, c) || tk(a) - tk(b));
    const prio = { town_center: 0, wonder: -4, castle: 1, barracks: 1, archery_range: 1, stables: 1, siege_workshop: 1, tower: 3, blacksmith: 2 };
    // nearest critical building, production and town centers first
    let best = null, bs = Infinity;
    for (const b of crit) {
      const sc = dist(b.xy, c) + (prio[b.type] ?? 2) * 6;
      if (sc < bs) { bs = sc; best = b.xy; }
    }
    if (best) return best;
    const minor = [...o.enemy_minor_buildings].sort((a, b) => dist(a.xy, c) - dist(b.xy, c) || tk(a) - tk(b));
    if (minor.length) return minor[0].xy;
    const starts = o.map.starts.filter((x) => x.rel === 'enemy').sort((a, b) => dist(a.xy, c) - dist(b.xy, c) || tk(a) - tk(b));
    // an enemy start we have not stood on yet; otherwise explore the nearest unexplored block
    const grid = o.map.grid;
    const B = o.map.size / 16;
    let un = null, ud = Infinity;
    for (let a = 0; a < 16; a++)
      for (let b2 = 0; b2 < 16; b2++) {
        const gy = s.flip ? 15 - a : a, gx = s.flip ? 15 - b2 : b2; // scan in the seat's own frame
        if (grid[gy][gx] === '?') {
          const xy = [this.tile((gx + 0.5) * B), this.tile((gy + 0.5) * B)];
          const d = dist(xy, c);
          if (d < ud) { ud = d; un = xy; }
        }
      }
    for (const st of starts) {
      const near = o.units.some((g) => dist(g.xy, st.xy) < 8);
      if (!near) return this.cornerOf(st.xy, 'town_center');
    }
    return un || (starts[0] ? this.cornerOf(starts[0].xy, 'town_center') : [Math.round(o.map.size / 2), Math.round(o.map.size / 2)]);
  }
}
