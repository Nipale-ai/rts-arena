import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../sim/game.mjs';
import { resolveRules } from '../sim/rules.mjs';
import { runMatch } from '../tools/run-match.mjs';
import { mapDiff, symmetryDiff, firstDivergence } from '../tools/seat-bias.mjs';
import { buildSystemPrompt } from '../agents/llm/prompt.mjs';
import { TICK_HZ } from '../sim/util.mjs';

test('classic is the default and unchanged', () => {
  const g = new Game({ seed: 3 });
  assert.equal(g.rules.preset, 'classic');
  assert.equal(g.W, 128);
  assert.equal([...g.units.values()].filter((u) => u.owner === 1).length, 5);
  assert.equal(g.rules.timeLimitS, 3600);
});

test('fast preset: village, scout, house, 96 map, treasure, 30 min; mirrored for both seats', () => {
  for (const seed of [1, 2, 3, 11, 42]) {
    const g = new Game({ seed, rules: 'fast' });
    assert.equal(g.W, 96);
    assert.equal(g.rules.timeLimitS, 1800);
    for (const pid of [1, 2]) {
      const us = [...g.units.values()].filter((u) => u.owner === pid);
      assert.equal(us.filter((u) => u.type === 'worker').length, 6);
      assert.equal(us.filter((u) => u.type === 'light_cavalry').length, 1);
      assert.equal([...g.buildings.values()].filter((b) => b.owner === pid && b.type === 'house').length, 1);
      assert.equal(g.players[pid].cap, 21);
      assert.equal(g.players[pid].res.food, 250);
    }
    assert.equal(mapDiff(g), null);
    assert.equal(symmetryDiff(g), null);
    const centre = [...g.nodes.values()].filter((n) => Math.abs(n.tx + 1 - 48) < 12 && Math.abs(n.ty + 1 - 48) < 12 && n.res === 'gold');
    assert.ok(centre.length >= 6, 'treasure gold in the middle');
  }
});

test('fast preset ends at its own time limit (score) and is symmetric over a mirror game', () => {
  const r = runMatch({ seed: 5, bots: ['boom', 'boom'], rules: 'fast' });
  assert.ok(r.result.seconds <= 1800 + 1);
  assert.equal(firstDivergence({ bot: 'boom', seed: 3, minutes: 6, rules: 'fast' }), null);
});

test('resolveRules sanitises input; the prompt follows the preset', () => {
  assert.equal(resolveRules({ preset: 'fast', mapSize: 100 }).mapSize, 96);
  assert.equal(resolveRules('nonsense').preset, 'classic');
  assert.match(buildSystemPrompt('fast'), /6 workers and 1 light cavalry/);
  assert.match(buildSystemPrompt('fast'), /treasure/);
  assert.match(buildSystemPrompt('fast'), /After 30 game minutes/);
  assert.match(buildSystemPrompt(), /After 60 game minutes/);
});

// ---------- sudden death (sim/game.mjs suddenDeathStep, commands.mjs cmd_build, checkVictory) ----------
// A short custom schedule keeps the tests fast: sudden death at 30 s, limit 600 s -> ramp over 570 s, every building is gone after ~377 s of it.
const SD_RULES = { preset: 'fast', suddenDeath: 30, timeLimitS: 600 };
const SD_T = 30 * TICK_HZ;
const tcOf = (g, pid) => [...g.buildings.values()].find((b) => b.owner === pid && b.type === 'town_center');
const hpSum = (g) => [...g.buildings.values()].reduce((a, b) => a + b.hp, 0);

