// Golden cases for the display names (R1). Runs the text builders of render/, tools/ and server/ that turn a unit or building id into words,
// once for every id of the game, and returns the plain output. The file test-support/display-name-golden.json holds the output of the code
// BEFORE R1 (every place had its own copy of String(id).replace(/_/g, ' ')); test/display-name.test.mjs compares today's output with it.
// Regenerate (only when a text is meant to change, never for R1):  node test-support/display-name-cases.mjs > test-support/display-name-golden.json
import { UNITS, BUILDINGS, TECHS } from '../sim/data.mjs';
import { WILD_UNITS } from '../sim/world-data.mjs';
import { nice as storyNice, typeList as storyTypeList } from '../tools/story-data.mjs';
import { nice as casterNice } from '../tools/caster-facts.mjs';
import { plainOrders } from '../tools/plain-orders.mjs';
import { feedLine } from '../tools/overlay.mjs';
import { validateShow } from '../tools/show-tags.mjs';
import { Hud } from '../render/hud.mjs';

// ids that are no unit, building or tech: the old text for them must stay what it was (underscore to space, nothing else)
export const EXTRA_IDS = ['', 'x_y_z', 'already spaced', 'train', 'advance_tier', 'berries', 'herd', 'forest', 'relic_shrine', 'constructor', 'toString', '__proto__'];

export function allIds() {
  return {
    units: Object.keys(UNITS),
    buildings: Object.keys(BUILDINGS),
    techs: Object.keys(TECHS),
    wild: [...WILD_UNITS],
    extra: [...EXTRA_IDS],
  };
}

const NAMES = (p) => `P${p}`;
// plainOrders('constructor') throws today (tools/plain-orders.mjs: `p in COUNTED` is true for names of Object.prototype). Not part of R1; the golden keeps the fact.
const safe = (fn) => (s) => { try { return fn(s); } catch (e) { return `THROWS ${e.name}`; } };

function hudLines(dead, ev = []) {
  const out = [];
  const ctx = { players: [{ name: 'Anna', color: '#c00' }, { name: 'Ben', color: '#00c' }], push: (html) => out.push(html) };
  Hud.prototype.events.call(ctx, { dead, ev });
  return out;
}

export function collectCases() {
  const ids = allIds();
  const every = [...new Set([...ids.units, ...ids.buildings, ...ids.techs, ...ids.wild, ...ids.extra])];
  const cases = Object.create(null); // no prototype: the id "__proto__" must be a plain key
  const world = { hasPlayer: () => true, unitsExist: () => false, structure: () => null };
  for (const id of every) {
    cases[id] = {
      storyNice: storyNice(id),
      casterNice: casterNice(id),
      storyTypeList: [storyTypeList({ [id]: 1 }), storyTypeList({ [id]: 3 })],
      plainOrders: [`train 1x ${id}`, `train 3x ${id}`, `build ${id}`, `build ${id}, build ${id}`, `research ${id}`, id].map(safe(plainOrders)),
      feed: [
        feedLine({ type: 'losses', by: 1, value: 100, types: { [id]: 2 } }, NAMES).text,
        feedLine({ type: 'losses', p: 2, value: 100, types: { [id]: 1 } }, NAMES).text,
        feedLine({ type: 'building_destroyed', p: 1, by: 2, building: id }, NAMES).text,
        feedLine({ type: 'key_building', p: 1, building: id }, NAMES).text,
        feedLine({ type: 'first_contact', p: 1, other: 2, what: id }, NAMES).text,
      ],
      hud: [
        hudLines([[2, 1, id]]),
        hudLines([[1, 1, id], [1, 1, id], [1, 2, id]]),
        hudLines([], [{ k: 'built', p: 1, b: id }]),
      ],
      show: [
        validateShow({ follow: { sel: { t: 'type', o: 1, ty: id } } }, world, 100),
        validateShow({ building: { player: 1, type: id } }, world, 100),
      ],
    };
  }
  return { ids, cases };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.stdout.write(JSON.stringify(collectCases(), null, 1) + '\n');
}
