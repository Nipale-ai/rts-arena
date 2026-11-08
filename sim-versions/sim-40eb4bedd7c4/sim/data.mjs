// ALL game numbers live here. Balancing only edits this file.
// Human units: seconds, tiles, tiles/second. The sim converts to ticks / milli-tiles.

export const RESOURCES = ['food', 'wood', 'stone', 'gold'];
export const TIME_LIMIT_S = 3600; // 60 game minutes, then score decides
export const POP_MAX = 150;

export const START = {
  resources: { food: 200, wood: 200, stone: 0, gold: 0 },
  workers: 5,
};

// Gathering: base rate in resource per second per worker, keyed by node kind.
export const GATHER = {
  rate: { wood: 0.7, berries: 0.9, herd: 1.1, farm: 0.55, stone: 0.6, gold: 0.6 },
  carry: 10,
  resOfKind: { wood: 'wood', berries: 'food', herd: 'food', farm: 'food', stone: 'stone', gold: 'gold' },
  // soft number of workers that fit on one node of this kind
  slots: { wood: 3, berries: 4, herd: 4, farm: 1, stone: 6, gold: 6 },
};

// Resource node kinds that map generators place. amount is the default if a map omits it.
export const NODES = {
  berries: { size: 1, amount: 200 },
  herd: { size: 1, amount: 350 },
  stone: { size: 2, amount: 1500 },
  gold: { size: 2, amount: 4500 },
};
export const FOREST_WOOD = 150; // wood per forest tile

// Damage multiplier per armour point: 0.9^armour. Bonus values are percent.
export const ARMOUR_STEP_PCT = 90;

// Damage dealt by buildings against units is in BUILDINGS[..].attack.
export const UNITS = {
  worker: {
    cls: 'worker', from: 'town_center', tier: 1, cost: { food: 50 }, time: 12, pop: 1,
    hp: 30, atk: 3, dmg: 'melee', cd: 1.5, range: 1.0, speed: 1.6,
    armour: { melee: 0, pierce: 0, siege: 0 }, sight: 6,
  },
  spearman: {
    cls: 'infantry', from: 'barracks', tier: 1, cost: { food: 45, wood: 25 }, time: 14, pop: 1,
    hp: 60, atk: 4, dmg: 'melee', cd: 1.5, range: 1.0, speed: 1.8,
    armour: { melee: 1, pierce: 2, siege: 0 }, sight: 7, bonus: { cavalry: 400 },
  },
  swordsman: {
    cls: 'infantry', from: 'barracks', tier: 2, cost: { food: 55, gold: 30 }, time: 16, pop: 1,
    hp: 85, atk: 9, dmg: 'melee', cd: 1.4, range: 1.0, speed: 1.9,
    armour: { melee: 2, pierce: 1, siege: 0 }, sight: 7, bonus: { siege: 250 },
  },
  archer: {
    cls: 'ranged', from: 'archery_range', tier: 1, cost: { wood: 45, gold: 30 }, time: 16, pop: 1,
    hp: 38, atk: 5, dmg: 'pierce', cd: 1.6, range: 7.0, speed: 1.8,
    armour: { melee: 0, pierce: 0, siege: 0 }, sight: 9, projectile: 14, bonus: { infantry: 130 },
  },
  skirmisher: {
    cls: 'ranged', from: 'archery_range', tier: 2, cost: { food: 30, wood: 35 }, time: 14, pop: 1,
    hp: 42, atk: 3, dmg: 'pierce', cd: 1.2, range: 5.5, speed: 1.9,
    armour: { melee: 0, pierce: 3, siege: 0 }, sight: 8, projectile: 14, bonus: { ranged: 300 },
  },
  light_cavalry: {
    cls: 'cavalry', from: 'stables', tier: 2, cost: { food: 80, gold: 30 }, time: 20, pop: 1,
    hp: 90, atk: 8, dmg: 'melee', cd: 1.4, range: 1.0, speed: 3.3,
    armour: { melee: 1, pierce: 2, siege: 0 }, sight: 10, bonus: { ranged: 200, siege: 200 },
  },
  heavy_cavalry: {
    cls: 'cavalry', from: 'stables', tier: 3, cost: { food: 70, gold: 80 }, time: 26, pop: 2,
    hp: 150, atk: 12, dmg: 'melee', cd: 1.8, range: 1.0, speed: 2.8,
    armour: { melee: 3, pierce: 2, siege: 0 }, sight: 8,
  },
  ram: {
    cls: 'siege', from: 'siege_workshop', tier: 2, cost: { wood: 170, gold: 60 }, time: 24, pop: 2,
    hp: 220, atk: 35, dmg: 'siege', cd: 2.0, range: 1.0, speed: 1.1,
    armour: { melee: 4, pierce: 12, siege: 0 }, sight: 6, only: 'buildings', bonus: { building: 300 },
  },
  catapult: {
    cls: 'siege', from: 'siege_workshop', tier: 3, cost: { wood: 200, gold: 140 }, time: 32, pop: 3,
    hp: 100, atk: 30, dmg: 'siege', cd: 5.0, range: 10.0, speed: 1.0,
    armour: { melee: 1, pierce: 3, siege: 0 }, sight: 9, projectile: 8, splash: 1.8, bonus: { building: 150 },
  },
  // ---- late game and support (part B) ----
  // scout: fast, huge sight, weak. Not part of the 'army' selector (noArmy); explores and spots the enemy.
  scout: {
    cls: 'cavalry', from: 'town_center', tier: 1, cost: { food: 60, wood: 20 }, time: 15, pop: 1,
    hp: 45, atk: 3, dmg: 'melee', cd: 1.4, range: 1.0, speed: 3.8,
    armour: { melee: 0, pierce: 1, siege: 0 }, sight: 14, noArmy: true,
  },
  // healer (trained at the barracks, tier 2): no attack. Heals the most wounded own or allied unit (not siege) within `range` tiles, `hp` hit points per second.
  healer: {
    cls: 'support', from: 'barracks', tier: 2, cost: { food: 50, gold: 70 }, time: 22, pop: 1,
    hp: 40, atk: 0, dmg: 'melee', cd: 2.0, range: 1.0, speed: 1.7,
    armour: { melee: 0, pierce: 0, siege: 0 }, sight: 8, heal: { hp: 5, range: 4.0 },
  },
  // mortar: lobs a shell (fixed landing point, 2.2 s flight) 13 tiles, further than any tower. Needs the tech blackpowder,
  // sets up for 2 s after every move, cannot hit anything closer than 4 tiles. Splash also damages the buildings around the target.
  mortar: {
    cls: 'siege', from: 'siege_workshop', tier: 3, needs: 'blackpowder', cost: { wood: 200, gold: 180 }, time: 34, pop: 3,
    hp: 75, atk: 60, dmg: 'siege', cd: 5.0, range: 13.0, minRange: 4.0, speed: 0.9,
    armour: { melee: 1, pierce: 3, siege: 0 }, sight: 13, projectile: 6, splash: 2.2, lob: true, setup: 2.0,
    only: 'buildings', bonus: { building: 250 }, splashBuilding: 60,
  },
  // sapper (pioneer): runs to a building, plants a charge and burns with it. 3 s fuse (killing the sapper in time defuses it).
  // The blast hits the building and, at a fraction, every building and unit around it.
  sapper: {
    cls: 'siege', from: 'siege_workshop', tier: 3, cost: { wood: 50, gold: 90 }, time: 18, pop: 1,
    hp: 46, atk: 0, dmg: 'siege', cd: 1.0, range: 1.0, speed: 2.2,
    armour: { melee: 0, pierce: 1, siege: 0 }, sight: 7, only: 'buildings', bonus: { building: 100 },
    charge: { fuse: 3.0, atk: 420, splash: 1.6, splashBuilding: 50, splashUnit: 30 },
  },
};

