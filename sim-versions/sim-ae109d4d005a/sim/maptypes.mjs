// Map types of the procedural generator: meadow (the original map), forest, desert, winter, coast.
// A profile describes how the master half of the map is scattered (forest, water, cliffs), what the start area looks like and which
// resources the map holds. The generator mirrors the master half onto the rest of the map, so every type is fair by construction.
// `scatter` is called with a context { rng, N, set(x,y,v), blob(cx,cy,rx,ry,v,density), line(count), get(x,y) } and fills the terrain
// (0 grass, 1 forest, 2 water, 3 cliff). `meadow` has no scatter: the generator keeps its original code for it, so old seeds give the old maps.
import { MAP_TYPES } from './world-data.mjs';

// a cliff line (rock ridge): same walk as the original meadow generator
function cliffLines(c, count, lenLo = 10, lenHi = 24) {
  const { rng, N, set } = c;
  for (let i = 0; i < count; i++) {
    let x = rng.int(N), y = rng.int(N);
    let dx = rng.range(-1, 1), dy = rng.range(-1, 1);
    if (!dx && !dy) dx = 1;
    const len = rng.range(lenLo, lenHi);
    for (let k = 0; k < len; k++) {
      if (rng.int(100) < 80) set(x, y, 3);
      if (rng.int(100) < 25) set(x + (dy ? 1 : 0), y + (dx ? 1 : 0), 3);
      x += dx;
      y += dy;
      if (rng.int(100) < 15) {
        dx = rng.range(-1, 1);
        dy = rng.range(-1, 1);
        if (!dx && !dy) dy = 1;
      }
    }
  }
}

export const PROFILES = {
  meadow: {
    id: 'meadow', scatter: null, startForest: [[12, 14, 3.6], [31, 35, 3.2]], mid: { gold: 3, stone: 2, herd: 3, berries: 2 }, mul: {}, woodPer: 0,
  },

  // dense woods: a lot of wood, little open ground; winding trails keep the way between the towns open
  forest: {
    id: 'forest',
    scatter(c) {
      const { rng, N, blob } = c;
      for (let i = 0; i < 62; i++) blob(rng.int(N), rng.int(N), rng.range(3, 8), rng.range(3, 8), 1, 88);
      for (let i = 0; i < 2; i++) blob(rng.int(N), rng.int(N), rng.range(3, 6), rng.range(3, 5), 2, 100);
      cliffLines(c, 4);
    },
    trails: 3,
    startForest: [[12, 14, 3.6], [31, 35, 3.2]], mid: { gold: 3, stone: 2, herd: 2, berries: 3 }, mul: {}, woodPer: 0,
  },

  // dunes and mesas: wood only from a few palm oases (every palm holds more wood), more gold and stone in the sand
  desert: {
    id: 'desert',
    scatter(c) {
      const { rng, N, blob } = c;
      for (let i = 0; i < 5; i++) { // oases: a pond inside a palm grove
        const x = rng.int(N), y = rng.int(N);
        blob(x, y, rng.range(3, 4), rng.range(3, 4), 1, 95);
        blob(x, y, 1.6, 1.6, 2, 100);
      }
      for (let i = 0; i < 8; i++) blob(rng.int(N), rng.int(N), rng.range(2, 4), rng.range(2, 3), 3, 72); // mesas
      cliffLines(c, 5, 8, 20);
    },
    startForest: [[12, 14, 2.9], [31, 35, 2.7]], mid: { gold: 4, stone: 3, herd: 2, berries: 1 }, mul: { gold: 1.15, stone: 1.15, berries: 0.9 }, woodPer: 230,
  },

  // spruce woods, frozen lakes and cliffs; plenty of game, thin farmland
  winter: {
    id: 'winter',
    scatter(c) {
      const { rng, N, blob } = c;
      for (let i = 0; i < 34; i++) blob(rng.int(N), rng.int(N), rng.range(3, 7), rng.range(3, 7), 1, 74);
      for (let i = 0; i < 5; i++) blob(rng.int(N), rng.int(N), rng.range(4, 9), rng.range(3, 6), 2, 100);
      cliffLines(c, 8);
    },
    trails: 2,
    startForest: [[12, 14, 3.6], [31, 35, 3.2]], mid: { gold: 3, stone: 2, herd: 4, berries: 1 }, mul: { berries: 0.85 }, woodPer: 0,
  },

  // an inland sea between the two towns (they face each other across it); land passes round the sea at the two corners
  coast: {
    id: 'coast',
    scatter(c) {
      const { rng, N, blob, set } = c;
      for (let i = 0; i < 16; i++) blob(rng.int(N), rng.int(N), rng.range(3, 6), rng.range(3, 6), 1, 80);
      cliffLines(c, 3, 8, 16);
      const f = (v) => Math.round(v * N);
      // the sea (master half; the mirror image completes it): a long body in the middle, bays reaching toward the towns
      blob(f(0.52), f(0.46), N * 0.28, N * 0.16, 2, 100);
      blob(f(0.40), f(0.38), N * 0.10, N * 0.07, 2, 100);
      blob(f(0.31), f(0.43), N * 0.07, N * 0.05, 2, 100);
      blob(f(0.67), f(0.40), N * 0.08, N * 0.06, 2, 100);
      // a few islets with palms (they cannot be reached on foot: decoration for the view)
      for (let i = 0; i < 3; i++) {
        const x = f(0.40 + 0.12 * i) + rng.range(-2, 2), y = f(0.42 + 0.02 * (i % 2)) + rng.range(-1, 1);
        if (c.get(x, y) === 2 && c.get(x + 3, y) === 2 && c.get(x - 3, y) === 2) { blob(x, y, 2.2, 1.8, 0, 100); blob(x, y, 1.4, 1.2, 1, 90); }
      }
      void set;
    },
    sea: true,
    startForest: [[12, 14, 3.4], [31, 35, 2.8]], mid: { gold: 3, stone: 2, herd: 2, berries: 2 }, mul: {}, woodPer: 0,
    // contested mines at the two land corners (equally far from both towns) instead of the centre disk, which would be sea
    treasureAt: [[0.80, 0.15]],
  },
};

export function profileFor(type) {
  return PROFILES[MAP_TYPES.includes(type) ? type : 'meadow'];
}

// Terrain trail: a winding corridor of open ground from (x0,y0) to (x1,y1), `w` tiles wide, only inside the master region.
export function carveTrail(c, x0, y0, x1, y1, w, inRegion) {
  const { rng, set, get } = c;
  let x = x0, y = y0;
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2.2);
  for (let i = 0; i < steps && (Math.abs(x - x1) > 0.8 || Math.abs(y - y1) > 0.8); i++) {
    const dx = x1 - x, dy = y1 - y, d = Math.hypot(dx, dy) || 1;
    x += (dx / d) * 0.9 + (rng.int(100) - 50) / 60;
    y += (dy / d) * 0.9 + (rng.int(100) - 50) / 60;
    const cx = Math.round(x), cy = Math.round(y);
    for (let j = 0; j < w; j++) for (let k = 0; k < w; k++) {
      const px = cx + k, py = cy + j;
      if (inRegion(px, py) && (get(px, py) === 1 || get(px, py) === 3)) set(px, py, 0);
    }
  }
  for (let j = 0; j < w; j++) for (let k = 0; k < w; k++) if (inRegion(x1 + k, y1 + j)) set(x1 + k, y1 + j, 0);
}
