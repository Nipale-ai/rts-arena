// Ranking protection (A4): a solo run, a stopped match, an invalid run and a cutoff never get ranked: true.
// Covers server/results.mjs (rankedOf, isSolo, soloMarker) and the three places in server/arena.mjs (onFinished, listMatches, createMatch).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { countsForRanking, isGodMode, isSolo, rankableMatches, rankedOf, soloMarker } from '../server/results.mjs';
import { runSolo } from '../tools/solo/run-solo.mjs';
import { loadScenario } from '../tools/solo/scenario.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = (p = 'rts-ranked-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('solo marker: isSolo sees it top level and inside .result; countsForRanking refuses it; the old God mode rule is unchanged', () => {
  const solo = { scenario: 'duel-ladder', level: 3, seed: 1, runIndex: 0 };
  assert.equal(isSolo({ solo }), true);
  assert.equal(isSolo({ result: { solo } }), true);
  assert.equal(isSolo({ solo: 'yes' }), false, 'only an object is a marker');
  assert.equal(isSolo(null) || isSolo({}) || isSolo({ result: {} }), false);
  assert.equal(countsForRanking({ winnerTeam: 1 }), true);
  assert.equal(countsForRanking({ winnerTeam: 1, solo }), false);
  assert.equal(countsForRanking({ result: { winnerTeam: 1, solo } }), false);
  assert.equal(countsForRanking({ godMode: true }), false);
  assert.equal(isGodMode({ result: { godMode: true } }), true);
  assert.deepEqual(rankableMatches([{ id: 'a' }, { id: 'b', solo }, { id: 'c', godMode: true }]).map((x) => x.id), ['a']);
  // a result that ended by cutoff still passes countsForRanking (test/god-server.test.mjs relies on it); rankedOf is the stricter flag
  assert.equal(countsForRanking({ reason: 'cutoff', winnerTeam: 0 }), true);
});

test('rankedOf: only a finished, valid, plain match is ranked', () => {
  const ok = { reason: 'victory', winnerTeam: 1 };
  assert.equal(rankedOf(ok), true);
  assert.equal(rankedOf(ok, { stopped: true }), false, 'stopped by hand');
  assert.equal(rankedOf(ok, { solo: { scenario: 'x' } }), false, 'solo');
  assert.equal(rankedOf(ok, { invalid: true }), false, 'declared invalid');
  assert.equal(rankedOf({ reason: 'cutoff', winnerTeam: 0 }), false, 'no ending');
  assert.equal(rankedOf({ ...ok, godMode: true }), false, 'God mode');
  assert.equal(rankedOf(undefined), false);
  assert.equal(rankedOf(ok, { solo: null, invalid: false, stopped: false }), true);
});

test('soloMarker keeps four plain fields and drops everything else', () => {
  assert.deepEqual(soloMarker({ scenario: 'duel-ladder', level: '3', seed: 42.9, runIndex: 1, evil: { a: 1 } }), { scenario: 'duel-ladder', level: 3, seed: 42, runIndex: 1 });
  assert.deepEqual(soloMarker({ scenario: 7 }), { scenario: '', level: 0, seed: 0, runIndex: 0 });
  assert.equal(soloMarker('x'), null);
  assert.equal(soloMarker(undefined), null);
  assert.equal(soloMarker({ scenario: 'x'.repeat(200) }).scenario.length, 60);
});

test('a real solo run: result.json alone would rank (cutoff aside), the marker in runMeta.json is what protects it', async () => {
  const scenario = { ...loadScenario('duel-ladder'), id: 'duel-mini', maxGameSeconds: 60 };
  const r = await runSolo({ scenario, level: 3, modelSeat: 1, seed: 42, player: { type: 'null' }, outDir: tmp(), speed: 20 });
  const result = readJson(path.join(r.replayDir, 'result.json'));
  assert.equal(rankedOf(result, { solo: r.runMeta.solo, invalid: !r.runMeta.valid }), false);
  assert.equal(rankedOf({ ...result, reason: 'victory', winnerTeam: 1 }, { solo: r.runMeta.solo }), false, 'even an ending would not rank it');
  assert.equal(r.runMeta.ranked, false);
});

// ---------------- the arena itself ----------------
function startArena(data, replays) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server/arena.mjs'), '--port', '0', '--data', data, '--replays', replays], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const ready = new Promise((resolve, reject) => {
    const t0 = Date.now();
    const poll = () => { const m = /Arena: http:\/\/127\.0\.0\.1:(\d+)\//.exec(out); if (m) resolve(+m[1]); else if (Date.now() - t0 > 20000) reject(new Error('arena did not start: ' + out)); else setTimeout(poll, 50); };
    poll();
  });
  return { child, ready };
}

