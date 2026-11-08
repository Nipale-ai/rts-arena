// Map checker for the world editor and the arena: is the map playable and is it fair?
// Pure function, no side effects. Used by POST /api/maps/validate and by the tests.
//   checkMap(map) -> { ok, errors[], warnings[], symmetry, starts[], fairness }
// ok = no errors (a map with warnings can still be played). fairness.level: "perfect" (symmetric), "good", "uneven", "unfair".
import { NODES, BUILDINGS, UNITS, FOREST_WOOD } from './data.mjs';
import { validateMap, rowsToTerrain } from './mapio.mjs';

const TC = BUILDINGS.town_center.size;
const D4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const FOOD = new Set(['berries', 'herd']);
const metricOf = (res) => (FOOD.has(res) ? 'food' : res);

export function checkMap(map) {
  const errors = [], warnings = [];
  try {
    validateMap(map);
  } catch (e) {
    return { ok: false, errors: [e.message.replace(/^invalid map: /, '')], warnings, symmetry: null, starts: [], fairness: { level: 'unknown', metrics: [] } };
  }
  const N = map.size, T = rowsToTerrain(map.terrain, N);
  const P = map.players;
  const at = (x, y) => y * N + x;
  const nodes = map.nodes || [];

  // ---- starts: footprint on open grass, inside the map ----
  P.forEach((p, i) => {
    const { tx, ty } = p.start;
    if (tx + TC > N || ty + TC > N) { errors.push(`Player ${i + 1}: the start (4x4 town centre) sticks out of the map`); return; }
    let bad = 0;
    for (let j = 0; j < TC; j++) for (let k = 0; k < TC; k++) if (T[at(tx + k, ty + j)] !== 0) bad++;
    if (bad) errors.push(`Player ${i + 1}: ${bad} tile(s) under the town centre are not grass`);
    for (let j = 0; j < i; j++) {
      const q = P[j].start;
      if (Math.abs(q.tx - tx) < TC && Math.abs(q.ty - ty) < TC) errors.push(`Players ${j + 1} and ${i + 1} start on top of each other`);
    }
    if (p.buildings && !p.buildings.some((b) => b.type === 'town_center')) warnings.push(`Player ${i + 1}: custom buildings but no town centre`);
    for (const b of p.buildings || []) if (!BUILDINGS[b.type]) errors.push(`Player ${i + 1}: unknown building "${b.type}"`);
    for (const u of p.units || []) if (!UNITS[u.type]) errors.push(`Player ${i + 1}: unknown unit "${u.type}"`);
    if (p.units && !p.units.some((u) => u.type === 'worker')) warnings.push(`Player ${i + 1}: custom units but no worker, nobody can gather`);
  });

  // ---- nodes: terrain, overlap ----
  const occ = new Int16Array(N * N).fill(-1);
  P.forEach((p, i) => { for (let j = 0; j < TC; j++) for (let k = 0; k < TC; k++) { const x = p.start.tx + k, y = p.start.ty + j; if (x < N && y < N) occ[at(x, y)] = 1000 + i; } });
  let onBlocked = 0, onForest = 0, overlap = 0;
  nodes.forEach((n, idx) => {
    const s = NODES[n.res].size;
    for (let j = 0; j < s; j++) for (let k = 0; k < s; k++) {
      const t = T[at(n.tx + k, n.ty + j)];
      if (t === 2 || t === 3) onBlocked++;
      else if (t === 1) onForest++;
      const o = occ[at(n.tx + k, n.ty + j)];
      if (o !== -1) overlap++;
      occ[at(n.tx + k, n.ty + j)] = idx;
    }
  });
  if (onBlocked) errors.push(`${onBlocked} resource tile(s) lie on water or cliffs`);
  if (overlap) errors.push(`${overlap} resource tile(s) overlap another node or a town centre`);
  if (onForest) warnings.push(`${onForest} resource tile(s) lie in forest`);

  // ---- reachability (4-neighbour walk over open grass, forest / water / cliffs block) ----
  const ring = (x, y, s) => {
    const out = [];
    for (let j = -1; j <= s; j++) for (let k = -1; k <= s; k++) {
      if (j >= 0 && j < s && k >= 0 && k < s) continue;
      const xx = x + k, yy = y + j;
      if (xx >= 0 && yy >= 0 && xx < N && yy < N) out.push(at(xx, yy));
    }
    return out;
  };
  const bfs = (seeds) => {
    const d = new Int32Array(N * N).fill(-1), q = [];
    for (const s of seeds) if (T[s] === 0 && d[s] < 0) { d[s] = 0; q.push(s); }
    for (let qi = 0; qi < q.length; qi++) {
      const i = q[qi], x = i % N, y = (i / N) | 0;
      for (const [dx, dy] of D4) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
        const ni = at(nx, ny);
        if (d[ni] < 0 && T[ni] === 0) { d[ni] = d[i] + 1; q.push(ni); }
      }
    }
    return d;
  };
  const dist = P.map((p) => bfs(ring(p.start.tx, p.start.ty, TC)));
  const startInfo = P.map((p, i) => ({ player: i + 1, reachable: true, near: {}, territory: {}, dist: {} }));
  P.forEach((p, i) => {
    for (let j = 0; j < P.length; j++) {
      if (j === i) continue;
      const hit = ring(P[j].start.tx, P[j].start.ty, TC).some((c) => dist[i][c] >= 0);
      if (!hit) { startInfo[i].reachable = false; }
    }
    if (!startInfo[i].reachable) errors.push(`Player ${i + 1} cannot walk to every other start (water, cliffs or forest in the way)`);
  });

  // ---- resources per start ----
  const cx = (n) => n.tx + NODES[n.res].size / 2, cy = (n) => n.ty + NODES[n.res].size / 2;
  const sc = (p) => [p.start.tx + TC / 2, p.start.ty + TC / 2];
  let unreachable = 0;
  const reachableBy = nodes.map(() => []);
  nodes.forEach((n, idx) => {
    const s = NODES[n.res].size;
    const cells = ring(n.tx, n.ty, s);
    P.forEach((p, i) => { if (cells.some((c) => dist[i][c] >= 0)) reachableBy[idx].push(i); });
    if (!reachableBy[idx].length) unreachable++;
    // territory: nearest start by straight distance; exact ties split evenly
    const ds = P.map((p) => { const [a, b] = sc(p); return Math.hypot(cx(n) - a, cy(n) - b); });
    const best = Math.min(...ds);
    const owners = ds.map((d, i) => (Math.abs(d - best) < 1e-9 ? i : -1)).filter((i) => i >= 0);
    for (const i of owners) {
      const m = metricOf(n.res);
      startInfo[i].territory[m] = (startInfo[i].territory[m] || 0) + n.amount / owners.length;
    }
    // nearest walkable distance for each start
    const m = metricOf(n.res);
    P.forEach((p, i) => {
      const dd = Math.min(...cells.map((c) => (dist[i][c] >= 0 ? dist[i][c] : Infinity)));
      if (dd < (startInfo[i].dist[m] ?? Infinity)) startInfo[i].dist[m] = dd;
    });
  });
  if (unreachable) warnings.push(`${unreachable} resource node(s) cannot be reached from any start`);
  // wood: forest tiles per nearest start
  const wood = new Map(); (map.wood || []).forEach((w) => wood.set(at(w.tx, w.ty), w.amount));
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    if (T[at(x, y)] !== 1) continue;
    let bi = 0, bd = Infinity, tie = [];
    P.forEach((p, i) => { const [a, b] = sc(p); const d = Math.hypot(x + 0.5 - a, y + 0.5 - b); if (d < bd - 1e-9) { bd = d; bi = i; tie = [i]; } else if (Math.abs(d - bd) < 1e-9) tie.push(i); });
    const amt = wood.has(at(x, y)) ? wood.get(at(x, y)) : FOREST_WOOD;
    for (const i of tie) startInfo[i].territory.wood = (startInfo[i].territory.wood || 0) + amt / tie.length;
  }
  // nearest tree (walking distance to an open tile next to a forest tile)
  P.forEach((p, i) => {
    let best = Infinity;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      if (dist[i][at(x, y)] < 0 || dist[i][at(x, y)] >= best) continue;
      if (D4.some(([dx, dy]) => x + dx >= 0 && y + dy >= 0 && x + dx < N && y + dy < N && T[at(x + dx, y + dy)] === 1)) best = dist[i][at(x, y)];
    }
    startInfo[i].dist.wood = best;
  });

  // ---- fairness table ----
  const metrics = [];
  const addMetric = (key, label, get, kind) => {
    const vals = startInfo.map(get).map((v) => (v == null ? 0 : v));
    const hi = Math.max(...vals), lo = Math.min(...vals);
    const ratio = hi === 0 ? 1 : lo / hi;
    metrics.push({ key, label, kind, values: vals.map((v) => (Number.isFinite(v) ? Math.round(v) : null)), ratio: +ratio.toFixed(3) });
  };
  for (const [k, label] of [['gold', 'Gold'], ['stone', 'Stone'], ['food', 'Food (berries, herds)'], ['wood', 'Wood']]) addMetric(k, label, (s) => s.territory[k] || 0, 'amount');
  for (const [k, label] of [['gold', 'Walk to nearest gold'], ['stone', 'Walk to nearest stone'], ['food', 'Walk to nearest food'], ['wood', 'Walk to nearest trees']]) {
    if (startInfo.every((s) => s.dist[k] === undefined || s.dist[k] === Infinity)) continue;
    // distance ratio uses +5 tiles so one tile of difference near a camp does not count as unfair
    const vals = startInfo.map((s) => (s.dist[k] === undefined ? Infinity : s.dist[k]));
    const fin = vals.map((v) => (Number.isFinite(v) ? v : 999));
    const hi = Math.max(...fin) + 5, lo = Math.min(...fin) + 5;
    metrics.push({ key: 'd-' + k, label, kind: 'distance', values: vals.map((v) => (Number.isFinite(v) ? v : null)), ratio: +(lo / hi).toFixed(3) });
  }
  const unitCount = (p) => (p.units ? p.units.length : -1) + '|' + (p.buildings ? p.buildings.length : -1);
  if (new Set(P.map(unitCount)).size > 1) warnings.push('Players have different pre-placed units or buildings');

  const symmetry = detectSymmetry(map, T, N);
  const worst = Math.min(1, ...metrics.map((m) => m.ratio));
  let level = worst >= 0.9 ? 'good' : worst >= 0.75 ? 'uneven' : 'unfair';
  if (symmetry && worst >= 0.999) level = 'perfect';
  if (level === 'uneven') warnings.push(`Uneven start: the weakest ${metrics.filter((m) => m.ratio < 0.9).map((m) => m.label.toLowerCase()).join(', ')} differ by more than 10 %`);
  if (level === 'unfair') warnings.push(`Unfair start: ${metrics.filter((m) => m.ratio < 0.75).map((m) => m.label.toLowerCase()).join(', ')} differ by more than 25 %`);
  const fairness = { level, worst: +worst.toFixed(3), metrics };

  return { ok: errors.length === 0, errors, warnings, symmetry, starts: startInfo.map(({ player, reachable, territory, dist }) => ({ player, reachable, territory: Object.fromEntries(Object.entries(territory).map(([k, v]) => [k, Math.round(v)])), nearest: Object.fromEntries(Object.entries(dist).map(([k, v]) => [k, Number.isFinite(v) ? v : null])) })), fairness };
}

