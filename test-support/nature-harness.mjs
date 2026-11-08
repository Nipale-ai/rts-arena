// A small world for the tests of the nature slots (package C5b): the real Pack with the real MAP.json, a loader that makes boxes for the classic models and reads the
// synthetic glb files of a test theme from disk, and a digest of what the builders of render/forest.mjs and render/props3d.mjs put into their scatters.
// The builders are imported from a root, so the same harness can run on the ORIGINAL tree (the classic digests in test/nature-theme.test.mjs were taken that way) and on this one.
// Nothing here is random: boxes come from the model id, maps from hash noise.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const modUrl = (root, rel) => pathToFileURL(path.join(root, rel)).href;

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
const f32 = (a) => sha(Buffer.from(a.buffer, a.byteOffset, a.byteLength));

// a map of `size` x `size` tiles: forest patches, a lake, a few cliffs; nodes of every kind; two start areas
export function makeWorld(hash, vnoise, size = 64) {
  const rows = [];
  for (let y = 0; y < size; y++) {
    let r = '';
    for (let x = 0; x < size; x++) {
      let c = '.';
      if (vnoise(x / 8, y / 8, 41) > 0.56) c = 'f';
      if (vnoise(x / 10, y / 10, 77) < 0.17) c = '~';
      else if (vnoise(x / 6, y / 6, 13) > 0.8) c = '#';
      r += c;
    }
    rows.push(r);
  }
  const nodes = [[1, 'gold', 12, 12, 2, 800, 800], [2, 'stone', 18, 12, 2, 600, 600], [3, 'berries', 12, 18, 1, 200, 200], [4, 'herd', 20, 20, 1, 300, 300], [5, 'gold', 40, 40, 2, 800, 400], [6, 'stone', 44, 30, 2, 600, 100]];
  void hash;
  return { size, rows, nodes, starts: [{ tx: 6, ty: 6 }, { tx: size - 10, ty: size - 10 }] };
}

// box models for the classic ids (size from the id), real parse of Pack.load
function boxGltf(THREE, id) {
  const w = 0.4 + (id % 7) * 0.1, h = 0.8 + (id % 5) * 0.35;
  const geo = new THREE.BoxGeometry(w, h, w).translate(0, h / 2, 0);
  const mat = new THREE.MeshStandardMaterial({ color: 0x808080 }); mat.name = 'body';
  const g = new THREE.Group(); g.add(new THREE.Mesh(geo, mat));
  return { scene: g };
}

// The pack: the real class, the real tables, a fake loader. `files`: { url -> Buffer } for the files of a test theme (parsed by the real GLTFLoader); `log`: the urls asked for.
export async function makePack(root, { theme = null, files = {}, fail = [], log = [] } = {}) {
  const { Pack } = await import(modUrl(root, 'render/assets3d.mjs'));
  const THREE = await import(modUrl(root, 'render/vendor/three.module.js'));
  const { GLTFLoader } = await import(modUrl(root, 'render/vendor/jsm/loaders/GLTFLoader.js'));
  const { classicTheme } = await import(modUrl(root, 'render/theme/theme-loader.mjs'));
  const pack = new Pack();
  const dir = path.join(root, 'render/assets/models');
  pack.map = JSON.parse(fs.readFileSync(path.join(dir, 'MAP.json'), 'utf8'));
  pack.lods = JSON.parse(fs.readFileSync(path.join(dir, 'LODS.json'), 'utf8'));
  pack.theme = theme || classicTheme();
  const real = new GLTFLoader();
  pack.loader = {
    loadAsync: async (url) => {
      log.push(url);
      if (fail.some((f) => url.includes(f))) throw new Error(`HTTP 404 ${url}`);
      const m = /assets\/models\/(\d+)(?:_lod(\d))?\.glb$/.exec(url);
      if (m) return boxGltf(THREE, +m[1]);
      const buf = files[url] || (url.startsWith('file:') ? fs.readFileSync(fileURLToPath(url)) : null);
      if (!buf) throw new Error(`no such file ${url}`);
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      return new Promise((res, rej) => real.parse(ab, '', res, rej));
    },
  };
  return { pack, THREE };
}

// what a scatter holds, as a short string: id, count, the matrices and colours (a digest), which items are alive
export function scatterDigest(s) {
  let alive = 0; for (let i = 0; i < s.n; i++) alive += s.alive[i];
  return `${s.id}:${s.n}:${alive}:${f32(s.mats)}:${f32(s.col)}`;
}
export const digestOf = (scatters) => sha(scatters.map(scatterDigest).sort().join('|'));
export const placedDigest = (placed) => sha(JSON.stringify(placed.map((p) => p.map((v) => +v.toFixed(6)))));

