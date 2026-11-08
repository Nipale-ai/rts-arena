// 16:9 story cut: the two decision cards (plan, orders, army) sit in the lower corners, each on the side of its team,
// bigger than before, clear of the captions (middle), the footer, the player cards and the kill feed (owner feedback 06.11.).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { hasChrome, hasPuppeteer, chromePath, puppeteerDir, angleArgs } from '../tools/make-video.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const BLUE = '#4d8dff', ORANGE = '#ff4a2a';

test('css: 16:9 story cards are in the lower corners, one per side, 430 px wide', () => {
  const css = read('render/broadcast.css');
  assert.match(css, /\.story\.preset-yt #sc0 \{ left: 24px; right: auto; bottom: 52px; \}/);
  assert.match(css, /\.story\.preset-yt #sc1 \{ right: 24px; left: auto; bottom: 52px; \}/);
  assert.match(css, /\.story\.preset-yt \.sc \{ top: auto; width: 430px;/);
  assert.match(css, /\.story\.preset-yt #feed \{ left: 24px; bottom: 312px;/);
});

const canRender = hasChrome() && hasPuppeteer();
function serve() {
  const render = path.join(ROOT, 'render');
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/fixture.html') {
      const html = read('render/broadcast.html').replace(/<script type="module" src="broadcast.mjs"><\/script>/, '<script type="module" src="/fixture.mjs"></script>');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); return;
    }
    if (u.pathname === '/fixture.mjs') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end(`import { layoutFaults } from './layout-faults.mjs';
document.body.className = 'preset-yt story';
const $ = (q) => document.querySelector(q);
$('#cls').textContent = '2 SPARKS vs MAC'; $('#clock').textContent = '08:42';
$('#foot').textContent = 'Caster voices, music and sound made with AI'; $('#foot').classList.add('on');
const LONG = 'Mass archers at the north gate, then push the second base once the siege workshop is done and the wood is back above two hundred';
for (const [i, col] of [[0, '${BLUE}'], [1, '${ORANGE}']]) {
  const pn = $('#pn' + i); pn.style.setProperty('--tc', col);
  pn.innerHTML = '<div class="ph"><div class="pcol"><div class="pname">DeepSeek-V4.1-Flash</div></div><div class="tier"></div></div><div class="res"><div class="r food"><b>0</b><span>food</span></div><div class="r wood"><b>0</b><span>wood</span></div><div class="r stone"><b>0</b><span>stone</span></div><div class="r gold"><b>0</b><span>gold</span></div></div><div class="pop"><span>POP</span><div class="bar"><i></i></div><span class="popn">0/0</span></div><div class="stats"><div>Army<b>0</b></div><div>Workers<b>0</b></div><div>Kills<b>0</b></div><div>Score<b>0</b></div></div><div class="kv"><span>think <b>-</b></span><span><b>-</b> tok/s</span><span><b>0</b> decisions</span></div>';
  const c = $('#sc' + i); c.style.setProperty('--tc', col); c.style.opacity = 1;
  const row = (l, t, k) => '<div class="rw ' + k + '"><i>' + l + '</i><p>' + t + '</p><em>08:3' + i + '</em></div>';
  c.innerHTML = '<div class="sh"><b>DeepSeek-V4.1-Flash</b><span>TIER 3</span></div>' + row('PLAN', '\\u201c' + LONG + ' ' + LONG + '\\u201d', 'q') + row('ORDERS', LONG + ' ' + LONG, 'o') + row('ARMY', LONG + ' ' + LONG, 'a');
}
const feed = $('#feed');
for (let i = 0; i < 5; i++) { const d = document.createElement('div'); d.className = 'fl'; d.style.setProperty('--c', '${BLUE}'); d.innerHTML = '<b>KILL</b><span>GLM-5.3-Flash kills 3x Scrap Cutter, 2x Arc Gunner</span>'; feed.append(d); }
const caps = $('#caps');
for (const [who, text] of [['DEX', 'Both armies are crashing into each other and the whole north gate is a sea of fire right now!'], ['JUNO', 'This one could decide a lot, I think, because nobody has a reserve left at all.']]) {
  const d = document.createElement('div'); d.className = 'cap'; d.style.setProperty('--c', '#3ddc97'); d.style.opacity = 1; d.innerHTML = '<div class="cw"><b></b><span></span></div><p></p>';
  d.querySelector('b').textContent = who; d.querySelector('span').textContent = 'caster'; d.querySelector('p').textContent = text; caps.append(d);
}
const rw = (l, t, k) => '<div class="rw ' + k + '"><i>' + l + '</i><p>' + t + '</p></div>';
const col = (c, n) => '<div class="col" style="--tc:' + c + '"><div class="ch">DeepSeek-V4.1-Flash \\u00b7 decision ' + n + ' \\u00b7 08:3' + n + '</div>' + rw('SAW', '3 enemy units in view (2 Arc Gunners, 1 Scrap Cutter), its army value is 1560', 's') + rw('SAW', 'a second long line of what it saw before it decided to move', 's') + rw('NOTE', '\\u201c' + LONG + ' ' + LONG + '\\u201d', 'q') + rw('ORDERED', LONG + ' ' + LONG, 'o') + '<div class="cm">thought for 91 s, 4,512 tokens</div></div>';
const SPLIT = {
  two: '<div class="st"><b>SIDE BY SIDE</b><span>14:45</span></div><div class="cols">' + col('${BLUE}', 61) + col('${ORANGE}', 62) + '</div>',
  cmp: '<div class="st"><b>TIER RACE</b><span>14:45</span></div><div class="tbl"><div class="tr th"><span></span><span>GLM-5.3-Flash</span><span>DeepSeek-V4.1-Flash</span></div>' + ['TIER', 'WORKERS', 'ARMY', 'BUILT', 'KILLS', 'LOST'].map((l) => '<div class="tr' + (/^(ARMY|BUILT)$/.test(l) ? ' txt' : '') + '"><span class="l">' + l + '</span><span class="v">' + (LONG + ' ' + LONG).slice(0, 150) + '</span><span class="v">' + (LONG + ' ' + LONG).slice(0, 150) + '</span></div>').join('') + '</div>'
};
window.__t = { split: (k) => { const sp = $('#split'); sp.className = k; sp.innerHTML = SPLIT[k]; sp.style.display = 'flex'; sp.style.opacity = 1; document.body.classList.add('split-on'); }, layoutFaults: () => layoutFaults(document), rect: (q) => { const r = $(q).getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height }; } };
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

test('16:9 story in Chrome: the longest cards sit in the lower corners, clear of captions, footer, player cards and feed', { skip: !canRender && 'needs Chrome and puppeteer-core', timeout: 120000 }, async () => {
  const { srv, port } = await serve();
  const puppeteer = createRequire(import.meta.url)(path.join(puppeteerDir(), 'puppeteer-core'));
  const browser = await puppeteer.launch({ executablePath: chromePath(), headless: 'new', args: [...angleArgs(), '--no-sandbox', '--force-device-scale-factor=1'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    await page.goto(`http://127.0.0.1:${port}/fixture.html`, { waitUntil: 'load' });
    await page.waitForFunction('window.__t', { timeout: 20000 });
    const faults = await page.evaluate(() => window.__t.layoutFaults());
    assert.deepEqual(faults, [], faults.join('; '));
    const R = {}; for (const q of ['#sc0', '#sc1', '#foot', '#caps', '#feed', '#pn0', '#pn1']) R[q] = await page.evaluate((s) => window.__t.rect(s), q);
    assert.ok(R['#sc0'].right <= 960 && R['#sc1'].left >= 960, 'one card per side');
    assert.ok(R['#sc0'].left >= 20 && 1920 - R['#sc1'].right >= 20, 'margin to the edge');
    assert.ok(R['#foot'].top - R['#sc0'].bottom >= 16 && R['#foot'].top - R['#sc1'].bottom >= 16, 'gap to the footer');
    assert.ok(R['#caps'].left - R['#sc0'].right >= 8 && R['#sc1'].left - R['#caps'].right >= 8, 'gap to the captions');
    assert.ok(R['#sc0'].w >= 420 && R['#sc1'].w >= 420, 'bigger than the old 372 px');
    assert.ok(R['#sc0'].top > R['#feed'].bottom, 'feed above the left card');
    assert.ok(R['#sc1'].top > R['#pn1'].bottom, 'right card below the player cards');
    for (const kind of ['two', 'cmp']) {
      await page.evaluate((k) => window.__t.split(k), kind);
      const sf = await page.evaluate(() => window.__t.layoutFaults());
      assert.deepEqual(sf, [], `${kind} split: ${sf.join('; ')}`);
      const sp = await page.evaluate(() => window.__t.rect('#split'));
      assert.ok(sp.bottom + 8 <= R['#sc0'].top, `${kind} split (bottom ${sp.bottom}) lies above the left card (top ${R['#sc0'].top})`);
    }
    console.log('cards', JSON.stringify({ sc0: [R['#sc0'].left, R['#sc0'].top, R['#sc0'].w, R['#sc0'].h], sc1: [R['#sc1'].left, R['#sc1'].top, R['#sc1'].w, R['#sc1'].h], feed: [R['#feed'].top, R['#feed'].bottom], pn1bottom: R['#pn1'].bottom }));
  } finally { await browser.close(); srv.close(); }
});
