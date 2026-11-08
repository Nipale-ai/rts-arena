// The fog of war scene of the broadcast: a banner says whose eyes the picture shows and what light and dark mean, the rings wear the colour of that side,
// the veil and the banner fade in 0.4 s and change side in one piece, and nothing lies on the class, the captions or the cards (BROADCAST-RULES.md rule 2).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { viewTitle, inkOn, enemyLine, bannerSpec } from '../render/fog-banner.mjs';
import { FOG_LEGEND, FOG_ALPHA, FOG_ALPHA_BROADCAST, fogShade, LEGEND_GROUND, lum } from '../render/fog-look.mjs';
import { Show, FADE, SWAP, tagParts, sightOf, UN } from '../tools/story-show.mjs';
import { World } from '../tools/show-tags.mjs';
import { hasChrome, hasPuppeteer, chromePath, puppeteerDir, angleArgs } from '../tools/make-video.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const BLUE = '#4d8dff', ORANGE = '#ff7a45'; // player 1 and 2 as everywhere in the picture
const colorOf = (p) => (p === 1 ? BLUE : ORANGE);

// ---------------------------------------------------------------- text and colour of the banner
test('banner: "<NAME>\'S VIEW" in the colour of the side, legend and enemy line', () => {
  assert.equal(viewTitle('MiniMax'), "MINIMAX'S VIEW");
  assert.equal(viewTitle('GLM'), "GLM'S VIEW");
  const a = bannerSpec({ p: 1, name: 'MiniMax', a: 1, swap: null, seen: { n: 0, total: 7 } }, colorOf);
  assert.equal(a.title, "MINIMAX'S VIEW"); assert.equal(a.color, BLUE); assert.equal(a.p, 1);
  const b = bannerSpec({ p: 2, name: 'GLM', a: 0.5, swap: null, seen: { n: 2, total: 40 } }, colorOf);
  assert.equal(b.title, "GLM'S VIEW"); assert.equal(b.color, ORANGE); assert.equal(b.a, 0.5);
  assert.notEqual(a.color, b.color, 'two sides, two colours');
  assert.deepEqual(a.legend.map((e) => e.label), ['SEEN NOW', 'SEEN BEFORE', 'UNKNOWN']);
  assert.equal(a.enemy, 'ENEMY UNSEEN: ALL 7 UNITS');
  assert.equal(b.enemy, 'ENEMY IN SIGHT: 2 OF 40 UNITS');
  assert.equal(bannerSpec(null, colorOf), null);
  assert.equal(bannerSpec({ p: 1, name: 'MiniMax', a: 0, swap: null, seen: null }, colorOf), null, 'faded out: nothing to draw');
});

test('banner: the enemy line only comes with a count from the state of the frame, never invented', () => {
  assert.equal(enemyLine(null), null);
  assert.equal(enemyLine({ n: 0, total: 0 }), null, 'no enemy unit alive: nothing to say about what is unseen');
  assert.equal(enemyLine({ n: 3, total: 3 }), 'ENEMY IN SIGHT: 3 OF 3 UNITS');
  assert.equal(enemyLine({ n: 1, total: 1 }), 'ENEMY IN SIGHT: 1 UNIT');
  assert.equal(enemyLine({ n: 0, total: 1 }), 'ENEMY UNSEEN: 1 UNIT');
  assert.equal(bannerSpec({ p: 1, name: 'MiniMax', a: 1, swap: null, seen: null }, colorOf).enemy, null);
});

test('banner: text on a side colour is readable (dark on light, white on dark)', () => {
  assert.equal(inkOn(ORANGE), '#0a0e14');
  assert.equal(inkOn('#1a2a6c'), '#ffffff');
  assert.equal(bannerSpec({ p: 2, name: 'GLM', a: 1, swap: null }, colorOf).ink, inkOn(ORANGE));
});

test('banner: a change of side carries both sides and how far the change is', () => {
  const s = bannerSpec({ p: 1, name: 'MiniMax', a: 1, swap: { from: { p: 1, name: 'MiniMax' }, to: { p: 2, name: 'GLM' }, x: 0.25 } }, colorOf);
  assert.equal(s.swap.from.title, "MINIMAX'S VIEW"); assert.equal(s.swap.from.color, BLUE);
  assert.equal(s.swap.to.title, "GLM'S VIEW"); assert.equal(s.swap.to.color, ORANGE);
  assert.equal(s.swap.x, 0.25);
});

