// Match 5: the story cut tells what the two models are before they play (measured numbers), can pull back to the whole map, and carries the flags of the recipe makers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { World, validateShow, METRICS } from '../tools/show-tags.mjs';
import { tagParts } from '../tools/story-show.mjs';
import { creatorOf, enrichEvents, missingFlags } from '../tools/lib/replay.mjs';
import { Cinema, fitWholeMap } from '../render/cinema.mjs';
import { spreadLabels } from '../render/layout-faults.mjs';
import { shownMarkers } from '../render/markers.mjs';
import { groupOutline, mainGroup } from '../render/mark-hull.mjs';
import { chunkArgs, CHUNK_VALUES, CHUNK_FLAGS, PARENT_ONLY } from '../tools/lib/chunk-args.mjs';
import { endScreen } from '../tools/commentary.mjs';
import { decisionCost } from '../tools/events.mjs';
import { withoutFinalWipe } from '../tools/caster-story.mjs';
import { fightRanges, rangesWith } from '../tools/story.mjs';

const bench = { players: [{ p: 1, peak_gib: 28.94, decode_tok_s: 159.6, words_500_s: 4.7, knowledge: 54.5, code: 55 }, { p: 2, peak_gib: 206.35, decode_tok_s: 75.5, words_500_s: 9.3, knowledge: 67.5, code: 60 }] };
const evOf = (b) => ({ events: [], players: [{ id: 1 }, { id: 2 }], ticks: 1000, ...(b ? { bench: b } : {}) });
const worldOf = (b) => new World(evOf(b));

test('measured bars show the numbers of bench.json and need that file', () => {
  for (const m of ['speed', 'memory', 'knowledge', 'code']) assert.ok(METRICS.includes(m));
  const v = worldOf(bench).versus('speed', 10, ['Qwen', 'DeepSeek']);
  assert.deepEqual(v.rows.map((r) => r.val), [159.6, 75.5]);
  assert.equal(v.rows[1].label, '75.5');
  assert.equal(worldOf(null).versus('memory', 10, ['a', 'b']), null);
  assert.equal(validateShow({ versus: { metric: 'knowledge' } }, worldOf(null), 10).tags.length, 0);
  assert.equal(validateShow({ versus: { metric: 'knowledge' } }, worldOf(bench), 10).tags.length, 1);
});

test('the map tag pulls back to both bases, under fog only the own side gets rings', () => {
  const w = worldOf(bench);
  assert.deepEqual(validateShow({ map: {} }, w, 10).tags[0], { map: {} });
  assert.deepEqual(validateShow({ map: {}, fog: { player: 2 } }, w, 10).tags[0], { fog: { player: 2 }, map: {} });
  const c = { starts: [{ x: 20, z: 20 }, { x: 70, z: 70 }], names: ['Qwen', 'DeepSeek'], world: w };
  const [open] = tagParts({ map: {} }, c, 10), [fog] = tagParts({ map: {}, fog: { player: 2 } }, c, 10);
  assert.equal(open.cam.k, 'map');
  assert.ok(open.clean);
  assert.deepEqual([...new Set(open.marks.map((m) => m.o))], [1, 2]);
  assert.equal(fog.fog, 2);
  assert.deepEqual([...new Set(fog.marks.map((m) => m.o))], [2]);
  assert.match(fog.tag.text, /FOG OF WAR/);
});

test('recipe makers come from the start line, else from players.json next to the log', () => {
  assert.equal(creatorOf({ players: [{ creator: 'a' }] }, [{ creator: 'b' }], 0), 'a');
  assert.equal(creatorOf({ players: [{}] }, [{ creator: 'b' }], 0), 'b');
  assert.equal(creatorOf({ players: [{}], creators: ['c'] }, null, 0), 'c');
  assert.equal(creatorOf({ players: [{}] }, null, 0), null);
  const ev = evOf(null), rep = { players: [{ creator: 'bob' }, { creator: null }], bench };
  enrichEvents(rep, ev, { bob: { name: 'Robin' } });
  assert.equal(ev.players[0].creator, 'Robin');
  assert.equal(ev.players[1].creator, undefined);
  assert.equal(ev.bench, bench);
});

test('the resolved rules ride in the events only on a day with its own win rule (preset war)', () => {
  const war = { preset: 'war', noScoreWin: true, towerCaps: [2, 2, 2], warAtS: 600, warTopUp: 5000, popMax: 300 };
  assert.equal(enrichEvents({ players: [], start: { rules: war } }, evOf(null)).rules, war);
  assert.equal(enrichEvents({ players: [], start: { rules: { preset: 'fast' } } }, evOf(null)).rules, undefined);
  assert.equal(enrichEvents({ players: [] }, evOf(null)).rules, undefined);
});

test('renderCut fails loudly when a model has no recipe maker', () => {
  const src = fs.readFileSync(new URL('../tools/render-broadcast.mjs', import.meta.url), 'utf8');
  assert.match(src, /NO RECIPE MAKER FLAG/);
  assert.match(src, /process\.exitCode = 3/);
});

