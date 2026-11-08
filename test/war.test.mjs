// Preset "war": the only way to win is to destroy the enemy; unlimited resources and a higher population limit from the war phase.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRules } from '../sim/rules.mjs';
import { Game } from '../sim/game.mjs';
import { runMatch } from '../tools/run-match.mjs';
import { buildSystemPrompt, promptVersion } from '../agents/llm/prompt.mjs';

test('war preset: no wonder, no shrines, no sudden death, no tie-break, towers capped, higher population limit', () => {
  const r = resolveRules('war');
  assert.equal(r.preset, 'war');
  assert.equal(r.wonder, false);
  assert.equal(r.shrines, false);
  assert.equal(r.suddenDeath, 0);
  assert.equal(r.tieBreak, 'none');
  assert.equal(r.noScoreWin, true);
  assert.deepEqual(r.towerCaps, [2, 2, 2]);
  assert.equal(r.popMax, 300);
  assert.equal(resolveRules('fast').popMax, 150);
});

test('war phase tops both players up to warTopUp every 5 seconds, from warAtS on', () => {
  const g = new Game({ seed: 7, rules: { preset: 'war', warAtS: 20, warTopUp: 4000 } });
  for (let i = 0; i < 20 * 10 - 1; i++) g.step();
  assert.ok(g.players[1].res.food < 4000);
  for (let i = 0; i < 60; i++) g.step();
  for (const p of [g.players[1], g.players[2]]) for (const k of ['food', 'wood', 'stone', 'gold']) assert.ok(p.res[k] >= 4000, k);
});

test('war: the time limit gives no winner (technical stop), never a score win', () => {
  const g = new Game({ seed: 3, rules: { preset: 'war', timeLimitS: 60 } });
  for (let i = 0; i < 700 && !g.over; i++) g.step();
  assert.equal(g.over, true);
  assert.equal(g.winnerTeam, 0);
  assert.match(g.endReason, /no result/);
});

test('war: scripted bots finish by destruction', () => {
  const r = runMatch({ seed: 5, bots: ['rush', 'turtle'], rules: 'war' });
  assert.equal(r.result.reason, 'victory');
  assert.ok(r.result.winnerTeam > 0);
});

test('war prompt names the only win, the tower limit and the war phase; other presets keep their text', () => {
  const p = buildSystemPrompt('war');
  assert.match(p, /ONLY WAY TO WIN IS TO DESTROY THE ENEMY COMPLETELY/);
  assert.match(p, /at most 2 towers/);
  assert.match(p, /WAR PHASE from minute 10/);
  assert.doesNotMatch(buildSystemPrompt('fast'), /WAR PHASE/);
  assert.equal(promptVersion(resolveRules('war')), 'rts-llm-1.9-war');
  assert.equal(promptVersion(resolveRules('fast')), 'rts-llm-1.9');
});
