// The orders of a model in plain words: what the casters read in their facts and what the cards on screen show. The log keeps the raw commands.
//   plainOrders('train 3x worker, build lumber_camp, cancel_standing') -> 'train 3 workers, build a lumber camp, cancel a standing order'
import { displayName, displayPlural } from '../render/theme/display-name.mjs';

const nice = (s) => displayName('any', s); // R1: the theme decides the words (default classic = the old underscore-to-space text)
const withA = (s) => `${/^[aeiou]/i.test(s) ? 'an' : 'a'} ${s}`; // C1: a theme name starts with a capital ("an Arc Gunner"); the classic words are lower case, so nothing moves for them
const WORDS = { auto_train: 'keep training', auto_build_houses: 'keep building houses', attack_wave: 'send attack waves', attack: 'attack', move: 'move units', scout: 'send the scout', say: 'send a chat message', trade: 'trade at the market', 'advance tier': 'go up a tier' };
// C1: the plural of a built thing is the theme's (classic: the regular plural, the one pluralOf makes)
const COUNTED = { build: (s, n, id) => (n > 1 ? `build ${n} ${displayPlural('building', id)}` : `build ${withA(s)}`), cancel_standing: (n) => (n > 1 ? `cancel ${n} standing orders` : 'cancel a standing order'), group: (n) => (n > 1 ? `form ${n} groups` : 'form a group') };

export function plainOrders(summary) {
  const parts = String(summary || '').split(', ').filter(Boolean), seen = new Map();
  for (const p of parts) seen.set(p, (seen.get(p) || 0) + 1);
  const out = [];
  for (const [p, n] of seen) {
    let m;
    if ((m = /^train (\d+)x (.+)$/.exec(p))) { const k = +m[1] * n, u = displayName('unit', m[2]); out.push(`train ${k} ${k === 1 ? u : displayPlural('unit', m[2])}`); }
    else if ((m = /^build (.+)$/.exec(p))) out.push(COUNTED.build(displayName('building', m[1]), n, m[1]));
    else if ((m = /^research (.+)$/.exec(p))) out.push(`research ${displayName('tech', m[1])}`);
    else if (p in COUNTED) out.push(COUNTED[p](n));
    else out.push(WORDS[p] || nice(p));
  }
  return out.join(', ');
}
