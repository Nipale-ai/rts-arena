// Terrain: while the worn paths fade in or out, only the vertices that changed are recoloured (render/terrain.mjs recolorSome). The colour buffers must be exactly
// the bytes a full recolor leaves, because the broadcast render shares this path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTerrain } from '../render/terrain.mjs';

const SIZE = 28;
const rows = Array.from({ length: SIZE }, (_, y) => Array.from({ length: SIZE }, (_, x) => (x >= 23 ? '~' : x >= 10 && x < 14 && y < 9 ? 'f' : y >= 25 && x < 6 ? '#' : '.')).join(''));
const B = (id, name, tx, ty, size, owner = 1) => ({ id, name, tx, ty, size, owner });
// buildings come, stay, go: a town centre, houses and a farm (paths and soil), a camp, then the farm and a house are lost, then more come
const steps = [
  [],
  [B(1, 'town_center', 4, 4, 4)],
  [B(1, 'town_center', 4, 4, 4), B(2, 'house', 9, 5, 2), B(3, 'farm', 4, 11, 3), B(4, 'lumber_camp', 8, 12, 2)],
  [B(1, 'town_center', 4, 4, 4), B(2, 'house', 9, 5, 2), B(3, 'farm', 4, 11, 3), B(4, 'lumber_camp', 8, 12, 2)],
  [B(1, 'town_center', 4, 4, 4), B(2, 'house', 9, 5, 2), B(4, 'lumber_camp', 8, 12, 2), B(5, 'mill', 16, 14, 2), B(6, 'wall', 12, 20, 1)],
  [B(1, 'town_center', 4, 4, 4), B(4, 'lumber_camp', 8, 12, 2), B(5, 'mill', 16, 14, 2), B(7, 'farm', 17, 17, 3), B(8, 'house', 20, 3, 2, 2)],
];
const same = (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength)) === 0;

for (const ground of [null, { tex: {}, mean: {} }]) {
  test(`terrain: the dirty-region recolor leaves exactly the bytes of the full recolor (${ground ? 'with' : 'without'} ground splat layers)`, () => {
    const opts = { seed: 5, starts: [{ tx: 4, ty: 4 }], ground };
    const inc = buildTerrain(SIZE, rows, opts), full = buildTerrain(SIZE, rows, { ...opts, fullRecolor: true });
    const col = (t) => t.mesh.geometry.attributes.color.array, sp = (t, n) => t.mesh.geometry.attributes[n]?.array;
    const check = (what) => {
      assert.ok(same(col(inc), col(full)), `colour, ${what}`);
      if (ground) { assert.ok(same(sp(inc, 'aSplat'), sp(full, 'aSplat')), `splat A, ${what}`); assert.ok(same(sp(inc, 'aSplat2'), sp(full, 'aSplat2')), `splat B, ${what}`); }
    };
    check('at the start');
    let changedOnce = false;
    steps.forEach((list, n) => {
      // a snapshot per step, then a few more with the same buildings while the paths fade (about 1 s of snapshots)
      for (let rep = 0; rep < 30; rep++) {
        const before = Uint8Array.from(Buffer.from(col(inc).buffer.slice(0)));
        inc.syncBuildings(list); full.syncBuildings(list);
        check(`step ${n}, snapshot ${rep}`);
        if (!same(before, new Uint8Array(col(inc).buffer))) changedOnce = true;
      }
      // and the incremental buffer is what a from-scratch recolor of the same state gives
      const keep = Float32Array.from(col(inc)), keepSp = ground ? Float32Array.from(sp(inc, 'aSplat')) : null;
      inc.recolorAll();
      assert.ok(same(keep, col(inc)), `colour = full recolor of the same state, step ${n}`);
      if (ground) assert.ok(same(keepSp, sp(inc, 'aSplat')), `splat = full recolor of the same state, step ${n}`);
    });
    assert.ok(changedOnce, 'the fixture really changes colours (paths and soil)');
  });
}
test('terrain: a snapshot with no change and no fade running does not touch the colour buffer', () => {
  const t = buildTerrain(SIZE, rows, { seed: 5 });
  const list = [B(1, 'town_center', 4, 4, 4), B(2, 'house', 9, 5, 2)];
  for (let i = 0; i < 40; i++) t.syncBuildings(list); // the fade is over
  const a = Float32Array.from(t.mesh.geometry.attributes.color.array);
  t.syncBuildings(list);
  assert.ok(same(a, t.mesh.geometry.attributes.color.array));
});
