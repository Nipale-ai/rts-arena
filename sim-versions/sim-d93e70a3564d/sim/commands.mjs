// Command API. Every command returns {ok:true, ...} or {ok:false, error:<code>, message:<text>}.
// Both scripted bots and LLMs use exactly this surface (see TOOLS for the function-call schemas).
import { RULES, RESOURCES, TIERS, POP_MAX } from './data.mjs';
import { stringToIds, TICK_HZ } from './util.mjs';
import { describeCommand } from './intent.mjs';

const fail = (error, message) => ({ ok: false, error, message });

export const TOOLS = [
  {
    name: 'train',
    description: 'Queue units at a production building you own. Cost is paid immediately; population is reserved.',
    parameters: {
      type: 'object',
      properties: {
        building_id: { type: 'integer' },
        unit_type: { type: 'string' },
        count: { type: 'integer', minimum: 1, maximum: RULES.trainMaxCount, default: 1 },
      },
      required: ['building_id', 'unit_type'],
    },
  },
  {
    name: 'build',
    description:
      'Place a building near a tile or entity and send workers to build it. worker_ids: list of ids, an id range string like "12-15,20", a group name, or "auto" (nearest idle/gathering workers). For wall and gate, `to` [x,y] builds a line from `near` to `to`.',
    parameters: {
      type: 'object',
      properties: {
        building_type: { type: 'string' },
        near: { description: '[x, y] tile or an entity id', oneOf: [{ type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }, { type: 'integer' }] },
        worker_ids: { description: 'ids, id range string, group name or "auto"', default: 'auto' },
        to: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
      },
      required: ['building_type', 'near'],
    },
  },
  {
    name: 'gather',
    description:
      'Send workers to gather a resource (food, wood, stone, gold). Use worker_ids (ids, range string, group, "idle_workers") or count (takes idle workers first, then workers on other resources). near [x,y] picks the node cluster closest to that tile.',
    parameters: {
      type: 'object',
      properties: {
        worker_ids: {},
        count: { type: 'integer', minimum: 1 },
        resource: { type: 'string', enum: RESOURCES },
        from: { type: 'string', description: 'with count: only take workers currently gathering this resource, or "idle"' },
        near: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
      },
      required: ['resource'],
    },
  },
  {
    name: 'attack_move',
    description:
      'Units walk to the target and fight everything on the way. units: ids, id range string "101-112,130", group name, "army", "type:<unit_type>". target: [x, y] tile or the id of a visible/known enemy entity (then they attack it).',
    parameters: {
      type: 'object',
      properties: { units: {}, target: { oneOf: [{ type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }, { type: 'integer' }] } },
      required: ['units', 'target'],
    },
  },
  {
    name: 'move',
    description: 'Units walk to [x, y] and do not stop to fight (they still defend when idle at the destination).',
    parameters: {
      type: 'object',
      properties: { units: {}, to: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 } },
      required: ['units', 'to'],
    },
  },
  {
    name: 'research',
    description: 'Research a tech at a building that offers it. building_id is optional (a free fitting building is chosen).',
    parameters: { type: 'object', properties: { tech: { type: 'string' }, building_id: { type: 'integer' } }, required: ['tech'] },
  },
  { name: 'advance_tier', description: 'Advance to the next tech tier at a town center (cost and time in the rules).', parameters: { type: 'object', properties: {} } },
  {
    name: 'set_rally',
    description: 'Set where new units from a building go. A rally point on a resource makes new workers gather it. xy null clears it.',
    parameters: {
      type: 'object',
      properties: { building_id: { type: 'integer' }, xy: { oneOf: [{ type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }, { type: 'null' }] } },
      required: ['building_id', 'xy'],
    },
  },
  {
    name: 'group',
    description: 'Name a set of units so later commands can use the name. Re-using a name replaces it.',
    parameters: { type: 'object', properties: { name: { type: 'string' }, units: {} }, required: ['name', 'units'] },
  },
  {
    name: 'scout',
    description: 'Send one unit to explore [x, y]. Without xy it walks to the nearest unexplored area.',
    parameters: { type: 'object', properties: { unit_id: { type: 'integer' }, xy: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 } }, required: ['unit_id'] },
  },
  {
    name: 'auto_train',
    description:
      'STANDING ORDER: keep producing a unit by itself. building_id (one building) or omit it to use ALL your finished buildings that train this unit. keep_queue=N refills the queue to N items whenever it drops (default 2); until_count=M stops once you own M of that unit (counting queued ones). Pays and queues automatically whenever resources and population allow. Replaces an earlier order for the same building and unit. cancel_standing removes it.',
    parameters: {
      type: 'object',
      properties: { unit_type: { type: 'string' }, building_id: { type: 'integer' }, keep_queue: { type: 'integer', minimum: 1, maximum: RULES.maxQueue }, until_count: { type: 'integer', minimum: 1, maximum: POP_MAX } },
      required: ['unit_type'],
    },
  },
  {
    name: 'attack_wave',
    description:
      'STANDING ORDER: whenever at least min_army IDLE soldiers are standing around, they attack_move to the target together. It repeats by itself (at most one wave per 10 s), so reinforcements form the next wave. target: [x, y] or "enemy_base" (nearest known enemy town center / production building, else the enemy start). group: "army" (default), "type:<unit_type>" or a group name. One wave order per player; setting it again replaces it.',
    parameters: {
      type: 'object',
      properties: { min_army: { type: 'integer', minimum: 1, maximum: POP_MAX, default: 10 }, target: { description: '[x, y] or "enemy_base"', default: 'enemy_base' }, group: { type: 'string', default: 'army' } },
    },
  },
  {
    name: 'auto_build_houses',
    description: 'STANDING ORDER: keep the population cap ahead. When free population room (including houses under construction) falls to margin or below, a worker builds a house next to your town center (needs wood). on=false switches it off.',
    parameters: { type: 'object', properties: { on: { type: 'boolean', default: true }, margin: { type: 'integer', minimum: 1, maximum: 30, default: 5 } } },
  },
  {
    name: 'cancel_standing',
    description: 'Cancel a standing order by its id (shown in the observation under standing_orders), or all of them with id "all".',
    parameters: { type: 'object', properties: { id: { description: 'order id or "all"', default: 'all' } } },
  },
  { name: 'resign', description: 'Give up the match.', parameters: { type: 'object', properties: {} } },
  { name: 'note', description: 'Free text shown on screen as your thought (max 120 chars). Has no game effect.', parameters: { type: 'object', properties: { text: { type: 'string', maxLength: 120 } }, required: ['text'] } },
];

