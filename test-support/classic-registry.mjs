// R4: the registry of the 14 classic bodies, cut out of the live registry render/assets/models/units/UNITS.json.
// Once a body of a theme (the Arc Gunner, key dustmoon_archer, family human_rifle) is merged into the live registry, the live file is no longer "the classic registry". The tests of the classic bake
// (rig-build-out, rig-merge-registry, rig-rifle-bake, rig-rifle-clip, rig-render-data) are about the classic bodies, so they read them through this helper: the same file as before the merge, byte for byte.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LIVE_DIR = path.join(ROOT, 'render/assets/models/units');
export const CLASSIC_FAMILIES = ['human', 'rider'];
// keys of the 14 classic bodies: tools/rig/units.json is frozen (units.d holds every newer body)
export const classicKeys = () => Object.entries(JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/rig/units.json'), 'utf8'))).map(([folder, u]) => u.key || folder.replace(/^\d+-/, ''));
export function classicOf(reg) {
  const keys = classicKeys().filter((k) => reg.units[k]);
  return { families: Object.fromEntries(CLASSIC_FAMILIES.filter((f) => reg.families[f]).map((f) => [f, reg.families[f]])), units: Object.fromEntries(keys.map((k) => [k, reg.units[k]])) };
}
export const liveRegistry = (dir = LIVE_DIR) => JSON.parse(fs.readFileSync(path.join(dir, 'UNITS.json'), 'utf8'));
export const classicRegistry = (dir = LIVE_DIR) => classicOf(liveRegistry(dir));
export const classicRegistryText = (dir = LIVE_DIR) => JSON.stringify(classicRegistry(dir)); // build-units.mjs writes JSON.stringify(registry)
// writes the classic registry as UNITS.json into a folder (the seed of a bake target)
export function writeClassicRegistry(destDir, dir = LIVE_DIR) { fs.writeFileSync(path.join(destDir, 'UNITS.json'), classicRegistryText(dir)); }
