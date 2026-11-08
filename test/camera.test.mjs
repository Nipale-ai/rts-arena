import test from 'node:test';
import assert from 'node:assert/strict';
import { computeHighlights } from '../tools/highlights.mjs';
import { buildPlan, timelineOf } from '../tools/plan.mjs';
import { Director } from '../tools/camera.mjs';
import { Cinema } from '../render/cinema.mjs';

const events = [
  { t: 3000, type: 'first_contact', p: 1, other: 2, loc: [60, 60], what: 'worker', id: 1 },
  { t: 2500, type: 'key_building', p: 2, building: 'barracks', loc: [105, 99], id: 2 },
  { t: 5000, type: 'key_building', p: 1, building: 'barracks', loc: [20, 26], id: 3 },
  { t: 7200, type: 'tier_up', p: 1, tier: 2, id: 4 },
  { t: 9000, type: 'expansion', p: 2, loc: [80, 100], count: 2, id: 5 },
  { t: 17400, type: 'base_destroyed', p: 1, loc: [20, 20], by: 2, value: 550, id: 6 },
  { t: 18000, type: 'victory', winner: 2, winner_team: 2, reason: 'victory', id: 7 },
];
const secs = 1801, destroyed = new Array(secs).fill(0), fighting = [new Array(secs).fill(0), new Array(secs).fill(0)];
for (const [a, b] of [[700, 760], [1500, 1560]]) for (let s = a; s <= b; s++) { destroyed[s] = 300; fighting[0][s] = 12; fighting[1][s] = 9; }
for (const [a, b] of [[700, 760], [1500, 1560]]) events.push({ t: a * 10, type: 'battle', t_end: b * 10, loc: [50 + a / 40, 50], value: 5000, kills: 20, peak_value_per_s: 600, peak_tick: a * 10 + 50, participants: {} });
events.sort((x, y) => x.t - y.t);
const ev = { version: 1, replay: 'syn', ticks: 18000, tick_hz: 10, seconds: 1800, players: [{ id: 1, name: 'A', kind: 'llm' }, { id: 2, name: 'B', kind: 'bot' }], events,
  series: { army: [new Array(secs).fill(0), new Array(secs).fill(0)], lost: [[], []], fighting, destroyed, focus_x: new Array(secs).fill(null), focus_y: new Array(secs).fill(null), focus_spread: new Array(secs).fill(null) } };

// a fake snapshot with a marching army and a fight, so the tracking shots have something to follow
const snapAt = (out) => {
  const units = [];
  for (let i = 0; i < 12; i++) units.push([i + 1, 1 + (i % 2), 1 + (i % 4), 40 + out * 0.5 + (i % 4), 40 + (i >> 2), 100, i < 8 ? 4 : 1, 0, 0, 0]);
  units.push([99, 2, 5, 90, 90, 100, 1, 0, 0, 0]);
  return { units, buildings: [[500, 1, 5, 20, 26, 100, 40, 0]] };
};

function run(seconds = 100) {
  const plan = buildPlan(ev, computeHighlights(ev), { mode: 'highlight' });
  const tl = timelineOf(plan);
  const d = new Director({ size: 128, starts: [{ tx: 18, ty: 18 }, { tx: 106, ty: 106 }], aspect: 1.29, scenes: plan.scenes, timeline: tl, events: ev.events });
  const out = [];
  for (let f = 0; f < Math.min(seconds, tl.duration_s) * 60; f++) out.push({ out: f / 60, ...d.update(f / 60, 1 / 60, snapAt(f / 60)), key: d.cur.key });
  return { d, out };
}

test('camera: always low and side-on (never above 35 degrees), long lens', () => {
  const { out } = run();
  assert.ok(out.length > 1000);
  for (const c of out) {
    const elev = 90 - (c.pol * 180) / Math.PI;
    assert.ok(elev <= 35.01 && elev >= 3, `elevation ${elev} at ${c.out}`);
    assert.ok(c.fov <= 30);
  }
});

test('camera: no jumps inside a shot, shots change by eased flights, hard cuts are rare', () => {
  const { out } = run();
  let cuts = 0;
  for (let i = 1; i < out.length; i++) {
    const a = out[i - 1], b = out[i];
    const step = Math.hypot(b.tx - a.tx, b.tz - a.tz) + Math.abs(b.dist - a.dist) + Math.abs(b.az - a.az) * 30;
    if (b.key !== a.key) { if (step > 4) cuts++; continue; }
    assert.ok(step < 4, `jump of ${step.toFixed(2)} inside shot ${b.key} at ${b.out}`);
  }
  assert.ok(cuts <= 2, `hard cuts are rare (a very far jump or a big hit only), got ${cuts}`);
});

test('camera: shot variety, stays on one side of the broadcast line', () => {
  const { d, out } = run();
  const keys = new Set(out.map((c) => c.key.replace(/[0-9.]+$/, '')));
  assert.ok(keys.size >= 5, [...keys].join(' '));
  for (const c of out) {
    const w = (((c.az - d.L) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2), da = Math.min(w, Math.PI * 2 - w);
    assert.ok(da < (110 * Math.PI) / 180, `azimuth ${(da * 57.3).toFixed(0)} deg off the line at ${c.out}`);
  }
});

test('cinema: camera clears the ground on a ring (hills), look-at stays inside the map', () => {
  const hill = (x, z) => (x < 10 ? 12 : 0);
  const rig = new Cinema({ size: 128, heightAt: hill, opts: { pol_min: 0.96 } });
  const o = rig.safe({ tx: 40, ty: 1, tz: 40, dist: 40, az: -Math.PI / 2, pol: 1.3 }); // camera would sit at x = 0
  const px = o.tx + o.dist * Math.sin(o.pol) * Math.sin(o.az);
  assert.ok(o.ty + o.dist * Math.cos(o.pol) >= (px < 12 ? 12 : 0) + rig.C.min_clear - 1e-6);
  assert.ok(o.tx >= 3 && o.tx <= 125);
});

test('a shot on a group looks at its biggest part, not at the empty ground between two parts, and stays with the part it is on', () => {
  const unit = (id, x, z) => [id, 1, 0, x, z, 0, 0];
  const big = [[100, 100], [101, 102], [99, 101], [102, 99], [100, 103], [98, 99], [103, 101], [101, 98]], small = [[140, 140], [141, 142], [139, 141], [142, 139]];
  const snap = { units: [...big, ...small].map(([x, z], i) => unit(i + 1, x, z)) }, ids = snap.units.map((u) => u[0]);
  const at = Director.prototype.locate.call({}, snap, { ids });
  assert.ok(Math.hypot(at.x - 100.6, at.z - 100.4) < 3, `camera at ${at.x}, ${at.z}`);
  assert.equal(at.n, 12);
  const stays = Director.prototype.locate.call({}, snap, { ids }, { x: 138, z: 138 });
  assert.ok(Math.hypot(stays.x - 140.5, stays.z - 140.5) < 3, `camera at ${stays.x}, ${stays.z}`);
  const lone = Director.prototype.locate.call({}, { units: [unit(1, 50, 50)] }, { ids: [1] });
  assert.equal(lone.x, 50);
});
