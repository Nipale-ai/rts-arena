// The action feed of the x preset: a theme with longer names may make the lines wider (.themed), classic keeps the old 500 px box byte for byte.
// Node only, no Chrome. The pictures are pinned by tools/golden-broadcast.mjs (classic must stay frame-identical) and the layout check of the renderer (theme: no cut text).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RENDER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'render');
const css = fs.readFileSync(path.join(RENDER, 'broadcast.css'), 'utf8');

test('classic rule of the x feed is unchanged', () => {
  assert.ok(css.includes('.preset-x #feed { left: 20px; top: 190px; width: 500px; gap: 4px; align-items: flex-start; } .preset-x .fl { max-width: 100%; }'));
});

test('the wider feed applies only under .themed', () => {
  const m = css.match(/(^|\n)([^\n{]*#feed[^\n{]*)\{[^}]*max-width: 640px[^}]*\}/);
  assert.ok(m, 'rule with max-width 640px');
  assert.match(m[2], /^\.themed \.preset-x #feed\s*$/);
  assert.equal((css.match(/max-width: 640px/g) || []).length, 1);
});

test('the class is set for a theme, never for classic', () => {
  const src = fs.readFileSync(path.join(RENDER, 'assets3d.mjs'), 'utf8');
  assert.match(src, /this\.theme && this\.theme\.isClassic === false && typeof document !== 'undefined' && document\.documentElement\) document\.documentElement\.classList\.add\('themed'\)/);
  assert.equal((src.match(/classList\.(add|toggle|remove)\('themed'/g) || []).length, 1, 'one place sets the class');
});
