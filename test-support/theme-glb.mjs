// Small synthetic files for the theme tests: a glb with a chosen triangle count, size and materials, a PNG header, an Ogg/Opus header,
// and a theme folder in the temp dir. Nothing here is random.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const pad4 = (b, fill) => (b.length % 4 === 0 ? b : Buffer.concat([b, Buffer.alloc(4 - (b.length % 4), fill)]));

// tris triangles on the corners of a box: width x width on the ground, `height` tall, lowest point at y = minY, centred on `centre` [x, z].
// materials: names in order; the first gets most triangles, every further one at least 1. nodes: extra empty nodes (anchors) as children of the root.
export function makeGlb({ tris = 1200, height = 0.9, width = 0.6, minY = 0, centre = [0, 0], materials = ['body', 'team'], nodes = [], meshName = 'lod0' } = {}) {
  const hx = width / 2, cx = centre[0], cz = centre[1];
  const corners = [];
  for (const y of [minY, minY + height]) for (const sx of [-1, 1]) for (const sz of [-1, 1]) corners.push([cx + sx * hx, y, cz + sz * hx]);
  const share = materials.map((_, i) => (i === 0 ? tris - (materials.length - 1) * Math.max(1, Math.floor(tris / 12)) : Math.max(1, Math.floor(tris / 12))));
  const bins = [], views = [], accs = [], prims = [];
  const push = (buf) => { const off = bins.reduce((s, b) => s + b.length, 0); bins.push(pad4(buf, 0)); return off; };
  let n = 0;
  materials.forEach((_, mi) => {
    const t = share[mi], pos = new Float32Array(t * 9), idx = new Uint32Array(t * 3);
    for (let i = 0; i < t; i++) for (let k = 0; k < 3; k++) { const c = corners[(n + i + k) % 8]; pos.set(c, i * 9 + k * 3); idx[i * 3 + k] = i * 3 + k; }
    n += t;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) for (let c = 0; c < 3; c++) { min[c] = Math.min(min[c], pos[i + c]); max[c] = Math.max(max[c], pos[i + c]); }
    const po = push(Buffer.from(pos.buffer)), io = push(Buffer.from(idx.buffer));
    views.push({ buffer: 0, byteOffset: po, byteLength: pos.byteLength, target: 34962 }, { buffer: 0, byteOffset: io, byteLength: idx.byteLength, target: 34963 });
    accs.push({ bufferView: views.length - 2, componentType: 5126, count: t * 3, type: 'VEC3', min, max }, { bufferView: views.length - 1, componentType: 5125, count: t * 3, type: 'SCALAR' });
    prims.push({ attributes: { POSITION: accs.length - 2 }, indices: accs.length - 1, material: mi });
  });
  const bin = Buffer.concat(bins);
  const json = {
    asset: { version: '2.0', generator: 'theme test' },
    scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: 'lod0', mesh: 0, children: nodes.map((_, i) => i + 1) }, ...nodes.map((name) => ({ name }))],
    meshes: [{ name: meshName, primitives: prims }],
    materials: materials.map((name) => ({ name })),
    accessors: accs, bufferViews: views, buffers: [{ byteLength: bin.length }],
  };
  const j = pad4(Buffer.from(JSON.stringify(json)), 0x20);
  const total = 12 + 8 + j.length + 8 + bin.length;
  const head = Buffer.alloc(12); head.write('glTF', 0, 'latin1'); head.writeUInt32LE(2, 4); head.writeUInt32LE(total, 8);
  const ch = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
  return Buffer.concat([head, ch(j.length, 0x4e4f534a), j, ch(bin.length, 0x004e4942), bin]);
}

export function makePng(width = 1024, height = 1024) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20);
  return b;
}

export function makeOgg(channels = 1) {
  const b = Buffer.alloc(64);
  b.write('OggS', 0, 'latin1');
  b.write('OpusHead', 28, 'latin1'); b[36] = 1; b[37] = channels; b.writeUInt32LE(48000, 40);
  return b;
}

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

export const FINAL = (buf, kind, extra = {}) => ({ kind, status: 'final', generator: 'test generator', prompt: 'test prompt', seed: 42, license: 'test licence', credits: 'test credits', sha256: sha256(buf), ...extra });
export const HOLE = (kind) => ({ kind, status: 'placeholder', generator: null, prompt: null, seed: null, license: null, credits: null, sha256: null });

// writes <tmp>/<id>-v<version>/ with theme.json and the given files ({ 'models/archer.glb': Buffer }); returns the folder
export function makeThemeDir(theme, files = {}, { id = theme.id, version = theme.version } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rts-theme-'));
  const dir = path.join(root, `${id}-v${version}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify(theme, null, 1));
  for (const [rel, buf] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), buf); }
  return dir;
}

// A small valid theme with a delivered archer: model + 2 LODs, shot sound; everything final and matching the files.
export function goodArcher() {
  const files = {
    'models/archer.glb': makeGlb({ tris: 2400, height: 0.9, nodes: ['muzzle_anchor'] }),
    'models/archer_lod1.glb': makeGlb({ tris: 1000, height: 0.9 }),
    'models/archer_lod2.glb': makeGlb({ tris: 400, height: 0.9 }),
    'audio/archer_shot.ogg': makeOgg(1),
  };
  const kinds = { 'models/archer.glb': 'model', 'models/archer_lod1.glb': 'model', 'models/archer_lod2.glb': 'model', 'audio/archer_shot.ogg': 'sound' };
  const theme = {
    schema: 'rts-theme-1', id: 'testmoon', version: 1, name: 'Testmoon', description: 'A theme made by the tests.', fallback: 'classic', status: 'slice',
    legal: { name_check: { status: 'unverified' } },
    assets: Object.fromEntries(Object.entries(files).map(([f, b]) => [f, FINAL(b, kinds[f])])),
    units: { archer: {
      name: 'Arc Gunner', plural: 'Arc Gunners', description: 'Ranged laser infantry. Fires bolts from a distance and is strong against infantry.',
      model: { file: 'models/archer.glb', lods: ['models/archer_lod1.glb', 'models/archer_lod2.glb'] },
      clips: { shoot: 'shoot_rifle' },
      projectile: { shape: 'bolt', color: '#7ff3e0', length: 0.45, width: 0.05 },
      muzzle: { fx: 'flash', color: '#9ff7ea', size: 0.35, anchor: 'muzzle_anchor' },
      sound: { shot: 'audio/archer_shot.ogg' },
    } },
  };
  return { theme, files };
}