test('sudden death: nothing crumbles before it starts, then the decay ramps up per building and ends every base', () => {
  const g = new Game({ seed: 4, rules: SD_RULES });
  const tc = tcOf(g, 1), house = [...g.buildings.values()].find((b) => b.owner === 1 && b.type === 'house');
  assert.equal(g.rules.suddenDeath, 30);
  while (g.t < SD_T) g.step();
  assert.equal(g.t, SD_T);
  // up to and including the first sudden-death tick the ramp is 0: no hp lost, but the announcement is made
  assert.equal(tc.hp, tc.maxhp);
  assert.equal(house.hp, house.maxhp);
  assert.ok(g.announcements.some((a) => a.type === 'sudden_death'));
  // loss per tick = maxhp * 0.008 * ramp / TICK_HZ, ramp = ticks since the start / (570 s in ticks)
  const span = (600 - 30) * TICK_HZ;
  let want = tc.maxhp, prevLoss = 0;
  for (let k = 1; k <= 400; k++) {
    const before = tc.hp;
    g.step();
    want -= tc.maxhp * 0.008 * (k / span) / TICK_HZ;
    assert.ok(Math.abs(tc.hp - want) < 1e-6, `tick +${k}: hp ${tc.hp} want ${want}`);
    const loss = before - tc.hp;
    assert.ok(loss > prevLoss, 'the loss per tick grows every tick');
    prevLoss = loss;
  }
  // the loss is a share of maxhp, so untouched buildings of any size fall in the same tick; the ramp ends every base before the limit
  // (0.008 * s^2 / (2 * 570 s) = 1 maxhp at s = 377.5 s after the start)
  while (!g.over) g.step();
  assert.equal(g.buildings.size, 0);
  assert.ok(Math.abs(g.t - (SD_T + Math.sqrt(2 * 570 / 0.008) * TICK_HZ)) < 15, `all buildings fell at tick ${g.t}`); // the win check runs every 10 ticks
  assert.ok(g.t < 600 * TICK_HZ, 'the game ends by the base falls, not at the time limit');
  assert.equal(hpSum(g), 0);
});

test('sudden death: the decay needs no killer and gives nobody kill credit', () => {
  const g = new Game({ seed: 4, rules: SD_RULES });
  while (g.t < SD_T + 600) g.step();
  for (const p of g.players) if (p) assert.equal(p.kills, 0);
  // not before the first sudden-death tick: the same game without sudden death keeps every hp
  const h = new Game({ seed: 4, rules: { ...SD_RULES, suddenDeath: 0 } });
  while (h.t < SD_T + 600) h.step();
  assert.equal(tcOf(h, 1).hp, tcOf(h, 1).maxhp);
});

test('sudden death: no building can be placed from its first tick on (before it, building works)', () => {
  const g = new Game({ seed: 4, rules: SD_RULES });
  g.players[1].res.wood = g.players[2].res.wood = 1000;
  const build = (pid) => g.command(pid, { cmd: 'build', building_type: 'house', near: [24, 24], worker_ids: 'auto' });
  while (g.t < SD_T - 1) g.step();
  assert.equal(build(1).ok, true, 'one tick before: allowed');
  g.step();
  assert.equal(g.t, SD_T);
  for (const pid of [1, 2]) {
    const r = build(pid);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'sudden_death');
  }
  // without sudden death in the rules placing stays allowed at the same tick
  const c = new Game({ seed: 4, rules: { ...SD_RULES, suddenDeath: 0 } });
  c.players[1].res.wood = 1000;
  while (c.t < SD_T + 5) c.step();
  assert.equal(c.command(1, { cmd: 'build', building_type: 'house', near: [24, 24], worker_ids: 'auto' }).ok, true);
});

test('sudden death: two bases that crumble in the same tick end in a mutual destruction; the seed picks the winner (fast), a draw otherwise', () => {
  const winners = new Set();
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const g = new Game({ seed, rules: SD_RULES });
    while (!g.over && g.t < 600 * TICK_HZ) g.step();
    assert.ok(g.over, `seed ${seed} ended`);
    assert.equal(g.endReason, 'mutual destruction (tie-break)');
    assert.ok(g.players[1].alive === false && g.players[2].alive === false);
    assert.equal(g.winnerTeam, [1, 2][g.firstPlayer(0) % 2], 'the winner is the seed tie-break');
    winners.add(g.winnerTeam);
  }
  assert.deepEqual([...winners].sort(), [1, 2], 'no seat is favoured over eight seeds');
  const d = new Game({ seed: 3, rules: { ...SD_RULES, tieBreak: null } });
  while (!d.over && d.t < 600 * TICK_HZ) d.step();
  assert.equal(d.endReason, 'mutual destruction');
  assert.equal(d.winnerTeam, 0, 'without the seed tie-break it stays a draw');
});

test('sudden death: the weaker base falls first and the other player wins outright (no tie-break)', () => {
  const g = new Game({ seed: 4, rules: SD_RULES });
  tcOf(g, 1).hp = 400; // player 1 starts the decay with a battered town center
  while (!g.over && g.t < 600 * TICK_HZ) g.step();
  assert.ok(g.over);
  assert.equal(g.endReason, 'victory');
  assert.equal(g.winnerTeam, 2);
  assert.equal(g.players[1].endReason, 'destroyed');
  assert.ok(g.players[2].alive);
});