// ---------------------------------------------------------------- the legend tells what the picture shows
test('legend: light, grey and dark are three different shades, in that order, made with the numbers of the overlay', () => {
  const [now, seen, unknown] = FOG_LEGEND.map((e) => lum(e.rgb));
  assert.ok(now > seen && seen > unknown, `${now} > ${seen} > ${unknown}`);
  assert.ok(now - seen > 0.04 && seen - unknown > 0.04, 'each step can be told apart');
  assert.deepEqual(FOG_LEGEND[0].rgb, LEGEND_GROUND, 'in sight: the ground as it is');
  assert.deepEqual(fogShade('unknown', LEGEND_GROUND), FOG_LEGEND[2].rgb);
  // the broadcast veil is heavier than the live one, and both go from clear (in sight) to light (seen) to heavy (never seen)
  for (const A of [FOG_ALPHA, FOG_ALPHA_BROADCAST]) assert.ok(A.visible < A.seen && A.seen < A.unknown);
  assert.ok(FOG_ALPHA_BROADCAST.unknown > FOG_ALPHA.unknown);
  const app = read('render/app.mjs');
  assert.match(app, /FOG_ALPHA_BROADCAST/); assert.match(app, /FA\.unknown/); assert.match(app, /FA\.seen/); assert.match(app, /FA\.visible/);
});

// ---------------------------------------------------------------- the scene: tags, rings, chips
const ctx = (names = ['MiniMax', 'GLM']) => ({ starts: [{ x: 20, z: 60 }, { x: 100, z: 60 }], names, world: new World({ events: [], players: [{ id: 1 }, { id: 2 }], ticks: 1000 }), pre: { scouts: {}, insets: {} } });
test('fog scene: rings carry the name of their side, small groups get no unnamed ring, the chip leaves for the banner', () => {
  const [part] = tagParts({ fog: { player: 2 } }, ctx(), 100);
  assert.equal(part.fog, 2); assert.equal(part.clean, true); assert.equal(part.cam.k, 'map');
  assert.equal(part.tag.viewOnly, true, 'the chip only repeats the banner');
  assert.match(part.tag.text, /FOG OF WAR/);
  assert.deepEqual([...new Set(part.marks.map((m) => m.o))], [2], 'only what the viewer owns is ringed');
  const base = part.marks.find((m) => m.bld), army = part.marks.find((m) => m.sel);
  assert.equal(base.label, 'GLM BASE');
  assert.equal(army.label, 'ARMY {n}'); assert.equal(army.minUnits, 3); assert.equal(army.labelFrom, 3);
  // a scout's find keeps its own chip: it is not "viewOnly"
  const fc = tagParts({ event: { id: 1 } }, { ...ctx(), world: { byId: new Map([[1, { id: 1, type: 'first_contact', p: 1, other: 2, what: 'spearman', loc: [60, 60], t: 10 }]]) } }, 100)[0];
  assert.equal(fc.fog, 1); assert.ok(!fc.tag.viewOnly);
  // the map tag under fog: base ring named, army ring needs 3 units
  const [map] = tagParts({ map: {}, fog: { player: 1 } }, ctx(), 100);
  assert.equal(map.marks.find((m) => m.bld).label, 'MINIMAX BASE'); assert.equal(map.marks.find((m) => m.sel).minUnits, 3);
  const [open] = tagParts({ map: {} }, ctx(), 100);
  assert.equal(open.marks.find((m) => m.sel).minUnits, 3, 'the open whole map: no unnamed ring either');
});

const U = (id, o, ty, x, z) => [id, o, UN.indexOf(ty), x, z, 100, 0];
function fake(parts, names = ['MiniMax', 'GLM']) { return { names, pre: { insets: {} }, partAt: Show.prototype.partAt, parts }; }
const at = (f, t, snap = {}, game = null) => Show.prototype.at.call(f, t, snap, game);

test('fog scene: veil and banner fade in 0.4 s and out 0.4 s, not a hard switch', () => {
  assert.equal(FADE, 0.4);
  const f = fake([{ line: 'L1', o0: 10, o1: 20, clean: true, fog: 1, cam: { k: 'map' } }]);
  assert.equal(at(f, 10).view.a, 0); assert.equal(at(f, 10).fog.a, 0);
  assert.equal(at(f, 10.2).view.a, 0.5); assert.equal(at(f, 10.2).fog.a, 0.5);
  assert.equal(at(f, 10.4).view.a, 1); assert.equal(at(f, 10.4).fog.a, 1);
  assert.equal(at(f, 19.6).view.a, 1);
  assert.equal(at(f, 19.8).view.a, 0.5); assert.equal(at(f, 19.8).fog.a, 0.5);
  assert.ok(at(f, 19.999).view.a < 0.01);
  const v = at(f, 15).view;
  assert.equal(v.p, 1); assert.equal(v.name, 'MiniMax'); assert.equal(v.swap, null);
});

