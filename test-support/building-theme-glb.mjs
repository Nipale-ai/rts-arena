// Small glb files for the tests of the building theme (package C4): a box for the body with a second material for the roof, and banner slots as children of the root node,
// either an empty (a place) or a flat quad (a place and a size). Builds on nothing, changes nothing. Nothing here is random.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeThemeDir, FINAL } from './theme-glb.mjs';

const pad4 = (b, fill) => (b.length % 4 === 0 ? b : Buffer.concat([b, Buffer.alloc(4 - (b.length % 4), fill)]));

// meshes: [{ name, prims: [{ pos: [x,y,z, ...], idx: [...], material }] }]; nodes: glTF nodes (name, mesh, translation, children); the first node is the root of the scene
export function glbOf({ meshes, nodes, materials = ['body', 'team'] }) {
  const bins = [], views = [], accs = [];
  const push = (buf) => { const off = bins.reduce((s, b) => s + b.length, 0); bins.push(pad4(buf, 0)); return off; };
  const jsonMeshes = meshes.map((m) => ({
    name: m.name,
    primitives: m.prims.map((p) => {
      const pos = new Float32Array(p.pos), idx = new Uint16Array(p.idx);
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < pos.length; i += 3) for (let c = 0; c < 3; c++) { min[c] = Math.min(min[c], pos[i + c]); max[c] = Math.max(max[c], pos[i + c]); }
      const po = push(Buffer.from(pos.buffer)), io = push(Buffer.from(idx.buffer));
      views.push({ buffer: 0, byteOffset: po, byteLength: pos.byteLength, target: 34962 }, { buffer: 0, byteOffset: io, byteLength: idx.byteLength, target: 34963 });
      accs.push({ bufferView: views.length - 2, componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max }, { bufferView: views.length - 1, componentType: 5123, count: idx.length, type: 'SCALAR' });
      return { attributes: { POSITION: accs.length - 2 }, indices: accs.length - 1, material: p.material };
    }),
  }));
  const bin = Buffer.concat(bins);
  const json = { asset: { version: '2.0', generator: 'building theme test' }, scene: 0, scenes: [{ nodes: [0] }], nodes, materials: materials.map((name) => ({ name })) };
  if (jsonMeshes.length) Object.assign(json, { meshes: jsonMeshes, accessors: accs, bufferViews: views, buffers: [{ byteLength: bin.length }] }); // (a file with no mesh has no buffer at all)
  const j = pad4(Buffer.from(JSON.stringify(json)), 0x20);
  const total = 12 + 8 + j.length + (bin.length ? 8 + bin.length : 0);
  const head = Buffer.alloc(12); head.write('glTF', 0, 'latin1'); head.writeUInt32LE(2, 4); head.writeUInt32LE(total, 8);
  const ch = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
  return Buffer.concat([head, ch(j.length, 0x4e4f534a), j, ...(bin.length ? [ch(bin.length, 0x004e4942), bin] : [])]);
}

const boxPrim = (x0, x1, y0, y1, z0, z1, material) => ({
  pos: [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1],
  idx: [0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 3, 2, 6, 3, 6, 7, 0, 3, 7, 0, 7, 4, 1, 5, 6, 1, 6, 2],
  material,
});