test('a decision costs everything it took, also the answer without orders before it', () => {
  assert.deepEqual(decisionCost({ latency_ms: 26475, completion_tokens: 3466, retry: { first: { latency_ms: 66188, completion_tokens: 9009 } } }), { latency_ms: 92663, completion_tokens: 12475, asked_again: true });
  assert.deepEqual(decisionCost({ latency_ms: 1000, completion_tokens: 10 }), { latency_ms: 1000, completion_tokens: 10, asked_again: false });
  assert.equal(decisionCost({}).latency_ms, null);
});

test('the last second is no swing: an army that disappears with its side was not beaten', () => {
  assert.deepEqual(withoutFinalWipe([3370, 3230, 3230, 0]), [3370, 3230, 3230]);
  assert.deepEqual(withoutFinalWipe([100, 50, 0, 0]), [100, 50, 0, 0]);
  assert.deepEqual(withoutFinalWipe([100, 50]), [100, 50]);
});

test('a small fight that flips the army lead is not fast-forwarded, a short fast-forward stays slow', () => {
  const S = { fight_speed: 3, after_speed: 3, short_gap_ticks: 200, ladder: [1, 3, 8], cap: 8, bin_ticks: 50 };
  const battle = { type: 'battle', t: 4986, t_end: 5099, kills: 7, value: 495 };
  assert.equal(fightRanges({ events: [battle] }, [], S, [0, 10000], []).length, 0);
  assert.deepEqual(fightRanges({ events: [battle, { type: 'momentum_swing', t: 5100 }] }, [], S, [0, 10000], []).map((r) => r.speed), [3]);
  const rs = rangesWith([{ a: 0, b: 100, speed: 3, kind: 'fight' }, { a: 250, b: 300, speed: 3, kind: 'fight' }], [0, 300], { events: [] }, {}, 600, S);
  assert.deepEqual(rs.map((r) => r.speed), [3, 3, 3]);
});

test('the whole map view really holds all four corners of the map', () => {
  const size = 96, fov = 26, aspect = 1080 / 1030, elev = 58;
  for (const az of [-Math.PI / 4, Math.PI / 4, 0.3]) {
    const v = fitWholeMap({ size, az, elev, fov, aspect });
    assert.ok(v, 'a view exists');
    const pol = ((90 - elev) * Math.PI) / 180, cam = [v.x + v.dist * Math.sin(pol) * Math.sin(az), v.dist * Math.cos(pol), v.z + v.dist * Math.sin(pol) * Math.cos(az)];
    const f = [v.x - cam[0], -cam[1], v.z - cam[2]].map((n) => n / v.dist);
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const r0 = cross(f, [0, 1, 0]), len = Math.hypot(...r0), r = r0.map((n) => n / len), u = cross(r, f), th = Math.tan((fov * Math.PI) / 360);
    for (const [x, z] of [[0, 0], [size, 0], [0, size], [size, size]]) {
      const q = [x - cam[0], -cam[1], z - cam[2]], d = dot(q, f), sx = dot(q, r) / d / (th * aspect), sy = dot(q, u) / d / th;
      assert.ok(Math.abs(sx) <= 1 && Math.abs(sy) <= 1, `corner ${x},${z} at ${sx.toFixed(2)},${sy.toFixed(2)}`);
      assert.ok(sy >= -0.76, 'the near corner stays above the caption');
    }
  }
});

test('only the whole map may look steeper than the normal limit, and the camera holds it', () => {
  const pol_min = (55 * Math.PI) / 180, make = () => new Cinema({ size: 96, aspect: 1.05, fov: 26, lineAz: -Math.PI / 4, opts: { pol_min } });
  const v = fitWholeMap({ size: 96, az: -Math.PI / 4, elev: 58, fov: 26, aspect: 1.05 });
  const rig = make();
  let c; for (let t = 0; t < 30; t += 1 / 30) c = rig.update(1 / 30, { kind: 'overview', key: 'm', x: v.x, z: v.z, elev: 58, dist: v.dist, norise: true }, t);
  assert.ok(Math.abs(c.pol - (32 * Math.PI) / 180) < 0.01, `steep view, pol ${c.pol}`);
  assert.ok(Math.abs(c.dist - v.dist) < 1, `distance ${c.dist} of ${v.dist}`);
  const rig2 = make();
  for (let t = 0; t < 10; t += 1 / 30) c = rig2.update(1 / 30, { kind: 'follow', key: 'f', x: 40, z: 40, elev: 58, dist: 40, track: true }, t);
  assert.ok(c.pol >= pol_min - 0.001, 'a normal shot keeps its limit');
});

test('the flag id survives the event list, and a missing flag is found', () => {
  const rep = { players: [{ kind: 'llm', creator: 'amberlabs' }, { kind: 'llm', creator: 'robin' }] };
  const ev = enrichEvents(rep, { players: rep.players }, { robin: { name: 'Robin' } });
  assert.equal(ev.players[1].creator, 'Robin');
  assert.equal(rep.players[1].creator, 'robin');
  assert.deepEqual(missingFlags(rep.players, { players: [{ creator: 'amberlabs' }, { creator: 'robin' }] }), []);
  assert.equal(missingFlags(rep.players, { players: [{ creator: 'amberlabs' }, { creator: null }] }).length, 1);
});

