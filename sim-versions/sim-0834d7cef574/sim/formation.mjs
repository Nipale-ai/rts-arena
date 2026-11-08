// Formations: land units that get the same move or attack_move order to a tile march as one body.
// Each unit gets a slot around the target: infantry in front, ranged units behind them, healers, siege and workers at
// the back, cavalry on the flanks. The body faces the way it travels (group centre to target) and is wider than deep.
// A formation has an anchor (a point that walks the route at the speed of the slowest member). Every member keeps its slot
// relative to the anchor, so the group moves at one pace and arrives together. A unit that gets another order, starts a
// fight (attack_move), or falls too far behind leaves the formation and continues on its own to its slot at the target.
// Integer math only, and everything is point-mirror equivariant (see Game.tieKey): slots are laid out in a local frame
// (forward, right) that is identical for both seats, and the frame vectors flip sign with the world.
import { INF } from './util.mjs';

// Round half away from zero: rnd(-v) === -rnd(v), so a point-mirrored value rounds to the mirrored value.
const rnd = (v) => (v < 0 ? -Math.round(-v) : Math.round(v));
const ONE = 4096; // fixed point scale of the direction vector
const LAT = 900, RANK = 1000, GAP = 250, FLANK = 1400; // milli-tiles: within a rank, between ranks, between role blocks, flank offset
const LOOSE = 1400; // workers only: a loose block
const ARRIVE_R = 350; // a member is home when it stands this close to its slot
const LAG_ON = 2600, LAG_OFF = 1000; // the anchor waits when a member is further than LAG_ON from its slot, and goes on at LAG_OFF
const FAR = 10000; // members further away than this at the start are not waited for
const HOLD_MAX = 150; // ticks the anchor waits for stragglers before they are let go
const NEAR = 600; // closer than this to the slot: step straight, no line-of-sight check
const CAV = 5;
const ROLE = { infantry: 0, ranged: 1, support: 2, siege: 3, worker: 4, cavalry: CAV };

