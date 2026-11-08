#!/usr/bin/env node
// Adds the empty node "muzzle_anchor" to the LOD0 .glb of a delivered unit (THEME-VERTRAG.md 6.1: a theme with `muzzle.anchor: "muzzle_anchor"` needs it, tools/theme-check.mjs checks it).
// The cleanup step of the art pipeline (art-v2/3d/_tools/process.py) exports the selected mesh only, so an empty cannot come out of it. This tool writes the node into the JSON chunk
// of the file afterwards. The mesh, the materials, the textures and the binary chunk stay byte for byte as they are. Pure Node, no Blender, no network, no random numbers.
//   node tools/theme-add-anchor.mjs <in.glb> <out.glb> --at x,y,z     position in the units of the file (tiles, +Y up, origin = ground centre, the space of the scene); <out.glb> must not exist
//   node tools/theme-add-anchor.mjs <in.glb> --info                   the bounding box and the node names of the file (to read the muzzle position off the preview)
// Where the muzzle is: the end of the weapon capsule of the rig fit (tools/rig/units.json, `tools`, point b, in cm of the rig frame) turned back into the frame of the file, or read off the preview.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseGlb, glbStats } from './lib/glb-stats.mjs';

export const ANCHOR = 'muzzle_anchor';

// buffer of a glb -> buffer of a glb with one more node in the root of the scene; throws when the node is already there
export function addAnchor(buf, at, name = ANCHOR) {
  if (!Array.isArray(at) || at.length !== 3 || !at.every((v) => Number.isFinite(v))) throw new Error('the position must be three numbers x,y,z');
  const { json } = parseGlb(buf); // also checks the header and the length field
  if ((json.nodes || []).some((n) => n.name === name)) throw new Error(`the file has a node "${name}" already`);
  const scene = json.scenes?.[json.scene ?? 0];
  if (!scene) throw new Error('the file has no scene');
  json.nodes = json.nodes || [];
  json.nodes.push({ name, translation: at.map((v) => Math.round(v * 1e6) / 1e6) });
  (scene.nodes = scene.nodes || []).push(json.nodes.length - 1);
  // rebuild: header, JSON chunk (padded with spaces to 4 bytes), then every other chunk exactly as it was
  const chunks = [];
  for (let off = 12; off + 8 <= buf.length;) {
    const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
    chunks.push({ type, data: buf.subarray(off + 8, off + 8 + len) });
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  const jt = chunks.findIndex((c) => c.type === 0x4e4f534a);
  let j = Buffer.from(JSON.stringify(json), 'utf8');
  if (j.length % 4) j = Buffer.concat([j, Buffer.alloc(4 - (j.length % 4), 0x20)]);
  chunks[jt] = { type: 0x4e4f534a, data: j };
  const parts = [Buffer.alloc(12)];
  for (const c of chunks) {
    const h = Buffer.alloc(8); h.writeUInt32LE(c.data.length, 0); h.writeUInt32LE(c.type, 4);
    const pad = (4 - (c.data.length % 4)) % 4;
    parts.push(h, c.data, Buffer.alloc(pad, c.type === 0x4e4f534a ? 0x20 : 0));
  }
  const out = Buffer.concat(parts);
  out.write('glTF', 0, 'latin1'); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8);
  return out;
}

export function main(argv) {
  const at = argv.indexOf('--at'), skip = at >= 0 ? at + 1 : -1, rest = argv.filter((a, i) => !a.startsWith('--') && i !== skip);
  if (argv.includes('--info') && rest.length === 1) {
    const st = glbStats(path.resolve(rest[0]));
    console.log(`triangles ${st.tris}, materials ${st.materials.join(', ')}, nodes ${st.nodeNames.join(', ') || '(none)'}`);
    console.log(`box min ${st.min.map((v) => v.toFixed(3)).join(' ')}  max ${st.max.map((v) => v.toFixed(3)).join(' ')}  height (98.5 %) ${st.height985.toFixed(3)}`);
    return 0;
  }
  if (rest.length !== 2 || at < 0 || !argv[at + 1]) { console.error('usage: node tools/theme-add-anchor.mjs <in.glb> <out.glb> --at x,y,z   or   <in.glb> --info'); return 2; }
  const [inFile, outFile] = rest.map((f) => path.resolve(f));
  if (inFile === outFile) { console.error('<out.glb> must be another file than <in.glb>'); return 2; }
  if (fs.existsSync(outFile)) { console.error(`${outFile} exists: nothing is overwritten`); return 2; }
  try {
    const pos = argv[at + 1].split(',').map(Number);
    fs.writeFileSync(outFile, addAnchor(fs.readFileSync(inFile), pos));
    console.log(`${path.basename(outFile)}: node ${ANCHOR} at ${pos.join(', ')} added`);
    return 0;
  } catch (e) { console.error(e.message); return 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exit(main(process.argv.slice(2)));
