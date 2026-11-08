// Ships and the harbor (coast maps). Ships are normal units (cls 'naval') that move on water tiles only: while a ship is updated the
// game swaps `this.paths` for a NavPaths instance, so the ordinary flow-field code (goPoint, moveToGoal, engage) steers it on the sea.
//   fishing boat  fishes the nearest shoal by itself while idle and delivers the food to the nearest own harbor
//   war boat      ranged siege damage, strong against ships and buildings, fires at land units on the shore too
//   transport     carries up to 6 land units (board / unload); a sunk transport takes its cargo with it
// Fish shoals are not map nodes (water blocks building): they live in game.fish. Everything is deterministic and mirror safe: every
// "nearest" pick breaks ties with tieKey, like the rest of the sim.
import { Paths } from './path.mjs';
import { hashStep } from './util.mjs';
import { FISH } from './world-data.mjs';
import { GATHER } from './data.mjs';

const fail = (error, message) => ({ ok: false, error, message });

class NavPaths extends Paths {
  canPass(owner, idx) {
    return this.g.terrain[idx] === 2;
  }
}

export function installNaval(Game) {
  const methods = {
    initNaval(mapObj) {
      this.fish = [];
      for (const f of mapObj.fish || []) {
        if (this.terrain[f.ty * this.W + f.tx] !== 2) continue;
        this.fish.push({ id: this.nextId++, tx: f.tx, ty: f.ty, x: f.tx * 1000 + 500, y: f.ty * 1000 + 500, amt: f.amount | 0 });
      }
      this.hasWater = false;
      for (let i = 0; i < this.terrain.length; i++) if (this.terrain[i] === 2) { this.hasWater = true; break; }
      this.landPaths = this.paths;
      this.nav = null;
      this.navUsed = false;
      this.waterLabel = null;
    },

    // water body labels (4-connected), used to tell a real sea from a puddle when a harbor is placed
    labelWater() {
      const W = this.W, H = this.H;
      const lab = new Int32Array(W * H);
      const size = [0];
      const stack = [];
      for (let i = 0; i < W * H; i++) {
        if (lab[i] || this.terrain[i] !== 2) continue;
        const id = size.length;
        size.push(0);
        lab[i] = id;
        stack.push(i);
        while (stack.length) {
          const c = stack.pop();
          size[id]++;
          const x = c % W, y = (c / W) | 0;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const ni = ny * W + nx;
            if (!lab[ni] && this.terrain[ni] === 2) { lab[ni] = id; stack.push(ni); }
          }
        }
      }
      this.waterLabel = { lab, size };
    },

    // a harbor needs a sea (a water body of at least 60 tiles) along its edge
    coastalOk(tx, ty, s) {
      if (!this.hasWater || this.mapType !== 'coast') return false;
      if (!this.waterLabel) this.labelWater();
      const { lab, size } = this.waterLabel, W = this.W;
      let n = 0;
      for (let j = -1; j <= s; j++) for (let i = -1; i <= s; i++) {
        if (i >= 0 && j >= 0 && i < s && j < s) continue;
        if ((i === -1 || i === s) && (j === -1 || j === s)) continue; // corners do not touch the footprint
        const x = tx + i, y = ty + j;
        if (x < 0 || y < 0 || x >= W || y >= this.H) continue;
        const l = lab[y * W + x];
        if (l && size[l] >= 60) n++;
      }
      return n >= 2;
    },

    navPaths() {
      return this.nav || (this.nav = new NavPaths(this));
    },

    // centre (milli) of the water tile nearest to a point within `maxR` tiles, or null
    navNear(x, y, maxR = 8, owner = 1) {
      const W = this.W, H = this.H, cx = Math.floor(x / 1000), cy = Math.floor(y / 1000);
      let best = null, bd = Infinity;
      for (let r = 0; r <= maxR; r++) {
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const tx = cx + dx, ty = cy + dy;
          if (tx < 0 || ty < 0 || tx >= W || ty >= H || this.terrain[ty * W + tx] !== 2) continue;
          const d = (tx * 1000 + 500 - x) ** 2 + (ty * 1000 + 500 - y) ** 2;
          if (d < bd || (d === bd && this.tieKey(owner, tx, ty) < this.tieKey(owner, best[0], best[1]))) { bd = d; best = [tx, ty]; }
        }
        if (best && r >= 1 && bd <= (r * 1000) ** 2) break;
      }
      return best ? [best[0] * 1000 + 500, best[1] * 1000 + 500] : null;
    },

    // where a new ship appears: a free water tile at the harbor's edge
    shipSpawn(b, k) {
      const W = this.W, cand = [];
      const wet = (x, y) => x >= 0 && y >= 0 && x < W && y < this.H && this.terrain[y * W + x] === 2;
      const clear = (x, y, c) => { for (let j = -c; j <= c; j++) for (let i = -c; i <= c; i++) if (!wet(x + i, y + j)) return false; return true; };
      // open water with room for the hull: 2 tiles of water all round if there is such a spot near the harbor, else 1, else any
      for (const need of [2, 1, 0]) {
        for (let r = 1; r <= 8 && !cand.length; r++) {
          for (let j = -r; j < b.size + r; j++) for (let i = -r; i < b.size + r; i++) {
            if (i >= -r + 1 && j >= -r + 1 && i < b.size + r - 1 && j < b.size + r - 1) continue;
            const x = b.tx + i, y = b.ty + j;
            if (!wet(x, y) || !clear(x, y, need)) continue;
            cand.push([x, y]);
          }
        }
        if (cand.length) break;
      }
      for (let r = 1; r <= 5 && !cand.length; r++) {
        for (let j = -r; j < b.size + r; j++) for (let i = -r; i < b.size + r; i++) {
          if (i >= -r + 1 && j >= -r + 1 && i < b.size + r - 1 && j < b.size + r - 1) continue;
          const x = b.tx + i, y = b.ty + j;
          if (x < 0 || y < 0 || x >= W || y >= this.H || this.terrain[y * W + x] !== 2) continue;
          cand.push([x, y]);
        }
      }
      if (!cand.length) return null;
      const o = b.owner;
      cand.sort((a, c) => (a[0] - b.tx - b.size / 2) ** 2 + (a[1] - b.ty - b.size / 2) ** 2 - ((c[0] - b.tx - b.size / 2) ** 2 + (c[1] - b.ty - b.size / 2) ** 2) || this.tieKey(o, a[0], a[1]) - this.tieKey(o, c[0], c[1]));
      const c = cand[k % Math.min(cand.length, 6)];
      return [c[0] * 1000 + 500, c[1] * 1000 + 500];
    },

    // ---------------- one ship, one tick ----------------
    updateShip(u) {
      this.navUsed = true;
      const keep = this.paths;
      this.paths = this.navPaths();
      try {
        const st = this.pl(u.owner).stats[u.type], o = u.ord;
        if ((o.t === 'move' || o.t === 'amove') && !o.nr) { // a land point becomes the nearest sea point
          o.nr = 1;
          const w = this.navNear(o.x, o.y, 10, u.owner);
          if (w) { o.x = w[0]; o.y = w[1]; }
        }
        switch (o.t) {
          case 'idle':
            if (st.naval === 'fisher') this.fishLoop(u, st);
            else if (!st.noAtk) this.idleLogic(u);
            break;
          case 'move': this.doMove(u, o); break;
          case 'amove': this.doAttackMove(u, o); break;
          case 'attack': this.doAttackOrder(u, o); break;
          case 'unload': this.doUnload(u, o); break;
          default: this.setOrder(u, { t: 'idle' });
        }
      } finally {
        this.paths = keep;
      }
    },

    // ---------------- fishing ----------------
    nearestFish(u) {
      let best = null, bd = Infinity;
      for (const f of this.fish) {
        if (f.amt <= 0) continue;
        const d = (f.x - u.x) ** 2 + (f.y - u.y) ** 2;
        if (d < bd || (d === bd && this.tieKey(u.owner, f.tx, f.ty) < this.tieKey(u.owner, best.tx, best.ty))) { bd = d; best = f; }
      }
      return best;
    },
    nearestHarbor(u) {
      let best = null, bd = Infinity;
      for (const b of this.buildings.values()) {
        if (b.owner !== u.owner || b.type !== 'harbor' || !b.built || b.dead || b.dying) continue;
        const d = this.distSq(u.x, u.y, b);
        if (d < bd || (d === bd && this.tieKey(u.owner, 2 * b.tx + b.size, 2 * b.ty + b.size) < this.tieKey(u.owner, 2 * best.tx + best.size, 2 * best.ty + best.size))) { bd = d; best = b; }
      }
      return best;
    },
    fishLoop(u) {
      const p = this.pl(u.owner);
      if (u.amt >= FISH.carry) u.fst = 'return';
      let spot = u.fid ? this.fish.find((f) => f.id === u.fid) : null;
      if (spot && spot.amt <= 0) spot = null;
      if (u.fst === 'return' || (!spot && u.amt > 0)) {
        const h = this.nearestHarbor(u);
        if (!h) return;
        const cx = (h.tx + h.size / 2) * 1000, cy = (h.ty + h.size / 2) * 1000;
        if ((u.x - cx) ** 2 + (u.y - cy) ** 2 <= ((h.size / 2 + 1.9) * 1000) ** 2) {
          p.res.food += u.amt;
          p.gathered.food += u.amt;
          u.amt = 0;
          u.fst = 'seek';
          return;
        }
        let g = u.gx !== undefined && u.gh === h.id ? [u.gx, u.gy] : null;
        if (!g) { g = this.navNear(cx, cy, 7, u.owner); if (!g) return; u.gx = g[0]; u.gy = g[1]; u.gh = h.id; }
        if (this.goPoint(u, g[0], g[1], 500) === 'stuck') u.gh = 0;
        return;
      }
      if (!spot) {
        spot = this.nearestFish(u);
        if (!spot) return;
        u.fid = spot.id;
      }
      u.fst = 'seek';
      if ((u.x - spot.x) ** 2 + (u.y - spot.y) ** 2 <= 1500 * 1500) {
        const pct = p.gatherPct.fish || 0;
        u.gp += Math.round((FISH.rate * 100 * (100 + pct)) / 100 * (this.wxGath ? this.worldGather('fish') : 1));
        while (u.gp >= 1000 && u.amt < FISH.carry && spot.amt > 0) { u.gp -= 1000; u.amt++; spot.amt--; }
        if (u.amt >= FISH.carry || spot.amt <= 0) u.fst = 'return';
        return;
      }
      this.goPoint(u, spot.x, spot.y, 1200);
    },

    // ---------------- transport ----------------
    // the land tile nearest to a ship (within 5 tiles), for boarding and landing
    shoreFor(t, owner) {
      const W = this.W, H = this.H, cx = Math.floor(t.x / 1000), cy = Math.floor(t.y / 1000);
      let best = null, bd = Infinity;
      for (let dy = -5; dy <= 5; dy++) for (let dx = -5; dx <= 5; dx++) {
        const tx = cx + dx, ty = cy + dy;
        if (tx < 0 || ty < 0 || tx >= W || ty >= H || !this.landPaths.canPass(owner, ty * W + tx)) continue;
        const d = (tx * 1000 + 500 - t.x) ** 2 + (ty * 1000 + 500 - t.y) ** 2;
        if (d < bd || (d === bd && this.tieKey(owner, tx, ty) < this.tieKey(owner, best[0], best[1]))) { bd = d; best = [tx, ty]; }
      }
      return best && bd <= 5200 * 5200 ? best : null;
    },

    cmd_board(p, a) {
      const t = this.units.get(+a.transport_id);
      if (!t || t.dead) return fail('not_found', `no ship ${a.transport_id}`);
      if (t.owner !== p.id) return fail('not_owner', `ship ${t.id} is not yours`);
      const ts = p.stats[t.type];
      if (!ts.cargo) return fail('not_a_transport', `${t.type} cannot carry units (only a transport can)`);
      const r = this.resolveUnits(p, a.units);
      if (r.error) return r.error;
      const list = r.list.filter((u) => !u.ship && !u.boarded && p.stats[u.type].cls !== 'siege');
      if (!list.length) return fail('no_units', 'no land unit to board (siege units and ships cannot board)');
      const going = [...this.units.values()].filter((u) => u.owner === p.id && u.ord.t === 'board' && u.ord.id === t.id && !u.dead).length;
      const free = ts.cargo - t.cargo.length - going;
      if (free <= 0) return fail('full', `transport ${t.id} is full (${ts.cargo})`);
      const sh = this.shoreFor(t, p.id);
      if (!sh) return fail('not_at_shore', `transport ${t.id} must lie within 5 tiles of land; move it to the shore first`);
      const take = list.slice(0, free);
      for (const u of take) this.setOrder(u, { t: 'board', id: t.id, x: sh[0] * 1000 + 500, y: sh[1] * 1000 + 500, r: 900, ck: 0 });
      const res = { ok: true, boarding: take.length, free_after: free - take.length };
      if (take.length < list.length) res.note = `only ${take.length} of ${list.length} fit`;
      return res;
    },

    doBoard(u, o) {
      const t = this.units.get(o.id);
      if (!t || t.dead || t.dying || !t.cargo) { this.setOrder(u, { t: 'idle' }); return; }
      if ((u.x - t.x) ** 2 + (u.y - t.y) ** 2 <= 3800 * 3800) {
        const cap = this.pl(u.owner).stats[t.type].cargo;
        if (t.cargo.length >= cap) { this.setOrder(u, { t: 'idle' }); return; }
        this.releaseNode(u);
        u.boarded = t.id;
        t.cargo.push(u.id);
        u.x = t.x; u.y = t.y; u.wp = null;
        u.ord = { t: 'idle' };
        this.event(this.pl(u.owner), { type: 'boarded', unit: u.type, ship: t.id });
        return;
      }
      if (++o.ck % 10 === 0) {
        const sh = this.shoreFor(t, u.owner);
        if (!sh) { this.setOrder(u, { t: 'idle' }); return; }
        o.x = sh[0] * 1000 + 500; o.y = sh[1] * 1000 + 500; u.wp = null;
      }
      if (this.goPoint(u, o.x, o.y, o.r) !== 'ok') this.setOrder(u, { t: 'idle' });
    },

    cmd_unload(p, a) {
      const t = this.units.get(+a.transport_id);
      if (!t || t.dead) return fail('not_found', `no ship ${a.transport_id}`);
      if (t.owner !== p.id) return fail('not_owner', `ship ${t.id} is not yours`);
      if (!p.stats[t.type].cargo) return fail('not_a_transport', `${t.type} cannot carry units`);
      if (!t.cargo.length) return fail('empty', `transport ${t.id} carries nobody`);
      let w;
      if (Array.isArray(a.to) && a.to.length === 2 && a.to.every((v) => Number.isFinite(+v))) {
        const [lx, ly] = this.clampXY(a.to);
        w = this.navNear(lx * 1000 + 500, ly * 1000 + 500, 6, p.id);
        if (!w) return fail('no_shore', `no water within 6 tiles of [${lx},${ly}]; give a land tile at a coast`);
      } else {
        w = this.navNear(t.x, t.y, 0, p.id) || [t.x, t.y];
        const sh = this.shoreFor(t, p.id);
        if (!sh) return fail('not_at_shore', 'no land within 5 tiles; sail to a coast or give `to`');
      }
      this.setOrder(t, { t: 'unload', wx: w[0], wy: w[1] });
      return { ok: true, unloading: t.cargo.length };
    },

    doUnload(u, o) {
      const r = this.goPoint(u, o.wx, o.wy, 800);
      if (r === 'stuck') { this.setOrder(u, { t: 'idle' }); return; }
      if (r !== 'arrived') return;
      const W = this.W, H = this.H, cx = Math.floor(u.x / 1000), cy = Math.floor(u.y / 1000), owner = u.owner;
      const cand = [];
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const tx = cx + dx, ty = cy + dy;
        if (tx < 0 || ty < 0 || tx >= W || ty >= H || !this.landPaths.canPass(owner, ty * W + tx)) continue;
        cand.push([tx, ty, (tx * 1000 + 500 - u.x) ** 2 + (ty * 1000 + 500 - u.y) ** 2]);
      }
      cand.sort((a, b) => a[2] - b[2] || this.tieKey(owner, a[0], a[1]) - this.tieKey(owner, b[0], b[1]));
      if (!cand.length) { this.event(this.pl(owner), { type: 'unload_failed', ship: u.id }); this.setOrder(u, { t: 'idle' }); return; }
      let k = 0, n = 0;
      for (const id of u.cargo) {
        const c = this.units.get(id);
        if (!c || c.dead) continue;
        const [tx, ty] = cand[k++ % cand.length];
        c.boarded = 0;
        c.x = tx * 1000 + 500; c.y = ty * 1000 + 500; c.px = c.x; c.py = c.y; c.wp = null;
        this.setOrder(c, { t: 'idle' });
        n++;
      }
      u.cargo = [];
      this.event(this.pl(owner), { type: 'landed', n });
      this.setOrder(u, { t: 'idle' });
    },

    // a sunk transport: the cargo goes down with it (counts as kills for the side that sank it)
    cargoLost(t, killerOwner, src) {
      for (const id of t.cargo) {
        const c = this.units.get(id);
        if (!c || c.dead || c.dying) continue;
        c.boarded = 0;
        this.kill(c, killerOwner, src);
      }
      t.cargo = [];
    },

    // keep the passengers on the ship (their position feeds the hash)
    navalStep() {
      for (const u of this.units.values()) {
        if (!u.cargo || !u.cargo.length) continue;
        for (const id of u.cargo) {
          const c = this.units.get(id);
          if (c) { c.x = u.x; c.y = u.y; }
        }
      }
    },

    hashNaval(h) {
      for (const f of this.fish) h = hashStep(h, f.amt);
      if (this.navUsed) for (const u of this.units.values()) if (u.cargo) h = hashStep(h, u.cargo.length);
      return h;
    },
  };
  Object.assign(Game.prototype, methods);
}

export { GATHER };
