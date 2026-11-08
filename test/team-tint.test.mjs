// Team tint of the bodies (video only): the gain is a pure function; without the page parameter nothing about the body changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { teamGain, teamTintOf } from '../render/units3d.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('k = 0 is exactly neutral, k = 1 is the team hue at the same luma', () => {
  const c = { r: 0.2, g: 0.5, b: 1.0 };
  assert.deepEqual(teamGain(c, 0), [1, 1, 1]);
  const g = teamGain(c, 1), lu = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  assert.ok(Math.abs(g[0] - c.r / lu) < 1e-12 && Math.abs(g[1] - c.g / lu) < 1e-12 && Math.abs(g[2] - c.b / lu) < 1e-12);
  const h = teamGain(c, 0.5);
  assert.ok(h[2] > 1 && h[0] < 1, 'blue team: more blue, less red');
});

test('a grey team colour changes nothing, black does not divide by zero', () => {
  assert.deepEqual(teamGain({ r: 0.4, g: 0.4, b: 0.4 }, 0.7).map((v) => +v.toFixed(9)), [1, 1, 1]);
  assert.ok(teamGain({ r: 0, g: 0, b: 0 }, 0.5).every(Number.isFinite));
});

test('the body gets an instance colour only when the page asks for it', () => {
  const u = src('render/units3d.mjs');
  assert.match(u, /const TEAM_TINT = typeof location === 'undefined' \? 0 :/);
  assert.match(u, /if \(TEAM_TINT > 0\) bodyM\.instanceColor = /);
  assert.match(u, /if \(TEAM_TINT > 0\) \{ teamGain\(color, teamTintOf\(color, TEAM_TINT\), _tg\); L\.body\.setColorAt\(/);
});

test('render-story --team-tint puts teamtint into the page address and keeps an existing one', () => {
  const r = src('tools/render-story.mjs');
  assert.match(r, /A\['team-tint'\] && !\/\(\^\|&\)teamtint=\/\.test\(process\.env\.RTS_QUERY \|\| ''\)\) process\.env\.RTS_QUERY = \[process\.env\.RTS_QUERY, `teamtint=\$\{\+A\['team-tint'\] \|\| 0\}`\]/);
  assert.match(r, /\[--team-tint 0\.5\]/);
});

test('a blue team colour is pushed harder than the others, never past 0.95, and k = 0 stays neutral', () => {
  const blue = { r: 0.29, g: 0.55, b: 1 }, orange = { r: 1, g: 0.5, b: 0.15 };
  assert.equal(teamTintOf(orange, 0.5), 0.5);
  assert.equal(teamTintOf(blue, 0.5), 0.8);
  assert.equal(teamTintOf(blue, 0.9), 0.95);
  assert.equal(teamTintOf(blue, 0), 0);
  assert.ok(teamGain(blue, teamTintOf(blue, 0.5))[2] > teamGain(blue, 0.5)[2], 'more blue than with the plain 0.5');
});