function isXY(v) {
  return Array.isArray(v) && v.length === 2 && Number.isFinite(+v[0]) && Number.isFinite(+v[1]);
}

function costText(c) {
  return Object.entries(c).map(([k, v]) => `${v} ${k}`).join(', ');
}

export function installCommands(Game) {
  const methods = {
    command(pid, cmd) {
      const p = this.players[pid];
      let res;
      if (!p) res = fail('bad_player', `no player ${pid}`);
      else if (this.over) res = fail('game_over', 'the match is over');
      else if (!p.alive) res = fail('eliminated', 'you are out of the match');
      else if (!cmd || typeof cmd !== 'object' || typeof (cmd.cmd ?? cmd.name) !== 'string') res = fail('bad_args', 'command must be an object with a "cmd" name');
      else {
        const name = cmd.cmd ?? cmd.name;
        const fn = this['cmd_' + name];
        if (!fn || !TOOL_NAMES.has(name)) res = fail('unknown_command', `unknown command "${name}"`);
        else {
          try {
            res = fn.call(this, p, cmd.args && typeof cmd.args === 'object' ? { ...cmd.args } : { ...cmd });
          } catch (err) {
            res = fail('bad_args', `invalid arguments: ${err.message}`);
          }
        }
      }
      if (p) {
        const name = cmd && (cmd.cmd ?? cmd.name);
        this.commandLog.push({ t: this.t, p: pid, cmd });
        const r = { t: this.t, cmd: name, ok: res.ok };
        if (!res.ok) {
          r.error = res.error;
          r.message = res.message;
        }
        p.results.push(r);
        if (res.ok) {
          const d = describeCommand(this, p, name, cmd.args && typeof cmd.args === 'object' ? cmd.args : cmd, res);
          if (d) this.noteIntent(p, d.text, d.kind);
        }
        if (p.results.length > 40) p.results.shift();
      }
      return res;
    },

    // ---- selectors ----
    resolveUnits(p, spec, workersOnly = false) {
      let list = [];
      const alive = (u) => u && !u.dead && u.owner === p.id;
      const add = (u) => {
        if (alive(u) && (!workersOnly || u.type === 'worker')) list.push(u);
      };
      if (Array.isArray(spec)) for (const id of spec) add(this.units.get(+id));
      else if (typeof spec === 'number') add(this.units.get(spec));
      else if (typeof spec === 'string') {
        const s = spec.trim();
        if (s === 'army') for (const u of this.units.values()) { if (alive(u) && u.type !== 'worker') add(u); }
        else if (s === 'workers') for (const u of this.units.values()) { if (alive(u) && u.type === 'worker') add(u); }
        else if (s === 'idle_workers' || s === 'idle')
          for (const u of this.units.values()) { if (alive(u) && u.type === 'worker' && u.ord.t === 'idle') add(u); }
        else if (s === 'all') for (const u of this.units.values()) add(u);
        else if (s.startsWith('type:')) {
          const ty = s.slice(5);
          for (const u of this.units.values()) if (alive(u) && u.type === ty) add(u);
        } else if (p.groups.has(s)) for (const id of p.groups.get(s)) add(this.units.get(id));
        else {
          const ids = stringToIds(s);
          if (!ids) return { error: fail('bad_args', `cannot parse units "${s}"`) };
          for (const id of ids) add(this.units.get(id));
        }
      } else return { error: fail('bad_args', 'units must be ids, an id range string, a group name or a selector') };
      const seen = new Set();
      list = list.filter((u) => (seen.has(u.id) ? false : (seen.add(u.id), true)));
      if (!list.length) return { error: fail('no_units', 'no matching live units of yours') };
      return { list };
    },

    clampXY(v) {
      return [Math.max(0, Math.min(this.W - 1, Math.floor(+v[0]))), Math.max(0, Math.min(this.H - 1, Math.floor(+v[1])))];
    },

    // target: [x,y] or entity id. Returns {xy:[tx,ty]} or {ent}
    resolveTarget(p, t) {
      if (isXY(t)) return { xy: this.clampXY(t) };
      const id = typeof t === 'string' && /^\d+$/.test(t) ? +t : t;
      if (Number.isInteger(id)) {
        const e = this.get(id);
        if (!e || e.dead) return { error: fail('bad_target', `entity ${id} does not exist (any more)`) };
        if (e.kind === 3) return { xy: [e.tx, e.ty] };
        if (this.team[e.owner] === p.team) return { ent: e };
        if (e.kind === 2) {
          if (!p.known.has(e.id)) return { error: fail('target_not_visible', `enemy building ${id} is not known to you`) };
          return { ent: e };
        }
        const tx = this.tileMilli(p.id, e.x), ty = this.tileMilli(p.id, e.y);
        if (!p.vis[ty * this.W + tx]) return { error: fail('target_not_visible', `enemy unit ${id} is not visible`) };
        return { ent: e };
      }
      return { error: fail('bad_args', 'target must be [x, y] or an entity id') };
    },

    // ---- train ----
    cmd_train(p, a) {
      const b = this.buildings.get(+a.building_id);
      if (!b || b.dead) return fail('not_found', `no building ${a.building_id}`);
      if (b.owner !== p.id) return fail('not_owner', `building ${b.id} is not yours`);
      if (!b.built) return fail('not_built', `building ${b.id} is still under construction`);
      const type = a.unit_type;
      const ud = p.faction.units[type];
      if (!ud) return fail('unknown_unit', `unknown unit type "${type}"`);
      const bd = p.faction.buildings[b.type];
      if (!bd.train || !bd.train.includes(type) || ud.from !== b.type) return fail('cannot_train_here', `${b.type} cannot train ${type} (${type} is trained at ${ud.from})`);
      if (ud.tier > p.tier) return fail('tier_too_low', `${type} needs tier ${ud.tier}, you are tier ${p.tier}`);
      let count = a.count === undefined ? 1 : +a.count;
      if (!Number.isInteger(count) || count < 1) return fail('bad_args', 'count must be a positive integer');
      count = Math.min(count, RULES.trainMaxCount);
      let queued = 0, why = '';
      for (; queued < count; queued++) {
        if (b.queue.length >= RULES.maxQueue) { why = 'queue_full'; break; }
        if (p.pop + ud.pop > p.cap) { why = 'pop_cap'; break; }
        let ok = true;
        for (const [r, v] of Object.entries(ud.cost)) if (p.res[r] < v) ok = false;
        if (!ok) { why = 'insufficient_resources'; break; }
        for (const [r, v] of Object.entries(ud.cost)) p.res[r] -= v;
        p.pop += ud.pop;
        b.queue.push({ kind: 'unit', type, t: Math.round(ud.time * TICK_HZ) });
      }
      if (queued === 0) {
        if (why === 'queue_full') return fail('queue_full', `queue of building ${b.id} is full (${RULES.maxQueue})`);
        if (why === 'pop_cap') return fail('pop_cap', `population ${p.pop}/${p.cap}: build houses${p.cap >= POP_MAX ? ' (cap is at the maximum)' : ''}`);
        return fail('insufficient_resources', `${type} costs ${costText(ud.cost)}; you have ${costText(p.res)}`);
      }
      const r = { ok: true, queued, building_id: b.id, unit_type: type };
      if (queued < count) r.note = `only ${queued} of ${count} queued (${why})`;
      return r;
    },

    // ---- build ----
    siteOk(p, d, tx, ty) {
      const W = this.W, s = d.size;
      if (tx < 0 || ty < 0 || tx + s > W || ty + s > this.H) return false;
      for (let j = 0; j < s; j++)
        for (let i = 0; i < s; i++) {
          const k = (ty + j) * W + tx + i;
          if (this.blk[k] || this.terrain[k] !== 0 || !p.expl[k]) return false;
        }
      if (!this.rectReachable(p.comp, tx, ty, s)) return false;
      if (!d.noMargin) {
        for (let j = -1; j <= s; j++)
          for (let i = -1; i <= s; i++) {
            if (i >= 0 && j >= 0 && i < s && j < s) continue;
            const x = tx + i, y = ty + j;
            if (x < 0 || y < 0 || x >= W || y >= this.H) continue;
            const k = y * W + x;
            if (this.buildings.has(this.occ[k]) || this.terrain[k] !== 0) return false;
          }
      }
      return true;
    },

    // Nearest valid site. Ties are broken toward the map centre (not by scan order) so that mirrored
    // positions of mirrored players resolve symmetrically.
    findSite(p, d, cx, cy) {
      const s = d.size;
      // Anchor tile -> footprint top-left. Player 2 sees the rotated world, so for even sizes the anchor sits
      // on the other side of the footprint (this keeps findSite exactly equivariant under 180 degree rotation).
      const lo = this.sgn[p.id] > 0 ? s >> 1 : s - 1 - (s >> 1);
      const ox = cx - lo, oy = cy - lo;
      const mc = this.W / 2;
      let best = null, bk = Infinity, found = -1;
      for (let r = 0; r <= RULES.siteSearchRadius; r++) {
        if (found >= 0 && r > found + 1) break;
        for (let dy = -r; dy <= r; dy++) {
          const edge = Math.abs(dy) === r;
          for (let dx = -r; dx <= r; dx += edge ? 1 : 2 * r || 1) {
            const x = ox + dx, y = oy + dy;
            if (!this.siteOk(p, d, x, y)) continue;
            const k = (dx * dx + dy * dy) * 1000 + ((x + s / 2 - mc) ** 2 + (y + s / 2 - mc) ** 2) / 100;
            if (k < bk || (k === bk && this.tieKey(p.id, 2 * x + s, 2 * y + s) < this.tieKey(p.id, 2 * best[0] + s, 2 * best[1] + s))) {
              bk = k;
              best = [x, y];
            }
            if (found < 0) found = r;
          }
        }
      }
      return best;
    },

    ejectUnits(b) {
      for (const u of this.units.values()) {
        const tx = this.tileMilli(u.owner, u.x), ty = this.tileMilli(u.owner, u.y);
        if (tx >= b.tx && ty >= b.ty && tx < b.tx + b.size && ty < b.ty + b.size) {
          const pos = this.spawnPoint(b, u.ph);
          u.x = pos[0];
          u.y = pos[1];
          u.wp = null;
        }
      }
    },

    cmd_build(p, a) {
      const type = a.building_type;
      const d = p.faction.buildings[type];
      if (!d) return fail('unknown_building', `unknown building type "${type}"`);
      if ((d.buildTier || d.tier) > p.tier) return fail('tier_too_low', `${type} needs tier ${d.buildTier || d.tier}, you are tier ${p.tier}`);
      let cx, cy;
      if (isXY(a.near)) [cx, cy] = this.clampXY(a.near);
      else if (a.near && typeof a.near === 'object' && isXY([a.near.x, a.near.y])) [cx, cy] = this.clampXY([a.near.x, a.near.y]);
      else if (Number.isInteger(+a.near)) {
        const e = this.get(+a.near);
        if (!e || e.dead) return fail('bad_near', `entity ${a.near} does not exist`);
        if (e.kind === 1) { cx = this.tileMilli(p.id, e.x); cy = this.tileMilli(p.id, e.y); }
        else {
          // middle tile of the footprint; for even sizes the "middle" is the other one of the two for player 2
          const mid = this.sgn[p.id] > 0 ? e.size >> 1 : e.size - 1 - (e.size >> 1);
          cx = e.tx + mid;
          cy = e.ty + mid;
        }
      } else return fail('bad_args', 'near must be [x, y] or an entity id');
      // site(s)
      const sites = [];
      const wallish = type === 'wall' || type === 'gate';
      if (wallish && isXY(a.to)) {
        const [x2, y2] = this.clampXY(a.to);
        // Bresenham is not point symmetric on ties. Player 2 runs it on the rotated grid and rotates the
        // tiles back, so its wall is the exact mirror image of player 1's.
        const rot = this.sgn[p.id] < 0, W1 = this.W - 1, H1 = this.H - 1;
        const fx = rot ? (v) => W1 - v : (v) => v, fy = rot ? (v) => H1 - v : (v) => v;
        const tx2 = fx(x2), ty2 = fy(y2);
        let x = fx(cx), y = fy(cy);
        const dx = Math.abs(tx2 - x), dy = -Math.abs(ty2 - y), sx = x < tx2 ? 1 : -1, sy = y < ty2 ? 1 : -1;
        let err = dx + dy;
        for (let n = 0; n < RULES.wallLineMax; n++) {
          if (this.siteOk(p, d, fx(x), fy(y))) sites.push([fx(x), fy(y)]);
          if (x === tx2 && y === ty2) break;
          const e2 = 2 * err;
          if (e2 >= dy) { err += dy; x += sx; }
          if (e2 <= dx) { err += dx; y += sy; }
        }
        if (!sites.length) return fail('no_site', 'no free explored tile along that line');
      } else {
        const s = this.findSite(p, d, cx, cy);
        if (!s) return fail('no_site', `no free explored spot for ${type} within ${RULES.siteSearchRadius} tiles of [${cx},${cy}]`);
        sites.push(s);
      }
      // tower limits of the rule preset: max towers per tier and minimum spacing between own towers
      if (type === 'tower' && this.rules.towerCaps) {
        const cap = this.rules.towerCaps[Math.min(p.tier, this.rules.towerCaps.length) - 1];
        let own = 0, close = false;
        for (const b of this.buildings.values()) {
          if (b.owner !== p.id || b.dead || b.type !== 'tower') continue;
          own++;
          if (Math.max(Math.abs(b.tx - sites[0][0]), Math.abs(b.ty - sites[0][1])) < (this.rules.towerSpacing || 0)) close = true;
        }
        if (own >= cap) return fail('tower_limit', `at tier ${p.tier} you may own at most ${cap} towers (you have ${own}); advance the tier or use soldiers`);
        if (close) return fail('too_close', `towers must stand at least ${this.rules.towerSpacing} tiles apart; pick a spot farther from your other towers`);
      }
      // cost
      const need = {};
      for (const [r, v] of Object.entries(d.cost)) need[r] = v * sites.length;
      for (const [r, v] of Object.entries(need)) if (p.res[r] < v) return fail('insufficient_resources', `${sites.length}x ${type} costs ${costText(need)}; you have ${costText(p.res)}`);
      // workers
      const ws = a.worker_ids === undefined || a.worker_ids === 'auto' ? 'auto' : a.worker_ids;
      let workers = [];
      const centre = [(sites[0][0] + d.size / 2) * 1000, (sites[0][1] + d.size / 2) * 1000];
      if (ws === 'auto') {
        const cand = [];
        for (const u of this.units.values()) {
          if (u.owner !== p.id || u.type !== 'worker' || u.dead || u.ord.t === 'build' || this.t - (u.stuck ?? -9999) < 600) continue;
          const dd = (u.x - centre[0]) ** 2 + (u.y - centre[1]) ** 2;
          cand.push({ u, key: (u.ord.t === 'idle' ? 0 : 1e12) + dd });
        }
        cand.sort((x, y) => x.key - y.key || x.u.id - y.u.id);
        const crew = Math.max(d.crew || 1, wallish ? Math.min(3, sites.length) : 1);
        workers = cand.slice(0, crew).map((c) => c.u);
      } else {
        const r = this.resolveUnits(p, ws, true);
        if (r.error) return r.error.error === 'no_units' ? fail('no_workers', 'none of the given worker_ids is a live worker of yours') : r.error;
        workers = r.list;
      }
      if (!workers.length) return fail('no_workers', 'no worker available to build');
      for (const [r, v] of Object.entries(need)) p.res[r] -= v;
      const created = sites.map(([tx, ty]) => {
        const b = this.addBuilding(p.id, type, tx, ty, false);
        this.ejectUnits(b);
        return b;
      });
      const n = workers.length;
      workers.forEach((u, i) => {
        const mine = created.filter((_, k) => k % n === i);
        if (!mine.length) mine.push(created[created.length - 1]);
        this.setOrder(u, { t: 'build', id: mine[0].id, next: mine.slice(1).map((b) => b.id), last: 0 });
      });
      for (const b of created) { p.ghosts.push({ t: this.t, id: b.id }); if (p.ghosts.length > 6) p.ghosts.shift(); }
      return { ok: true, building_id: created[0].id, building_ids: created.map((b) => b.id), at: [created[0].tx, created[0].ty], workers: workers.map((u) => u.id) };
    },

    // ---- gather ----
    cmd_gather(p, a) {
      const res = a.resource;
      if (!RESOURCES.includes(res)) return fail('bad_args', `resource must be one of ${RESOURCES.join(', ')}`);
      let near = null;
      if (a.near !== undefined && a.near !== null) {
        if (!isXY(a.near)) return fail('bad_args', 'near must be [x, y]');
        const [nx, ny] = this.clampXY(a.near);
        near = [nx * 1000 + 500, ny * 1000 + 500];
      }
      let workers;
      if (a.worker_ids !== undefined && a.worker_ids !== null) {
        const r = this.resolveUnits(p, a.worker_ids, true);
        if (r.error) return r.error.error === 'no_units' ? fail('no_workers', 'none of the given worker_ids is a live worker of yours') : r.error;
        workers = r.list;
      } else if (Number.isInteger(+a.count) && +a.count > 0) {
        const cand = [];
        for (const u of this.units.values()) {
          if (u.owner !== p.id || u.type !== 'worker' || u.dead) continue;
          if (u.ord.t === 'build' || this.t - (u.stuck ?? -9999) < 600) continue;
          if (u.ord.t === 'gather' && u.ord.res === res) continue;
          if (a.from === 'idle' && u.ord.t !== 'idle') continue;
          if (a.from && a.from !== 'idle' && !(u.ord.t === 'gather' && u.ord.res === a.from)) continue;
          const dd = near ? (u.x - near[0]) ** 2 + (u.y - near[1]) ** 2 : 0;
          cand.push({ u, key: (u.ord.t === 'idle' ? 0 : u.ord.t === 'gather' ? 1e13 : 2e13) + dd });
        }
        cand.sort((x, y) => x.key - y.key || x.u.id - y.u.id);
        workers = cand.slice(0, +a.count).map((c) => c.u);
        if (!workers.length) return fail('no_workers', 'no worker is available for that (all are building or already on that resource)');
      } else return fail('bad_args', 'give worker_ids or count');
      let ok = 0;
      for (const u of workers) if (this.assignGather(u, res, near)) ok++;
      if (!ok) return fail('no_node', `no explored ${res} source reachable; scout first or build a farm`);
      const r = { ok: true, assigned: ok, resource: res };
      if (ok < workers.length) r.note = `${workers.length - ok} workers found no node`;
      return r;
    },

    // ---- movement ----
    groupRadius(n) {
      return Math.round(800 + 350 * Math.sqrt(n));
    },

    // slowest unit speed of a group of 4+ units (0 = no cap)
    marchSpeed(p, list) {
      if (list.length < 4) return 0;
      let m = Infinity;
      for (const u of list) m = Math.min(m, p.stats[u.type].speed);
      return m;
    },

    cmd_attack_move(p, a) {
      const sel = this.resolveUnits(p, a.units ?? a.unit_ids ?? a.group);
      if (sel.error) return sel.error;
      const tg = this.resolveTarget(p, a.target ?? a.target_xy ?? a.target_id);
      if (tg.error) return tg.error;
      const list = sel.list;
      if (tg.ent && this.team[tg.ent.owner] !== p.team) {
        let n = 0;
        for (const u of list) {
          const st = p.stats[u.type];
          if (st.only === 'buildings' && tg.ent.kind === 1) continue;
          this.setOrder(u, { t: 'attack', id: tg.ent.id, auto: false });
          n++;
        }
        if (!n) return fail('cannot_attack', 'these units can only attack buildings');
        return { ok: true, units: n, target: tg.ent.id };
      }
      const xy = tg.xy || [tg.ent.tx ?? this.tileMilli(p.id, tg.ent.x), tg.ent.ty ?? this.tileMilli(p.id, tg.ent.y)];
      const r = this.groupRadius(list.length);
      const cap = this.marchSpeed(p, list);
      for (const u of list) this.setOrder(u, { t: 'amove', x: xy[0] * 1000 + 500, y: xy[1] * 1000 + 500, r, blocked: false, cap });
      return { ok: true, units: list.length, target: xy };
    },

    cmd_move(p, a) {
      const sel = this.resolveUnits(p, a.units ?? a.unit_ids ?? a.group);
      if (sel.error) return sel.error;
      const tg = this.resolveTarget(p, a.to ?? a.target ?? a.xy);
      if (tg.error) return tg.error;
      const xy = tg.xy || [tg.ent.tx ?? this.tileMilli(p.id, tg.ent.x), tg.ent.ty ?? this.tileMilli(p.id, tg.ent.y)];
      const r = this.groupRadius(sel.list.length);
      const cap = this.marchSpeed(p, sel.list);
      for (const u of sel.list) this.setOrder(u, { t: 'move', x: xy[0] * 1000 + 500, y: xy[1] * 1000 + 500, r, cap });
      return { ok: true, units: sel.list.length, to: xy };
    },

    cmd_scout(p, a) {
      const u = this.units.get(+a.unit_id);
      if (!u || u.dead || u.owner !== p.id) return fail('not_found', `no unit ${a.unit_id} of yours`);
      let xy;
      if (a.xy !== undefined && a.xy !== null) {
        if (!isXY(a.xy)) return fail('bad_args', 'xy must be [x, y]');
        xy = this.clampXY(a.xy);
      } else {
        // nearest unexplored coarse cell centre
        let best = null, bd = Infinity;
        const S = 8;
        const o0 = this.sgn[p.id] > 0 ? S / 2 : S / 2 - 1; // sample grid is point symmetric for both players
        for (let y = o0; y < this.H; y += S)
          for (let x = o0; x < this.W; x += S) {
            if (p.expl[y * this.W + x] || this.blk[y * this.W + x]) continue;
            const d = (x * 1000 + 500 - u.x) ** 2 + (y * 1000 + 500 - u.y) ** 2;
            if (d < bd || (d === bd && this.tieKey(p.id, x, y) < this.tieKey(p.id, best[0], best[1]))) { bd = d; best = [x, y]; }
          }
        if (!best) return fail('nothing_to_scout', 'the whole map is explored');
        xy = best;
      }
      this.setOrder(u, { t: 'move', x: xy[0] * 1000 + 500, y: xy[1] * 1000 + 500, r: 700, scout: true });
      return { ok: true, unit_id: u.id, to: xy };
    },

    // ---- research / tier ----
    cmd_research(p, a) {
      const name = a.tech;
      const t = p.faction.techs[name];
      if (!t) return fail('unknown_tech', `unknown tech "${name}"`);
      if (p.techs.has(name)) return fail('already_done', `${name} is already researched`);
      if (p.queuedTechs.has(name)) return fail('busy', `${name} is already being researched`);
      if (t.tier > p.tier) return fail('tier_too_low', `${name} needs tier ${t.tier}, you are tier ${p.tier}`);
      if (t.req && !p.techs.has(t.req)) return fail('requires', `${name} needs ${t.req} first`);
      let b = null;
      if (a.building_id !== undefined && a.building_id !== null) {
        b = this.buildings.get(+a.building_id);
        if (!b || b.dead || b.owner !== p.id) return fail('not_found', `no building ${a.building_id} of yours`);
        if (b.type !== t.at) return fail('wrong_building', `${name} is researched at ${t.at}`);
        if (!b.built) return fail('not_built', 'that building is not finished');
        if (b.research) return fail('busy', `building ${b.id} is busy with research`);
      } else {
        for (const x of this.buildings.values()) if (x.owner === p.id && !x.dead && x.built && x.type === t.at && !x.research) { b = x; break; }
        if (!b) return fail('no_building', `no free finished ${t.at} (needed for ${name})`);
      }
      for (const [r, v] of Object.entries(t.cost)) if (p.res[r] < v) return fail('insufficient_resources', `${name} costs ${costText(t.cost)}; you have ${costText(p.res)}`);
      for (const [r, v] of Object.entries(t.cost)) p.res[r] -= v;
      b.research = { kind: 'tech', tech: name, t: Math.round(t.time * TICK_HZ) };
      p.queuedTechs.add(name);
      return { ok: true, tech: name, building_id: b.id, seconds: t.time };
    },

    cmd_advance_tier(p) {
      if (p.tier >= 3) return fail('already_done', 'you are at the highest tier');
      if (p.advancing) return fail('busy', 'tier advance already in progress');
      const to = p.tier + 1;
      const td = TIERS[to];
      let b = null;
      for (const x of this.buildings.values()) if (x.owner === p.id && !x.dead && x.built && x.type === 'town_center' && !x.research) { b = x; break; }
      if (!b) return fail('no_building', 'you need a free finished town center');
      for (const [r, v] of Object.entries(td.cost)) if (p.res[r] < v) return fail('insufficient_resources', `tier ${to} costs ${costText(td.cost)}; you have ${costText(p.res)}`);
      for (const [r, v] of Object.entries(td.cost)) p.res[r] -= v;
      b.research = { kind: 'tier', tier: to, t: Math.round(td.time * TICK_HZ) };
      p.advancing = to;
      return { ok: true, tier: to, building_id: b.id, seconds: td.time };
    },

    // ---- rally / groups ----
    cmd_set_rally(p, a) {
      const b = this.buildings.get(+a.building_id);
      if (!b || b.dead || b.owner !== p.id) return fail('not_found', `no building ${a.building_id} of yours`);
      if (a.xy === null || a.xy === undefined) {
        b.rally = null;
        return { ok: true, building_id: b.id, rally: null };
      }
      if (!isXY(a.xy)) return fail('bad_args', 'xy must be [x, y] or null');
      const [tx, ty] = this.clampXY(a.xy);
      const rally = { x: tx * 1000 + 500, y: ty * 1000 + 500 };
      const idx = ty * this.W + tx;
      if (this.terrain[idx] === 1) rally.res = 'wood';
      else if (this.occ[idx]) {
        const e = this.get(this.occ[idx]);
        if (e && e.kind === 3) rally.res = { berries: 'food', herd: 'food', stone: 'stone', gold: 'gold' }[e.res];
        else if (e && e.kind === 2 && e.owner === p.id && p.faction.buildings[e.type].node === 'farm') rally.res = 'food';
      }
      b.rally = rally;
      b.rallyT = this.t;
      return { ok: true, building_id: b.id, rally: [tx, ty], gather: rally.res || null };
    },

    cmd_group(p, a) {
      const name = String(a.name ?? '');
      if (!/^[A-Za-z0-9_-]{1,16}$/.test(name)) return fail('bad_args', 'group name must be 1-16 chars of letters, digits, _ or -');
      if (['army', 'workers', 'idle', 'idle_workers', 'all'].includes(name)) return fail('bad_args', `"${name}" is a reserved selector`);
      const sel = this.resolveUnits(p, a.units ?? a.unit_ids);
      if (sel.error) return sel.error;
      if (!p.groups.has(name) && p.groups.size >= 12) return fail('too_many_groups', 'at most 12 groups');
      p.groups.set(name, sel.list.map((u) => u.id));
      return { ok: true, group: name, size: sel.list.length };
    },

    cmd_resign(p) {
      p.resigned = true;
      this.eliminate(p, 'resigned');
      this.checkVictory();
      return { ok: true };
    },

    cmd_note(p, a) {
      p.note = String(a.text ?? '').slice(0, 120);
      p.noteTick = this.t;
      return { ok: true };
    },
  };
  Object.assign(Game.prototype, methods);
}

const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));
