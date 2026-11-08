// Rush: small economy, early barracks + archery range, first wave around minute 3-4, keeps reinforcing.
import { ScriptedBot, tune } from './common.mjs';

export const profile = {
  navy: false, // coast maps: no harbor, the wood goes into the army
  name: 'rush',
  mill: true,
  batch: 2,
  parallelBuilds: 2,
  defendRadius: 22,
  retreatRatio: 0.3,
  // classic (no preset in the observation): bigger map and no tower caps, so the rush needs a larger economy than in the fast preset
  workers: (o) => (o.preset ? (o.t < 100 ? 12 : o.t < 240 ? 16 : o.t < 480 ? 22 : 30) : o.t < 100 ? 12 : o.t < 240 ? 18 : o.t < 480 ? 28 : 38),
  ratio: (o) => (o.t < 90 ? { food: 50, wood: 45, gold: 5, stone: 0 } : !o.preset ? { food: 40, wood: 45, gold: 12, stone: 3 } : o.tier >= 3 ? { food: 32, wood: 45, gold: 18, stone: 5 } : { food: 36, wood: 35, gold: 25, stone: 4 }),
  buildings: (o, b) => {
    const list = [['barracks', 1]];
    if (b.have.worker >= 0 && o.workers.n >= 9) list.push(['archery_range', 1]);
    if (o.workers.n >= 12) list.push(['barracks', 2]);
    if (o.t > 300) list.push(['blacksmith', 1], ['stables', 1], ['barracks', 3]);
    if (o.t > 480) list.push(['archery_range', 2]);
    if (o.tier >= 2 && o.t > 360) list.push(['siege_workshop', 1]); // rams crack towers and walls
    return list;
  },
  mix: (o) => ({ spearman: 3, archer: 2.5, swordsman: 3, skirmisher: 1, light_cavalry: 1.5, ram: o.tier >= 2 ? 1.2 : 0, healer: o.tier >= 2 ? (o.preset ? 0.5 : 0.2) : 0, sapper: o.tier >= 3 ? (o.preset ? 2 : 1) : 0 }),
  techs: () => ['melee_attack_1', 'pierce_armour_1', 'melee_armour_1', 'ranged_attack_1', 'wood_axe', 'carry_1'],
  priority: (o) => (o.tier >= 3 ? ['blackpowder'] : []),
  priorityUnits: (o) => (o.preset && o.tier >= 3 && o.t > 900 ? [{ unit: 'mortar', max: 2 }] : []),
  shrineSquad: () => tune('sq_rush', { from: 500, size: 3, minArmy: 2000 }), // a squad stands on the relic shrines
  scouts: [150, 1], // the rush bot hardly spends on scouting
  advance: (o) => (o.tier === 1 ? o.t > 240 && o.workers.n >= 14 : o.t > 720 && o.workers.n >= 24),
  // 725/1035 (was 630/900, before that 560/800): re-measured on 30.10. after the bots learned about sudden death and got a per-game economy role;
  // with the old values rush fell to 44 % of the non-mirror games, 725/1035 brings it back to the 50s
  waveValue: (o) => tune("rwv", 1) * (o.t < 480 ? 725 : 1035),
  earliestAttack: () => 150,
};

export function createBot() {
  return new ScriptedBot(profile);
}
