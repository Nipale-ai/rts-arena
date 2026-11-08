// Procedural symmetric map generator. Output is the JSON map format of mapio.mjs.
// players=2: point symmetry (start tiles are 180 degree rotations of each other).
// players=4: four-fold mirror symmetry (quadrants), start slots TL, TR, BL, BR.
import { RNG } from './rng.mjs';
import { NODES } from './data.mjs';
import { MAP_FORMAT, SHRINE_SIZE, terrainToRows } from './mapio.mjs';
import { profileFor, carveTrail } from './maptypes.mjs';
import { FISH } from './world-data.mjs';

const TC_SIZE = 4;
const TC_TL = [18, 18];

// Resources around the master start (coordinates are for the top-left start, TC at 18,18).
const START_NODES = [
  ['berries', 28, 16], ['berries', 29, 17], ['berries', 29, 19], ['berries', 28, 20], ['berries', 30, 18],
  ['gold', 26, 26], ['stone', 12, 26], ['herd', 32, 22], ['herd', 31, 28],
];

export function generateMap(seed, opts = {}) {
  const players = opts.players === 4 ? 4 : 2;
  const size = opts.size === 96 ? 96 : 128;
  for (let attempt = 0; attempt < 40; attempt++) {
    const m = tryGenerate(seed, attempt, players, size, opts.treasure, profileFor(opts.mapType), !!opts.shrines);
    if (m) return m;
  }
  throw new Error('map generation failed');
}

// Mirror transforms of a tile (x,y) and of a rect footprint.
function transformsFor(players, N) {
  if (players === 2) return [(x, y, s) => [N - x - s, N - y - s]];
  return [
    (x, y, s) => [N - x - s, y],
    (x, y, s) => [x, N - y - s],
    (x, y, s) => [N - x - s, N - y - s],
  ];
}

// Relic shrines (content 2): top-left tiles of the 2x2 shrines, point / quad symmetric by construction. A 2 player map gets a shrine in
// the middle (unless the treasure sits there) and one pair on the flanks, equally far from both starts; a 4 player map gets the middle
// and one on every edge axis. Returns the final list (all mirror copies, no duplicates).
function shrinePositions(players, N, treasure, tf) {
  const c = N / 2, d = Math.round(N * 0.17), S = SHRINE_SIZE;
  const master = [];
  if (players === 2) {
    if (!treasure) master.push([c - 1, c - 1]);
    master.push([c + d - 1, c - d - 1]);
  } else {
    master.push([c - 1, c - 1], [c - 1, c - d - 1], [c - d - 1, c - 1]);
  }
  const seen = new Set(), out = [];
  for (const [x, y] of master) {
    for (const f of [(a, b) => [a, b], ...tf]) {
      const [mx, my] = f(x, y, S);
      const k = my * N + mx;
      if (!seen.has(k)) { seen.add(k); out.push([mx, my]); }
    }
  }
  return out.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}