// Which exact mirror does the map have? 'quad' (both axes), 'point' (180 degrees), 'mirror-x' (left/right), 'mirror-y' (top/bottom) or null.
// Terrain, resource nodes (position, size, amount) and the start squares must map onto each other.
export function detectSymmetry(map, T = rowsToTerrain(map.terrain, map.size), N = map.size) {
  const tfs = {
    'mirror-x': (x, y, s) => [N - x - s, y],
    'mirror-y': (x, y, s) => [x, N - y - s],
    point: (x, y, s) => [N - x - s, N - y - s],
  };
  const holds = (f) => {
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const [a, b] = f(x, y, 1); if (T[y * N + x] !== T[b * N + a]) return false; }
    const key = (n) => `${n.res}|${n.tx}|${n.ty}|${n.amount}`;
    const set = new Set((map.nodes || []).map(key));
    for (const n of map.nodes || []) { const [a, b] = f(n.tx, n.ty, NODES[n.res].size); if (!set.has(key({ ...n, tx: a, ty: b }))) return false; }
    const st = new Set(map.players.map((p) => `${p.start.tx}|${p.start.ty}`));
    for (const p of map.players) { const [a, b] = f(p.start.tx, p.start.ty, TC); if (!st.has(`${a}|${b}`)) return false; }
    return true;
  };
  const h = {};
  for (const k of Object.keys(tfs)) h[k] = holds(tfs[k]);
  if (h['mirror-x'] && h['mirror-y']) return 'quad';
  if (h.point) return 'point';
  if (h['mirror-x']) return 'mirror-x';
  if (h['mirror-y']) return 'mirror-y';
  return null;
}