// Building footprint size in tiles. crew = how many workers "auto" assigns.
export const BUILDINGS = {
  town_center: {
    size: 4, buildTier: 2, tier: 1, cost: { wood: 300, stone: 150, gold: 100 }, time: 90, hp: 1800, crew: 3,
    armour: { melee: 6, pierce: 12, siege: 0 }, sight: 9, pop: 15,
    drop: ['food', 'wood', 'stone', 'gold'], train: ['worker', 'scout'],
    attack: { atk: 10, dmg: 'pierce', cd: 1.8, range: 8.0, projectile: 14 },
  },
  house: { size: 2, tier: 1, cost: { wood: 40 }, time: 18, hp: 400, crew: 1, armour: { melee: 3, pierce: 8, siege: 0 }, sight: 3, pop: 6 },
  lumber_camp: { size: 2, tier: 1, cost: { wood: 60 }, time: 20, hp: 450, crew: 1, armour: { melee: 3, pierce: 8, siege: 0 }, sight: 4, drop: ['wood'] },
  mining_camp: { size: 2, tier: 1, cost: { wood: 60 }, time: 20, hp: 450, crew: 1, armour: { melee: 3, pierce: 8, siege: 0 }, sight: 4, drop: ['stone', 'gold'] },
  mill: { size: 2, tier: 1, cost: { wood: 80 }, time: 24, hp: 450, crew: 1, armour: { melee: 3, pierce: 8, siege: 0 }, sight: 4, drop: ['food'] },
  farm: { size: 2, tier: 1, cost: { wood: 50 }, time: 12, hp: 150, crew: 1, armour: { melee: 0, pierce: 4, siege: 0 }, sight: 2, node: 'farm', noMargin: true },
  barracks: {
    size: 3, tier: 1, cost: { wood: 140 }, time: 35, hp: 1100, crew: 2,
    armour: { melee: 5, pierce: 10, siege: 0 }, sight: 5, train: ['spearman', 'swordsman', 'healer'], production: true,
  },
  archery_range: {
    size: 3, tier: 1, cost: { wood: 140 }, time: 35, hp: 1000, crew: 2,
    armour: { melee: 5, pierce: 10, siege: 0 }, sight: 5, train: ['archer', 'skirmisher'], production: true,
  },
  stables: {
    size: 3, tier: 2, cost: { wood: 160 }, time: 40, hp: 1100, crew: 2,
    armour: { melee: 5, pierce: 10, siege: 0 }, sight: 5, train: ['light_cavalry', 'heavy_cavalry'], production: true,
  },
  siege_workshop: {
    size: 3, tier: 2, cost: { wood: 180, stone: 60 }, time: 45, hp: 1100, crew: 2,
    armour: { melee: 5, pierce: 10, siege: 0 }, sight: 5, train: ['ram', 'catapult', 'mortar', 'sapper'], production: true,
  },
  blacksmith: { size: 3, tier: 1, cost: { wood: 120 }, time: 35, hp: 900, crew: 2, armour: { melee: 5, pierce: 10, siege: 0 }, sight: 4 },
  tower: {
    size: 2, tier: 1, cost: { wood: 70, stone: 60 }, time: 35, hp: 1000, crew: 2,
    armour: { melee: 6, pierce: 12, siege: 0 }, sight: 10,
    attack: { atk: 14, dmg: 'pierce', cd: 1.6, range: 9.5, projectile: 14 },
  },
  wall: { size: 1, tier: 2, cost: { stone: 6 }, time: 6, hp: 700, crew: 1, armour: { melee: 6, pierce: 20, siege: 0 }, sight: 1, noMargin: true },
  gate: { size: 1, tier: 2, cost: { stone: 20, wood: 20 }, time: 10, hp: 450, crew: 1, armour: { melee: 4, pierce: 20, siege: 0 }, sight: 2, noMargin: true, gate: true },
};

