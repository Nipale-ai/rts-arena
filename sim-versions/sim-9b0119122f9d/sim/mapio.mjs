// Map file format (JSON). The procedural generator produces exactly this object.
//
// {
//   "format": "rts-map-1", "name": "...", "size": 128,
//   "terrain": ["....ff~~#...", ...],          // size strings of size chars: . grass  f forest  ~ water  # cliff
//   "nodes": [{"res":"gold","tx":10,"ty":12,"amount":2500}, ...],   // res: gold | stone | berries | herd
//   "wood": [{"tx":5,"ty":6,"amount":80}],      // optional per-tile overrides of forest wood (default FOREST_WOOD)
//   "players": [                                 // 2 to 4 slots
//     {"start":{"tx":18,"ty":18},                // town center top-left tile (default start building)
//      "buildings":[{"type":"town_center","tx":18,"ty":18}],   // optional, replaces the default town center
//      "units":[{"type":"worker","tx":22,"ty":22}]},           // optional, replaces the default workers
//     ...
//   ],
//   "symmetry": "point" | "quad" | null          // informational (used by fairness tests)
// }
import { NODES } from './data.mjs';

export const MAP_FORMAT = 'rts-map-1';
const CH = { '.': 0, f: 1, '~': 2, '#': 3 };
const CHR = ['.', 'f', '~', '#'];

export function terrainToRows(terrain, size) {
  const rows = [];
  for (let y = 0; y < size; y++) {
    let s = '';
    for (let x = 0; x < size; x++) s += CHR[terrain[y * size + x]];
    rows.push(s);
  }
  return rows;
}

export function rowsToTerrain(rows, size) {
  const t = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) t[y * size + x] = CH[rows[y][x]];
  return t;
}

export function validateMap(m) {
  const err = (s) => {
    throw new Error(`invalid map: ${s}`);
  };
  if (!m || typeof m !== 'object') err('not an object');
  if (m.format !== MAP_FORMAT) err(`format must be "${MAP_FORMAT}"`);
  const size = m.size;
  if (!Number.isInteger(size) || size < 32 || size > 256) err('size must be an integer 32..256');
  if (!Array.isArray(m.terrain) || m.terrain.length !== size) err('terrain must have `size` rows');
  for (const r of m.terrain) {
    if (typeof r !== 'string' || r.length !== size) err('terrain rows must be strings of `size` chars');
    for (const c of r) if (!(c in CH)) err(`bad terrain char "${c}"`);
  }
  const inb = (x, y) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < size && y < size;
  for (const n of m.nodes || []) {
    if (!NODES[n.res]) err(`unknown node res "${n.res}"`);
    const s = NODES[n.res].size;
    if (!inb(n.tx, n.ty) || !inb(n.tx + s - 1, n.ty + s - 1)) err('node out of bounds');
    if (!(n.amount > 0)) err('node amount must be > 0');
  }
  for (const w of m.wood || []) if (!inb(w.tx, w.ty) || !(w.amount >= 0)) err('bad wood override');
  if (!Array.isArray(m.players) || m.players.length < 2 || m.players.length > 4) err('players must have 2 to 4 entries');
  for (const p of m.players) {
    if (!p.start || !inb(p.start.tx, p.start.ty)) err('player start missing or out of bounds');
    for (const b of p.buildings || []) if (!inb(b.tx, b.ty) || !b.type) err('bad pre-placed building');
    for (const u of p.units || []) if (!inb(u.tx, u.ty) || !u.type) err('bad pre-placed unit');
  }
  return m;
}

export function saveMap(m) {
  return JSON.stringify(m);
}

export function loadMap(jsonOrObject) {
  const m = typeof jsonOrObject === 'string' ? JSON.parse(jsonOrObject) : jsonOrObject;
  return validateMap(m);
}
