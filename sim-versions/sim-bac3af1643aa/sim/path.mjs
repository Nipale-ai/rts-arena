// Flow-field pathfinding on the tile grid. One Dijkstra field per (owner, goal) is cached and
// shared by every unit going to that goal (groups, gatherers on the same node, ...).
// Fields are computed lazily with a search limit; a unit outside the limit triggers a full recompute.
import { INF } from './util.mjs';

const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DY = [0, 0, 1, -1, 1, -1, 1, -1];
const DC = [10, 10, 10, 10, 14, 14, 14, 14];
const OPP = [1, 0, 3, 2, 7, 6, 5, 4]; // opposite direction: player 2 scans neighbours in the mirrored order
const MAX_AGE = 150; // ticks
const MAX_CACHE = 48;

export class Paths {
  constructor(game) {
    this.g = game;
    this.W = game.W;
    this.NN = game.W * game.H;
    // one cache per owner: eviction and ageing of one player's fields must not depend on what the other did
    this.caches = [new Map(), new Map(), new Map(), new Map(), new Map()];
    this.pool = [];
    this.heap = new Float64Array(this.NN * 8 + 16);
    this.hs = 0;
    this.computed = 0;
    this.hits = 0;
  }

  canPass(owner, idx) {
    const g = this.g;
    if (g.blk[idx] === 0) return true;
    const go = g.gate[idx]; // owner id of a gate on this tile (allies may pass)
    return go !== 0 && g.team[go] === g.team[owner];
  }