// the draw list of a scene: every InstancedMesh with its group, draw order, shadow flag, count, geometry size and a digest of the matrices and colours that are drawn
export function drawDigest(scene) {
  const rows = [];
  scene.traverse((o) => {
    if (!o.isInstancedMesh) return;
    const n = o.count, m = o.instanceMatrix.array, c = o.instanceColor ? o.instanceColor.array : null;
    rows.push([o.parent?.name || '', o.renderOrder, o.castShadow ? 1 : 0, o.receiveShadow ? 1 : 0, n, o.geometry.attributes.position.count, sha(Buffer.from(m.buffer, m.byteOffset, n * 64)), c ? sha(Buffer.from(c.buffer, c.byteOffset, n * 12)) : '-'].join(':'));
  });
  return { sha: sha(rows.sort().join('\n')), rows: rows.length, meshes: rows.sort() };
}

// buildFarTrees paints its soft ground shadow on a canvas: a canvas that records nothing is enough here (no pixels are compared)
const canvasStub = () => ({ width: 0, height: 0, getContext: () => ({ createRadialGradient: () => ({ addColorStop() {} }), fillRect() {}, drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(16 * 16 * 4) }) }) });
export async function withDocument(fn) {
  const had = Object.hasOwn(globalThis, 'document'), old = globalThis.document;
  globalThis.document = { createElement: canvasStub };
  try { return await fn(); } finally { if (had) globalThis.document = old; else delete globalThis.document; }
}

// Runs the builders of forest.mjs and props3d.mjs on a world, lets the models load, updates them from one fixed camera and returns the digests:
// { trees, farForest, farTrees, nodes, deco, draw (sha, rows, meshes) } and the pieces (scene, builders, world, terrain)
export const runBuilders = (root, pack, THREE, opts = {}) => withDocument(() => runBuildersInner(root, pack, THREE, opts));
async function runBuildersInner(root, pack, THREE, { mapType = 'meadow', size = 64, seed = 3 } = {}) {
  const terr = await import(modUrl(root, 'render/terrain.mjs'));
  const forest = await import(modUrl(root, 'render/forest.mjs'));
  const props = await import(modUrl(root, 'render/props3d.mjs'));
  const { biomeOf } = await import(modUrl(root, 'render/biomes.mjs'));
  const w = makeWorld(terr.hash, terr.vnoise, size);
  const bio = biomeOf(mapType);
  const t = terr.buildTerrain(size, w.rows, { seed, nodes: w.nodes, starts: w.starts, biome: bio });
  const scene = new THREE.Scene();
  const env = { dust() {}, rows: w.rows, size, cry() {} };
  const trees = forest.buildForest(scene, pack, size, w.rows, seed, mapType, env);
  const farForest = forest.buildFarForest(scene, pack, size, seed, mapType, () => 0, 50, trees.placed);
  const farTrees = forest.buildFarTrees(scene, pack, size, seed, mapType, () => 0, [...trees.placed, ...farForest.placed], new THREE.Vector3(-0.5, -0.8, -0.4).normalize());
  const nodes = props.buildNodes(scene, pack, w.nodes, env);
  const deco = props.buildDeco3D(scene, pack, size, w.rows, w.starts, t, bio);
  await Promise.all([trees.ready, farForest.ready, farTrees.ready, nodes.ready, deco.ready]);
  const camera = new THREE.PerspectiveCamera(32, 16 / 9, 1, 900);
  camera.position.set(size / 2 - 40, 55, size / 2 + 40); camera.lookAt(size / 2, 0, size / 2); camera.updateMatrixWorld(true); camera.updateProjectionMatrix();
  for (const b of [trees, farForest, farTrees, nodes, deco]) b.update(camera);
  const draw = drawDigest(scene);
  return {
    world: w, scene, terrain: t, builders: { trees, farForest, farTrees, nodes, deco },
    digest: { trees: `${digestOf(trees.scatters)}/${placedDigest(trees.placed)}`, farForest: placedDigest(farForest.placed), farTrees: String(farTrees.count), nodes: digestOf(nodes.scatters), deco: `${digestOf(deco.scatters)}/${deco.blockers.length}`, draw: draw.sha, drawRows: draw.rows },
    draw,
  };
}

export { HERE };