// A building: a box `width` x `depth` on the ground and `height` tall (material body), a cube on top of it (material team), centred on `centre` [x, z].
// slots: [{ at: [x, y, z], quad?: { w, h, axis: 'x' | 'z' } }] -> nodes banner_slot_0..n; without `quad` an empty, with it a flat quad of w x h whose centre is `at` (axis 'x': it lies in the plane of the width, facing +z).
export function makeBuildingGlb({ width = 2, depth = width, height = 3, centre = [0, 0], slots = [], bare = false } = {}) {
  const [cx, cz] = centre, hx = width / 2, hz = depth / 2;
  const meshes = [{ name: 'lod0', prims: [boxPrim(cx - hx, cx + hx, 0, height, cz - hz, cz + hz, 0), boxPrim(cx - 0.2, cx + 0.2, height, height + 0.4, cz - 0.2, cz + 0.2, 1)] }];
  const nodes = [{ name: 'lod0', mesh: 0, children: slots.map((_, i) => i + 1) }];
  slots.forEach((s, i) => {
    const node = { name: s.name || `banner_slot_${i}`, translation: s.at };
    if (s.quad) {
      const { w, h, axis = 'x' } = s.quad;
      meshes.push({ name: `slot_${i}`, prims: [{ pos: axis === 'x' ? [-w / 2, -h / 2, 0, w / 2, -h / 2, 0, w / 2, h / 2, 0, -w / 2, h / 2, 0] : [0, -h / 2, -w / 2, 0, -h / 2, w / 2, 0, h / 2, w / 2, 0, h / 2, -w / 2], idx: [0, 1, 2, 0, 2, 3], material: 0 }] });
      node.mesh = meshes.length - 1;
    }
    nodes.push(node);
  });
  if (bare) return glbOf({ meshes: [], nodes: [{ name: 'lod0' }] }); // a glb with no mesh at all
  return glbOf({ meshes, nodes });
}

// A theme folder in the temp dir for the building tests. `buildings`: { <type>: { file: Buffer-or-options, tiers: [..], damage: [..], damage_t2: [..], damage_t3: [..], lods: [..], rot } }, every entry a glb (Buffer);
// the files are named by the contract (<type>.glb, <type>_t2.glb, <type>_d1.glb, <type>_t2_d1.glb, <type>_lod1.glb). `skip`: ids of files that are listed in the theme but get no file on disk (they are final, so a 404).
// `placeholder`: file names listed as placeholder. Returns { dir, root (file: URL of the folder that holds the theme folder), theme, id }
export function makeBuildingTheme(buildings, { id = 'bldmoon', version = 1, skip = [], placeholder = [] } = {}) {
  const files = {}, assets = {}, slots = {};
  const add = (rel, buf) => {
    if (placeholder.includes(rel)) { assets[rel] = { kind: 'model', status: 'placeholder', generator: null, prompt: null, seed: null, license: null, credits: null, sha256: null }; return rel; }
    assets[rel] = FINAL(buf, 'model');
    if (!skip.includes(rel)) files[rel] = buf;
    return rel;
  };
  for (const [type, b] of Object.entries(buildings)) {
    const m = { file: add(`models/${type}.glb`, b.file) };
    if (b.lods) m.lods = b.lods.map((buf, i) => add(`models/${type}_lod${i + 1}.glb`, buf));
    if (b.tiers) m.tiers = b.tiers.map((buf, i) => add(`models/${type}_t${i + 2}.glb`, buf));
    if (b.damage) m.damage = b.damage.map((buf, i) => add(`models/${type}_d${i + 1}.glb`, buf));
    if (b.damage_t2) m.damage_t2 = b.damage_t2.map((buf, i) => add(`models/${type}_t2_d${i + 1}.glb`, buf));
    if (b.damage_t3) m.damage_t3 = b.damage_t3.map((buf, i) => add(`models/${type}_t3_d${i + 1}.glb`, buf));
    if (b.rot !== undefined) m.rot = b.rot;
    slots[type] = { model: m };
  }
  const theme = {
    schema: 'rts-theme-1', id, version, name: 'Building test theme', description: 'A theme made by the tests of the building hook.', fallback: 'classic', status: 'slice',
    legal: { name_check: { status: 'unverified' } }, assets, buildings: slots,
  };
  const dir = makeThemeDir(theme, files);
  return { dir, root: pathToFileURL(path.dirname(dir) + '/'), theme, folder: `${id}-v${version}` };
}

// reads a file: URL of a theme folder like the loader of the browser would fetch it (for the tests, which have no server)
export const bytesOf = (url) => fs.readFileSync(new URL(url));