test('fog scene: two views of different sides in a row: the banner stays up and changes side (name and colour), the veil dips for 2 x 0.2 s', () => {
  assert.equal(SWAP, 0.2);
  const f = fake([
    { line: 'L1', o0: 0, o1: 5, clean: true, fog: 1, cam: { k: 'map' } },
    { line: 'L2', o0: 5, o1: 10, clean: true, fog: 2, cam: { k: 'map' } },
  ]);
  // far from the cut: one side, no change
  assert.equal(at(f, 3).view.swap, null); assert.equal(at(f, 3).view.p, 1);
  assert.equal(at(f, 7).view.swap, null); assert.equal(at(f, 7).view.p, 2);
  // 0.1 s before the cut: still player 1's part, the change has begun (x below one half), the banner is fully up
  const before = at(f, 4.9).view, after = at(f, 5.1).view;
  assert.equal(before.p, 1); assert.equal(before.a, 1);
  assert.deepEqual([before.swap.from.p, before.swap.to.p, before.swap.from.name, before.swap.to.name], [1, 2, 'MiniMax', 'GLM']);
  assert.ok(before.swap.x > 0 && before.swap.x < 0.5, `x ${before.swap.x}`);
  assert.equal(after.p, 2); assert.equal(after.a, 1);
  assert.deepEqual([after.swap.from.p, after.swap.to.p], [1, 2]);
  assert.ok(after.swap.x > 0.5 && after.swap.x < 1, `x ${after.swap.x}`);
  assert.ok(Math.abs(at(f, 4.85).view.swap.x - 0.125) < 0.01); assert.equal(at(f, 5.25).view.swap, null, 'done after 0.2 s'); assert.equal(at(f, 4.75).view.swap, null, 'not begun 0.25 s before');
  // the banner never dips at the cut (it is always visible in a fog scene) ...
  for (const t of [4.6, 4.8, 4.9, 4.999, 5, 5.001, 5.1, 5.2, 5.4]) assert.equal(at(f, t).view.a, 1, `banner at ${t}`);
  // ... the veil of the first side is gone at the cut and the second one fades in
  assert.equal(at(f, 5).fog.a, 0); assert.equal(at(f, 5).fog.p, 2);
  assert.ok(at(f, 4.9).fog.a > 0 && at(f, 4.9).fog.a < 0.6);
  assert.equal(at(f, 4.7).fog.a, 1); assert.equal(at(f, 5.2).fog.a, 1);
  assert.equal(at(f, 4.9).fog.p, 1);
});

test('fog scene: the same side twice in a row is one picture (no dip, no change of side)', () => {
  const f = fake([{ line: 'L1', o0: 0, o1: 5, clean: true, fog: 2, cam: { k: 'map' } }, { line: 'L2', o0: 5, o1: 10, clean: true, fog: 2, cam: { k: 'map' } }]);
  for (const t of [4.8, 4.999, 5, 5.1]) { const s = at(f, t); assert.equal(s.fog.a, 1); assert.equal(s.view.a, 1); assert.equal(s.view.swap, null); }
});

test('fog scene: a fog view that ends in the game view fades out, the banner with it; a part without fog has no banner', () => {
  const f = fake([{ line: 'L1', o0: 0, o1: 5, fog: 1, cam: { k: 'grp' } }, { line: 'L2', o0: 5, o1: 10, cam: { k: 'grp' } }]);
  assert.equal(at(f, 4.8).view.a, 0.5); assert.ok(at(f, 4.999).view.a < 0.01);
  assert.equal(at(f, 7).view, null); assert.equal(at(f, 7).fog, null);
});

