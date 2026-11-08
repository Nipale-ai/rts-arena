// Rule presets. "classic" is the original game (default for the sim, tests and old replays).
// "fast" is the default for LLM matches: models answer only a few times a minute, so the match starts richer and
// more eventful: bigger starting village, a smaller map, a contested treasure in the centre, 30 minute limit.
// Everything here is symmetric for both seats. The resolved rules are written into the replay start line.
import { START, TIME_LIMIT_S } from './data.mjs';
import { MAP_TYPES, WEATHER_KINDS } from './world-data.mjs';

export const PRESETS = {
  classic: {
    preset: 'classic', mapSize: 128, timeLimitS: TIME_LIMIT_S, startWorkers: START.workers,
    startResources: {}, startUnits: [], startHouse: false, treasure: null, gatherPct: {}, buildingMods: {}, unitMods: {}, towerCaps: null, towerSpacing: 0, separation: false,
    // living world (worldRev 1): classic stays the plain meadow without weather or caravans
    worldRev: 1, mapType: 'meadow', weather: 'off', caravans: false,
  },
  fast: {
    preset: 'fast', mapSize: 96, timeLimitS: 1800, startWorkers: 6,
    startResources: { food: 50, wood: 50 }, // on top of the base start resources
    startUnits: [{ type: 'light_cavalry', n: 1 }], // the scout
    startHouse: true,
    treasure: { gold: 2000, stone: 1200 }, // six gold mines and two stone mines around the map centre
    // Towers were a wall of death (both sides turtled, attacked and died). Weaker, slower to build, costlier, limited per tier.
    buildingMods: {
      tower: { cost: { wood: 80, stone: 90 }, time: 45, hp: 900, attack: { atk: 12, dmg: 'pierce', cd: 1.9, range: 9, projectile: 14 } },
      barracks: { hp: 600 }, archery_range: { hp: 560 }, stables: { hp: 600 }, siege_workshop: { hp: 600 }, blacksmith: { hp: 550 }, house: { hp: 250 },
      town_center: { hp: 1400, attack: { atk: 24, dmg: 'pierce', cd: 1.5, range: 9.0, projectile: 14 } }, // a rush must not simply run over a sleeping base
    },
    // softer buildings: games end instead of dragging on
    gatherPct: {},
    // late game must end: siege is faster and hits harder (rams are the answer to towers, from tier 2)
    unitMods: { ram: { time: 16, atk: 55 }, catapult: { atk: 40 } },
    towerCaps: [3, 5, 7], towerSpacing: 6,
    tieBreak: 'seed', // equal score at the time limit: the seed decides, not a draw
    separation: true, // idle units push each other apart smoothly instead of standing in one spot
    // living world: weather from the seed ('auto'; 'off'; or one fixed kind), two neutral caravans, the map type of the generator
    worldRev: 1, mapType: 'meadow', weather: 'auto', caravans: true,
  },
  // "fast" without the tower rework, only to measure before/after in tools/balance.mjs
  'fast-v0': null,
};
PRESETS['fast-v0'] = { ...PRESETS.fast, preset: 'fast-v0', buildingMods: {}, unitMods: {}, gatherPct: {}, towerCaps: null, towerSpacing: 0, separation: false };

// spec: undefined | "fast" | { preset, ...overrides }  ->  a complete plain rules object
export function resolveRules(spec) {
  const o = typeof spec === 'string' ? { preset: spec } : spec && typeof spec === 'object' ? spec : {};
  const base = PRESETS[o.preset] || PRESETS.classic;
  const r = { ...base, ...o, preset: PRESETS[o.preset] ? o.preset : 'classic' };
  r.startResources = { ...base.startResources, ...(o.startResources || {}) };
  r.buildingMods = o.buildingMods || base.buildingMods;
  r.unitMods = o.unitMods || base.unitMods;
  r.gatherPct = o.gatherPct || base.gatherPct;
  r.mapSize = [96, 128].includes(+r.mapSize) ? +r.mapSize : base.mapSize;
  r.timeLimitS = Math.max(60, Math.min(TIME_LIMIT_S, Math.round(+r.timeLimitS || base.timeLimitS)));
  r.startWorkers = Math.max(1, Math.min(12, Math.round(+r.startWorkers || base.startWorkers)));
  // living world. A complete rules object recorded before the world existed (no worldRev) replays as it was: plain meadow, no weather, no caravans.
  const legacy = o.startUnits !== undefined && o.separation !== undefined && o.worldRev === undefined;
  r.worldRev = 1;
  r.mapType = MAP_TYPES.includes(o.mapType) ? o.mapType : legacy ? 'meadow' : base.mapType;
  r.weather = o.weather === 'off' || o.weather === 'auto' || WEATHER_KINDS.includes(o.weather) ? o.weather : legacy ? 'off' : base.weather;
  r.caravans = o.caravans !== undefined ? !!o.caravans : legacy ? false : base.caravans;
  return r;
}
