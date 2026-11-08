// Boom: big economy first, fast tier ups, upgrades and a large combined-arms wave later.
import { ScriptedBot, tune } from './common.mjs';

export const profile = {
  fishers: 1, boats: 0, harborAt: 24, // coast maps: one fishing boat, later
  name: 'boom',
  mill: true,
  batch: 3,
  parallelBuilds: 2,
  defendRadius: 26,
  retreatRatio: 0.3,
  alwaysDefend: false,
  // cap 36 (was 62): with seats now exactly fair, a 62 worker boom lost ~90 % to turtle; 36 gives ~45 %. Measured, see README.
  // 27.10.: fast preset 56 (economy buff after the tower nerf, BALANCE-2610 part F; classic keeps the measured 36).
  workers: (o) => Math.min(o.preset ? 48 : 36, 9 + Math.floor(o.t / 7)),
  ratio: (o) => (o.tier === 1 ? { food: 45, wood: 40, gold: 10, stone: 5 } : { food: 38, wood: 28, gold: 24, stone: 10 }),
  buildings: (o, b) => {
    const list = [];
    if (o.workers.n >= 11) list.push(['barracks', 1]);
    if (o.workers.n >= 18) list.push(['archery_range', 1]);
    if (o.workers.n >= 27) list.push(['tower', 1]);
    if (o.tier >= 2) list.push(['blacksmith', 1], ['stables', 1], ['barracks', 2]);
    if (o.tier >= 2 && o.workers.n >= 34) list.push(['siege_workshop', 1], ['archery_range', 2]);
    if (o.tier >= 3) list.push(['castle', 1], ['stables', 2], ['barracks', 3], ['siege_workshop', 2]);
    return list;
  },
  mix: (o) => ({ spearman: o.tier >= 2 ? 1 : 3, archer: 3, swordsman: 4, skirmisher: 1.5, light_cavalry: 2, heavy_cavalry: 4, ram: 0.9, catapult: 1.3, healer: o.tier >= 2 ? (o.preset ? 0.8 : 0.4) : 0, mortar: o.tier >= 3 ? (o.preset ? 1.3 : 0.8) : 0, sapper: o.tier >= 3 ? (o.preset ? 1.5 : 0.5) : 0, bulwark: o.tier >= 3 ? tune('bw_boom', 1.5) : 0 }),
  techs: () => [
    'wood_axe', 'plough', 'carry_1', 'mining_1', 'wood_axe_2', 'plough_2', 'mining_2', 'carry_2', 'melee_attack_1', 'pierce_armour_1',
    'melee_armour_1', 'ranged_attack_1', 'bloodlines', 'fletching', 'masonry', 'field_medicine_1', 'melee_attack_2', 'ranged_attack_2', 'melee_armour_2', 'pierce_armour_2', 'siege_craft',
  ],
  priorityUnits: (o) => (o.tier >= 3 && o.t > 700 ? [{ unit: 'mortar', max: 2 }] : []),
  priority: (o) => (o.tier >= 3 ? ['blackpowder'] : []),
  // classic keeps the original 38 workers; the fast preset (smaller map, faster fights) goes to tier 3 with 32
  advance: (o) => (o.tier === 1 ? o.t > 150 && o.workers.n >= 20 : o.t > 330 && o.workers.n >= (o.preset ? 32 : 38)),
  marketPile: tune('mp_boom', 450), // boom runs a big economy: it swaps surplus into gold early
  shrineSquad: () => tune('sq_boom', null),
  waveValue: () => tune('wv_boom', 5500),
  earliestAttack: (o, b) => (o.tier >= 3 || o.t > 780 ? 0 : 99999),
};

export function createBot() {
  return new ScriptedBot(profile);
}