test('arena: a stopped match and a match started with a solo marker are not ranked; a stopped one from an older record is fixed when listed; imported replays follow runMeta.json', async () => {
  const dir = tmp(), data = path.join(dir, 'data'), replays = path.join(dir, 'replays');
  fs.mkdirSync(path.join(data, 'matches'), { recursive: true });
  // an older record of a stopped match, as the arena wrote it before: ranked true
  fs.writeFileSync(path.join(data, 'matches', 'old-stopped.json'), JSON.stringify({ id: 'old-stopped', name: 'old', created: 1, status: 'stopped', ranked: true, players: [], result: { reason: 'cutoff', winnerTeam: 0 } }));
  fs.writeFileSync(path.join(data, 'matches', 'old-finished.json'), JSON.stringify({ id: 'old-finished', name: 'old2', created: 2, status: 'finished', ranked: true, players: [], result: { reason: 'victory', winnerTeam: 1 } }));
  // replays recorded outside the arena (older style listing)
  const mkReplay = (id, result, meta) => {
    const d = path.join(replays, id);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'log.jsonl'), JSON.stringify({ type: 'start', bots: ['Rush', 'Boom'], teams: [1, 2] }) + '\n');
    fs.writeFileSync(path.join(d, 'result.json'), JSON.stringify({ seed: 1, bots: ['Rush', 'Boom'], seconds: 300, ...result }));
    if (meta) fs.writeFileSync(path.join(d, 'runMeta.json'), JSON.stringify(meta));
  };
  mkReplay('imp-plain', { reason: 'victory', winnerTeam: 1 });
  mkReplay('imp-cutoff', { reason: 'cutoff', winnerTeam: 0 });
  mkReplay('imp-solo', { reason: 'victory', winnerTeam: 1 }, { schema: 'solo-run-meta-1', status: 'done', valid: true, solo: { scenario: 'duel-ladder', level: 3, seed: 5, runIndex: 0 } });
  mkReplay('imp-invalid', { reason: 'victory', winnerTeam: 1 }, { schema: 'solo-run-meta-1', status: 'done', valid: false });
  mkReplay('imp-unfinished', { reason: 'victory', winnerTeam: 1 }, { schema: 'solo-run-meta-1', status: 'running' });

  const { child, ready } = startArena(data, replays);
  try {
    const port = await ready, base = `http://127.0.0.1:${port}`;
    const post = async (p, body) => (await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
    const get = async (p) => (await fetch(base + p)).json();
    // two live matches, both stopped at once: one with a solo marker (with junk in it), one plain
    const soloRec = await post('/api/matches', { players: [{ type: 'bot' }, { type: 'bot' }], rules: { speed: 64 }, solo: { scenario: 'duel-ladder', level: 3, seed: 8, runIndex: 2, evil: 'x' } });
    const plainRec = await post('/api/matches', { players: [{ type: 'bot' }, { type: 'bot' }], rules: { speed: 64 } });
    assert.deepEqual(soloRec.solo, { scenario: 'duel-ladder', level: 3, seed: 8, runIndex: 2 }, 'the record carries the cleaned marker');
    assert.equal(plainRec.solo, undefined);
    assert.equal((await post(`/api/matches/${soloRec.id}/stop`, {})).stopped, true);
    assert.equal((await post(`/api/matches/${plainRec.id}/stop`, {})).stopped, true);
    const list = Object.fromEntries((await get('/api/matches')).map((m) => [m.id, m]));
    assert.equal(list[soloRec.id].status, 'stopped');
    assert.equal(list[soloRec.id].ranked, false);
    assert.deepEqual(list[soloRec.id].solo, { scenario: 'duel-ladder', level: 3, seed: 8, runIndex: 2 });
    assert.equal(list[plainRec.id].status, 'stopped');
    assert.equal(list[plainRec.id].ranked, false, 'a stopped match is never ranked');
    assert.equal(list['old-stopped'].ranked, false, 'an old stopped record is not ranked any more');
    assert.equal(list['old-finished'].ranked, true, 'a finished record keeps its flag');
    assert.equal(list['imp-plain'].ranked, true);
    assert.equal(list['imp-cutoff'].ranked, false);
    assert.equal(list['imp-solo'].ranked, false);
    assert.deepEqual(list['imp-solo'].solo, { scenario: 'duel-ladder', level: 3, seed: 5, runIndex: 0 });
    assert.equal(list['imp-invalid'].ranked, false);
    assert.equal(list['imp-unfinished'].ranked, false);
    assert.equal(list['imp-plain'].solo, undefined);
  } finally { child.kill('SIGTERM'); }
});