  push(v) {
    const h = this.heap;
    let i = this.hs++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (h[p] <= v) break;
      h[i] = h[p];
      i = p;
    }
    h[i] = v;
  }

  pop() {
    const h = this.heap;
    const top = h[0];
    const last = h[--this.hs];
    let i = 0;
    const n = this.hs;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= n) break;
      if (c + 1 < n && h[c + 1] < h[c]) c++;
      if (h[c] >= last) break;
      h[i] = h[c];
      i = c;
    }
    h[i] = last;
    return top;
  }

  alloc() {
    return this.pool.pop() || new Int32Array(this.NN);
  }

  drop(owner, key) {
    const c = this.caches[owner];
    const f = c.get(key);
    if (f) {
      this.pool.push(f.dist);
      c.delete(key);
    }
  }

  invalidate(owner, key) {
    this.drop(owner, key);
  }

  // Get a field for goal `key` (seeds from seedsFn) that covers tile `startIdx`.
  get(owner, key, startIdx, seedsFn) {
    const cache = this.caches[owner];
    let f = cache.get(key);
    if (f && this.g.t - f.t > MAX_AGE) {
      this.drop(owner, key);
      f = undefined;
    }
    if (f && (f.dist[startIdx] < INF || f.complete)) {
      this.hits++;
      return f;
    }
    const wasPartial = !!f;
    if (f) this.drop(owner, key);
    const seeds = seedsFn();
    let limit = INF;
    if (!wasPartial && seeds.length) {
      const W = this.W;
      const s0 = this.g.sgn[owner] < 0 ? seeds[seeds.length - 1] : seeds[0]; // mirror-equivariant pick
      const sx = s0 % W, sy = (s0 / W) | 0, ux = startIdx % W, uy = (startIdx / W) | 0;
      const ddx = Math.abs(sx - ux), ddy = Math.abs(sy - uy);
      const est = 10 * Math.max(ddx, ddy) + 4 * Math.min(ddx, ddy);
      if (est < 500) limit = est * 2 + 300;
    }
    f = this.compute(owner, seeds, limit);
    if (f.dist[startIdx] >= INF && !f.complete) {
      this.pool.push(f.dist);
      f = this.compute(owner, seeds, INF);
    }
    if (cache.size >= MAX_CACHE) this.drop(owner, cache.keys().next().value);
    cache.set(key, f);
    return f;
  }

  compute(owner, seeds, limit) {
    this.computed++;
    const g = this.g, W = this.W, H = g.H, NN = this.NN;
    const dist = this.alloc();
    dist.fill(INF);
    this.hs = 0;
    const SHIFT = 262144; // > NN
    // Equal-cost tiles are popped in index order for player 1 and in reverse index order for player 2, so the
    // search (and every tentative value left behind at the search limit) is the mirror image for the other seat.
    const rev = g.sgn[owner] < 0, LAST = NN - 1;
    for (const s of seeds) {
      dist[s] = 0;
      this.push(rev ? LAST - s : s);
    }
    let complete = true;
    while (this.hs > 0) {
      const v = this.pop();
      const c = Math.floor(v / SHIFT);
      const i = rev ? LAST - (v - c * SHIFT) : v - c * SHIFT;
      if (c > dist[i]) continue;
      if (c > limit) {
        complete = false;
        // Tiles reached but not settled keep a tentative cost that depends on the pop order. Forget them, so a
        // field only holds exact distances and never depends on which search ran first.
        dist[i] = INF;
        for (let q = 0; q < this.hs; q++) {
          const hv = this.heap[q], hc = Math.floor(hv / SHIFT), hi = rev ? LAST - (hv - hc * SHIFT) : hv - hc * SHIFT;
          if (hc === dist[hi] && hc > limit) dist[hi] = INF;
        }
        break;
      }
      const x = i % W, y = (i / W) | 0;
      for (let k = 0; k < 8; k++) {
        const nx = x + DX[k], ny = y + DY[k];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = ny * W + nx;
        if (!this.canPass(owner, ni)) continue;
        if (k >= 4 && (!this.canPass(owner, y * W + nx) || !this.canPass(owner, ny * W + x))) continue;
        const nc = c + DC[k];
        if (nc < dist[ni]) {
          dist[ni] = nc;
          this.push(nc * SHIFT + (rev ? LAST - ni : ni));
        }
      }
    }
    return { dist, t: this.g.t, complete };
  }

  // Best neighbour tile with a lower distance, or -1.
  next(owner, f, idx) {
    const dist = f.dist, W = this.W, H = this.g.H;
    const d = dist[idx];
    if (d >= INF) return -1;
    const x = idx % W, y = (idx / W) | 0;
    let best = -1, bd = d;
    const flip = this.g.sgn[owner] < 0;
    for (let k0 = 0; k0 < 8; k0++) {
      const k = flip ? OPP[k0] : k0;
      const nx = x + DX[k], ny = y + DY[k];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = ny * W + nx;
      const v = dist[ni];
      if (v >= bd) continue;
      if (!this.canPass(owner, ni)) continue;
      if (k >= 4 && (!this.canPass(owner, y * W + nx) || !this.canPass(owner, ny * W + x))) continue;
      bd = v;
      best = ni;
    }
    return best;
  }

  losClear(owner, x0, y0, x1, y1) {
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.sqrt(dx * dx + dy * dy);
    const steps = Math.ceil(len / 300);
    const W = this.W;
    const g = this.g;
    for (let i = 1; i <= steps; i++) {
      const x = x0 + (dx * i) / steps, y = y0 + (dy * i) / steps;
      // the line must keep a 0.2 tile clearance to blocked tiles (a sample exactly on a tile edge belongs to
      // the tile on the owner's "forward" side, so mirrored samples hit mirrored tiles)
      for (let k = 0; k < 4; k++) {
        const px = x + (k & 1 ? 200 : -200), py = y + (k & 2 ? 200 : -200);
        if (!this.canPass(owner, g.tileMilli(owner, py) * W + g.tileMilli(owner, px))) return false;
      }
    }
    return true;
  }

  // Next waypoint (milli coordinates) for a unit at (ux,uy) following field f, or null.
  waypoint(owner, f, ux, uy) {
    const W = this.W;
    let cur = this.g.tileMilli(owner, uy) * W + this.g.tileMilli(owner, ux);
    const chain = [];
    for (let s = 0; s < 6; s++) {
      const n = this.next(owner, f, cur);
      if (n < 0) break;
      chain.push(n);
      cur = n;
    }
    if (!chain.length) return null;
    let pick = chain[0];
    for (let k = chain.length - 1; k >= 1; k--) {
      const c = chain[k];
      if (this.losClear(owner, ux, uy, (c % W) * 1000 + 500, ((c / W) | 0) * 1000 + 500)) {
        pick = c;
        break;
      }
    }
    return [(pick % W) * 1000 + 500, ((pick / W) | 0) * 1000 + 500];
  }
}
