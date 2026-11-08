// Deterministic "miss" for the weaker solo levels (levels 1 and 2 drop a share of their commands).
// The verdict is a pure hash of (game seed, game second, running command number) and rate. It does NOT see the player number:
// the scripted bots are built seat-mirrored (common.mjs: tile(), cornerOf()), so a hash with the seat in it would put a seat bias
// into the errors. Both seats of a mirrored game issue the same (t, n) stream and therefore drop the same commands.
// Scaffold only: no bot calls it yet (levels 1 and 2 come with package A1b). Lives next to the bots because it counts into bot_version.

// 32-bit mix of three integers (murmur3 style finalizer rounds); unsigned result
export function missHash(seed, t, n) {
  let h = Math.imul((seed | 0) ^ 0x6a09e667, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15) ^ (Math.floor(t) | 0), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13) ^ (n | 0), 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x27d4eb2f);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return h >>> 0;
}

// true = this command is dropped. seed: game seed, t: game second, n: running command number of the bot, rate: share to drop (0..1)
export function deterministicMiss(seed, t, n, rate) {
  if (!(rate > 0)) return false;
  if (rate >= 1) return true;
  return missHash(seed, t, n) / 4294967296 < rate;
}