test('labels on the map never lie on each other', () => {
  const out = spreadLabels([{ x: 100, y: 100, w: 120, h: 40 }, { x: 110, y: 110, w: 90, h: 40 }, { x: 105, y: 95, w: 90, h: 40 }, { x: 500, y: 100, w: 90, h: 40 }]);
  for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) {
    const a = out[i], b = out[j];
    assert.ok(!(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h), `${i} and ${j}`);
  }
  assert.equal(out[3].y, 100);
});

test('every chunk of a parallel render gets the footer and the fixed script', () => {
  const a = chunkArgs({ footer: 'AI footer', 'no-fill': true, 'llm-output': 'x.json', voices: 'v.json', class: '32 GB vs MAC', workers: '4' });
  assert.deepEqual(a.slice(a.indexOf('--footer'), a.indexOf('--footer') + 2), ['--footer', 'AI footer']);
  assert.ok(a.includes('--no-fill'));
  assert.ok(!a.includes('--workers'));
  // a new option of render-story.mjs must say whether the chunks need it
  const src = fs.readFileSync(new URL('../tools/render-story.mjs', import.meta.url), 'utf8');
  const used = [...src.matchAll(/\bA(?:\.([a-z_]+)|\['([a-z-]+)'\])/g)].map((m) => m[1] || m[2]);
  const known = new Set([...CHUNK_VALUES, ...CHUNK_FLAGS, ...PARENT_ONLY]);
  assert.deepEqual([...new Set(used)].filter((k) => !known.has(k)), []);
});

test('the army at the end is the army that stood, not the sample after the last building fell', () => {
  const e = endScreen({ ticks: 6000, winner: 1, reason: 'victory', final: [{ p: 1 }, { p: 2 }], events: [], series: { army: [[100, 3575], [900, 3230, 0]] }, players: [{}, {}] }, [{ name: 'A' }, { name: 'B' }]);
  assert.deepEqual(e.rows.find((r) => r.key === 'army_final').raw, [3575, 3230]);
});

test('a fog view shows the whole map from above, with only what that player owns marked', () => {
  const src = fs.readFileSync(new URL('../tools/story-show.mjs', import.meta.url), 'utf8');
  const part = src.slice(src.indexOf("case 'fog':"), src.indexOf("case 'follow':"));
  assert.match(part, /k: 'map'/); assert.match(part, /fog: p/); assert.match(part, /clean: true/);
  assert.doesNotMatch(part, /look\(/);
});

test('under fog only the own markers show, on the whole map none', () => {
  const mk = [['a', 'attack', 1, 0, 0], ['b', 'task', 2, 5, 5]];
  assert.deepEqual(shownMarkers(mk, 1).map((m) => m[0]), ['a']);
  assert.deepEqual(shownMarkers(mk, 2).map((m) => m[0]), ['b']);
  assert.equal(shownMarkers(mk, 0).length, 2);
  assert.deepEqual(shownMarkers(mk, 0, true), []);
});

test('the outline of a split army goes around its main part only', () => {
  const big = Array.from({ length: 9 }, (_, i) => [100 + (i % 3) * 30, 100 + Math.floor(i / 3) * 30]);
  const small = Array.from({ length: 4 }, (_, i) => [700 + i * 30, 800]);
  assert.equal(mainGroup([...big, ...small]).length, 9);
  const h = groupOutline([...big, ...small]);
  assert.ok(Math.max(...h.map((p) => p[0])) < 300);
});

test('labels keep off the overlay boxes and stay in the picture', () => {
  const [a] = spreadLabels([{ x: 50, y: 100, w: 100, h: 40 }], 4, [{ x: 0, y: 90, w: 300, h: 60 }]);
  assert.equal(a.y, 46);
  const [b] = spreadLabels([{ x: 50, y: 20, w: 100, h: 40 }], 4, [{ x: 0, y: 10, w: 300, h: 60 }]);
  assert.equal(b.y, 74);
});

test('a fight keeps the picture on the bigger group, not on the empty ground between one stray unit and the army', () => {
  const src = fs.readFileSync(new URL('../tools/camera.mjs', import.meta.url), 'utf8');
  assert.match(src, /c\.weighted \? a\.n \/ \(\(a\.n \+ b\.n\) \|\| 1\) : 0\.5/);
  const show = fs.readFileSync(new URL('../tools/story-show.mjs', import.meta.url), 'utf8');
  const part = show.slice(show.indexOf("case 'battle':"), show.indexOf("case 'momentum_swing':"));
  assert.match(part, /weighted: true/);
  assert.doesNotMatch(part, /\[near\(1\), \{ t: 'army', o: 1 \}\]/);
});

test('a short part far away is a whip pan, the slow flight stays for long parts', () => {
  const src = fs.readFileSync(new URL('../tools/camera.mjs', import.meta.url), 'utf8');
  assert.match(src, /len < SHOW_WHIP\.len/);
  assert.match(src, /outT - sp\.o0 < this\.C\.whip_s/);
});

