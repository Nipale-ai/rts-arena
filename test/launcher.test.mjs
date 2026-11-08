import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, resolveDataDir, findFreePort, openCommand, nodeOk, UsageError, DEFAULT_PORT, PORT_TRIES } from '../bin/rts-arena.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin/rts-arena.mjs');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// ---- pure parts ----
test('launcher args: defaults, own flags, both ways to give a value, everything else passes through in order', () => {
  assert.deepEqual(parseArgs([]), { port: DEFAULT_PORT, data: null, open: true, help: false, rest: [] });
  assert.equal(DEFAULT_PORT, 8800);
  const o = parseArgs(['--port', '9001', '--data', 'my/data', '--no-open']);
  assert.deepEqual([o.port, o.data, o.open], [9001, 'my/data', false]);
  const e = parseArgs(['--port=9002', '--data=/abs/d']);
  assert.deepEqual([e.port, e.data], [9002, '/abs/d']);
  assert.equal(parseArgs(['-h']).help, true);
  assert.equal(parseArgs(['--help']).help, true);
  // arena flags are not ours: they keep their order and their values
  assert.deepEqual(parseArgs(['--allow-host', 'a.test,b.test', '--port', '9003', '--replays', 'r', '--verbose']).rest, ['--allow-host', 'a.test,b.test', '--replays', 'r', '--verbose']);
});

test('launcher args: a bad or missing value is a usage error with a plain message', () => {
  for (const bad of [['--port', 'abc'], ['--port', '0'], ['--port', '70000'], ['--port', '80.5'], ['--port'], ['--port', '--no-open'], ['--data'], ['--data', '--no-open'], ['--data=']]) {
    assert.throws(() => parseArgs(bad), (err) => err instanceof UsageError && /--port|--data/.test(err.message), bad.join(' '));
  }
  assert.throws(() => parseArgs(['--port', 'x']), /--port must be a number from 1 to 65535 \(got "x"\)/);
});

test('launcher data folder: --data, then RTS_ARENA_DATA, then <package>/data in a git checkout, else ~/.rts-arena', () => {
  const base = { root: '/pkg', home: '/home/u', cwd: '/work' };
  assert.equal(resolveDataDir({ ...base, flag: 'x', env: { RTS_ARENA_DATA: '/e' }, exists: () => true }), path.resolve('/work', 'x'), 'the flag wins over the environment');
  assert.equal(resolveDataDir({ ...base, flag: '/abs', exists: () => false }), path.resolve('/abs'));
  assert.equal(resolveDataDir({ ...base, env: { RTS_ARENA_DATA: 'rel' }, exists: () => false }), path.resolve('/work', 'rel'), 'relative paths are relative to where the user typed the command');
  assert.equal(resolveDataDir({ ...base, env: {}, exists: (p) => p === path.join('/pkg', '.git') }), path.join('/pkg', 'data'));
  assert.equal(resolveDataDir({ ...base, env: {}, exists: () => false }), path.join('/home/u', '.rts-arena'), 'an npx cache can vanish: keep the data in the home folder');
  assert.equal(resolveDataDir({ ...base, flag: '', env: { RTS_ARENA_DATA: '' }, exists: () => false }), path.join('/home/u', '.rts-arena'), 'empty means not set');
});

test('launcher: Node version gate and the browser command per platform', () => {
  assert.equal(nodeOk('21.7.3'), false);
  assert.equal(nodeOk('20.11.1'), false);
  assert.equal(nodeOk('22.0.0'), true);
  assert.equal(nodeOk('26.3.1'), true);
  assert.equal(nodeOk(), true, 'the Node that runs this test suite');
  const u = 'http://127.0.0.1:8800/';
  assert.deepEqual(openCommand('darwin', u), ['open', [u]]);
  assert.deepEqual(openCommand('linux', u), ['xdg-open', [u]]);
  assert.deepEqual(openCommand('win32', u), ['cmd', ['/c', 'start', '', u]]);
});

// ---- ports ----
const listen = (port) => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(port, '127.0.0.1', () => resolve(s)); });
const close = (s) => new Promise((r) => s.close(r));
// n free ports in a row; the servers that hold them
async function holdRun(n) {
  for (let base = 41000 + Math.floor(Math.random() * 15000); ; base += 37) {
    const held = [];
    try { for (let i = 0; i < n; i++) held.push(await listen(base + i)); return { base, held }; } catch { await Promise.all(held.map(close)); }
  }
}

