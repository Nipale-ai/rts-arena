import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../render/vendor/three.module.js';
import { Scatter } from '../render/scatter.mjs';

// a pack with one model of one part, no GPU needed (InstancedMesh only holds arrays)
const pack = {
  lodCount: () => 1,
  load: async () => ({ box: new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 2, 1)), parts: [{ geo: new THREE.BoxGeometry(1, 1, 1), mat: new THREE.MeshBasicMaterial() }] }),
};
async function field(n = 40) {
  const sc = new Scatter(new THREE.Scene(), pack, 1, n, { maxLods: 1 });
  await sc.promise;
  for (let i = 0; i < n; i++) sc.set(i, (i % 8) * 3 - 12, 0.1 * i, Math.floor(i / 8) * 25 - 40, i * 0.37, 0.8 + (i % 5) * 0.1);
  return sc;
}
function cam(x = 0, z = 0) {
  const c = new THREE.PerspectiveCamera(60, 1.5, 0.1, 400);
  c.position.set(x, 8, z); c.lookAt(x, 0, z + 10); c.updateMatrixWorld();
  return c;
}
const drawnMats = (sc) => Array.from(sc.meshes[0][0].instanceMatrix.array.subarray(0, sc.counts[0] * 16));

test('Scatter.update: the copy loop gives the same matrices and colours as before (items in index order)', async () => {
  const sc = await field();
  sc.update(cam());
  const idx = [];
  const want = [];
  const c = cam(), f = new THREE.Frustum();
  f.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse));
  for (let i = 0; i < sc.n; i++) {
    const y = sc.pos[i * 3 + 1] + sc.boxR * 0.5 * sc.sy[i];
    if (f.intersectsSphere(new THREE.Sphere(new THREE.Vector3(sc.pos[i * 3], y, sc.pos[i * 3 + 2]), sc.boxR * sc.smax[i] + sc.pad))) { idx.push(i); want.push(...sc.mats.subarray(i * 16, i * 16 + 16)); }
  }
  assert.ok(idx.length > 3 && idx.length < sc.n, `some but not all visible (${idx.length})`);
  assert.equal(sc.counts[0], idx.length);
  assert.deepEqual(drawnMats(sc), want);
});

test('Scatter.update: default arguments never skip (broadcast path), throttle skips and catches up', async () => {
  const sc = await field();
  sc.update(cam());
  const n0 = sc.counts[0];
  for (let i = 0; i < sc.n; i += 2) sc.setAlive(i, false);
  sc.update(cam()); // no clock, no interval: runs at once
  assert.ok(sc.counts[0] < n0);

  const t = await field();
  t.update(cam(), 1000, 100); // first call always runs
  const m0 = t.counts[0];
  for (let i = 0; i < t.n; i += 2) t.setAlive(i, false);
  t.update(cam(), 1050, 100); // too early: nothing changes, dirty stays
  assert.equal(t.counts[0], m0);
  assert.equal(t.dirty, true);
  t.update(cam(), 1100, 100); // due
  assert.ok(t.counts[0] < m0);
  assert.equal(t.dirty, false);
  assert.equal(t.update(cam(), 1110, 100), undefined); // unmoved and clean: still a no-op
});