test('fog scene: the enemy count comes from the sight of the player at that frame; wild animals and own units are not counted', () => {
  const W = 8, vis = new Uint8Array(W * W);
  vis[2 * W + 2] = 1; // the player sees tile (2, 2)
  const game = { W, players: { 1: { vis } } };
  const snap = { units: [U(1, 1, 'worker', 2.5, 2.5), U(2, 2, 'worker', 2.5, 2.5), U(3, 2, 'spearman', 6.5, 6.5), U(4, 2, 'archer', 7, 7), U(5, 0, 'worker', 2.5, 2.5)] };
  assert.deepEqual(sightOf(snap, game, 1), { n: 1, total: 3 });
  assert.deepEqual(sightOf({ units: [] }, game, 1), { n: 0, total: 0 });
  assert.equal(sightOf({}, game, 1), null);
  const f = fake([{ line: 'L1', o0: 0, o1: 10, clean: true, fog: 1, cam: { k: 'map' } }]);
  assert.deepEqual(at(f, 5, snap, game).view.seen, { n: 1, total: 3 });
  assert.equal(at(f, 5, snap, null).view.seen, null, 'no sim state, no line');
  const withInset = fake([{ line: 'L2', o0: 0, o1: 10, fog: 1, inset: 'p1d1', cam: { k: 'look', from: 1, to: 2 } }]);
  withInset.pre.insets.p1d1 = { p: 1, tick: 0, n: 0, workers: 0, fog: '', own: [], enemy: [], box: [0, 0, 8], size: 8 };
  assert.equal(at(withInset, 5, snap, game).view.seen, null, 'beside the map of what the model saw then, a count of now would contradict it');
});

test('fog scene: a group of one or two units gets no ring, a group of three does; a ring is the colour of its side in the picture', () => {
  const mk = { sel: { t: 'army', o: 1 }, o: 1, label: 'ARMY {n}', labelFrom: 3, minUnits: 3 };
  const f = fake([{ line: 'L1', o0: 0, o1: 10, clean: true, fog: 1, cam: { k: 'map' }, marks: [mk] }]);
  const W = 8, vis = new Uint8Array(W * W).fill(1), game = { W, players: { 1: { vis } } };
  const two = { units: [U(1, 1, 'spearman', 2, 2), U(2, 1, 'spearman', 3, 2)] }, three = { units: [...two.units, U(3, 1, 'archer', 2, 3)] };
  assert.equal(at(f, 5, two, game).marks.length, 0); assert.equal(at(f, 5, two, game).labels.length, 0);
  assert.equal(at(f, 5, three, game).marks.length, 3); assert.equal(at(f, 5, three, game).labels[0].text, 'ARMY 3');
  const bc = read('render/broadcast.mjs');
  assert.match(bc, /const ringCol = \(o\) => \(fogSide \? col\(o\) : '#ffe066'\)/, 'in a fog scene no yellow ring');
  assert.match(bc, /strokeStyle = fogSide \? col\(fogSide\.p\)/, 'the frame of the map has the colour of the side');
});

