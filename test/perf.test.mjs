// Low-power viewer (render/perf.mjs): frame cap, adaptive pixel ratio, hidden-tab filter, quality toggle, GPU timer, and the wiring in app.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  shouldDraw, nextDraw, targetFps, dprSteps, startIndex, frameCost, AdaptiveDpr, ViewerPerf, dropStale, GpuTimer,
  ownerColorCache, nextMode, loadQuality, saveQuality, QUALITY_KEY, readout, FPS_BUSY, FPS_IDLE, IDLE_MS, STALE_MS,
} from '../render/perf.mjs';

// ticks of a display with `hz` for `sec` seconds, run through the cap; returns the tick indexes that draw
function drawsAt(hz, fps, sec = 2) {
  const iv = 1000 / hz, out = [];
  let last = 0;
  for (let i = 1; i <= hz * sec; i++) {
    const now = i * iv;
    if (shouldDraw(now, last, fps)) { last = nextDraw(now, last, fps); out.push(i); }
  }
  return out;
}

test('shouldDraw: 120 Hz ticks give 60 draws per second, one every second tick', () => {
  const d = drawsAt(120, 60);
  assert.equal(d.length, 120);
  for (let i = 1; i < d.length; i++) assert.equal(d[i] - d[i - 1], 2);
});
test('shouldDraw: a 60 Hz display with the 60 fps cap draws every tick', () => {
  assert.equal(drawsAt(60, 60).length, 120);
});
test('shouldDraw: the 30 fps cap at 120 Hz draws every 4th tick, at 60 Hz every 2nd', () => {
  const d = drawsAt(120, 30);
  assert.equal(d.length, 60);
  for (let i = 1; i < d.length; i++) assert.equal(d[i] - d[i - 1], 4);
  const e = drawsAt(60, 30);
  assert.equal(e.length, 60);
  for (let i = 1; i < e.length; i++) assert.equal(e[i] - e[i - 1], 2);
});
test('shouldDraw: odd refresh rates (75, 144 Hz) still average the target rate', () => {
  for (const hz of [75, 144, 100]) {
    const n = drawsAt(hz, 60, 4).length;
    assert.ok(n >= 4 * 60 - 2 && n <= 4 * 60 + 2, `${hz} Hz gave ${n} draws in 4 s`);
  }
});
test('shouldDraw: jittery ticks (+-1.5 ms) do not drop below the target', () => {
  let last = 0, n = 0, seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 1; i <= 240; i++) {
    const now = i * (1000 / 120) + (rnd() - 0.5) * 3;
    if (shouldDraw(now, last, 60)) { last = nextDraw(now, last, 60); n++; }
  }
  assert.ok(n >= 118 && n <= 121, 'draws ' + n);
});
test('nextDraw: after a long stall the schedule restarts at now (no catch-up burst)', () => {
  const t = nextDraw(5000, 0, 60);
  assert.equal(t, 5000);
  assert.ok(!shouldDraw(5000 + 8, t, 60), 'the next tick 8 ms later is skipped');
});
test('targetFps: 60 while playing; 30 when paused, over, or idle; 60 again while the viewer moves the camera', () => {
  assert.equal(targetFps({}), FPS_BUSY);
  assert.equal(targetFps({ paused: true }), FPS_IDLE);
  assert.equal(targetFps({ over: true }), FPS_IDLE);
  assert.equal(targetFps({ idleMs: IDLE_MS }), FPS_BUSY, 'exactly 2 s is not yet idle');
  assert.equal(targetFps({ idleMs: IDLE_MS + 1 }), FPS_IDLE);
  assert.equal(targetFps({ paused: true, active: true }), FPS_BUSY);
});

test('dprSteps: 1.25 / 1.5 / 1.75 / 2 up to the device pixel ratio', () => {
  assert.deepEqual(dprSteps(2), [1.25, 1.5, 1.75, 2]);
  assert.deepEqual(dprSteps(3), [1.25, 1.5, 1.75, 2], 'never above 2');
  assert.deepEqual(dprSteps(1), [1]);
  assert.deepEqual(dprSteps(1.5), [1.25, 1.5]);
  assert.deepEqual(dprSteps(1.6), [1.25, 1.5, 1.6]);
  assert.deepEqual(dprSteps(undefined), [1]);
  assert.equal(dprSteps(2)[startIndex(dprSteps(2))], 1.5, 'starts at 1.5');
  assert.equal(dprSteps(1)[startIndex(dprSteps(1))], 1);
});
test('frameCost: the work time, or the whole interval when a vsync was missed', () => {
  assert.equal(frameCost(6, 16.7, 60), 6);
  assert.equal(frameCost(6, 25, 60), 25, 'a 3rd tick at 120 Hz');
  assert.equal(frameCost(6, 33.4, 30), 6, 'normal at the 30 fps cap');
  assert.equal(frameCost(20, 16.7, 60), 20);
  assert.equal(frameCost(6, 20.84, 60), 6, 'a 144 Hz display draws every 2nd or 3rd tick for 60 fps: 20.8 ms is not late');
});

