// Deterministic RTS simulation core. Fixed tick (10 Hz), integer math, seeded RNG.
// Players are 1-based ids (1..4). owner 0 = neutral. Units live in milli-tiles.
import { RNG } from './rng.mjs';
import {
  UNITS, BUILDINGS, TECHS, TIERS, GATHER, NODES, FOREST_WOOD, START, RULES, POP_MAX, SCORE, TIME_LIMIT_S,
  mergedFaction,
} from './data.mjs';
import { generateMap } from './mapgen.mjs';
import { loadMap, rowsToTerrain } from './mapio.mjs';
import { Paths } from './path.mjs';
import { hashStep, TICK_HZ } from './util.mjs';
import { installLogic } from './logic.mjs';
import { installCommands } from './commands.mjs';

const CELL = 8;

export class Game {
  constructor(opts = {}) {
    this.seed = opts.seed ?? 1;
    this.opts = { autoWorkers: true, ...opts };
    this.rng = new RNG((this.seed ^ 0x5bd1e995) >>> 0);
    const mapObj = opts.map ? loadMap(opts.map) : generateMap(this.seed, { players: opts.numPlayers || 2 });
    this.mapName = mapObj.name || 'map';
    this.W = this.H = mapObj.size;
    const NN = this.W * this.H;
    this.terrain = rowsToTerrain(mapObj.terrain, this.W);
    this.wood = new Int32Array(NN);
    for (let i = 0; i < NN; i++) if (this.terrain[i] === 1) this.wood[i] = FOREST_WOOD;
    for (const w of mapObj.wood || []) this.wood[w.ty * this.W + w.tx] = w.amount;
    this.blk = new Uint8Array(NN);
    this.occ = new Int32Array(NN);
    this.gate = new Uint8Array(NN);
    this.treeGat = new Uint8Array(NN);
    for (let i = 0; i < NN; i++) if (this.terrain[i] !== 0) this.blk[i] = 1;
    this.t = 0;
    this.nextId = 1;
    this.units = new Map();
    this.buildings = new Map();
    this.nodes = new Map();
    this.proj = [];
    this.dead = [];
    this.commandLog = [];
    this.over = false;
    this.winnerTeam = 0;
    this.endReason = '';
    this.gw = Math.ceil(this.W / CELL);
    this.cells = Array.from({ length: this.gw * this.gw }, () => []);
    this.starts = mapObj.players.map((p) => ({ tx: p.start.tx, ty: p.start.ty }));

    const n = mapObj.players.length;
    const specs = opts.players || (n === 2 ? [{ team: 1 }, { team: 2 }] : mapObj.players.map((_, i) => ({ team: i + 1 })));
    if (specs.length !== n) throw new Error(`map has ${n} player slots, got ${specs.length} player specs`);
    this.numPlayers = n;
    this.team = [0];
    this.players = [null];
    const teamState = new Map();
    for (let i = 0; i < n; i++) {
      const s = specs[i];
      const id = i + 1;
      const team = s.team ?? id;
      this.team[id] = team;
      if (!teamState.has(team))
        teamState.set(team, {
          vis: new Uint8Array(NN), expl: new Uint8Array(NN), known: new Map(), ids: [],
        });
      const ts = teamState.get(team);
      ts.ids.push(id);
      const fac = mergedFaction(s.faction || 'default');
      const p = {
        id, team, faction: fac, factionId: fac.id, name: s.name || `P${id}`,
        res: { food: 0, wood: 0, stone: 0, gold: 0 },
        tier: 1, techs: new Set(), stats: {}, bstats: {}, gatherPct: {}, carry: GATHER.carry,
        pop: 0, cap: 0, vis: ts.vis, expl: ts.expl, known: ts.known, groups: new Map(),
        results: [], events: [], killFeed: [], note: '', noteTick: 0, alive: true, resigned: false,
        gathered: { food: 0, wood: 0, stone: 0, gold: 0 }, killValue: 0, lostValue: 0, kills: 0, losses: 0,
        built: {}, trained: {}, unitStats: {}, queuedTechs: new Set(), start: this.starts[i], income: [],
      };
      for (const r of Object.keys(p.res)) p.res[r] = (START.resources[r] || 0) + (fac.startResources[r] || 0);
      for (const [k, v] of Object.entries(fac.gatherPct)) p.gatherPct[k] = v;
      this.players.push(p);
    }
    this.teamState = teamState;
    this.paths = new Paths(this);
    this.labelComponents();
    for (const p of this.players) if (p) this.computeStats(p);

    // resource nodes and clusters
    for (const nd of mapObj.nodes) this.addNode(nd.res, nd.tx, nd.ty, nd.amount);
    this.buildClusters();
    // players: buildings first (so vision exists), then units
    mapObj.players.forEach((mp, i) => {
      const id = i + 1;
      if (mp.buildings) for (const b of mp.buildings) this.addBuilding(id, b.type, b.tx, b.ty, true);
      else this.addBuilding(id, 'town_center', mp.start.tx, mp.start.ty, true);
    });
    for (const p of this.players) {
      if (!p) continue;
      p.comp = 0;
      for (const b of this.buildings.values()) {
        if (b.owner !== p.id || p.comp) continue;
        for (let i = -1; i <= b.size && !p.comp; i++)
          for (let j = -1; j <= b.size; j++) {
            const x = b.tx + i, y = b.ty + j;
            if (x < 0 || y < 0 || x >= this.W || y >= this.H) continue;
            if (this.comp[y * this.W + x]) { p.comp = this.comp[y * this.W + x]; break; }
          }
      }
    }
    this.updateVision();
    mapObj.players.forEach((mp, i) => {
      const id = i + 1;
      const p = this.players[id];
      if (mp.units) for (const u of mp.units) this.addUnit(id, u.type, u.tx * 1000 + 500, u.ty * 1000 + 500);
      else {
        const tc = [...this.buildings.values()].find((b) => b.owner === id && b.type === 'town_center') || [...this.buildings.values()].find((b) => b.owner === id);
        for (let k = 0; k < START.workers && tc; k++) {
          const pos = this.spawnPoint(tc, k);
          const u = this.addUnit(id, 'worker', pos[0], pos[1]);
          if (this.opts.autoWorkers) this.autoGather(u);
        }
      }
      this.recalcPop(p);
    });
    this.updateVision();
  }