test('launcher port: a free port stays, a busy one moves to the next free one, the 10th further is the last try', async () => {
  const probe = await listen(0), free = probe.address().port;
  await close(probe);
  assert.equal(await findFreePort(free), free);
  const { base, held } = await holdRun(PORT_TRIES + 1);
  try {
    assert.equal(await findFreePort(base), null, `${base}..${base + PORT_TRIES} are all busy`);
    await close(held[PORT_TRIES]);
    assert.equal(await findFreePort(base), base + PORT_TRIES, 'the 10th port after the wanted one is still tried');
    await close(held[1]);
    assert.equal(await findFreePort(base), base + 1);
    assert.equal(await findFreePort(base, { tries: 0 }), null, 'tries = how many more after the wanted port');
  } finally { await Promise.all(held.map((h) => new Promise((r) => (h.listening ? h.close(r) : r())))); }
});

// ---- the command itself ----
function run(args, { env = {} } = {}) {
  const child = spawn(process.execPath, [BIN, ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const exit = new Promise((resolve) => child.on('exit', (code, sig) => resolve({ code, sig, out })));
  const until = (re, ms = 15000) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => { const m = re.exec(out); if (m) resolve(m); else if (Date.now() - t0 > ms) reject(new Error(`no ${re} in: ${out}`)); else setTimeout(tick, 50); };
    tick();
  });
  return { child, exit, until, output: () => out };
}
const get = (port, p, host) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p, headers: host ? { Host: host } : {} }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); }).on('error', reject);
});

test('rts-arena --help prints the options and exits 0; a bad option exits 1 with a hint', async () => {
  const h = await run(['--help']).exit;
  assert.equal(h.code, 0);
  for (const flag of ['--port', '--data', '--no-open', '--help', 'RTS_ARENA_DATA', '8800']) assert.ok(h.out.includes(flag), flag);
  const bad = await run(['--port', 'nope']).exit;
  assert.equal(bad.code, 1);
  assert.match(bad.out, /--port must be a number/);
  assert.match(bad.out, /--help/);
});

test('rts-arena starts the arena on the wanted port with its own data folder, passes arena flags on, and stops with it', async () => {
  const probe = await listen(0), port = probe.address().port;
  await close(probe);
  const data = path.join(tmp('rts-launch-'), 'new-folder'); // does not exist yet: the launcher makes it
  const r = run(['--no-open', '--port', String(port), '--data', data, '--allow-host', 'example.test']);
  try {
    await r.until(new RegExp(`RTS Arena is running: http://127\\.0\\.0\\.1:${port}/`));
    assert.ok(fs.existsSync(path.join(data, 'matches')) && fs.existsSync(path.join(data, 'players')), 'the arena works in the folder given');
    assert.equal((await get(port, '/')).status, 200);
    const doc = await get(port, '/api/doctor');
    assert.equal(doc.status, 200);
    assert.equal(JSON.parse(doc.body).ok, true);
    assert.equal((await get(port, '/api/state', 'example.test')).status, 200, '--allow-host reached the arena');
    assert.equal((await get(port, '/api/state', 'other.test')).status, 403);
    // a data folder of the user's own: the replays go with it, not into the package folder (an npx cache can vanish)
    const made = await fetch(`http://127.0.0.1:${port}/api/matches`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ players: [{ type: 'bot' }, { type: 'bot' }], rules: { speed: 64 } }) });
    const id = (await made.json()).id;
    await fetch(`http://127.0.0.1:${port}/api/matches/${id}/stop`, { method: 'POST' });
    assert.ok(fs.existsSync(path.join(data, 'replays', id, 'log.jsonl')), 'replays live in <data>/replays');
    assert.ok(!r.output().includes('Could not open a browser'), '--no-open does not even try');
  } finally { r.child.kill('SIGTERM'); }
  const end = await r.exit;
  assert.equal(end.code, 0, end.out);
  await assert.rejects(get(port, '/'), 'the arena stopped together with the launcher');
});

test('rts-arena: a busy port moves on to the next one and says so', async () => {
  const taken = await listen(0), port = taken.address().port;
  const r = run(['--no-open', '--port', String(port), '--data', tmp('rts-launch-')]);
  try {
    const m = await r.until(new RegExp(`Port ${port} is busy, using (\\d+)\\.`));
    const next = +m[1];
    assert.ok(next > port && next <= port + PORT_TRIES);
    await r.until(new RegExp(`RTS Arena is running: http://127\\.0\\.0\\.1:${next}/`));
    assert.equal((await get(next, '/')).status, 200);
  } finally { r.child.kill('SIGTERM'); await r.exit; await close(taken); }
});

test('rts-arena: RTS_ARENA_DATA sets the data folder when --data is not given', async () => {
  const probe = await listen(0), port = probe.address().port;
  await close(probe);
  const data = tmp('rts-launch-env-');
  const r = run(['--no-open', '--port', String(port)], { env: { RTS_ARENA_DATA: data } });
  try {
    await r.until(/RTS Arena is running/);
    assert.ok(r.output().includes(`Data folder: ${data}`), r.output());
    assert.ok(fs.existsSync(path.join(data, 'matches')));
  } finally { r.child.kill('SIGTERM'); await r.exit; }
});