// feeds a constant cost at 60 samples/s; returns [{t, dpr}] of every step
function feed(ctl, from, to, cost) {
  const steps = [];
  for (let t = from; t < to; t += 1000 / 60) { const r = ctl.push(t, cost); if (r !== null) steps.push({ t, dpr: r }); }
  return steps;
}
test('AdaptiveDpr: steps down after 2 s above 0.85 x budget, and keeps 3 s between steps', () => {
  const ctl = new AdaptiveDpr({ steps: [1.25, 1.5, 1.75, 2], index: 3, warmupMs: 0 });
  const s = feed(ctl, 0, 12000, 16); // 16 ms > 0.85 x 16.67 = 14.2
  assert.deepEqual(s.map((x) => x.dpr), [1.75, 1.5, 1.25]);
  assert.ok(s[0].t >= 2000 && s[0].t < 2200, 'first step after about 2 s: ' + s[0].t);
  for (let i = 1; i < s.length; i++) assert.ok(s[i].t - s[i - 1].t >= 3000, 'gap ' + (s[i].t - s[i - 1].t));
  assert.equal(ctl.dpr, 1.25);
});
test('AdaptiveDpr: never leaves 1.25..2', () => {
  const ctl = new AdaptiveDpr({ steps: [1.25, 1.5, 1.75, 2], index: 1, warmupMs: 0 });
  feed(ctl, 0, 60000, 40);
  assert.equal(ctl.dpr, 1.25);
  feed(ctl, 60000, 200000, 2);
  assert.equal(ctl.dpr, 2);
  feed(ctl, 200000, 260000, 2);
  assert.equal(ctl.dpr, 2);
});
test('AdaptiveDpr: steps up only after 10 s below 0.5 x budget', () => {
  const ctl = new AdaptiveDpr({ steps: [1.25, 1.5, 1.75, 2], index: 1, warmupMs: 0 });
  assert.deepEqual(feed(ctl, 0, 9500, 6), [], 'nothing before 10 s');
  const s = feed(ctl, 9500, 14000, 6);
  assert.equal(s.length, 1);
  assert.equal(s[0].dpr, 1.75);
  assert.ok(s[0].t >= 10000);
});
test('AdaptiveDpr: a cost in between (0.5 .. 0.85 x budget) holds the step', () => {
  const ctl = new AdaptiveDpr({ steps: [1.25, 1.5, 1.75, 2], index: 1, warmupMs: 0 });
  assert.deepEqual(feed(ctl, 0, 60000, 11), []);
  assert.equal(ctl.dpr, 1.5);
});
test('AdaptiveDpr: a short spike does not step; the first seconds (warm-up) are ignored', () => {
  const ctl = new AdaptiveDpr({ steps: [1.25, 1.5, 1.75, 2], index: 1 });
  assert.deepEqual(feed(ctl, 0, 3000, 50), [], 'warm-up: shader compile and world build');
  let t = 3000;
  for (let i = 0; i < 60; i++, t += 16.7) ctl.push(t, 6);
  for (let i = 0; i < 40; i++, t += 16.7) assert.equal(ctl.push(t, 50), null); // 0.67 s of 50 ms frames
  for (let i = 0; i < 600; i++, t += 16.7) assert.equal(ctl.push(t, 6), null);
  assert.equal(ctl.dpr, 1.5);
});
test('AdaptiveDpr: reset() after a step ignores the resize hitch', () => {
  const ctl = new AdaptiveDpr({ steps: [1.25, 1.5, 1.75, 2], index: 3, warmupMs: 0 });
  const s = feed(ctl, 0, 2300, 16);
  assert.equal(s.length, 1);
  assert.equal(ctl.ema, null, 'average cleared');
  assert.equal(ctl.push(s[0].t + 100, 400), null, 'the hitch frame inside the settle time is ignored');
  assert.equal(ctl.ema, null);
});