// Tier advance happens at a town center. Key = the tier you advance TO.
export const TIERS = {
  2: { cost: { food: 400, gold: 150 }, time: 45 },
  3: { cost: { food: 800, gold: 450, stone: 100 }, time: 70 },
};

// Techs. Effects:
//  units: list of unit types or cls names, atkPct, hpPct, speedPct, armour:{melee,pierce}, range (tiles), sight
//  gather: {kind: pct}, carry: +n, buildingHpPct, towerAtkPct, towerRange, healPct / healRange (tiles; healers)
export const TECHS = {
  wood_axe: { at: 'lumber_camp', tier: 1, cost: { food: 80, wood: 40 }, time: 25, gather: { wood: 25 } },
  wood_axe_2: { at: 'lumber_camp', tier: 2, req: 'wood_axe', cost: { food: 200, wood: 100, gold: 50 }, time: 35, gather: { wood: 25 } },
  plough: { at: 'mill', tier: 1, cost: { food: 50, wood: 80 }, time: 25, gather: { farm: 30, berries: 15 } },
  plough_2: { at: 'mill', tier: 2, req: 'plough', cost: { food: 150, wood: 150, gold: 40 }, time: 35, gather: { farm: 30, berries: 15 } },
  mining_1: { at: 'mining_camp', tier: 1, cost: { food: 100, wood: 60 }, time: 25, gather: { gold: 20, stone: 20 } },
  mining_2: { at: 'mining_camp', tier: 2, req: 'mining_1', cost: { food: 200, wood: 100, gold: 50 }, time: 35, gather: { gold: 20, stone: 20 } },
  carry_1: { at: 'town_center', tier: 1, cost: { food: 120, wood: 60 }, time: 25, carry: 5 },
  carry_2: { at: 'town_center', tier: 2, req: 'carry_1', cost: { food: 250, gold: 60 }, time: 35, carry: 5 },
  melee_attack_1: { at: 'blacksmith', tier: 2, cost: { food: 120, gold: 80 }, time: 40, units: ['infantry', 'cavalry'], atkPct: 15 },
  melee_attack_2: { at: 'blacksmith', tier: 3, req: 'melee_attack_1', cost: { food: 250, gold: 200 }, time: 55, units: ['infantry', 'cavalry'], atkPct: 15 },
  ranged_attack_1: { at: 'blacksmith', tier: 2, cost: { wood: 120, gold: 80 }, time: 40, units: ['ranged'], atkPct: 15, towerAtkPct: 15 },
  ranged_attack_2: { at: 'blacksmith', tier: 3, req: 'ranged_attack_1', cost: { wood: 250, gold: 200 }, time: 55, units: ['ranged'], atkPct: 15, towerAtkPct: 15 },
  melee_armour_1: { at: 'blacksmith', tier: 2, cost: { food: 120, gold: 60 }, time: 40, units: ['infantry', 'cavalry'], armour: { melee: 1 } },
  melee_armour_2: { at: 'blacksmith', tier: 3, req: 'melee_armour_1', cost: { food: 250, gold: 150 }, time: 55, units: ['infantry', 'cavalry'], armour: { melee: 1 } },
  pierce_armour_1: { at: 'blacksmith', tier: 2, cost: { wood: 100, gold: 60 }, time: 40, units: ['infantry', 'cavalry', 'worker'], armour: { pierce: 1 } },
  pierce_armour_2: { at: 'blacksmith', tier: 3, req: 'pierce_armour_1', cost: { wood: 200, gold: 150 }, time: 55, units: ['infantry', 'cavalry', 'worker'], armour: { pierce: 1 } },
  fletching: { at: 'blacksmith', tier: 2, cost: { wood: 150, gold: 100 }, time: 45, units: ['ranged'], range: 1, towerRange: 1 },
  masonry: { at: 'blacksmith', tier: 2, cost: { wood: 150, stone: 100 }, time: 50, buildingHpPct: 20 },
  bloodlines: { at: 'stables', tier: 2, cost: { food: 150, gold: 80 }, time: 40, units: ['cavalry'], hpPct: 20 },
  blackpowder: { at: 'siege_workshop', tier: 3, cost: { wood: 200, gold: 160 }, time: 45 },
  field_medicine_1: { at: 'barracks', tier: 2, cost: { food: 100, gold: 120 }, time: 40, healPct: 50 },
  field_medicine_2: { at: 'barracks', tier: 3, req: 'field_medicine_1', cost: { food: 200, gold: 250 }, time: 55, healPct: 25, healRange: 2 },
  siege_craft: { at: 'siege_workshop', tier: 3, cost: { wood: 200, gold: 150 }, time: 50, units: ['siege'], atkPct: 20 },
};

