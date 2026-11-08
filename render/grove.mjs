// Groves: every patch of forest is ONE tree species, picked per patch (a jittered Voronoi cell, world space) from the seed and the map type. Different
// species only meet at a patch border, with a small gap. Within a species the look varies by size, rotation and tint. Trees keep a minimum spacing by
// crown radius (dart throwing, deterministic): crowns may overlap by the `spacing` share, trunks never meet. Render only: the sim forest tiles are untouched.
import { hash, vnoise } from './terrain.mjs';

export const GROVE = 12;        // patch size in tiles
export const BORDER_GAP = 1.4;  // tiles of empty ground between two groves of different species

// horizontal crown radius of each tree model at scale 1 (half the widest x/z extent of the glb, tools/make-game-assets output)
export const CROWN = { 5: 1.15, 6: 0.53, 22: 0.6, 23: 0.9, 117: 0.42, 118: 0.52, 119: 0.95, 120: 0.88, 121: 1.28, 122: 0.3, 124: 0.64, 125: 0.5, 126: 0.88, 127: 1.0, 128: 0.58, 134: 0.3 };
// 117 (tall red-trunk pine) reads as dark crossed planes at LOD1/2 in the distance: kept out of the groves
const SKIP = new Set([117]);
export const crownOf = (id) => CROWN[id] ?? 0.8;

function pick(list, r) {
  let tot = 0;
  for (const e of list) tot += e[1];
  let a = r * tot;
  for (const e of list) { a -= e[1]; if (a <= 0) return e; }
  return list[list.length - 1];
}

// the tint (brightness multiplier) of every species of this map type
export function tintsOf(T) {
  const m = new Map();
  for (const k of ['conifer', 'broadleaf', 'rare']) for (const e of T[k] || []) m.set(e[0], e[2] ?? 1);
  return m;
}

export function makeGroves(T, seed) {
  const cache = new Map();
  const cell = (cx, cy) => {
    const key = cx * 100003 + cy;
    let c = cache.get(key);
    if (c) return c;
    const x = (cx + 0.12 + 0.76 * hash(cx, cy, seed + 701)) * GROVE, y = (cy + 0.12 + 0.76 * hash(cx, cy, seed + 702)) * GROVE;
    const b = vnoise(x / 13, y / 13, seed + 301), r = hash(cx, cy, seed + 703);
    let e;
    if (T.rare?.length && hash(cx, cy, seed + 704) < 0.0) e = pick(T.rare, hash(cx, cy, seed + 705));
    else {
      const conifer = b < 0.42 ? 1 : b > 0.58 ? 0 : (b - 0.42) / 0.16 < r ? 1 : 0;
      const raw = (conifer ? T.conifer : T.broadleaf) || T.broadleaf || T.conifer;
      const ok = raw.filter((q) => q[1] >= 0.5 && !SKIP.has(q[0])), list = ok.length ? ok : raw; // the 0.15-weight oddities only ever sprinkle, never fill a grove
      e = pick(list, hash(cx, cy, seed + 706));
    }
    c = { x, y, id: e[0], tint: (0.94 + 0.12 * hash(cx, cy, seed + 707)), key };
    cache.set(key, c);
    return c;
  };
  // grove at a world position: its species and the distance to the border with a different species
  return function groveAt(x, y) {
    const gx = Math.floor(x / GROVE), gy = Math.floor(y / GROVE);
    let best = null, bd = 1e9;
    const all = [];
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const c = cell(gx + i, gy + j), d = Math.hypot(c.x - x, c.y - y);
      all.push([d, c]);
      if (d < bd) { bd = d; best = c; }
    }
    let od = 1e9;
    for (const [d, c] of all) if (c.id !== best.id && d < od) od = d;
    return { id: best.id, tint: best.tint, cell: best.key, border: (od - bd) / 2 };
  };
}

// Plans the trees. cand: [[tile x, tile y, weight 0..1]] (a tile can hold up to `per` candidates, kept with probability weight);
// occupied: [[x, z, r]] already standing trees; spacing: share of the summed crown radii two trees keep apart (1 = crowns only touch). Returns [{x, z, tx, ty, id, s, ry, b (brightness), cr (tint jitter)}].
export function planGroves(T, seed, cand, { scale = [1.1, 1.55], per = 2, occupied = [], salt = 0, spacing = 1 } = {}) {
  const groveAt = makeGroves(T, seed), tints = tintsOf(T);
  const CS = 3, grid = new Map();
  const put = (x, z, r) => { const k = Math.floor(x / CS) * 65537 + Math.floor(z / CS); (grid.get(k) || grid.set(k, []).get(k)).push([x, z, r]); };
  for (const [x, z, r] of occupied) put(x, z, r);
  const free = (x, z, r) => {
    const cx = Math.floor(x / CS), cz = Math.floor(z / CS);
    for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) {
      const l = grid.get((cx + i) * 65537 + cz + j);
      if (l) for (const [ox, oz, orr] of l) if (Math.hypot(ox - x, oz - z) < (r + orr) * spacing) return false;
    }
    return true;
  };
  const list = [];
  for (const [tx, ty, w = 1] of cand) for (let q = 0; q < per; q++) {
    const sl = salt + q * 100;
    if (q > 0 && hash(tx, ty, 330 + sl) > w) continue;
    if (q === 0 && w < 1 && hash(tx, ty, 331 + sl) > w) continue;
    const x = tx + 0.1 + 0.8 * hash(tx, ty, 10 + sl), z = ty + 0.1 + 0.8 * hash(tx, ty, 20 + sl);
    list.push({ x, z, tx, ty, q, prio: hash(tx, ty, 340 + sl) });
  }
  list.sort((a, b) => a.prio - b.prio);
  const out = [];
  for (const c of list) {
    const g = groveAt(c.x, c.z);
    if (g.border < BORDER_GAP * 0.5) continue; // border strip between two species stays empty
    const sl = salt + c.q * 100;
    const s = scale[0] + hash(c.tx, c.ty, 30 + sl) * (scale[1] - scale[0]);
    const r = crownOf(g.id) * s;
    if (!free(c.x, c.z, r)) continue;
    put(c.x, c.z, r);
    out.push({ x: c.x, z: c.z, tx: c.tx, ty: c.ty, id: g.id, s, ry: hash(c.tx, c.ty, 40 + sl) * 6.283, b: (0.88 + hash(c.tx, c.ty, 50 + sl) * 0.26) * (tints.get(g.id) ?? 1) * g.tint, cr: hash(c.tx, c.ty, 60 + sl) });
  }
  return out;
}
