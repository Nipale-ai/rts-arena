import { Game } from '../sim/game.mjs';

export function stepN(g, n) {
  for (let i = 0; i < n && !g.over; i++) g.step();
}
export function tc(g, pid) {
  return [...g.buildings.values()].find((b) => b.owner === pid && b.type === 'town_center');
}
export function workers(g, pid) {
  return [...g.units.values()].filter((u) => u.owner === pid && u.type === 'worker');
}
// a game where player 1 has lots of resources and tier 3 so that command checks reach the interesting branch
export function richGame(seed = 1) {
  const g = new Game({ seed });
  for (const r of ['food', 'wood', 'stone', 'gold']) g.players[1].res[r] = 5000;
  stepN(g, 5);
  return g;
}