// Per-faction overrides. v1 ships a single faction; the hooks are live:
//  unitMods[type] / buildingMods[type]: partial objects merged over the base entry (cost merged key-wise)
//  extraUnits / extraBuildings: whole new entries (unique units), extraTechs likewise
//  gatherPct: {kind: pct}, startResources: partial
export const FACTIONS = {
  default: { name: 'Standard', unitMods: {}, buildingMods: {}, extraUnits: {}, extraBuildings: {}, extraTechs: {}, gatherPct: {}, startResources: {} },
};

// Score = resources gathered / 10 + value of enemy units and buildings destroyed.
export const SCORE = { gatheredDiv: 10, killMul: 1 };

// Game rules knobs
export const RULES = {
  maxQueue: 8,
  trainMaxCount: 10,
  siteSearchRadius: 14,
  wallLineMax: 14,
  idleAcquireBonus: 2.0, // tiles added to range for idle auto-targeting
  leash: 10.0, // tiles an auto-engaged idle unit chases
  workerPolicy: { food: 45, wood: 35, gold: 12, stone: 8 }, // default auto-gather mix for new workers (percent)
};

// rules (optional): rules.unitMods / rules.buildingMods are applied after the faction mods (rule presets)
function mergeMod(a, b) {
  if (!a) return b;
  if (!b) return a;
  return { ...a, ...b, cost: { ...(a.cost || {}), ...(b.cost || {}) }, armour: { ...(a.armour || {}), ...(b.armour || {}) } };
}

export function mergedFaction(id, rules = {}) {
  const f = FACTIONS[id] || FACTIONS.default;
  const units = {};
  const buildings = {};
  const techs = { ...TECHS, ...(f.extraTechs || {}) };
  for (const [k, v] of Object.entries({ ...UNITS, ...(f.extraUnits || {}) })) {
    const m = mergeMod((f.unitMods || {})[k], (rules.unitMods || {})[k]);
    units[k] = m ? { ...v, ...m, cost: { ...v.cost, ...(m.cost || {}) }, armour: { ...v.armour, ...(m.armour || {}) } } : v;
  }
  for (const [k, v] of Object.entries({ ...BUILDINGS, ...(f.extraBuildings || {}) })) {
    const m = mergeMod((f.buildingMods || {})[k], (rules.buildingMods || {})[k]);
    buildings[k] = m ? { ...v, ...m, cost: { ...v.cost, ...(m.cost || {}) } } : v;
  }
  return { id, name: f.name, units, buildings, techs, gatherPct: { ...(f.gatherPct || {}), ...(rules.gatherPct || {}) }, startResources: f.startResources || {} };
}
