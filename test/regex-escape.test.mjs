import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Player names and notes are free text. A regex built from them without escaping crashes the whole video chain on the first bracket
// (real case 01.11.: "Bob's TensorFold Metal recipe"). Every dynamic regex in the code escapes its text, or says in a comment why it is safe.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (['vendor', 'test', 'node_modules', 'assets'].includes(e.name) ? [] : walk(path.join(d, e.name))) : /\.(mjs|js)$/.test(e.name) ? [path.join(d, e.name)] : []));

test('no regex is built from unescaped text', () => {
  const bad = [];
  for (const f of ['tools', 'render', 'server', 'agents'].flatMap((d) => walk(path.join(ROOT, d)))) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (!/new RegExp\(/.test(line) || !/\$\{|'\s*\+|\+\s*'/.test(line)) return;
      if (/\besc\b|\.replace\(\/\[\.\*\+\?\^\$\{\}\(\)\|\[\\\]\\\\\]\/g|regex-safe:/.test(line)) return;
      bad.push(`${path.relative(ROOT, f)}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(bad, []);
});