test('page: the banner is wired in, the chip steps back, plan cards and headline give way', () => {
  const bc = read('render/broadcast.mjs'), html = read('render/broadcast.html'), css = read('render/broadcast.css'), lf = read('render/layout-faults.mjs');
  assert.match(html, /<div id="fogban"><\/div>/);
  assert.match(bc, /bannerSpec\(sh\.view/); assert.match(bc, /applyBanner\(ban/);
  assert.match(bc, /chip = sh\.tag && !\(banner && sh\.tag\.viewOnly\)/);
  assert.match(bc, /\['#sc0', '#sc1'\]/);
  assert.match(lf, /'#fogban'/); assert.match(lf, /BANNER_KEEP_OFF/);
  for (const sel of ['#head', '#cls', '#caps .cap', '#mom']) assert.ok(lf.includes(`'${sel}'`), `the banner keeps off ${sel}`);
  assert.match(css, /\.story\.preset-x #fogban \{ top: 146px; \}/);
  assert.match(css, /\.preset-x #fogban \{ top: 128px; right: 20px; \}/);
  assert.match(css, /\.preset-yt #fogban \{ top: 128px; right: 480px; \}/);
});

test('rules: rule 2 describes the banner, the legend and how a fog scene is spoken', () => {
  const rules = read('BROADCAST-RULES.md');
  for (const must of ['banner', 'light ground', 'grey ground', 'dark ground', 'MINIMAX\'S VIEW', '2a.', 'Never say "fog on" or "fog off"', 'about half a second']) assert.ok(rules.includes(must), `rules mention ${must}`);
  assert.doesNotMatch(rules, /from that player's corner/, 'the old description (a low view from the corner) is gone');
});

// ---------------------------------------------------------------- real layout in Chrome: the real CSS, the real banner code, no 3D
const canRender = hasChrome() && hasPuppeteer();
function serve() {
  const render = path.join(ROOT, 'render');
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/fixture.html') {
      // the real page without its 3D script: the same elements, the same CSS; the test fills them like render/broadcast.mjs does
      const html = fs.readFileSync(path.join(render, 'broadcast.html'), 'utf8').replace(/<script type="module" src="broadcast.mjs"><\/script>/, '<script type="module" src="/fixture.mjs"></script>');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); return;
    }
    if (u.pathname === '/fixture.mjs') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end(`import { layoutFaults } from './layout-faults.mjs';
import { bannerSpec, applyBanner } from './fog-banner.mjs';
const preset = new URLSearchParams(location.search).get('preset') === 'yt' ? 'yt' : 'x';
document.body.className = 'preset-' + preset + (new URLSearchParams(location.search).get('story') === '0' ? '' : ' story');
const $ = (q) => document.querySelector(q);
$('#cls').textContent = '2 SPARKS vs MAC';
$('#clock').textContent = '08:42';
$('#mu0 b').textContent = 'MiniMax-M3.1-Flash'; $('#mu1 b').textContent = 'GLM-5.3-Flash';
const caps = $('#caps');
for (const [who, text] of [['DEX', 'Through MiniMax\\'s eyes it has not found a single enemy unit yet, so everything out there is still a guess.'], ['JUNO', 'Right, and that is why the dark part of the map is so big.']]) {
  const d = document.createElement('div'); d.className = 'cap'; d.style.setProperty('--c', '#3ddc97'); d.style.opacity = 1; d.innerHTML = '<div class="cw"><b></b><span></span></div><p></p>';
  d.querySelector('b').textContent = who; d.querySelector('span').textContent = 'caster'; d.querySelector('p').textContent = text; caps.append(d);
}
for (const i of [0, 1]) { const c = $('#sc' + i); c.style.setProperty('--tc', i ? '${ORANGE}' : '${BLUE}'); c.innerHTML = '<div class="sh"><b>name</b><span>TIER 2</span></div><div class="rw q"><i>PLAN</i><p>a plan that takes some room</p></div>'; c.style.opacity = 1; }
window.__t = { layoutFaults: () => layoutFaults(document), show: (view, opts = {}) => {
  const spec = bannerSpec(view, (p) => (p === 1 ? '${BLUE}' : '${ORANGE}'));
  applyBanner($('#fogban'), spec);
  for (const id of ['#sc0', '#sc1']) $(id).style.opacity = opts.cardsOff ? 0 : 1;
  const t = $('#showtag'); t.textContent = opts.chip || ''; t.style.opacity = opts.chip ? 1 : 0; t.classList.toggle('under', !!opts.chip);
  return !!spec;
}, rect: (q) => { const r = $(q).getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height }; }, bg: (q) => getComputedStyle($(q)).backgroundColor, text: (q) => $(q).textContent };
`);
      return;
    }
    const f = path.normalize(path.join(render, decodeURIComponent(u.pathname)));
    if (!f.startsWith(render + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('no'); return; }
    res.writeHead(200, { 'Content-Type': f.endsWith('.css') ? 'text/css' : f.endsWith('.mjs') || f.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port })));
}
const SIZES = { x: [1080, 1350], yt: [1920, 1080] };
const view = (p, name, extra = {}) => ({ p, name, a: 1, swap: null, seen: { n: 0, total: 14 }, ...extra });
const overlaps = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;

test('banner layout in Chrome: both formats, story and plain cut, longest names: big, in the colour of the side, on no caption, no class label, no card', { skip: !canRender && 'needs Chrome and puppeteer-core', timeout: 180000 }, async () => {
  const { srv, port } = await serve();
  const puppeteer = createRequire(import.meta.url)(path.join(puppeteerDir(), 'puppeteer-core'));
  const browser = await puppeteer.launch({ executablePath: chromePath(), headless: 'new', args: [...angleArgs(), '--no-sandbox', '--force-device-scale-factor=1'] });
  try {
    for (const preset of ['x', 'yt']) for (const story of [1, 0]) {
      const page = await browser.newPage();
      await page.setViewport({ width: SIZES[preset][0], height: SIZES[preset][1], deviceScaleFactor: 1 });
      await page.goto(`http://127.0.0.1:${port}/fixture.html?preset=${preset}&story=${story}`, { waitUntil: 'load' });
      await page.waitForFunction('window.__t', { timeout: 20000 });
      const tag = `${preset}${story ? ' story' : ''}`;
      // 1. the longest names a banner meets
      for (const [p, name, title] of [[1, 'MiniMax', "MINIMAX'S VIEW"], [2, 'GLM', "GLM'S VIEW"], [1, 'Zoe kit TP2', "ZOE KIT TP2'S VIEW"], [2, 'DeepSeek-V4.1-Flash', "DEEPSEEK-V4.1-FLASH'S VIEW"]]) {
        await page.evaluate((v) => window.__t.show(v, { cardsOff: true }), view(p, name));
        const faults = await page.evaluate(() => window.__t.layoutFaults());
        assert.deepEqual(faults, [], `${tag} ${name}: ${faults.join('; ')}`);
        const r = await page.evaluate(() => window.__t.rect('#fogban'));
        const size = SIZES[preset];
        assert.ok(r.left >= 0 && r.top >= 0 && r.right <= size[0] && r.bottom <= size[1], `${tag} ${name}: inside the picture`);
        assert.ok(r.w >= 440 && r.h >= 120, `${tag}: big enough to read at a glance (${r.w} x ${r.h})`);
        // not on the class label and match-up on top, not on the clock strip, not on any caption, not on a player card
        for (const q of ['#head', '#cls', '#timebox', '#caps .cap', '#pn0', '#pn1']) {
          const r2 = await page.evaluate((s) => (document.querySelector(s) ? window.__t.rect(s) : null), q);
          if (r2 && r2.w > 0 && r2.h > 0) assert.ok(!overlaps(r, r2), `${tag} ${name}: banner over ${q}`);
        }
        // the title is the name, nothing cut; the bar is the colour of the side
        const shown = await page.evaluate(() => [...document.querySelectorAll('#fogban .fbl')].filter((e) => +getComputedStyle(e).opacity > 0).map((e) => ({ t: e.querySelector('b').textContent, bg: getComputedStyle(e).backgroundColor, cut: e.querySelector('b').scrollWidth > e.querySelector('b').clientWidth + 1 })));
        assert.equal(shown.length, 1); assert.equal(shown[0].t, title); assert.equal(shown[0].cut, false, `${tag} ${name}: the name is never cut`);
        assert.equal(shown[0].bg, p === 1 ? 'rgb(77, 141, 255)' : 'rgb(255, 122, 69)');
        assert.equal((await page.evaluate(() => document.querySelectorAll('#fogban .fb-g span').length)), 3);
      }
      // 2. a scout's chip sits under the banner, not on it
      await page.evaluate((v) => window.__t.show(v, { cardsOff: true, chip: "MINIMAX'S SCOUT  ENEMY SPEARMAN FOUND" }), view(1, 'MiniMax'));
      assert.deepEqual(await page.evaluate(() => window.__t.layoutFaults()), [], `${tag}: chip under the banner`);
      // 3. the change of side: both bars are in the picture, still inside, still clear of everything
      await page.evaluate((v) => window.__t.show(v, { cardsOff: true }), view(1, 'MiniMax', { swap: { from: { p: 1, name: 'MiniMax' }, to: { p: 2, name: 'GLM' }, x: 0.5 } }));
      assert.deepEqual(await page.evaluate(() => window.__t.layoutFaults()), [], `${tag}: change of side`);
      // 4. the check bites: a plan card under the banner, or a caption pushed onto it, is a fault
      await page.evaluate((v) => window.__t.show(v, {}), view(2, 'GLM'));
      if (preset === 'x' && story) {
        const f1 = await page.evaluate(() => window.__t.layoutFaults());
        assert.ok(f1.some((x) => /#fogban over #sc1/.test(x)), `${tag}: a plan card under the banner is found (${f1.join('; ')})`);
      }
      await page.evaluate(() => { const c = document.querySelector('#caps'); c.style.position = 'fixed'; c.style.left = document.querySelector('#fogban').getBoundingClientRect().left + 'px'; c.style.top = document.querySelector('#fogban').getBoundingClientRect().top + 20 + 'px'; c.style.width = '400px'; });
      const f2 = await page.evaluate(() => window.__t.layoutFaults());
      assert.ok(f2.some((x) => /#fogban over #caps/.test(x)), `${tag}: a caption on the banner is found (${f2.join('; ')})`);
      await page.close();
    }
  } finally { await browser.close(); srv.close(); }
});