test('ViewerPerf: Auto starts at 1.5, High is the device ratio (max 2) and never adapts; ?quality-free defaults', () => {
  const a = new ViewerPerf({ mode: 'auto', deviceDpr: 2 });
  assert.equal(a.dpr, 1.5); assert.ok(a.lowpower);
  const h = new ViewerPerf({ mode: 'high', deviceDpr: 3 });
  assert.equal(h.dpr, 2); assert.ok(!h.lowpower);
  for (let t = 0; t < 30000; t += 16.7) assert.equal(h.frame(t, 40, 16.7, 60), null);
  assert.equal(h.dpr, 2);
  assert.equal(h.setMode('auto'), 1.5);
  assert.equal(h.setMode('nonsense'), 1.5, 'unknown mode falls back to auto');
  assert.equal(new ViewerPerf({ deviceDpr: 1 }).dpr, 1, 'a 1x display stays at 1');
});
test('ViewerPerf: Auto steps down under load, treats a stall (hidden tab) as no signal', () => {
  const p = new ViewerPerf({ mode: 'auto', deviceDpr: 2 });
  let got = null, t = 0;
  for (; t < 9000 && got === null; t += 16.7) got = p.frame(t, 5, 33.4, 60); // every second tick missed: late frames
  assert.equal(got, 1.25);
  const q = new ViewerPerf({ mode: 'auto', deviceDpr: 2 });
  for (t = 0; t < 20000; t += 1000) assert.equal(q.frame(t, 5, 1000, 60), null, 'one frame per second with a 1 s interval is a stall, not a load');
  assert.equal(q.dpr, 1.5);
});

test('dropStale: queued entries older than 2 s that were never drawn are dropped, the rest stay', () => {
  const now = 100000;
  const deaths = [{ qAt: now - 5000, t0: null }, { qAt: now - 5000, t0: 3 }, { qAt: now - 1500, t0: null }, { qAt: 0, t0: null }, { qAt: now - STALE_MS - 1, t0: null }];
  assert.equal(dropStale(deaths, now, undefined, (e) => e.t0 === null), 2);
  assert.deepEqual(deaths.map((e) => [e.qAt, e.t0]), [[now - 5000, 3], [now - 1500, null], [0, null]]);
  const javs = new Map([['a', { qAt: now - 9000, h: null }], ['b', { qAt: now - 9000, h: {} }], ['c', { qAt: now - 100, h: null }]]);
  assert.equal(dropStale(javs, now, STALE_MS, (e) => e.h === null), 1);
  assert.deepEqual([...javs.keys()], ['b', 'c']);
  assert.equal(dropStale(null, now), 0);
});
test('dropStale: qAt 0 (the broadcast) is never dropped, and exactly 2 s is not yet stale', () => {
  const a = [{ qAt: 0 }, { qAt: 98000 }];
  assert.equal(dropStale(a, 100000), 0);
  assert.equal(a.length, 2);
});

test('quality mode: switch order, storage round trip, blocked storage', () => {
  assert.equal(nextMode('auto'), 'high'); assert.equal(nextMode('high'), 'auto');
  const mem = new Map(); const st = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  assert.equal(loadQuality(st), null);
  saveQuality(st, { mode: 'high', fps: true });
  assert.ok(mem.has(QUALITY_KEY));
  assert.deepEqual(loadQuality(st), { mode: 'high', fps: true });
  mem.set(QUALITY_KEY, '{"mode":"ultra"}'); assert.equal(loadQuality(st), null, 'unknown mode ignored');
  mem.set(QUALITY_KEY, 'not json'); assert.equal(loadQuality(st), null);
  const bad = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(loadQuality(bad), null); assert.doesNotThrow(() => saveQuality(bad, { mode: 'auto' }));
  assert.equal(loadQuality(null), null);
});
test('readout: fps, pixel ratio and mode', () => {
  assert.equal(readout(59.6, 1.5, 'auto'), '60 fps · 1.5x auto');
  assert.equal(readout(30, 2, 'high'), '30 fps · 2x high');
});

test('GpuTimer: no extension means ms stays 0; a result is read when ready; a disjoint result is dropped; an error switches it off', () => {
  assert.equal(new GpuTimer({ getExtension: () => null }).ok, false);
  assert.equal(new GpuTimer(null).ok, false);
  const t0 = new GpuTimer({ getExtension: () => null }); t0.begin(); t0.end(); assert.equal(t0.poll(), 0);
  let ready = false, disjoint = false; const calls = [];
  const gl = {
    QUERY_RESULT_AVAILABLE: 1, QUERY_RESULT: 2,
    getExtension: () => ({ TIME_ELAPSED_EXT: 10, GPU_DISJOINT_EXT: 11 }),
    createQuery: () => ({}), beginQuery: () => calls.push('b'), endQuery: () => calls.push('e'), deleteQuery: () => calls.push('d'),
    getParameter: () => disjoint, getQueryParameter: (q, p) => (p === 1 ? ready : 4e6),
  };
  const g = new GpuTimer(gl);
  assert.ok(g.ok);
  g.begin(); g.end(); assert.equal(g.poll(), 0, 'not ready yet');
  g.begin(); assert.deepEqual(calls, ['b', 'e'], 'only one query in flight');
  ready = true; assert.equal(g.poll(), 4, '4 ms');
  disjoint = true; g.begin(); g.end(); ready = false; g.poll(); assert.equal(g.ms, 4, 'a disjoint result is dropped'); assert.equal(g.pending, null);
  gl.beginQuery = () => { throw new Error('lost'); }; g.begin(); assert.equal(g.ok, false);
});