  // Static connected components of walkable terrain (forest and water block). Used to reject
  // building sites and resource nodes that no worker could ever reach.
  labelComponents() {
    const W = this.W, H = this.H;
    this.comp = new Int32Array(W * H);
    let label = 0;
    const stack = [];
    for (let i = 0; i < W * H; i++) {
      if (this.comp[i] || this.terrain[i] !== 0) continue;
      label++;
      this.comp[i] = label;
      stack.push(i);
      while (stack.length) {
        const c = stack.pop();
        const x = c % W, y = (c / W) | 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const ni = ny * W + nx;
          if (!this.comp[ni] && this.terrain[ni] === 0) {
            this.comp[ni] = label;
            stack.push(ni);
          }
        }
      }
    }
  }

  // true if some tile around the rect lies in the walkable component `label`
  rectReachable(label, tx, ty, size) {
    const W = this.W;
    for (let i = -1; i <= size; i++)
      for (let j = -1; j <= size; j++) {
        if (i >= 0 && j >= 0 && i < size && j < size) continue;
        const x = tx + i, y = ty + j;
        if (x < 0 || y < 0 || x >= W || y >= this.H) continue;
        if (this.comp[y * W + x] === label) return true;
      }
    return false;
  }

  // ---------- lookups ----------
  get(id) {
    return this.units.get(id) || this.buildings.get(id) || this.nodes.get(id);
  }
  isAllied(a, b) {
    return this.team[a] === this.team[b];
  }
  tileOf(x, y) {
    return Math.floor(y / 1000) * this.W + Math.floor(x / 1000);
  }

  // ---------- stats ----------
  computeStats(p) {
    const fac = p.faction;
    p.stats = {};
    for (const [type, d] of Object.entries(fac.units)) {
      p.stats[type] = {
        cls: d.cls, atk: d.atk * 10, hp: d.hp, armour: { ...d.armour }, range: Math.round(d.range * 1000),
        speed: Math.round(d.speed * 100), sight: d.sight, cd: Math.max(1, Math.round(d.cd * 10)),
        proj: d.projectile ? Math.round(d.projectile * 100) : 0, splash: d.splash ? Math.round(d.splash * 1000) : 0,
        dmg: d.dmg, bonus: d.bonus || null, only: d.only || null, pop: d.pop,
      };
    }
    p.bstats = {};
    for (const [type, d] of Object.entries(fac.buildings)) {
      const a = d.attack;
      p.bstats[type] = {
        hp: d.hp, armour: { ...d.armour }, sight: d.sight,
        atk: a ? a.atk * 10 : 0, dmg: a ? a.dmg : null, cd: a ? Math.max(1, Math.round(a.cd * 10)) : 0,
        range: a ? Math.round(a.range * 1000) : 0, proj: a ? Math.round(a.projectile * 100) : 0, bonus: null,
      };
    }
    p.carry = GATHER.carry;
    p.gatherPct = { ...fac.gatherPct };
    for (const tn of p.techs) {
      const t = fac.techs[tn];
      if (!t) continue;
      if (t.units) {
        for (const [type, s] of Object.entries(p.stats)) {
          if (!(t.units.includes(type) || t.units.includes(s.cls))) continue;
          if (t.atkPct) s.atk = Math.floor((s.atk * (100 + t.atkPct)) / 100);
          if (t.hpPct) s.hp = Math.floor((s.hp * (100 + t.hpPct)) / 100);
          if (t.speedPct) s.speed = Math.floor((s.speed * (100 + t.speedPct)) / 100);
          if (t.range) s.range += t.range * 1000;
          if (t.sight) s.sight += t.sight;
          if (t.armour) for (const [k, v] of Object.entries(t.armour)) s.armour[k] += v;
        }
      }
      if (t.towerAtkPct) for (const s of Object.values(p.bstats)) if (s.atk) s.atk = Math.floor((s.atk * (100 + t.towerAtkPct)) / 100);
      if (t.towerRange) for (const s of Object.values(p.bstats)) if (s.range) s.range += t.towerRange * 1000;
      if (t.buildingHpPct) for (const s of Object.values(p.bstats)) s.hp = Math.floor((s.hp * (100 + t.buildingHpPct)) / 100);
      if (t.gather) for (const [k, v] of Object.entries(t.gather)) p.gatherPct[k] = (p.gatherPct[k] || 0) + v;
      if (t.carry) p.carry += t.carry;
    }
  }

  applyTechToEntities(p) {
    for (const u of this.units.values())
      if (u.owner === p.id) {
        const m = p.stats[u.type].hp;
        if (m !== u.maxhp) {
          u.hp += m - u.maxhp;
          u.maxhp = m;
        }
      }
    for (const b of this.buildings.values())
      if (b.owner === p.id) {
        const m = p.bstats[b.type].hp;
        if (m !== b.maxhp) {
          b.hp += m - b.maxhp;
          b.maxhp = m;
        }
      }
  }

  // ---------- entity creation ----------
  addUnit(owner, type, x, y) {
    const p = this.players[owner];
    const st = p.stats[type];
    const u = {
      id: this.nextId++, kind: 1, owner, type, x, y, hp: st.hp, maxhp: st.hp, ord: { t: 'idle' }, wp: null, cd: 0,
      res: null, amt: 0, gp: 0, tgt: 0, hitBy: 0, hitT: -999, dead: false, lastRes: null,
    };
    this.units.set(u.id, u);
    p.trained[type] = (p.trained[type] || 0) + 1;
    return u;
  }

  footprintTiles(tx, ty, size) {
    const out = [];
    for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) out.push((ty + j) * this.W + tx + i);
    return out;
  }

  occupy(e) {
    for (const i of this.footprintTiles(e.tx, e.ty, e.size)) {
      this.occ[i] = e.id;
      this.blk[i] = 1;
      if (e.kind === 2 && this.players[e.owner].faction.buildings[e.type].gate) this.gate[i] = e.owner;
    }
  }
  vacate(e) {
    for (const i of this.footprintTiles(e.tx, e.ty, e.size)) {
      if (this.occ[i] === e.id) this.occ[i] = 0;
      this.blk[i] = this.terrain[i] !== 0 || this.occ[i] !== 0 ? 1 : 0;
      this.gate[i] = 0;
    }
  }

  addBuilding(owner, type, tx, ty, built) {
    const p = this.players[owner];
    const d = p.faction.buildings[type];
    const bs = p.bstats[type];
    const b = {
      id: this.nextId++, kind: 2, owner, type, tx, ty, size: d.size, hp: built ? bs.hp : Math.max(1, Math.floor(bs.hp / 10)),
      maxhp: bs.hp, built, prog: 0, queue: [], research: null, rally: null, cd: 0, bt: -1, bn: 0, gat: 0, dead: false, tgt: 0,
    };
    this.buildings.set(b.id, b);
    this.occupy(b);
    p.built[type] = (p.built[type] || 0) + 1;
    return b;
  }

  addNode(res, tx, ty, amount) {
    const d = NODES[res];
    const n = { id: this.nextId++, kind: 3, owner: 0, res, tx, ty, size: d.size, amt: amount ?? d.amount, gat: 0, dead: false, cluster: -1 };
    this.nodes.set(n.id, n);
    this.occupy(n);
    return n;
  }

  // Free standing tile centre near a building for spawning units.
  spawnPoint(b, k = 0) {
    const W = this.W;
    const ring = [];
    for (let i = -1; i <= b.size; i++)
      for (let j = -1; j <= b.size; j++) {
        if (i >= 0 && j >= 0 && i < b.size && j < b.size) continue;
        const x = b.tx + i, y = b.ty + j;
        if (x < 0 || y < 0 || x >= W || y >= this.H) continue;
        if (this.blk[y * W + x]) continue;
        ring.push([x, y]);
      }
    if (!ring.length) {
      // fall back: widen
      for (let r = 2; r < 6 && !ring.length; r++)
        for (let i = -r; i <= b.size + r - 1; i++)
          for (let j = -r; j <= b.size + r - 1; j++) {
            const x = b.tx + i, y = b.ty + j;
            if (x < 0 || y < 0 || x >= W || y >= this.H || this.blk[y * W + x]) continue;
            ring.push([x, y]);
          }
      if (!ring.length) return [b.tx * 1000 + 500, b.ty * 1000 + 500];
    }
    let target = b.rally && b.rally.x !== undefined ? [Math.floor(b.rally.x / 1000), Math.floor(b.rally.y / 1000)] : null;
    if (!target) target = [this.W >> 1, this.H >> 1];
    let best = null, bd = Infinity;
    for (let i = 0; i < ring.length; i++) {
      const [x, y] = ring[(i + k) % ring.length];
      const d = (x - target[0]) ** 2 + (y - target[1]) ** 2 + (((i + k) % 3) * 0.1);
      if (d < bd) {
        bd = d;
        best = [x, y];
      }
    }
    // spread by k so units do not stack exactly
    const alt = ring[k % ring.length];
    const pick = k % 2 === 0 ? best : alt;
    return [pick[0] * 1000 + 500, pick[1] * 1000 + 500];
  }

  // ---------- clusters (resource summary regions) ----------
  buildClusters() {
    const W = this.W, H = this.H;
    this.clusters = [];
    this.tileCluster = new Int16Array(W * H).fill(-1);
    const CS = Math.max(4, Math.floor(this.W / 16)); // aligned with mirror symmetry
    const cw = Math.ceil(W / CS);
    const cells = new Map();
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        if (this.terrain[y * W + x] === 1) {
          const k = Math.floor(y / CS) * cw + Math.floor(x / CS);
          let c = cells.get(k);
          if (!c) cells.set(k, (c = { n: 0, sx: 0, sy: 0, tiles: [] }));
          c.n++;
          c.sx += x;
          c.sy += y;
          c.tiles.push(y * W + x);
        }
    for (const k of [...cells.keys()].sort((a, b) => a - b)) {
      const c = cells.get(k);
      if (c.n < 5) continue;
      const id = this.clusters.length;
      let amt = 0;
      for (const t of c.tiles) {
        this.tileCluster[t] = id;
        amt += this.wood[t];
      }
      this.clusters.push({ id, res: 'wood', cx: Math.round(c.sx / c.n), cy: Math.round(c.sy / c.n), amt, nodes: [] });
    }
    // node clusters: greedy by proximity and kind
    const groupKind = (r) => (r === 'berries' || r === 'herd' ? 'food' : r);
    for (const nd of this.nodes.values()) {
      const gk = groupKind(nd.res);
      let found = null;
      for (const c of this.clusters) {
        if (c.res === 'wood' || c.gk !== gk) continue;
        if ((c.cx - nd.tx) ** 2 + (c.cy - nd.ty) ** 2 <= 36) {
          found = c;
          break;
        }
      }
      if (!found) {
        found = { id: this.clusters.length, res: gk, gk, cx: nd.tx, cy: nd.ty, amt: 0, nodes: [] };
        this.clusters.push(found);
      }
      found.nodes.push(nd.id);
      nd.cluster = found.id;
    }
    for (const c of this.clusters) if (c.nodes.length) {
      let sx = 0, sy = 0;
      for (const id of c.nodes) {
        const n = this.nodes.get(id);
        sx += n.tx;
        sy += n.ty;
      }
      c.cx = Math.round(sx / c.nodes.length);
      c.cy = Math.round(sy / c.nodes.length);
    }
  }

  clusterAmount(c) {
    if (c.res === 'wood') return c.amt;
    let a = 0;
    for (const id of c.nodes) {
      const n = this.nodes.get(id);
      if (n) a += n.amt;
    }
    return a;
  }

  // ---------- population / counts ----------
  recalcPop(p) {
    let used = 0, cap = 0;
    for (const u of this.units.values()) if (u.owner === p.id) used += p.stats[u.type].pop;
    for (const b of this.buildings.values()) {
      if (b.owner !== p.id) continue;
      if (b.built) cap += p.faction.buildings[b.type].pop || 0;
      for (const q of b.queue) if (q.kind === 'unit') used += p.stats[q.type].pop;
    }
    p.pop = used;
    p.cap = Math.min(POP_MAX, cap);
  }

  // ---------- events / results ----------
  event(p, ev) {
    ev.t = this.t;
    p.events.push(ev);
    if (p.events.length > 40) p.events.shift();
  }
  eventTeam(team, ev) {
    for (const p of this.players) if (p && p.team === team) this.event(p, { ...ev });
  }

  // ---------- spatial grid ----------
  rebuildGrid() {
    for (const c of this.cells) c.length = 0;
    const gw = this.gw;
    for (const u of this.units.values()) {
      if (u.dead) continue;
      this.cells[Math.floor(u.y / 1000 / CELL) * gw + Math.floor(u.x / 1000 / CELL)].push(u);
    }
  }

  // Calls fn(unit) for every live unit within r milli of (x,y) (cell-granular superset check done inside).
  unitsNear(x, y, r, fn) {
    const gw = this.gw;
    const c0 = Math.max(0, Math.floor((x - r) / 1000 / CELL)), c1 = Math.min(gw - 1, Math.floor((x + r) / 1000 / CELL));
    const r0 = Math.max(0, Math.floor((y - r) / 1000 / CELL)), r1 = Math.min(gw - 1, Math.floor((y + r) / 1000 / CELL));
    const rr = r * r;
    for (let cy = r0; cy <= r1; cy++)
      for (let cx = c0; cx <= c1; cx++) {
        const cell = this.cells[cy * gw + cx];
        for (let i = 0; i < cell.length; i++) {
          const u = cell[i];
          if (u.dead) continue;
          const dx = u.x - x, dy = u.y - y;
          if (dx * dx + dy * dy <= rr) fn(u);
        }
      }
  }

  // ---------- vision ----------
  updateVision() {
    const W = this.W, H = this.H;
    const seen = new Set();
    for (const ts of this.teamState.values()) ts.vis.fill(0);
    const stamp = (ts, x, y, r) => {
      const cx = Math.floor(x / 1000), cy = Math.floor(y / 1000);
      const r2 = r * r;
      for (let dy = -r; dy <= r; dy++) {
        const yy = cy + dy;
        if (yy < 0 || yy >= H) continue;
        const hw = Math.floor(Math.sqrt(r2 - dy * dy));
        const a = Math.max(0, cx - hw), b = Math.min(W - 1, cx + hw);
        ts.vis.fill(1, yy * W + a, yy * W + b + 1);
        ts.expl.fill(1, yy * W + a, yy * W + b + 1);
      }
    };
    for (const u of this.units.values()) {
      if (u.dead) continue;
      stamp(this.teamState.get(this.team[u.owner]), u.x, u.y, this.players[u.owner].stats[u.type].sight);
    }
    for (const b of this.buildings.values()) {
      if (b.dead) continue;
      const ts = this.teamState.get(this.team[b.owner]);
      stamp(ts, (b.tx + b.size / 2) * 1000, (b.ty + b.size / 2) * 1000, this.players[b.owner].bstats[b.type].sight + (b.size >> 1));
    }
    // known buildings (shared per team)
    for (const [team, ts] of this.teamState) {
      for (const [id, k] of ts.known) {
        const b = this.buildings.get(id);
        if (!b || b.dead) {
          // forget when its tiles are visible, or when it no longer exists
          ts.known.delete(id);
        }
      }
      for (const b of this.buildings.values()) {
        if (b.dead || this.team[b.owner] === team) continue;
        let vis = false;
        for (let j = 0; j < b.size && !vis; j++)
          for (let i = 0; i < b.size; i++) if (ts.vis[(b.ty + j) * W + b.tx + i]) { vis = true; break; }
        if (vis) ts.known.set(b.id, { id: b.id, owner: b.owner, type: b.type, tx: b.tx, ty: b.ty, hp: b.hp, maxhp: b.maxhp, built: b.built, seen: this.t, vis: true });
        else {
          const k = ts.known.get(b.id);
          if (k) k.vis = false;
        }
      }
    }
  }

  isTileVisible(p, tx, ty) {
    return p.vis[ty * this.W + tx] === 1;
  }

  // ---------- main step ----------
  step() {
    if (this.over) return;
    this.t++;
    this.rebuildGrid();
    // Players alternate who is updated first each tick so list order gives nobody a systematic edge.
    const n = this.numPlayers, first = this.t % n;
    const bBy = this.bBy || (this.bBy = Array.from({ length: n + 1 }, () => []));
    const uBy = this.uBy || (this.uBy = Array.from({ length: n + 1 }, () => []));
    for (const l of bBy) l.length = 0;
    for (const l of uBy) l.length = 0;
    for (const b of this.buildings.values()) bBy[b.owner].push(b);
    for (const u of this.units.values()) uBy[u.owner].push(u);
    for (let k = 0; k < n; k++) for (const b of bBy[((first + k) % n) + 1]) this.updateBuilding(b);
    for (let k = 0; k < n; k++) for (const u of uBy[((first + k) % n) + 1]) this.updateUnit(u);
    this.updateProjectiles();
    this.cleanup();
    if (this.t % 4 === 0) this.updateVision();
    if (this.t % 10 === 0) this.checkVictory();
    if (this.t % 100 === 0) {
      for (const p of this.players) {
        if (!p) continue;
        p.income.push({ t: this.t, g: { ...p.gathered } });
        if (p.income.length > 7) p.income.shift();
      }
    }
  }

  cleanup() {
    if (!this.dead.length) return;
    const list = this.dead;
    this.dead = [];
    for (const e of list) {
      e.dead = true;
      if (e.kind === 1) {
        this.releaseNode(e);
        this.units.delete(e.id);
        const p = this.players[e.owner];
        p.pop -= p.stats[e.type].pop;
      } else if (e.kind === 2) {
        this.buildings.delete(e.id);
        this.vacate(e);
        const p = this.players[e.owner];
        p.built[e.type]--;
        this.recalcPop(p);
        this.event(p, { type: 'building_lost', b: e.type, x: e.tx, y: e.ty });
      } else {
        this.nodes.delete(e.id);
        this.vacate(e);
      }
    }
  }

  // ---------- victory ----------
  playerEliminated(p) {
    let tc = false, prod = false, workers = false, army = false;
    for (const b of this.buildings.values()) {
      if (b.owner !== p.id) continue;
      if (b.type === 'town_center') tc = true;
      if (p.faction.buildings[b.type].production) prod = true;
    }
    if (!tc && !prod) return true;
    for (const u of this.units.values()) {
      if (u.owner !== p.id) continue;
      if (u.type === 'worker') workers = true;
      else army = true;
    }
    if (!workers && !army && tc) {
      // cannot rebuild economy without resources for a worker
      let queued = false;
      for (const b of this.buildings.values()) if (b.owner === p.id && b.queue.length || b.research) queued = true;
      if (!queued && p.res.food < 50) return true;
    }
    return false;
  }

  eliminate(p, reason) {
    p.alive = false;
    p.endReason = reason;
    for (const u of this.units.values()) if (u.owner === p.id && !u.dead) {
      u.dead = true;
      this.dead.push(u);
    }
    this.cleanup();
  }

  score(p) {
    const g = p.gathered;
    return Math.floor((g.food + g.wood + g.stone + g.gold) / SCORE.gatheredDiv) + p.killValue * SCORE.killMul;
  }

  teamScore(team) {
    let s = 0;
    for (const p of this.players) if (p && p.team === team) s += this.score(p);
    return s;
  }

  checkVictory() {
    for (const p of this.players) if (p && p.alive && this.playerEliminated(p)) this.eliminate(p, 'destroyed');
    const alive = new Set();
    for (const p of this.players) if (p && p.alive) alive.add(p.team);
    if (alive.size <= 1) {
      this.over = true;
      this.winnerTeam = alive.size === 1 ? [...alive][0] : 0;
      this.endReason = alive.size === 1 ? 'victory' : 'mutual destruction';
      return;
    }
    if (this.t >= TIME_LIMIT_S * TICK_HZ) {
      let best = -1, bt = 0, tie = false;
      for (const team of alive) {
        const s = this.teamScore(team);
        if (s > best) { best = s; bt = team; tie = false; }
        else if (s === best) tie = true;
      }
      this.over = true;
      this.winnerTeam = tie ? 0 : bt;
      this.endReason = 'time limit (score)';
    }
  }

  result() {
    return {
      over: this.over, winnerTeam: this.winnerTeam, reason: this.endReason, tick: this.t, seconds: this.t / TICK_HZ,
      players: this.players.filter(Boolean).map((p) => ({
        id: p.id, team: p.team, alive: p.alive, score: this.score(p), killValue: p.killValue, lostValue: p.lostValue,
        gathered: { ...p.gathered }, tier: p.tier, trained: { ...p.trained }, unitStats: p.unitStats,
      })),
    };
  }

  // ---------- hashing ----------
  hash() {
    let h = 2166136261;
    h = hashStep(h, this.t);
    h = hashStep(h, this.rng.s);
    for (const p of this.players) {
      if (!p) continue;
      h = hashStep(h, p.res.food); h = hashStep(h, p.res.wood); h = hashStep(h, p.res.stone); h = hashStep(h, p.res.gold);
      h = hashStep(h, p.tier); h = hashStep(h, p.pop); h = hashStep(h, p.cap); h = hashStep(h, p.alive ? 1 : 0);
    }
    for (const u of this.units.values()) {
      h = hashStep(h, u.id); h = hashStep(h, u.x); h = hashStep(h, u.y); h = hashStep(h, u.hp); h = hashStep(h, u.amt);
    }
    for (const b of this.buildings.values()) {
      h = hashStep(h, b.id); h = hashStep(h, b.hp); h = hashStep(h, b.prog); h = hashStep(h, b.queue.length); h = hashStep(h, b.research ? b.research.t : 0);
    }
    for (const n of this.nodes.values()) { h = hashStep(h, n.id); h = hashStep(h, n.amt); }
    h = hashStep(h, this.proj.length);
    return h >>> 0;
  }
}

installLogic(Game);
installCommands(Game);
