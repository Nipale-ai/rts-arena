import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LiveMatch } from '../server/live-match.mjs';
import { verifyReplay, readLog } from '../server/replay-verify.mjs';
import { guardDirector, cleanDirector, injectToken } from '../server/god.mjs';
import { countsForRanking, isGodMode, rankableMatches } from '../server/results.mjs';
import { loadReplay } from '../tools/lib/replay.mjs';
import { computeEvents } from '../tools/events.mjs';
import { Overlay } from '../tools/overlay.mjs';
import { Match } from '../server/spectate.mjs';

function liveRun(withGod) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rts-god-'));
  const m = new LiveMatch({ seed: 9, specs: ['scripted:rush', 'scripted:boom'], rules: 'fast', outRoot: root, maxGameSeconds: 150 });
  const done = [];
  while (!m.finished) {
    const g = m.game;
    if (withGod) {
      if (g.t === 100) done.push(m.director({ cmd: 'director', action: 'give', player: 2, res: 'food', amount: 100 }));
      if (g.t === 250) done.push(m.director({ cmd: 'director', action: 'wolves', count: 2 }));
      if (g.t === 400) done.push(m.director({ cmd: 'director', action: 'treasure', res: 'gold', amount: 200 }));
      if (g.t === 600) done.push(m.director({ cmd: 'director', action: 'spawn', player: 1, unit: 'archer', x: 30, y: 30, count: 2 }));
    }
    m.tick();
  }
  return { m, root, done };
}

test('live match with interventions: result and log are marked godMode, and the recorded replay verifies', () => {
  const { m, done } = liveRun(true);
  assert.ok(done.every((r) => r.ok), JSON.stringify(done));
  assert.equal(m.result.godMode, true);
  assert.equal(countsForRanking(m.result), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(m.dir, 'result.json'), 'utf8')).godMode, true);
  const lines = readLog(m.dir);
  assert.equal(lines.filter((l) => l.type === 'cmd' && l.p === 0).length, 4);
  assert.equal(lines.find((l) => l.type === 'result').godMode, true);
  const v = verifyReplay(m.dir);
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(v.hash, m.result.hash);
});

test('live match without interventions is not marked and counts', () => {
  const { m } = liveRun(false);
  assert.equal(m.result.godMode, false);
  assert.equal(countsForRanking(m.result), true);
  assert.equal(verifyReplay(m.dir).ok, true);
});

test('ranking filter: God mode matches never count, in any shape of record', () => {
  const normal = { id: 'a', result: { winnerTeam: 1, godMode: false } };
  const god = { id: 'b', result: { winnerTeam: 1, godMode: true } };
  const godTop = { id: 'c', godMode: true, result: { winnerTeam: 2 } };
  assert.equal(isGodMode(god) && isGodMode(godTop) && !isGodMode(normal), true);
  assert.deepEqual(rankableMatches([normal, god, godTop, null]).map((x) => x.id), ['a']);
  assert.equal(countsForRanking(undefined), false);
});

const req = (o = {}) => ({ method: 'POST', headers: { host: '127.0.0.1:8800', origin: 'http://127.0.0.1:8800', 'content-type': 'application/json', 'x-god-token': 'tok', ...(o.headers || {}) }, ...(o.method ? { method: o.method } : {}) });

test('director endpoint guard: only the same-origin spectator page with the token', () => {
  assert.equal(guardDirector(req(), 'tok').ok, true);
  assert.equal(guardDirector(req({ method: 'GET' }), 'tok').code, 405);
  assert.equal(guardDirector(req({ headers: { origin: undefined } }), 'tok').code, 403, 'no Origin header (a script, not the page)');
  assert.equal(guardDirector(req({ headers: { origin: 'http://evil.example' } }), 'tok').code, 403, 'foreign origin');
  assert.equal(guardDirector(req({ headers: { 'sec-fetch-site': 'cross-site' } }), 'tok').code, 403);
  assert.equal(guardDirector(req({ headers: { 'content-type': 'text/plain' } }), 'tok').code, 415);
  assert.equal(guardDirector(req({ headers: { 'x-god-token': 'nope' } }), 'tok').code, 403, 'wrong token');
  assert.equal(guardDirector(req({ headers: { 'x-god-token': undefined } }), 'tok').code, 403, 'no token');
});

test('director body is reduced to known plain fields; the page gets the token', () => {
  const c = cleanDirector({ action: 'give', player: 1, res: 'gold', amount: 100, evil: { a: 1 }, cmd: 'resign', unit: 'x'.repeat(100) });
  assert.deepEqual(Object.keys(c).sort(), ['action', 'amount', 'cmd', 'player', 'res', 'unit']);
  assert.equal(c.cmd, 'director');
  assert.equal(c.unit.length, 40);
  assert.match(injectToken('<html><head></head><body></body></html>', 'abc'), /window\.__GOD_TOKEN="abc"/);
});

test('a replay match never accepts interventions', () => {
  const { m } = liveRun(true);
  const saved = { replay: process.argv };
  void saved;
  const rm = Object.create(Match.prototype);
  rm.mode = 'replay';
  rm.game = m.game;
  assert.equal(rm.director({ cmd: 'director', action: 'give', player: 1, res: 'food' }).error, 'replay');
});

test('broadcast: interventions become ticker events and the GOD MODE badge stays on', () => {
  const { m } = liveRun(true);
  const rep = loadReplay(m.dir);
  const ev = computeEvents(rep);
  const gods = ev.events.filter((e) => e.type === 'god');
  assert.ok(gods.length >= 4, 'one event per intervention (plus results)');
  assert.equal(gods[0].text, '+100 food to orange');
  const players = [{ name: 'Rush' }, { name: 'Boom' }];
  const tl = { a: 0, b: 1500, outAt: (t) => t / 10, speedAtOut: () => 1 };
  const ov = new Overlay({ events: ev.events, timeline: tl, players });
  const at = ov.at(gods[0].t / 10 + 0.5, gods[0].t + 5);
  assert.equal(at.ticker.text, 'GOD: +100 food to orange');
  assert.equal(at.god, true);
  assert.equal(ov.at(1, 1).god, false, 'badge only after the first intervention');
  assert.equal(ov.at(100, 1000).god, true, 'and then permanently');
});
