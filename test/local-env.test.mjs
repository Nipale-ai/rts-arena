import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyLocalEnv } from '../server/local-env.mjs';

const tmpFile = (content) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rts-local-env-'));
  const f = path.join(d, 'local-env.json');
  if (content !== undefined) fs.writeFileSync(f, content);
  return f;
};

test('local-env.json fills unset RTS_* variables only', () => {
  const f = tmpFile(JSON.stringify({ RTS_PAUSE_FILE: '/x/lock', RTS_VOICES_DIR: '/x/voices', PATH: '/evil', RTS_NUM: 3, rts_lower: 'a' }));
  const env = { RTS_VOICES_DIR: '/from/env' };
  assert.deepEqual(applyLocalEnv(f, env), ['RTS_PAUSE_FILE']);
  assert.deepEqual(env, { RTS_VOICES_DIR: '/from/env', RTS_PAUSE_FILE: '/x/lock' }); // env wins; non-RTS, non-string and lower-case keys are ignored
});

test('a missing or broken local-env.json changes nothing', () => {
  const env = {};
  const quiet = () => {};
  assert.deepEqual(applyLocalEnv(tmpFile(), env, quiet), []);
  assert.deepEqual(applyLocalEnv(tmpFile('{not json'), env, quiet), []);
  assert.deepEqual(applyLocalEnv(tmpFile('null'), env, quiet), []);
  assert.deepEqual(applyLocalEnv(tmpFile('[1]'), env, quiet), []);
  assert.deepEqual(Object.keys(env).filter((k) => !k.startsWith('RTS_LOCAL_ENV')), []);
});

test('a missing file is silent; a file that is there but unusable is named in one warning', () => {
  const lines = [];
  const warn = (m) => lines.push(m);
  assert.deepEqual(applyLocalEnv(tmpFile(), {}, warn), []);
  assert.deepEqual(lines, [], 'no file: no warning');
  assert.deepEqual(applyLocalEnv(tmpFile(JSON.stringify({ RTS_X: 'ok' })), {}, warn), ['RTS_X']);
  assert.deepEqual(lines, [], 'a good file: no warning');

  for (const [content, why] of [['{not json', /not valid JSON/], ['', /not valid JSON/], ['null', /not a JSON object/], ['[1, 2]', /not a JSON object/], ['"text"', /not a JSON object/], ['7', /not a JSON object/]]) {
    lines.length = 0;
    const f = tmpFile(content);
    assert.deepEqual(applyLocalEnv(f, {}, warn), []);
    assert.equal(lines.length, 1, `one warning for ${JSON.stringify(content)}`);
    assert.ok(lines[0].includes(f), 'the warning names the file');
    assert.match(lines[0], why);
    assert.match(lines[0], /RTS_VOICES_DIR/, 'it shows what the file should look like');
  }
});

test('an unreadable local-env.json (a folder) is reported; the warning is said once per process tree', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rts-local-env-'));
  const lines = [];
  const env = {};
  assert.deepEqual(applyLocalEnv(d, env, (m) => lines.push(m)), []);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /cannot be read/);
  assert.deepEqual(applyLocalEnv(d, env, (m) => lines.push(m)), []);
  assert.equal(lines.length, 1, 'a child process inherits the marker and stays quiet');
});

test('by default the warning goes to stderr', (t) => {
  const seen = [];
  t.mock.method(console, 'error', (m) => seen.push(m));
  applyLocalEnv(tmpFile('{oops'), {});
  assert.equal(seen.length, 1);
  assert.match(seen[0], /ignoring .*local-env\.json/);
});
