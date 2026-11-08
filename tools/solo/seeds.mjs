// Fixed seed lists of the solo scenarios. A seed is never picked by hand and never after a result: every list is derived
// from a public rule (sha256 of a fixed string) and frozen in scenarios/SEEDS-HASH.txt before the first pilot run.
//
//   node tools/solo/seeds.mjs --print    the derived lists as JSON (what the scenario files must contain)
//   node tools/solo/seeds.mjs --check    scenario files, derivation and scenarios/SEEDS-HASH.txt agree (exit 1 if not)
//
// Derivation: candidate(i, j) = 100000 + (first 4 bytes of sha256("rts-solo-seeds-v1/<scenario>/<list>/<i>/<j>") mod 900000).
// A candidate is skipped (j + 1) when another list already uses it or when its 2 player map for the scenario settings is not
// valid and perfectly mirrored (checkMap). Both skips depend on the map only, never on a game result.
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { generateMap } from '../../sim/mapgen.mjs';
import { checkMap } from '../../sim/mapcheck.mjs';
import { resolveRules } from '../../sim/rules.mjs';

export const SEED_RULE = 'rts-solo-seeds-v1';
const SEED_MIN = 100000, SEED_SPAN = 900000;

// Order matters: a later list skips the seeds of the earlier ones. Never reorder or insert, append only (new version = new rule string).
export const SEED_PLAN = [
  { scenario: 'duel-ladder', list: 'board', n: 8 }, // level 1-3 cell: 4 styles x 2 seats, one map seed per game
  { scenario: 'eco-sprint', list: 'board', n: 4 }, // no style: 2 seats x 4 maps
  { scenario: 'duel-ladder', list: 'tune', n: 50 }, // calibration (50 maps) and pilot
  { scenario: 'eco-sprint', list: 'tune', n: 8 },
];

// the map settings both scenarios use (preset fast, 96 tiles, no shrines): same rules as scenarios/*.json resolve to
const MAP_RULES = resolveRules({ preset: 'fast', wonder: false, shrines: false });

export function seedCandidate(scenario, list, i, j = 0) {
  const h = crypto.createHash('sha256').update(`${SEED_RULE}/${scenario}/${list}/${i}/${j}`).digest();
  return SEED_MIN + (h.readUInt32BE(0) % SEED_SPAN);
}

export function mapIsGood(seed, rules = MAP_RULES) {
  const m = generateMap(seed, { players: 2, size: rules.mapSize, treasure: rules.treasure, mapType: rules.mapType, shrines: rules.shrines });
  const c = checkMap(m);
  return c.ok && c.fairness.level === 'perfect';
}

// -> { 'duel-ladder': { board: [...], tune: [...] }, 'eco-sprint': { board, tune } }
export function deriveAll({ accept = mapIsGood } = {}) {
  const out = {}, taken = new Set();
  for (const { scenario, list, n } of SEED_PLAN) {
    const seeds = [];
    for (let i = 0; seeds.length < n; i++) {
      let s, j = 0;
      do { s = seedCandidate(scenario, list, i, j++); } while (taken.has(s) || !accept(s));
      taken.add(s);
      seeds.push(s);
    }
    (out[scenario] ||= {})[list] = seeds;
  }
  return out;
}

export const seedListHash = (list) => crypto.createHash('sha256').update(JSON.stringify(list)).digest('hex');

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2];
  if (arg === '--print') console.log(JSON.stringify(deriveAll(), null, 1));
  else if (arg === '--check') {
    const { loadScenario, listScenarioIds } = await import('./scenario.mjs');
    const want = deriveAll();
    let bad = 0;
    for (const id of listScenarioIds()) {
      try {
        const sc = loadScenario(id); // also checks scenarios/SEEDS-HASH.txt
        for (const list of ['board', 'tune']) {
          const same = JSON.stringify(sc.seeds[list]) === JSON.stringify(want[id]?.[list]);
          if (!same) { bad++; console.log(`${id}: ${list} seeds differ from the derivation`); }
        }
        console.log(`${id} v${sc.version}: ok`);
      } catch (e) { bad++; console.log(`${id}: ${e.message}`); }
    }
    process.exit(bad ? 1 : 0);
  } else console.log('usage: node tools/solo/seeds.mjs --print | --check');
}