function tryGenerate(seed, attempt, players, N, treasure, profile, withShrines) {
  const rng = new RNG(Math.imul(seed >>> 0, 2654435761) + attempt * 7919 + players);
  const T = new Uint8Array(N * N); // 0 grass 1 forest 2 water 3 cliff
  const inRegion = players === 2 ? (x, y) => y < N / 2 : (x, y) => x < N / 2 && y < N / 2;
  const set = (x, y, v) => {
    if (x >= 0 && y >= 0 && x < N && y < N) T[y * N + x] = v;
  };
  const blob = (cx, cy, rx, ry, v, density) => {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const dx = (x - cx) / rx, dy = (y - cy) / ry;
        if (dx * dx + dy * dy <= 1 && rng.int(100) < density) set(x, y, v);
      }
  };
  const get = (x, y) => (x >= 0 && y >= 0 && x < N && y < N ? T[y * N + x] : -1);
  if (profile.scatter) profile.scatter({ rng, N, set, get, blob });
  else {
    // meadow: the original scatter, call for call (old seeds keep their maps)
    for (let i = 0; i < 26; i++) blob(rng.int(N), rng.int(N), rng.range(3, 7), rng.range(3, 7), 1, 80);
    for (let i = 0; i < 4; i++) blob(rng.int(N), rng.int(N), rng.range(4, 9), rng.range(3, 7), 2, 100);
    for (let i = 0; i < 6; i++) {
      let x = rng.int(N), y = rng.int(N);
      let dx = rng.range(-1, 1), dy = rng.range(-1, 1);
      if (!dx && !dy) dx = 1;
      const len = rng.range(10, 24);
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
  // Clear the start area, then add the start forests.
  const cx = TC_TL[0] + 2, cy = TC_TL[1] + 2;
  for (let y = cy - 14; y <= cy + 14; y++)
    for (let x = cx - 14; x <= cx + 14; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= 14 * 14) set(x, y, 0);
  for (const [bx, by, br] of profile.startForest) blob(bx, by, br, br, 1, 96);
  // Keep the node spots clear.
  for (const [res, x, y] of START_NODES) {
    const s = NODES[res].size;
    for (let j = -1; j <= s; j++) for (let i = -1; i <= s; i++) set(x + i, y + j, 0);
  }
  // Trails through dense terrain: open corridors from the start to the middle of the map (the mirror image continues them), so woods never wall the towns off.
  if (profile.trails) {
    const cx2 = Math.floor(N / 2) - 1;
    carveTrail({ rng, set, get }, cx, cy, cx2, cx2, 3, inRegion);
    for (let i = 1; i < profile.trails; i++) carveTrail({ rng, set, get }, cx, cy, rng.range(N * 0.3, N * 0.7), rng.range(N * 0.15, N * 0.45), 2, inRegion);
  }
  // Treasure: on the meadow-like maps a cleared, point symmetric disk in the middle of a 2 player map with gold and stone mines;
  // the coast has sea there, so its mines lie at a land corner instead (equally far from both towns).
  const TREASURE = [];
  if (treasure && players === 2 && profile.treasureAt) {
    for (const [fx, fy] of profile.treasureAt) {
      const px = Math.round(fx * N), py = Math.round(fy * N);
      for (let y = py - 6; y <= py + 6; y++) for (let x = px - 6; x <= px + 6; x++) if ((x - px) ** 2 + (y - py) ** 2 <= 5.6 * 5.6 && y < N / 2 - 1) set(x, y, 0);
      TREASURE.push(['gold', px - 3, py - 2, treasure.gold], ['gold', px + 1, py - 4, treasure.gold], ['stone', px - 5, py + 1, treasure.stone], ['gold', px + 1, py + 2, treasure.gold]);
    }
  } else if (treasure && players === 2) {
    const c = N / 2;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if ((x + 0.5 - c) ** 2 + (y + 0.5 - c) ** 2 <= 8.5 * 8.5) set(x, y, 0);
    // master half nodes (offsets from the centre, mirrored later like all other nodes): 3 gold + 1 stone
    TREASURE.push(['gold', c - 7, c - 5, treasure.gold], ['gold', c - 3, c - 8, treasure.gold], ['stone', c - 8, c - 2, treasure.stone], ['gold', c - 2, c - 4, treasure.gold]);
  }
  // Mirror the master region onto the rest of the map.
  const tf = transformsFor(players, N);
  // Relic shrines: a cleared disc around each (clearing the master side is enough, the mirror copies the rest)
  const SHRINES = withShrines ? shrinePositions(players, N, treasure, tf) : [];
  for (const [sx, sy] of SHRINES)
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if ((x + 0.5 - sx - SHRINE_SIZE / 2) ** 2 + (y + 0.5 - sy - SHRINE_SIZE / 2) ** 2 <= 4.6 * 4.6) set(x, y, 0);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      if (!inRegion(x, y)) continue;
      for (const f of tf) {
        const [mx, my] = f(x, y, 1);
        T[my * N + mx] = T[y * N + x];
      }
    }
  // Reachability from the first start.
  const reach = new Uint8Array(N * N);
  const q = [];
  const s0 = (TC_TL[1] + TC_TL[0] % 1) * N + TC_TL[0] + 4;
  reach[s0] = 1;
  q.push(s0);
  for (let qi = 0; qi < q.length; qi++) {
    const i = q[qi], x = i % N, y = (i / N) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
      const ni = ny * N + nx;
      if (!reach[ni] && T[ni] === 0) {
        reach[ni] = 1;
        q.push(ni);
      }
    }
  }
  const starts = [[...TC_TL]];
  if (players === 2) starts.push(tf[0](TC_TL[0], TC_TL[1], TC_SIZE));
  else for (const f of tf) starts.push(f(TC_TL[0], TC_TL[1], TC_SIZE));
  // players=4 order from the transforms is TR, BL, BR (matches slots TL, TR, BL, BR).
  for (const [sx, sy] of starts) if (!reach[(sy + 1) * N + sx + TC_SIZE]) return null;

  // Nodes in the master region.
  const occ = new Uint8Array(N * N);
  const nodes = [];
  const regionOk = (x, y, s) => {
    if (players === 2) return y + s <= N / 2;
    return x + s <= N / 2 && y + s <= N / 2;
  };
  const freeSpot = (x, y, s, margin) => {
    if (x < 3 || y < 3 || x + s > N - 3 || y + s > N - 3 || !regionOk(x, y, s)) return false;
    let adjReach = false;
    for (let j = -margin; j < s + margin; j++)
      for (let i = -margin; i < s + margin; i++) {
        const xx = x + i, yy = y + j;
        if (xx < 0 || yy < 0 || xx >= N || yy >= N) return false;
        const inside = i >= 0 && j >= 0 && i < s && j < s;
        if (inside && (T[yy * N + xx] !== 0 || occ[yy * N + xx])) return false;
        if (!inside && occ[yy * N + xx]) return false;
        if (!inside && reach[yy * N + xx]) adjReach = true;
      }
    return adjReach;
  };
  const place = (res, x, y, amount) => {
    const s = NODES[res].size;
    for (let j = 0; j < s; j++) for (let i = 0; i < s; i++) occ[(y + j) * N + x + i] = 1;
    nodes.push({ res, tx: x, ty: y, amount: amount ?? Math.round((NODES[res].amount * (profile.mul[res] || 1)) / 10) * 10 });
  };
  for (const [res, x, y] of START_NODES) place(res, x, y);
  for (const [res, x, y, amount] of TREASURE) place(res, x, y, amount);
  if (TREASURE.length && !profile.treasureAt) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if ((x + 0.5 - N / 2) ** 2 + (y + 0.5 - N / 2) ** 2 <= 9.5 * 9.5) occ[y * N + x] = 1;
  if (TREASURE.length && profile.treasureAt) for (const [fx, fy] of profile.treasureAt) { const px = Math.round(fx * N), py = Math.round(fy * N); for (let y = py - 7; y <= py + 7; y++) for (let x = px - 7; x <= px + 7; x++) if (x >= 0 && y >= 0 && x < N && y < N && (x - px) ** 2 + (y - py) ** 2 <= 6.5 * 6.5) occ[y * N + x] = 1; }
  for (const [sx, sy] of SHRINES) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if ((x + 0.5 - sx - SHRINE_SIZE / 2) ** 2 + (y + 0.5 - sy - SHRINE_SIZE / 2) ** 2 <= 6 * 6) occ[y * N + x] = 1;
  const dist2 = (x, y, a, b) => (x - a) ** 2 + (y - b) ** 2;
  const tryPlace = (res, minD, maxD, count, clusterCount) => {
    let placed = 0;
    for (let tries = 0; tries < 400 && placed < count; tries++) {
      const x = rng.range(3, N - 4), y = rng.range(3, N - 4);
      const d = dist2(x, y, cx, cy);
      if (d < minD * minD || d > maxD * maxD) continue;
      const s = NODES[res].size;
      if (!freeSpot(x, y, s, 1)) continue;
      place(res, x, y);
      placed++;
      // clusters of small nodes
      for (let k = 1; k < clusterCount; k++) {
        for (let t2 = 0; t2 < 12; t2++) {
          const xx = x + rng.range(-3, 3), yy = y + rng.range(-3, 3);
          if (freeSpot(xx, yy, s, 0)) {
            place(res, xx, yy);
            break;
          }
        }
      }
    }
  };
  const scale = players === 2 ? 1 : 0.5;
  // natural expansions near each start, then contested mid map
  tryPlace('gold', 28, 46, 1, 1);
  tryPlace('stone', 28, 46, 1, 1);
  tryPlace('berries', 26, 46, 1, 4);
  tryPlace('gold', 40, 120, Math.round(profile.mid.gold * scale) || 1, 1);
  tryPlace('stone', 40, 120, Math.round(profile.mid.stone * scale) || 1, 1);
  tryPlace('herd', 30, 120, Math.round(profile.mid.herd * scale) || 1, 3);
  tryPlace('berries', 40, 120, Math.round(profile.mid.berries * scale) || 1, 4);

  // Mirror nodes.
  const base = nodes.slice();
  for (const f of tf)
    for (const n of base) {
      const s = NODES[n.res].size;
      const [mx, my] = f(n.tx, n.ty, s);
      nodes.push({ res: n.res, tx: mx, ty: my, amount: n.amount });
    }

  const out = {
    format: MAP_FORMAT,
    name: profile.id === 'meadow' ? `procedural-${players}p-${seed}` : `procedural-${profile.id}-${players}p-${seed}`,
    seed,
    size: N,
    terrain: terrainToRows(T, N),
    nodes,
    ...(SHRINES.length ? { shrines: SHRINES.map(([tx, ty]) => ({ tx, ty })) } : {}),
    players: starts.map(([tx, ty]) => ({ start: { tx, ty } })),
    symmetry: players === 2 ? 'point' : 'quad',
  };
  if (profile.id !== 'meadow') out.mapType = profile.id;
  // desert palms hold more wood than forest tiles of the other maps
  if (profile.woodPer) {
    out.wood = [];
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (T[y * N + x] === 1) out.wood.push({ tx: x, ty: y, amount: profile.woodPer });
  }
  // fish shoals (coast): deep water, mirrored
  if (profile.sea) {
    const wet = (x, y) => x >= 0 && y >= 0 && x < N && y < N && T[y * N + x] === 2;
    const deep = (x, y) => { for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) if (!wet(x + i, y + j)) return false; return true; };
    const mine = [];
    for (let tries = 0; tries < 900 && mine.length < FISH.shoalsPerSide; tries++) {
      const x = rng.range(4, N - 5), y = rng.range(4, Math.floor(N / 2) - 1);
      if (!deep(x, y) || Math.hypot(x - cx, y - cy) > 48 || mine.some(([a, b]) => Math.hypot(a - x, b - y) < 4)) continue;
      mine.push([x, y]);
    }
    out.fish = [];
    for (const [x, y] of mine) { out.fish.push({ tx: x, ty: y, amount: FISH.amount }); for (const f of tf) { const [mx, my] = f(x, y, 1); out.fish.push({ tx: mx, ty: my, amount: FISH.amount }); } }
  }
  // neutral caravans: one route per start (a trade post near the town and one toward the middle), mirrored like everything else
  {
    const posts = [];
    const ok = (x, y) => x >= 4 && y >= 4 && x < N - 4 && y < N - 4 && regionOk(x, y, 1) && reach[y * N + x] && T[y * N + x] === 0 && !occ[y * N + x];
    const pick = (lo, hi, tries = 400) => {
      for (let t = 0; t < tries; t++) {
        const x = rng.range(4, N - 5), y = rng.range(4, N - 5), d = Math.hypot(x - cx, y - cy);
        if (d >= lo && d <= hi && ok(x, y)) return [x, y];
      }
      return null;
    };
    const a = pick(22, 32), b = pick(36, 52);
    if (a && b) posts.push([a, b]);
    out.caravans = [];
    for (const [pa, pb] of posts) {
      out.caravans.push({ route: [pa, pb] });
      for (const f of tf) out.caravans.push({ route: [pa, pb].map(([x, y]) => f(x, y, 1)) });
    }
  }
  return out;
}
