import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../sim/game.mjs';
import { feedOf, markersOf } from '../sim/intent.mjs';
import { runMatch } from '../tools/run-match.mjs';
import { richGame, stepN, tc } from '../test-support/helpers.mjs';

test('feed: commands become readable lines, not raw coordinates', () => {
  const g = richGame();
  const p = g.players[1], t = tc(g, 1);
  g.command(1, { cmd: 'train', building_id: t.id, unit_type: 'worker', count: 3 });
  g.command(1, { cmd: 'build', building_type: 'lumber_camp', near: [14, 14] });
  g.command(1, { cmd: 'gather', resource: 'gold', count: 2 });
  const lines = feedOf(g, p, 8).map((l) => l.text);
  assert.ok(lines.some((l) => /^Training 3 workers at town center$/.test(l)), lines.join(' | '));
  assert.ok(lines.some((l) => /^Building lumber camp (near|at|[NSEW])/.test(l)) && !lines.some((l) => /\[|\(\d/.test(l)), lines.join(' | '));
  assert.ok(lines.some((l) => /to gold$/.test(l)));
});

test('attack and defend are told apart; markers are capped and deterministic', () => {
  const run = () => {
    const g = new Game({ seed: 5, rules: 'fast' });
    const home = g.starts[0], en = g.starts[1];
    for (let i = 0; i < 6; i++) g.addUnit(1, 'spearman', (home.tx + 8) * 1000 + 500, (home.ty + 8 + i) * 1000 + 500);
    g.command(1, { cmd: 'attack_move', units: 'type:spearman', target: [en.tx - 2, en.ty - 2] });
    stepN(g, 5);
    return g;
  };
  const a = run(), b = run();
  assert.match(feedOf(a, a.players[1], 1)[0].text, /^Attack: 6 units -> enemy base$/);
  assert.deepEqual(markersOf(a), markersOf(b));
  const atk = markersOf(a).find((m) => m[1] === 'attack');
  assert.ok(atk && atk[8] === 'ATTACK' && atk[7] === 6);
  const home = a.starts[0];
  a.command(1, { cmd: 'attack_move', units: 'type:spearman', target: [home.tx + 6, home.ty + 6] });
  assert.match(feedOf(a, a.players[1], 1)[0].text, /^Defend: 6 units at home base$/);
});

test('a full bot game never shows more than 6 markers per side and the feed keeps the last lines', () => {
  let maxMk = 0, ok = true;
  const r = runMatch({ seed: 3, bots: ['boom', 'rush'], rules: 'fast', maxMinutes: 8, onTick: (g) => {
    if (g.t % 50) return;
    const mk = markersOf(g);
    for (const o of [1, 2]) maxMk = Math.max(maxMk, mk.filter((m) => m[2] === o).length);
    for (const p of g.players.slice(1)) if (p.intents.length > 8) ok = false;
  } });
  assert.ok(maxMk <= 6 && maxMk > 0, `max markers ${maxMk}`);
  assert.ok(ok);
  assert.ok(r.game.players[1].intents.length > 0);
});
