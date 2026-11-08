import { createBot as rush } from './rush.mjs';
import { createBot as boom } from './boom.mjs';
import { createBot as turtle } from './turtle.mjs';
import { createBot as towers } from './towers.mjs';
import { createBot as idle } from './idle.mjs';

// idle is level 0 of the solo ladder (a passive economy bot). It comes last, so the default seat picks of the setup page stay as they were.
export const BOTS = { rush, boom, turtle, towers, idle };
export const BOT_NAMES = Object.keys(BOTS);
// the four style bots (solo level 3): the only bots that balance runs play against each other
export const STYLE_BOT_NAMES = ['rush', 'boom', 'turtle', 'towers'];

export function createBot(name) {
  const f = BOTS[name];
  if (!f) throw new Error(`unknown bot "${name}" (have: ${BOT_NAMES.join(', ')})`);
  return f();
}
