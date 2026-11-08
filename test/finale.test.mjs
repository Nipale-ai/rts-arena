// Finale (render/finale.mjs): which buildings fall, when, in which order; deterministic, no Math.random; camera shots; Cinema 'finale' pose.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FIN, hash01, planFinale, finaleShot } from '../render/finale.mjs';
import { Cinema } from '../render/cinema.mjs';
import { Director } from '../tools/camera.mjs';

// a base of n buildings on a ring/grid around (cx, cz), owner o, ids from id0
const base = (owner, cx, cz, n, id0) => {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = i * 2.4, r = i === 0 ? 0 : 3 + (i % 7) * 1.6;
    out.push([id0 + i, { owner, tx: Math.round(cx + Math.cos(a) * r), ty: Math.round(cz + Math.sin(a) * r), size: i === 0 ? 4 : 2, name: i === 0 ? 'town_center' : 'house' }]);
  }
  return out;
};
const team = (o) => (o <= 2 ? o : o === 3 ? 1 : 2);
const over = (extra = {}) => ({ winnerTeam: 2, reason: 'victory', seconds: 900, ...extra });
const noRandom = (fn) => { const R = Math.random; Math.random = () => { throw new Error('Math.random in the finale plan'); }; try { return fn(); } finally { Math.random = R; } };

test('finale: every building of the loser falls, none of the winner; it runs 4 to 8 seconds', () => {
  const b = [...base(1, 30, 30, 20, 1), ...base(2, 100, 100, 15, 100)];
  const p = noRandom(() => planFinale({ buildings: b, over: over(), teamOf: team }));
  assert.equal(p.items.length, 20);
  assert.ok(p.items.every((it) => it.o.owner === 1));
  assert.deepEqual([...new Set(p.items.map((it) => it.id))].length, 20);
  for (let i = 1; i < p.items.length; i++) assert.ok(p.items[i].at >= p.items[i - 1].at);
  assert.ok(p.items[0].at >= FIN.lead && p.items[0].at < 2.5);
  assert.ok(p.end >= 4.2 && p.end <= 8.3, `end ${p.end}`);
});
test('finale: deterministic, delays come from the building id, the wave goes outward', () => {
  const b = base(1, 30, 30, 30, 1);
  const a = noRandom(() => planFinale({ buildings: b, over: over(), teamOf: team })), c = planFinale({ buildings: new Map(b), over: over(), teamOf: team });
  assert.deepEqual(a.items.map((i) => [i.id, i.at]), c.items.map((i) => [i.id, i.at]));
  const g = a.groups[0], d = (it) => Math.hypot(it.cx - g.cx, it.cz - g.cz), by = [...a.items].sort((x, y) => d(x) - d(y));
  const n = by.length, near = by.slice(0, 5).reduce((s, i) => s + i.at, 0) / 5, far = by.slice(n - 5).reduce((s, i) => s + i.at, 0) / 5;
  assert.ok(far > near + 1.5, `far ${far} near ${near}`);
  assert.ok(hash01(7) !== hash01(8) && hash01(7) === hash01(7) && hash01(123456) >= 0 && hash01(123456) < 1);
});
test('finale: a bigger base takes longer (up to the cap); a tiny one is short but not instant', () => {
  const small = planFinale({ buildings: base(1, 30, 30, 3, 1), over: over(), teamOf: team }), big = planFinale({ buildings: base(1, 30, 30, 80, 1), over: over(), teamOf: team });
  assert.ok(small.end < big.end && small.end >= 4.2 - 0.5 && big.end <= 8.3, `${small.end} ${big.end}`);
});
test('finale: no finale on a time-limit win, in god mode, or with nothing left', () => {
  const b = base(1, 30, 30, 5, 1);
  assert.equal(planFinale({ buildings: b, over: over({ reason: 'time limit (score)' }), teamOf: team }), null);
  assert.equal(planFinale({ buildings: b, over: over({ reason: 'cutoff' }), teamOf: team }), null);
  assert.equal(planFinale({ buildings: b, over: over({ godMode: true }), teamOf: team }), null);
  assert.equal(planFinale({ buildings: base(2, 30, 30, 5, 1), over: over(), teamOf: team }), null);
  assert.equal(planFinale({ buildings: [], over: over(), teamOf: team }), null);
  assert.equal(planFinale({ buildings: b, over: null, teamOf: team }), null);
  assert.ok(planFinale({ buildings: b, over: over({ reason: 'wonder' }), teamOf: team }));
});
test('finale: teams. Both losers of a team fall, a team mate base nearby is one shot; mutual destruction without a winner takes everything', () => {
  const b = [...base(1, 30, 30, 8, 1), ...base(3, 38, 34, 6, 50), ...base(2, 100, 100, 9, 100), ...base(4, 104, 96, 4, 200)];
  const p = planFinale({ buildings: b, over: over({ winnerTeam: 2 }), teamOf: team });
  assert.equal(p.items.length, 14);
  assert.equal(p.groups.length, 1);
  const all = planFinale({ buildings: b, over: over({ winnerTeam: 0, reason: 'mutual destruction' }), teamOf: team });
  assert.equal(all.items.length, 27);
  assert.equal(all.groups.length, 2);
});
test('finale: two far bases fall one after the other and the camera follows', () => {
  const b = [...base(1, 20, 20, 10, 1), ...base(3, 100, 100, 10, 50)];
  const p = planFinale({ buildings: b, over: over(), teamOf: team });
  assert.equal(p.groups.length, 2);
  assert.ok(p.groups[1].a > p.groups[0].a);
  const s0 = finaleShot(p, 0.2), s1 = finaleShot(p, p.end), s2 = finaleShot(p, p.end + 20);
  assert.equal(s0.kind, 'finale');
  assert.notEqual(s0.key, s1.key);
  assert.equal(s1.key, s2.key); // the last shot is held
  assert.ok(Math.hypot(s0.x - s1.x, s0.z - s1.z) > 50);
  assert.ok(s0.len >= 3 && s1.len >= 3);
});
test('cinema: the finale shot is a pure, smooth pose that frames the base and rises', () => {
  const mk = () => new Cinema({ size: 128, aspect: 16 / 9 });
  const shot = { kind: 'finale', key: 'a', x: 40, z: 40, r: 9, len: 7 }, a = mk(), b = mk();
  const pa = a.update(0.016, shot, 10), pb = b.update(0.016, shot, 10);
  assert.deepEqual(pa, pb);
  const t0 = a.pose(shot, 10), t1 = a.pose(shot, 17);
  assert.equal(t0.tx, 40); assert.equal(t0.tz, 40);
  assert.ok(t1.pol < t0.pol, 'the view rises (smaller polar angle = steeper view)');
  assert.ok(t0.dist >= 30 && t1.dist <= 100 && t1.dist > t0.dist);
  let last = a.update(0.016, shot, 10);
  for (let t = 10; t < 18; t += 1 / 60) { const q = a.update(1 / 60, shot, t); assert.ok(Math.abs(q.az - last.az) < 0.05 && Math.abs(q.dist - last.dist) < 3); last = q; }
});

