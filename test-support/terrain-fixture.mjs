// A small fixed terrain for the tests of the ground and light hooks (package C5A): open ground, a forest patch, a cliff corner, a lake, a town centre with houses, a farm and a camp.
// `digestTerrain` builds it with a given buildTerrain and a given biome, lets the worn paths and the farm soil fade in, and returns what the picture is made of as short hashes:
// the vertex colours of the land, the vertex colours of the water and its opacity. The same function runs on the ORIGINAL tree (tools/terrain-pins.mjs <tree>, the tree is only read)
// and on the new code (test/ground-theme.test.mjs): equal digests mean equal bytes. Nothing here is random.
import crypto from 'node:crypto';

export const SIZE = 28;
// 5 columns of water on the right (x >= 23), a forest patch (x 10..13, y < 9), a cliff corner (x < 6, y >= 25), open ground elsewhere
export const rows = Array.from({ length: SIZE }, (_, y) => Array.from({ length: SIZE }, (_, x) => (x >= 23 ? '~' : x >= 10 && x < 14 && y < 9 ? 'f' : y >= 25 && x < 6 ? '#' : '.')).join(''));
const B = (id, name, tx, ty, size, owner = 1) => ({ id, name, tx, ty, size, owner });
export const buildings = [B(1, 'town_center', 4, 4, 4), B(2, 'house', 9, 5, 2), B(3, 'farm', 4, 11, 3), B(4, 'lumber_camp', 8, 12, 2), B(5, 'mill', 16, 14, 2)];
export const FADE_SNAPSHOTS = 40; // the worn paths ease in over about a second of snapshots (render/terrain.mjs syncBuildings)

const sha = (typed) => crypto.createHash('sha256').update(Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength)).digest('hex').slice(0, 16);

// buildTerrain: the function of render/terrain.mjs (new or original); biome: what the page passes as opts.biome (null = no biome)
export function digestTerrain(buildTerrain, biome) {
  const t = buildTerrain(SIZE, rows, { seed: 5, starts: [{ tx: 4, ty: 4 }], biome });
  for (let i = 0; i < FADE_SNAPSHOTS; i++) t.syncBuildings(buildings);
  const land = t.mesh.geometry.attributes.color.array, water = t.water.geometry.attributes.color.array;
  return {
    land: sha(land), water: sha(water), opacity: t.water.material.opacity, baseOpacity: t.water.userData.baseOpacity,
    vertices: land.length / 3, waterVertices: water.length / 4,
  };
}
