// Turtle: medium economy, towers and a wall line with a gate, ranged defenders, late siege push.
import { ScriptedBot, tune } from './common.mjs';

export const profile = {
  name: 'turtle',
  mill: true,
  walls: true,
  batch: 2,
  parallelBuilds: 1,
  defendRadius: 30,
  alwaysDefend: false,
  retreatRatio: 0.3,
  workers: (o) => Math.min(56, 9 + Math.floor(o.t / 8)),
  ratio: (o) => (o.tier === 1 ? { food: 40, wood: 36, gold: 10, stone: 14 } : { food: 30, wood: 38, gold: 20, stone: 12 }),
  buildings: (o, b) => {
    const list = [];
    if (o.workers.n >= 10) list.push(['barracks', 1]);
    if (o.workers.n >= 12) list.push(['tower', 1]);
    if (o.workers.n >= 14) list.push(['archery_range', 1]);
    if (o.workers.n >= 24) list.push(['barracks', 2]);
    if (o.workers.n >= 16) list.push(['tower', 2]);
    if (o.tier >= 2) list.push(['blacksmith', 1], ['tower', 3], ['tower', 4]);
    if (o.tier >= 2 && o.t > 420) list.push(['siege_workshop', 1], ['tower', 5], ['tower', 6], ['barracks', 2], ['stables', 1]);
    if (o.tier >= 3) list.push(['castle', 1], ['tower', 8], ['archery_range', 2], ['tower', 10]);
    return list;
  },
  mix: (o) => ({ spearman: 3, archer: 4, swordsman: 2, skirmisher: 2, light_cavalry: o.tier >= 2 ? 1 : 0, heavy_cavalry: 1.5, ram: 1.0, catapult: 2.5, healer: o.tier >= 2 ? (o.preset ? 0.8 : 0) : 0, mortar: o.tier >= 3 && o.preset ? 1.8 : 0, sapper: o.tier >= 3 && o.preset ? 1 : 0, bulwark: o.tier >= 3 ? 1.2 : 0 }),
  techs: () => [
    'masonry', 'wood_axe', 'plough', 'ranged_attack_1', 'pierce_armour_1', 'fletching', 'melee_armour_1', 'carry_1', 'mining_1',
    'ranged_attack_2', 'field_medicine_1', 'melee_attack_1', 'pierce_armour_2', 'siege_craft', 'melee_armour_2',
  ],
  priorityUnits: (o) => (o.tier >= 3 ? (o.preset ? [{ unit: 'mortar', max: 2 }] : []) : []),
  priority: (o) => (o.tier >= 3 && o.preset ? ['blackpowder'] : []),
  advance: (o) => (o.tier === 1 ? o.t > 200 && o.workers.n >= 16 : o.t > 480 && o.workers.n >= 28),
  wonder: (o) => o.t >= tune('twt', 1000) && o.army_value >= tune('twa', 2400),
  outposts: true,
  shrineSquad: () => tune('sq_turtle', null),
  waveValue: (o) => Math.min(5000, 2600 + Math.max(0, o.t - 900) * 2),
  earliestAttack: (o) => (o.tier >= 3 && o.t > 900 ? 0 : 99999),
};

export function createBot() {
  return new ScriptedBot(profile);
}
