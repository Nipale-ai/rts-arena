// Map store for the world editor: data/maps/<id>.json, each file is one `rts-map-1` map (see sim/mapio.mjs).
// Deleted maps are moved to data/_alt-maps/, never removed.
import fs from 'node:fs';
import path from 'node:path';
import { validateMap, SHRINE_SIZE } from '../sim/mapio.mjs';
import { checkMap, detectSymmetry } from '../sim/mapcheck.mjs';
import { NODES, BUILDINGS, UNITS, FOREST_WOOD } from '../sim/data.mjs';

const RESERVED = new Set(['generate', 'validate', 'catalog']);
export const mapIdOk = (s) => typeof s === 'string' && /^[a-z0-9][a-z0-9._-]{0,60}$/.test(s) && !s.includes('..') && !RESERVED.has(s);
const slug = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

export function createMapStore(dataDir) {
  const dir = path.join(dataDir, 'maps');
  fs.mkdirSync(dir, { recursive: true });
  const file = (id) => path.join(dir, id + '.json');
  const read = (id) => { try { return JSON.parse(fs.readFileSync(file(id), 'utf8')); } catch { return null; } };
  const brief = (id, m, mtime) => ({ id, name: m.name || id, size: m.size, players: m.players.length, nodes: (m.nodes || []).length, symmetry: detectSymmetry(m) || m.symmetry || null, modified: mtime });
  return {
    dir,
    get: (id) => (mapIdOk(id) ? read(id) : null),
    list() {
      const out = [];
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        const id = f.slice(0, -5), m = read(id);
        if (!mapIdOk(id) || !m) continue;
        try { validateMap(m); out.push(brief(id, m, fs.statSync(path.join(dir, f)).mtimeMs)); } catch { /* skip broken files */ }
      }
      return out.sort((a, b) => b.modified - a.modified);
    },
    // save: id given and existing -> overwrite; else new id from the name
    save(rawMap, wantedId) {
      const m = validateMap(structuredCloneJson(rawMap));
      m.name = String(m.name || '').trim().slice(0, 60) || 'Untitled map';
      let id = mapIdOk(wantedId) ? wantedId : null;
      if (!id) {
        const base = slug(m.name) || 'map';
        id = base;
        for (let k = 2; (RESERVED.has(id) || fs.existsSync(file(id))) && k < 1000; k++) id = `${base}-${k}`;
      }
      const tmp = file(id) + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(m));
      fs.renameSync(tmp, file(id));
      return { id, brief: brief(id, m, Date.now()), check: checkMap(m) };
    },
    remove(id) {
      if (!mapIdOk(id) || !fs.existsSync(file(id))) return false;
      const alt = path.join(dataDir, '_alt-maps');
      fs.mkdirSync(alt, { recursive: true });
      fs.renameSync(file(id), path.join(alt, `${id}-${Date.now()}.json`));
      return true;
    },
  };
}

const structuredCloneJson = (o) => JSON.parse(JSON.stringify(o ?? null));

// what the editor may place
export function mapCatalog() {
  return {
    nodes: Object.fromEntries(Object.entries(NODES).map(([k, v]) => [k, { size: v.size, amount: v.amount }])),
    buildings: Object.fromEntries(Object.entries(BUILDINGS).map(([k, v]) => [k, { size: v.size }])),
    units: Object.keys(UNITS),
    forest_wood: FOREST_WOOD,
    town_center_size: BUILDINGS.town_center.size,
    shrine: { size: SHRINE_SIZE, max: 8 }, // the limit of the map format (sim/mapio.mjs)
    sizes: [48, 64, 96, 128],
  };
}
