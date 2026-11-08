import test from 'node:test';
import assert from 'node:assert/strict';
import { runMatch } from '../tools/run-match.mjs';
import { replay } from '../sim/replay.mjs';
import { Game } from '../sim/game.mjs';

test('same seed + same bots gives the same final state hash', () => {
  const a = runMatch({ seed: 11, bots: ['rush', 'boom'], maxMinutes: 8 });
  const b = runMatch({ seed: 11, bots: ['rush', 'boom'], maxMinutes: 8 });
  assert.equal(a.game.hash(), b.game.hash());
  assert.equal(a.ticks, b.ticks);
  assert.deepEqual(a.game.commandLog, b.game.commandLog);
});

test('different seeds differ', () => {
  const a = runMatch({ seed: 11, bots: ['boom', 'boom'], maxMinutes: 5 });
  const b = runMatch({ seed: 12, bots: ['boom', 'boom'], maxMinutes: 5 });
  assert.notEqual(a.game.hash(), b.game.hash());
});

test('seed + command log replays to the identical state', () => {
  const a = runMatch({ seed: 21, bots: ['turtle', 'rush'], maxMinutes: 10 });
  const g = replay({ seed: 21, players: [{ team: 1 }, { team: 2 }] }, a.game.commandLog, a.ticks);
  assert.equal(g.t, a.game.t);
  assert.equal(g.hash(), a.game.hash());
});

test('a fresh game is deterministic at tick 0', () => {
  assert.equal(new Game({ seed: 3 }).hash(), new Game({ seed: 3 }).hash());
});
