import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../sim/game.mjs';
import { observe } from '../sim/observe.mjs';
import { replay } from '../sim/replay.mjs';
import { standingChips } from '../sim/standing.mjs';
import { validateCall } from '../agents/llm/validate.mjs';
import { richGame, stepN, tc } from '../test-support/helpers.mjs';

const rich = (g, pid = 1) => { for (const r of ['food', 'wood', 'stone', 'gold']) g.players[pid].res[r] = 5000; };

test('auto_train keeps the queue filled and respects until_count', () => {
  const g = richGame();
  const t = tc(g, 1);
  assert.equal(g.command(1, { cmd: 'auto_train', unit_type: 'worker', building_id: t.id, keep_queue: 3 }).ok, true);
  stepN(g, 6);
  assert.ok(t.queue.length >= 3, 'queue refilled to 3');
  const g2 = richGame();
  assert.equal(g2.command(1, { cmd: 'auto_train', unit_type: 'worker', until_count: 8 }).ok, true);
  stepN(g2, 600);
  const n = [...g2.units.values()].filter((u) => u.owner === 1 && u.type === 'worker').length;
  assert.equal(n, 8, 'stops at 8 workers');
});

test('auto_train: errors and replacement', () => {
  const g = richGame();
  assert.equal(g.command(1, { cmd: 'auto_train', unit_type: 'dragon' }).error, 'unknown_unit');
  assert.equal(g.command(1, { cmd: 'auto_train', unit_type: 'worker', keep_queue: 99 }).error, 'bad_args');
  const a = g.command(1, { cmd: 'auto_train', unit_type: 'worker' }), b = g.command(1, { cmd: 'auto_train', unit_type: 'worker', keep_queue: 4 });
  assert.equal(a.standing_id, b.standing_id);
  assert.equal(g.players[1].standing.length, 1);
  assert.equal(g.command(1, { cmd: 'cancel_standing', id: a.standing_id }).ok, true);
  assert.equal(g.players[1].standing.length, 0);
  assert.equal(g.command(1, { cmd: 'cancel_standing', id: 77 }).error, 'not_found');
});

test('attack_wave launches idle soldiers when min_army is reached and repeats', () => {
  const g = richGame();
  rich(g);
  const home = g.starts[0];
  for (let i = 0; i < 4; i++) g.addUnit(1, 'spearman', (home.tx + 6) * 1000 + 500, (home.ty + 6 + i) * 1000 + 500);
  assert.equal(g.command(1, { cmd: 'attack_wave', min_army: 5, target: 'enemy_base' }).ok, true);
  stepN(g, 10);
  assert.ok([...g.units.values()].every((u) => u.ord.t !== 'amove'), 'only 4, no wave yet');
  g.addUnit(1, 'spearman', (home.tx + 8) * 1000 + 500, (home.ty + 8) * 1000 + 500);
  stepN(g, 10);
  const moving = [...g.units.values()].filter((u) => u.owner === 1 && u.ord.t === 'amove');
  assert.equal(moving.length, 5);
  assert.equal(g.players[1].standing[0].fired, 1);
  const o = observe(g, 1);
  assert.equal(o.standing_orders[0].order, 'attack_wave');
  assert.deepEqual(standingChips(g.players[1]), ['wave 5+ (1x)']);
});

test('auto_build_houses builds when the cap gets close and stops at the margin', () => {
  const g = richGame();
  assert.equal(g.command(1, { cmd: 'auto_build_houses', margin: 20 }).ok, true);
  stepN(g, 30);
  const houses = [...g.buildings.values()].filter((b) => b.owner === 1 && b.type === 'house');
  assert.ok(houses.length >= 1, 'a house was ordered');
  assert.ok(houses.length <= 2, 'at most 2 at a time');
  assert.equal(g.command(1, { cmd: 'auto_build_houses', on: false }).ok, true);
  assert.equal(g.players[1].standing.length, 0);
});

test('standing orders are deterministic and replay with the command log', () => {
  const run = () => {
    const g = new Game({ seed: 7 });
    const t = tc(g, 1), t2 = tc(g, 2);
    const cmds = [
      { t: 3, p: 1, cmd: { cmd: 'auto_train', unit_type: 'worker', until_count: 12 } },
      { t: 3, p: 1, cmd: { cmd: 'auto_build_houses' } },
      { t: 3, p: 2, cmd: { cmd: 'auto_train', unit_type: 'worker', keep_queue: 2, building_id: t2.id } },
      { t: 200, p: 1, cmd: { cmd: 'attack_wave', min_army: 3 } },
    ];
    void t;
    let i = 0;
    while (g.t < 900) {
      while (i < cmds.length && cmds[i].t === g.t) { g.command(cmds[i].p, cmds[i].cmd); i++; }
      g.step();
    }
    return { g, cmds: g.commandLog.map((c) => ({ t: c.t, p: c.p, cmd: c.cmd })) };
  };
  const a = run(), b = run();
  assert.equal(a.g.hash(), b.g.hash());
  const r = replay({ seed: 7 }, a.cmds, 900);
  assert.equal(r.hash(), a.g.hash());
});

test('validate: standing order tools accept string-encoded targets', () => {
  const v = validateCall({ name: 'attack_wave', args: { min_army: '12', target: '[60, 70]' } });
  assert.equal(v.ok, true);
  assert.deepEqual(v.cmd.target, [60, 70]);
  assert.equal(validateCall({ name: 'auto_train', args: { unit_type: 'archer', keep_queue: 3 } }).ok, true);
});
