// 4:5 broadcast: the winner banner (top ~200 px) covers the first line of the action feed, so the feed fades out with the banner. 16:9 keeps its feed.
// No browser: the two functions are cut out of render/broadcast.mjs and run against a small stand-in for the DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../render/broadcast.mjs'), 'utf8');
const a = src.indexOf('function winnerBanner('), b = src.indexOf('// ---- small decision card');
assert.ok(a > 0 && b > a, 'winnerBanner and updateFeed are where the test expects them');
const code = src.slice(a, b);

function run(preset, ui) {
  const mk = () => { const style = { props: {}, setProperty(k, v) { this.props[k] = v; } }; return { style, children: [], className: '', append(x) { this.children.push(x); }, set innerHTML(_) { this.children = [{ textContent: '' }, { textContent: '' }]; } }; };
  const box = mk();
  const document = { createElement: () => mk() };
  const f = new Function('$', 'document', 'init', 'preset', `${code}; return updateFeed;`)(() => box, document, { players: [{ color: '#f00' }, { color: '#0f0' }] }, preset);
  f(ui);
  return box;
}
const feed = [{ tag: 'BUILD', text: 'house', p: 1, a: 1 }, { tag: 'TRAIN', text: 'archer', p: 2, a: 0.5 }];

test('4:5: the feed is as visible as the winner banner is not (fades out with it, back to full without a banner)', () => {
  assert.equal(run('x', { feed }).style.opacity, '1');
  assert.equal(run('x', { feed, banner: { title: 'Model wins', a: 0 } }).style.opacity, '1');
  assert.equal(run('x', { feed, banner: { title: 'Model wins', a: 0.25 } }).style.opacity, '0.75');
  assert.equal(run('x', { feed, banner: { title: 'Model wins', a: 1 } }).style.opacity, '0');
});
test('4:5: other banners (not a win) leave the feed alone', () => {
  assert.equal(run('x', { feed, banner: { title: 'FIGHT', a: 1 } }).style.opacity, '1');
});
test('16:9: the feed is untouched by the winner banner', () => {
  assert.equal(run('yt', { feed, banner: { title: 'Model wins', a: 1 } }).style.opacity, '');
});
test('the feed lines keep their own fade (item opacity) whatever the box does', () => {
  const box = run('x', { feed, banner: { title: 'Model wins', a: 1 } });
  assert.deepEqual(box.children.slice(-2).map((c) => c.style.opacity), [1, 0.5]);
});