export function installFormation(Game) {
  const methods = {
    // True if a unit can stand at the milli point (inside the map, on a passable tile).
    slotFree(owner, x, y) {
      const W = this.W;
      if (x < 0 || y < 0 || x >= W * 1000 || y >= this.H * 1000) return false;
      return this.paths.canPass(owner, this.tileMilli(owner, y) * W + this.tileMilli(owner, x));
    },

    // True if the straight line between two milli points runs over passable tiles only (sampled every 300 milli, no clearance).
    lineFree(owner, x0, y0, x1, y1) {
      const dx = x1 - x0, dy = y1 - y0;
      const n = Math.ceil(Math.sqrt(dx * dx + dy * dy) / 300);
      for (let i = 1; i <= n; i++) if (!this.slotFree(owner, x0 + rnd((dx * i) / n), y0 + rnd((dy * i) / n))) return false;
      return true;
    },

    // Centre of the nearest passable tile that is not in `taken` (ring by ring; inside a ring the closest wins, exact ties by tieKey).
    nearFree(owner, x, y, taken) {
      const W = this.W, H = this.H;
      const cx = Math.max(0, Math.min(W - 1, this.tileMilli(owner, x))), cy = Math.max(0, Math.min(H - 1, this.tileMilli(owner, y)));
      for (let r = 0; r <= 8; r++) {
        let best = null, bd = Infinity;
        for (let dy = -r; dy <= r; dy++)
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const tx = cx + dx, ty = cy + dy;
            if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
            const idx = ty * W + tx;
            if (!this.paths.canPass(owner, idx) || taken.has(idx)) continue;
            const d = (tx * 1000 + 500 - x) ** 2 + (ty * 1000 + 500 - y) ** 2;
            if (d < bd || (d === bd && this.tieKey(owner, tx, ty) < this.tieKey(owner, best[0], best[1]))) { bd = d; best = [tx, ty]; }
          }
        if (best) {
          taken.add(best[1] * W + best[0]);
          return [best[0] * 1000 + 500, best[1] * 1000 + 500];
        }
      }
      return null;
    },

    // Puts the units of `list` that can march in formation (at least 2 land units) into one formation heading for tile (tx, ty).
    // kind is 'move' or 'amove'. Returns the units that were not taken in; the caller gives them their plain order.
    formUp(p, list, tx, ty, kind) {
      const mem = list.filter((u) => !u.ship && !u.boarded);
      if (mem.length < 2) return list;
      const rest = list.filter((u) => u.ship || u.boarded);
      const W2 = this.W * 500, H2 = this.H * 500; // map centre: positions relative to it negate under the point mirror
      let sx = 0, sy = 0;
      for (const u of mem) { sx += u.x - W2; sy += u.y - H2; }
      const cx = W2 + rnd(sx / mem.length), cy = H2 + rnd(sy / mem.length);
      const want = [tx * 1000 + 500, ty * 1000 + 500];
      const r0 = this.groupRadius(list.length), cap0 = this.marchSpeed(p, list); // what the plain order would have had
      const goal = this.slotFree(p.id, want[0], want[1]) ? want : this.nearFree(p.id, want[0], want[1], new Set()) || want;
      // facing: group centre to target (a group that is already there faces the middle of the map)
      let dx = goal[0] - cx, dy = goal[1] - cy;
      if (dx * dx + dy * dy < 1500 * 1500) {
        dx = W2 - goal[0]; dy = H2 - goal[1];
        if (!dx && !dy) { dx = this.sgn[p.id]; dy = 0; }
      }
      const len = Math.sqrt(dx * dx + dy * dy);
      const fx = rnd((dx * ONE) / len), fy = rnd((dy * ONE) / len);
      const slots = this.formSlots(p, mem, cx, cy, fx, fy);

      // final slots: the free ones keep their place, the others move to the nearest free tile
      const taken = new Set();
      const W = this.W;
      for (const s of slots) {
        s.x = goal[0] + s.ox; s.y = goal[1] + s.oy;
        s.ok = this.slotFree(p.id, s.x, s.y);
        if (s.ok) taken.add(this.tileMilli(p.id, s.y) * W + this.tileMilli(p.id, s.x));
      }
      for (const s of slots) if (!s.ok) {
        const c = this.nearFree(p.id, s.x, s.y, taken);
        if (c) { s.x = c[0]; s.y = c[1]; } else { s.x = goal[0]; s.y = goal[1]; }
      }

      let slow = mem[0], v = Infinity;
      for (const u of mem) { const sp = p.stats[u.type].speed; if (sp < v) { v = sp; slow = u; } }
      const f = {
        id: this.nextForm++, owner: p.id, gx: goal[0], gy: goal[1], key: this.tileOf(goal[0], goal[1]), fx, fy, v,
        au: { owner: p.id, type: slow.type, x: cx, y: cy, wp: null, ord: { cap: 0 } }, // the anchor: a pseudo unit that only walks
        ids: [], st: 'march', hold: true, holdT: 0,
      };
      if (!this.slotFree(p.id, f.au.x, f.au.y)) this.unstick(f.au);
      for (const s of slots) {
        const o = { t: kind, x: s.x, y: s.y, tgx: want[0], tgy: want[1], r0, cap0, r: ARRIVE_R, fm: f.id, sf: s.f, ss: s.s, ox: s.ox, oy: s.oy, sx: 0, sy: 0, far: false, blind: false };
        if (kind === 'amove') o.blocked = false;
        this.setOrder(s.u, o);
        f.ids.push(s.u.id);
      }
      this.formTargets(f);
      for (const s of slots) {
        const o = s.u.ord, ex = o.sx - s.u.x, ey = o.sy - s.u.y;
        o.far = ex * ex + ey * ey > FAR * FAR;
      }
      this.forms.set(f.id, f);
      return rest;
    },

    // Slot of every member in the local frame (f forward, s to the right) and as a world offset from the formation centre.
    // The assignment follows the units' places (the front-most unit of a role takes the front rank, left stays left), so
    // paths cross as little as possible.
    formSlots(p, mem, cx, cy, fx, fy) {
      const ents = mem.map((u) => {
        const ux = u.x - cx, uy = u.y - cy;
        return { u, role: ROLE[p.stats[u.type].cls] ?? 0, a: ux * fx + uy * fy, b: uy * fx - ux * fy };
      });
      const order = (x, y) => x.role - y.role || y.a - x.a || x.b - y.b || x.u.ph - y.u.ph || x.u.id - y.u.id;
      let line = ents.filter((e) => e.role !== CAV), cav = ents.filter((e) => e.role === CAV);
      if (!line.length) { line = cav; cav = []; } // only cavalry: they form the line
      const loose = ents.every((e) => e.role === ROLE.worker);
      const lat = loose ? LOOSE : LAT, rank = loose ? LOOSE : RANK;
      // role blocks: infantry, ranged, then support + siege + workers
      const blocks = [[], [], []];
      for (const e of line) blocks[e.role === 1 ? 1 : e.role >= 2 && e.role < CAV ? 2 : 0].push(e);
      let F = 2; // units per rank: about sqrt(2 n), so the body is wider than deep
      while (F * F < 2 * line.length) F++;
      const rows = []; // { ents (left to right), depth }
      let nb = 0;
      for (const bl of blocks) {
        if (!bl.length) continue;
        bl.sort(order);
        const nr = Math.ceil(bl.length / F), base = Math.floor(bl.length / nr), extra = bl.length % nr;
        let k = 0;
        for (let r = 0; r < nr; r++) {
          const m = base + (r < extra ? 1 : 0);
          const re = bl.slice(k, k + m);
          k += m;
          re.sort((x, y) => x.b - y.b || order(x, y));
          rows.push({ ents: re, depth: rows.length * rank + nb * GAP });
        }
        nb++;
      }
      const total = rows[rows.length - 1].depth, half = Math.floor(total / 2);
      const out = [];
      let halfW = 0;
      for (const row of rows) {
        const m = row.ents.length;
        halfW = Math.max(halfW, ((m - 1) * lat) / 2);
        row.ents.forEach((e, j) => out.push({ u: e.u, f: half - row.depth, s: ((2 * j - (m - 1)) * lat) / 2 }));
      }
      if (cav.length) { // cavalry guard the flanks: one column on each side, starting at the front rank
        cav.sort((x, y) => x.b - y.b || order(x, y));
        const nl = Math.ceil(cav.length / 2);
        const cols = [cav.slice(0, nl).sort(order), cav.slice(nl).sort(order)];
        cols.forEach((col, side) => col.forEach((e, i) => out.push({ u: e.u, f: half - i * rank, s: (side ? 1 : -1) * (halfW + FLANK) })));
      }
      for (const s of out) {
        s.ox = rnd((fx * s.f - fy * s.s) / ONE);
        s.oy = rnd((fy * s.f + fx * s.s) / ONE);
      }
      return out;
    },

    // Where every member should be right now: its slot around the anchor. A slot in a wall (trees, water, buildings, map edge)
    // is pulled toward the anchor until it is free.
    formTargets(f) {
      const ax = f.au.x, ay = f.au.y;
      for (const id of f.ids) {
        const o = this.units.get(id).ord;
        let x = ax + o.ox, y = ay + o.oy;
        for (let k = 3; k >= 0 && !this.slotFree(f.owner, x, y); k--) { x = ax + rnd((o.ox * k) / 4); y = ay + rnd((o.oy * k) / 4); }
        o.sx = x; o.sy = y;
      }
    },

    // Drops a unit out of its formation; it carries on alone with the plain order (the common target tile, so that all
    // the units that leave share one flow field instead of one per slot).
    leaveForm(u) {
      const o = u.ord;
      o.fm = 0;
      o.x = o.tgx; o.y = o.tgy; o.r = o.r0; o.cap = o.cap0;
    },

    stepForms() {
      for (const f of this.forms.values()) this.stepForm(f);
    },

    // One tick of one formation: the anchor walks on unless a member lags too far behind, then the slots follow the anchor.
    stepForm(f) {
      const ids = f.ids;
      let n = 0;
      for (let i = 0; i < ids.length; i++) {
        const u = this.units.get(ids[i]);
        if (u && !u.dead && !u.boarded && u.ord.fm === f.id) ids[n++] = ids[i];
      }
      ids.length = n;
      if (!n) { this.forms.delete(f.id); return; }
      if (f.st !== 'march') return;
      // how far is the member that lags most (members that started far away or cannot see their slot are not waited for)
      let lag = 0;
      for (const id of ids) {
        const u = this.units.get(id), o = u.ord, dx = o.sx - u.x, dy = o.sy - u.y, d2 = dx * dx + dy * dy;
        if (o.far) { if (d2 > LAG_ON * LAG_ON) continue; o.far = false; }
        if (o.blind) continue; // no straight way to its slot (it walks around the obstacle): the anchor does not wait
        if (d2 > lag) lag = d2;
      }
      if (f.hold) {
        if (lag <= LAG_OFF * LAG_OFF) { f.hold = false; f.holdT = 0; }
        else if (++f.holdT > HOLD_MAX) { // a straggler is stuck: let it go on alone
          for (const id of ids) {
            const u = this.units.get(id), dx = u.ord.sx - u.x, dy = u.ord.sy - u.y;
            if (dx * dx + dy * dy > LAG_OFF * LAG_OFF) this.leaveForm(u);
          }
          f.holdT = 0;
        }
      } else if (lag > LAG_ON * LAG_ON) { f.hold = true; f.holdT = 0; }
      if (!f.hold) {
        const r = this.goPoint(f.au, f.gx, f.gy, 0);
        if (r === 'arrived') f.st = 'arrive';
        else if (r === 'stuck') { for (const id of ids) this.leaveForm(this.units.get(id)); this.forms.delete(f.id); return; }
      }
      if (f.st === 'march') this.formTargets(f);
    },

    // Movement of a member of a formation. Returns 'arrived' | 'ok' | 'stuck' like goPoint.
    formGo(u, o) {
      const f = this.forms.get(o.fm);
      if (!f) { this.leaveForm(u); return this.goPoint(u, o.x, o.y, o.r); }
      if (f.st !== 'march') { // the anchor is there: walk to the own slot (straight if it is near and in sight, else on the shared field)
        const ex = o.x - u.x, ey = o.y - u.y, ed = ex * ex + ey * ey;
        if (ed <= o.r * o.r) return 'arrived';
        if (ed < 2200 * 2200 && this.paths.losClear(u.owner, u.x, u.y, o.x, o.y)) return this.stepDirect(u, o.x, o.y, 0) ? 'ok' : 'stuck';
        return this.moveToGoal(u, f.key, this.tileSeeds(f.key), 0);
      }
      const dx = o.sx - u.x, dy = o.sy - u.y, d2 = dx * dx + dy * dy;
      if (d2 === 0) { o.blind = false; return 'ok'; }
      // The slot is near or in sight: step straight to it at full speed. It is never more than one step ahead, so the member keeps the pace of the anchor.
      // Behind an obstacle: aim at the nearest point on the way to the anchor that it can see.
      let tx = o.sx, ty = o.sy, seen = d2 <= NEAR * NEAR || this.lineFree(u.owner, u.x, u.y, tx, ty);
      o.blind = !seen;
      for (let k = 3; !seen && k >= 0; k--) {
        tx = f.au.x + rnd((o.ox * k) / 4); ty = f.au.y + rnd((o.oy * k) / 4);
        seen = this.lineFree(u.owner, u.x, u.y, tx, ty);
      }
      if (seen && this.stepDirect(u, tx, ty, 0)) {
        u.wp = null;
        return 'ok';
      }
      // Trees, water or buildings in the way: follow the route of the formation, and wait when ahead of the slot.
      o.blind = true;
      const P = this.paths, W = this.W, ow = u.owner;
      const ui = this.tileMilli(ow, u.y) * W + this.tileMilli(ow, u.x);
      const fld = P.get(ow, f.key, ui, this.tileSeeds(f.key));
      const dU = fld.dist[ui], dA = fld.dist[this.tileMilli(ow, f.au.y) * W + this.tileMilli(ow, f.au.x)];
      if (dU < INF && dA < INF && (dA - dU) * 100 > o.sf + 600) return 'ok';
      return this.moveToGoal(u, f.key, this.tileSeeds(f.key), 0);
    },
  };
  Object.assign(Game.prototype, methods);
}
