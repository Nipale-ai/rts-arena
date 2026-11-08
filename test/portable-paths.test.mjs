import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { voiceRef, VoiceError } from '../tools/video-voices.mjs';
import { CASTERS } from '../tools/caster-facts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A stranger's checkout must not point at somebody's home folder: no absolute /Users/<name> or /home/<name> path in the code.
test('no private home-folder path in the code (sim/ and sim-versions/ are not part of this check)', () => {
  const SKIP = new Set(['.git', 'node_modules', 'sim', 'sim-versions', 'data', 'replays', 'vendor', 'test', 'test-support', 'art-v2']); // art-v2: local art tools, git-ignored, not in a checkout
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name) || e.name.startsWith('_alt-') || e.name.startsWith('tmp-')) continue;
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.(mjs|js|py|html|css|sh)$/.test(e.name) || e.name === 'package.json') {
        fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => { if (/\/(Users|home)\/[A-Za-z]/.test(l)) hits.push(`${path.relative(ROOT, f)}:${i + 1}`); });
      }
    }
  };
  walk(ROOT);
  assert.deepEqual(hits, []);
});

// Runs a snippet of module code in a fresh node and returns the JSON it prints. The child gets RTS_VOICES_DIR explicitly (empty unless given):
// a variable that is set, even to '', is never overwritten from a local-env.json, so the answer does not depend on this machine's file.
const inChild = (code, env = {}) => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, RTS_VOICES_DIR: '', ...env } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const voiceDirsWith = (env) => inChild("import('./tools/caster-voice.mjs').then((m) => console.log(JSON.stringify(m.VOICE_DIRS)))", env);

test('voice reference folders: no default folder, env RTS_VOICES_DIR is the base folder of caster_a and caster_b', () => {
  assert.deepEqual(voiceDirsWith({}), { caster_a: '', caster_b: '' });
  assert.deepEqual(voiceDirsWith({ RTS_VOICES_DIR: '/v' }), { caster_a: '/v/caster_a', caster_b: '/v/caster_b' });
  for (const c of Object.values(CASTERS)) assert.ok(!path.isAbsolute(c.voice_ref), 'the reference named in the manifest is relative');
});

test('voiceRef: a voice without a folder says what to set; a folder in the settings still works', () => {
  const none = inChild("import('./tools/video-voices.mjs').then((m) => { try { m.voiceRef('caster_a'); console.log(JSON.stringify({ threw: false })); } catch (e) { console.log(JSON.stringify({ threw: true, voiceError: e instanceof m.VoiceError, message: e.message })); } })");
  assert.equal(none.threw, true);
  assert.equal(none.voiceError, true);
  assert.match(none.message, /RTS_VOICES_DIR/);
  assert.match(none.message, /Settings/);
  assert.throws(() => voiceRef('nobody'), (e) => e instanceof VoiceError && /unknown voice/.test(e.message));
  assert.throws(() => voiceRef('caster_a', { caster_a: '/no/such/folder' }), (e) => e instanceof VoiceError && /not found/.test(e.message));
});
