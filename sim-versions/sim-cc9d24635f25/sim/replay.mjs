// Replay: same options (seed, map, players) + the command log reproduces a match exactly.
import { Game } from './game.mjs';

export function replay(opts, commandLog, untilTick = Infinity) {
  const g = new Game(opts);
  let i = 0;
  while (!g.over && g.t < untilTick) {
    while (i < commandLog.length && commandLog[i].t === g.t) {
      g.command(commandLog[i].p, commandLog[i].cmd);
      i++;
    }
    g.step();
  }
  return g;
}
