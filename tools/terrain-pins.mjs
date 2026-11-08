#!/usr/bin/env node
// Dev tool (reskin package C5A): the digests of the terrain fixture (test-support/terrain-fixture.mjs) for every map type, for any tree that has render/terrain.mjs and render/biomes.mjs.
//   node tools/terrain-pins.mjs [<tree>]     default: this tree. Prints JSON: { noBiome, meadow, forest, desert, winter, coast, moon } = land colours, water colours, opacity, vertex counts.
// "The old ground did not change" in numbers, without Chrome: the ORIGINAL tree is only read (node tools/terrain-pins.mjs <original-checkout>) and the numbers go into
// ORIGINAL of test/ground-theme.test.mjs; the test then checks the new code against them. Record again on the original tree if the terrain code changes on purpose.
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { digestTerrain } from '../test-support/terrain-fixture.mjs';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tree = path.resolve(process.argv[2] || HERE);
const imp = (rel) => import(pathToFileURL(path.join(tree, rel)).href);
const { buildTerrain } = await imp('render/terrain.mjs');
const { biomeOf } = await imp('render/biomes.mjs');
const out = { noBiome: digestTerrain(buildTerrain, null) };
for (const type of ['meadow', 'forest', 'desert', 'winter', 'coast', 'moon']) out[type] = digestTerrain(buildTerrain, biomeOf(type)); // 'moon': an unknown map type is the meadow
console.log(JSON.stringify(out, null, 1));