test('director: from the victory on the broadcast camera frames the base of the loser and holds the last pose', () => {
  const tl = { outAt: (t) => t / 10, b: 1e9 };
  const mk = (reason) => new Director({ size: 128, starts: [{ tx: 18, ty: 18 }, { tx: 106, ty: 106 }], aspect: 1.78, scenes: [], timeline: tl, events: [{ t: 600, type: 'victory', winner: 2, winner_team: 2, reason, id: 1 }] });
  const b = [...base(1, 30, 30, 12, 1), ...base(2, 100, 100, 9, 100)].map(([id, o]) => [id, o.owner, 5, o.tx, o.ty, 100, 100, 0]);
  const snap = { units: [], buildings: b };
  const d = mk('victory');
  d.update(10, 1 / 60, snap);
  assert.notEqual(d.cur.key, 'finale'); // before the victory
  let c;
  for (let t = 60; t < 75; t += 1 / 60) c = d.update(t, 1 / 60, snap);
  assert.equal(d.cur.key, 'finale');
  assert.ok(Math.hypot(c.tx - 31, c.tz - 31) < 8, `looks at the loser base: ${c.tx.toFixed(1)} ${c.tz.toFixed(1)}`);
  const a = d.update(75, 1 / 60, snap), z = d.update(95, 1 / 60, snap);
  assert.ok(Math.abs(a.dist - z.dist) < 1 && Math.abs(a.az - z.az) < 0.02, 'held after the shot length');
  const t = mk('time limit (score)');
  for (let x = 60; x < 62; x += 1 / 60) t.update(x, 1 / 60, snap);
  assert.notEqual(t.cur.key, 'finale'); // a win on score has no finale
});
