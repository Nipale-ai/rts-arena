import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { angleArgs } from '../tools/make-video.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('angleArgs: the Metal backend flag on macOS only', () => {
  assert.deepEqual(angleArgs('darwin'), ['--use-angle=metal']);
  assert.deepEqual(angleArgs('linux'), []);
  assert.deepEqual(angleArgs('win32'), []);
  assert.deepEqual(angleArgs(), process.platform === 'darwin' ? ['--use-angle=metal'] : []);
});

test('no tool puts --use-angle=metal into its own launch list: they all spread angleArgs()', () => {
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'vendor' || e.name === 'node_modules' || e.name.startsWith('_alt')) continue;
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.(mjs|js)$/.test(e.name) && path.relative(ROOT, f) !== path.join('tools', 'make-video.mjs') && fs.readFileSync(f, 'utf8').includes('--use-angle=metal')) hits.push(path.relative(ROOT, f));
    }
  };
  for (const d of ['tools', 'render', 'ui', 'server']) walk(path.join(ROOT, d));
  assert.deepEqual(hits, []);
});
