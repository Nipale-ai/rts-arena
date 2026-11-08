// A stand-in for tools/rig/build-units.mjs, for the tests of tools/rig/bake-batch.mjs: no Blender, no ImageMagick, no art sources.
// It does what the real one does to the folder: for `--only <folder>` it writes <key>_0..2.bin, <key>.anim, <key>.jpg and then UNITS.json whole,
// built from the registry it read at the START (so two of them at the same time lose each other's entries, like the real thing).
// Environment: FAKE_UNITS_DIR (output folder), FAKE_CATALOG (JSON: folder -> { key?, family? }), FAKE_MODE (comma list, below), FAKE_ARGV_LOG (file that gets the argv).
//   fail:<key>       exit 3 for that key                 clobber      the new registry holds only the new entry (the lost-update race)
//   families         change the clip table of the family human          touch-classic   rewrite bauer_0.bin with other bytes
//   lods1            bake one LOD only                   noentry      do not write the unit into UNITS.json
//   newfamily        add a clip table for the family human_x (what the rifle clip package does)
// Nothing random: the bytes depend on the key only.
import fs from 'node:fs';
import path from 'node:path';

const dir = process.env.FAKE_UNITS_DIR, catalog = JSON.parse(process.env.FAKE_CATALOG || '{}'), modes = (process.env.FAKE_MODE || '').split(',').filter(Boolean);
if (process.env.FAKE_ARGV_LOG) fs.appendFileSync(process.env.FAKE_ARGV_LOG, `${JSON.stringify(process.argv.slice(2))}\n`);
const only = process.argv[process.argv.indexOf('--only') + 1];
const u = catalog[only];
if (!u) { console.error(`unknown unit ${only}`); process.exit(2); }
const key = u.key || only.replace(/^\d+-/, '');
if (modes.includes(`fail:${key}`)) { console.error(`boom in ${key}`); process.exit(3); }

const regFile = path.join(dir, 'UNITS.json');
const old = fs.existsSync(regFile) ? JSON.parse(fs.readFileSync(regFile, 'utf8')) : { families: {}, units: {} };
const FAMILY = { bones: 18, rows: 5, clips: { idle: { start: 0, n: 2, loop: true, dur: 1 }, walk: { start: 2, n: 3, loop: true, dur: 1 } } };
const registry = { families: { human: modes.includes('families') ? { ...FAMILY, rows: 6 } : (old.families.human || FAMILY) }, units: {} };
if (modes.includes('newfamily')) registry.families.human_x = { ...FAMILY, rows: 7 };
const lods = modes.includes('lods1') ? 1 : 3;
const entry = { folder: only, key, family: u.family || 'human', lods: Array.from({ length: lods }, (_, i) => ({ verts: 100 + i, body: 10, team: 2, bytes: 8 })), H: 0.9 };
for (let i = 0; i < lods; i++) fs.writeFileSync(path.join(dir, `${key}_${i}.bin`), `${key} mesh ${i}\n`);
fs.writeFileSync(path.join(dir, `${key}.anim`), `${key} anim\n`);
fs.writeFileSync(path.join(dir, `${key}.jpg`), `${key} atlas\n`);
if (modes.includes('touch-classic')) fs.writeFileSync(path.join(dir, 'bauer_0.bin'), 'not the classic bytes\n');
registry.units = modes.includes('clobber') ? {} : { ...old.units };
if (!modes.includes('noentry')) registry.units[key] = entry;
fs.writeFileSync(regFile, JSON.stringify(registry));
console.log(key, 'fake bake');