// ---- wiring: the viewer path only; the broadcast renderer is untouched ----
const app = fs.readFileSync(new URL('../render/app.mjs', import.meta.url), 'utf8');
test('app.mjs: the low-power viewer is off for the broadcast and for ?capture', () => {
  assert.match(app, /const PERF_ON = !BC && !params\.has\('capture'\);/);
  assert.match(app, /const perf = PERF_ON \? new ViewerPerf\(/);
  assert.match(app, /antialias: !PERF_ON \|\| params\.get\('quality'\) === 'off'/, 'canvas MSAA stays on for the broadcast and capture');
  assert.match(app, /renderer\.setPixelRatio\(perf \? perf\.dpr : Math\.min\(window\.devicePixelRatio \|\| 1, params\.has\('capture'\) \? 1 : 2\)\);/, 'the old ratio stays for the other paths');
  assert.match(app, /const qStamp = \(\) => BC \? 0 : performance\.now\(\);/, 'no wall clock in the frame-exact path');
  assert.match(app, /const pcol = \(owner\) => BC \? tmpC\.set\(/, 'the broadcast keeps the colour parse');
});
test('app.mjs: the frame cap sits before lastT and only runs with perf; the broadcast render hook has no perf code', () => {
  const f = app.indexOf('function frame(now)'), l = app.indexOf('lastT = now;', f);
  const cap = app.indexOf('shouldDraw(now, lastDraw, tgtFps)', f);
  assert.ok(f > 0 && cap > f && cap < l, 'a skipped tick returns before lastT = now, so dt builds up');
  assert.match(app, /dt = Math\.min\(0\.1, interval \/ 1000\);/, 'the 0.1 dt clamp stays');
  const bc = app.slice(app.indexOf('window.__bcHooks = {'), app.indexOf('// ---------------- network'));
  assert.ok(!/perf|gpuT|shouldDraw|dropStale/.test(bc.replace(/\bperformance\b/g, '')), 'no viewer code in __bcHooks');
});
test('app.mjs: the queued deaths and javelins carry a stamp, the visible tab drops the old unplayed ones', () => {
  assert.match(app, /deaths\.push\(\{ qAt: qStamp\(\)/);
  assert.match(app, /javs\.set\(key, \{ qAt: qStamp\(\)/);
  assert.match(app, /dropStale\(deaths, n, undefined, \(e\) => e\.t0 === null\)/);
  assert.match(app, /dropStale\(javs, n, undefined, \(e\) => e\.h === null\)/);
  assert.match(app, /if \(perf\) document\.addEventListener\('visibilitychange'/);
});
test('index.html and style.css: #perf next to #sound, body.lowpower drops the blur', () => {
  const html = fs.readFileSync(new URL('../render/index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('<div id="sound"></div>') > 0 && html.indexOf('<div id="perf"></div>') > html.indexOf('<div id="sound"></div>'));
  const css = fs.readFileSync(new URL('../render/style.css', import.meta.url), 'utf8');
  assert.match(css, /body\.lowpower \.panel[^{]*\{ backdrop-filter: none;/);
  assert.match(css, /body\.lowpower \{ --panel: rgba\(10, 14, 20, 0\.9\); \}/);
});

test('ownerColorCache: owner 0 (the God mode wolves, players[-1]) has a colour; one object per owner', () => {
  const players = [{ color: '#111111' }, { color: '#222222' }];
  players[-1] = { color: '#9aa0a8' }; // as buildWorld sets it
  let made = 0;
  const col = ownerColorCache(players, (c) => { made++; return { c }; });
  assert.equal(col(0).c, '#9aa0a8');
  assert.equal(col(1).c, '#111111');
  assert.equal(col(2).c, '#222222');
  assert.equal(col(0), col(0), 'cached');
  assert.equal(made, 3);
  assert.equal(players.map((p) => p.color)[-1], undefined, 'the .map() copy the old cache used drops players[-1]');
});
test('app.mjs: pcol in the viewer uses the per-owner cache, and keys are cleared on blur', () => {
  assert.match(app, /ownerColorCache\(G\.players, \(c\) => new THREE\.Color\(c\)\)\)\)\(owner\)/);
  assert.doesNotMatch(app, /G\.players\.map\(\(p\) => new THREE\.Color/);
  assert.match(app, /addEventListener\('blur', \(\) => keys\.clear\(\)\)/);
});
