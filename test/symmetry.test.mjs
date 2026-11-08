import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../sim/game.mjs';
import { stepN } from '../test-support/helpers.mjs';
import { symmetryDiff, mapDiff, firstDivergence, wilson } from '../tools/seat-bias.mjs';

test('generated maps are exactly point symmetric (terrain, wood, starts)', () => {
  for (const seed of [1, 2, 3, 7, 42]) {
    const g = new Game({ seed });
    assert.equal(mapDiff(g), null, `seed ${seed}`);
  }
});

test('fresh game: player 1 equals the point-mirrored player 2 in every field', () => {
  for (const seed of [1, 5, 9]) {
    const g = new Game({ seed });
    assert.equal(symmetryDiff(g), null, `seed ${seed}`);
  }
});

test('idle games stay mirror symmetric (vision, gathering, spawn points, paths)', () => {
  const g = new Game({ seed: 4 });
  for (let i = 0; i < 40; i++) {
    stepN(g, 25);
    assert.equal(symmetryDiff(g), null, `tick ${g.t}`);
  }
});

test('symmetryDiff reports the field of an injected asymmetry', () => {
  const g = new Game({ seed: 2 });
  stepN(g, 10);
  const u = [...g.units.values()].find((x) => x.owner === 2);
  u.hp -= 1;
  const d = symmetryDiff(g);
  assert.ok(d);
  assert.equal(d.field, 'units');
  g.players[2].res.wood += 1;
  g.units.get(u.id).hp += 1;
  assert.equal(symmetryDiff(g).field, 'resources');
});

test('scripted mirror matches stay perfectly symmetric until the armies meet', () => {
  for (const bot of ['boom', 'turtle', 'rush']) {
    // 4 game minutes: far before the first contact of any bot
    const d = firstDivergence({ bot, seed: 3, minutes: 4 });
    assert.equal(d, null, `${bot}: ${JSON.stringify(d)}`);
  }
});

test('wilson interval brackets the sample rate and shrinks with n', () => {
  const [a, b] = wilson(50, 100);
  assert.ok(a < 0.5 && b > 0.5);
  const [c, d] = wilson(500, 1000);
  assert.ok(d - c < b - a);
  assert.deepEqual(wilson(0, 0), [0, 1]);
});
