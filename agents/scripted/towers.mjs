// Tower turtle: towers first (as many as the rules allow), few soldiers, one slow late push with siege.
import { ScriptedBot, tune } from './common.mjs';

export const profile = {
  name: 'towers',
  mill: true,
  walls: false,
  batch: 2,
  parallelBuilds: 1,
  defendRadius: 26,
  alwaysDefend: false,
  retreatRatio: 0.3,
  workers: (o) => Math.min(50, 9 + Math.floor(o.t / 8)),
  ratio: (o) => (o.tier === 1 ? { food: 38, wood: 36, gold: 8, stone: 18 } : { food: 30, wood: 36, gold: 18, stone: 16 }),
  buildings: (o) => {
    const list = [];
    if (o.workers.n >= 9) list.push(['tower', 1]);
    if (o.workers.n >= 10) list.push(['barracks', 1]);
    if (o.workers.n >= 12) list.push(['tower', 2]);
    if (o.workers.n >= 14) list.push(['archery_range', 1]);
    if (o.tier >= 2) list.push(['tower', 3], ['tower', 4], ['blacksmith', 1], ['barracks', 2]);
    if (o.tier >= 2 && o.t > 420) list.push(['siege_workshop', 1], ['tower', 5], ['tower', 6]);
    if (o.tier >= 3) list.push(...(tune('nocastle', 0) ? [] : [['castle', 1]]), ['tower', 7], ['tower', 8]);
    return list;
  },
  mix: (o) => ({ spearman: 2, archer: 4, swordsman: 2, skirmisher: 1, light_cavalry: 0.5, heavy_cavalry: 1, ram: 1.4, catapult: 2, healer: o.tier >= 2 ? (o.preset ? 0.5 : 0.3) : 0, mortar: o.tier >= 3 ? 1.5 : 0, sapper: o.tier >= 3 ? 0.5 : 0, bulwark: o.tier >= 3 ? 1 : 0 }),
  techs: () => ['masonry', 'wood_axe', 'plough', 'ranged_attack_1', 'fletching', 'pierce_armour_1', 'carry_1', 'mining_1', 'ranged_attack_2', 'siege_craft'],
  priority: (o) => (o.tier >= 3 ? ['blackpowder'] : []),
  advance: (o) => (o.tier === 1 ? o.t > 200 && o.workers.n >= 16 : o.t > 480 && o.workers.n >= 28),
  // the wonder strategy: a defended base, then a wonder behind it, then hold out until the countdown ends
  wonder: (o, b) => o.t >= tune('wt', 850) && o.army_value >= tune('wa', 2400),
  outposts: true,
  shrineSquad: () => tune('sq_towers', null),
  waveValue: (o) => Math.min(6000, 3600 + Math.max(0, o.t - 900) * 2),
  earliestAttack: (o) => (o.tier >= 2 && o.t > 700 ? 0 : 99999),
};

export function createBot() {
  return new ScriptedBot(profile);
}
