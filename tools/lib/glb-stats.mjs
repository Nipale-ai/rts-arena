// Reads what tools/theme-check.mjs needs from a .glb: triangles, used material names, node/mesh names, bounding box in world space,
// the 98.5 % vertex height (SKALA.md: spear tip, plume and hat are ignored) and the longest horizontal extent.
// Plain glTF 2.0 binary only; a Draco or meshopt file gives counts and the box from the accessor min/max (approx: true).
import fs from 'node:fs';

const COMP = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const COMPRESSED = ['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_mesh_quantization'];

export function parseGlb(buf) {
  if (buf.length < 20 || buf.toString('latin1', 0, 4) !== 'glTF') throw new Error('not a glb file (no glTF header)');
  if (buf.readUInt32LE(4) !== 2) throw new Error('glTF version must be 2');
  if (buf.readUInt32LE(8) !== buf.length) throw new Error('glb length field does not match the file size');
  let off = 12, json = null, bin = null;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4), start = off + 8;
    if (type === 0x4e4f534a) json = JSON.parse(buf.toString('utf8', start, start + len));
    else if (type === 0x004e4942 && !bin) bin = buf.subarray(start, start + len);
    off = start + len + ((4 - (len % 4)) % 4);
  }
  if (!json) throw new Error('glb has no JSON chunk');
  return { json, bin };
}

const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const mul = (a, b) => { const o = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]; return o; };
function local(n) {
  if (n.matrix) return n.matrix;
  const [x, y, z, w] = n.rotation || [0, 0, 0, 1], [sx, sy, sz] = n.scale || [1, 1, 1], [tx, ty, tz] = n.translation || [0, 0, 0];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}
const xf = (m, x, y, z) => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];

function readVec3(json, bin, accIndex) {
  const a = json.accessors[accIndex];
  if (a.bufferView === undefined || a.sparse || a.componentType !== 5126 || a.type !== 'VEC3') return null;
  const bv = json.bufferViews[a.bufferView], T = COMP[a.componentType];
  const base = (bv.byteOffset || 0) + (a.byteOffset || 0), stride = bv.byteStride || 12;
  const dv = new DataView(bin.buffer, bin.byteOffset + base, Math.max(0, bv.byteLength - (a.byteOffset || 0)));
  const out = new Float32Array(a.count * 3);
  for (let i = 0; i < a.count; i++) for (let c = 0; c < 3; c++) out[i * 3 + c] = dv.getFloat32(i * stride + c * T.BYTES_PER_ELEMENT, true);
  return out;
}

export function glbStats(file) {
  const { json, bin } = parseGlb(fs.readFileSync(file));
  const used = new Set([...(json.extensionsUsed || []), ...(json.extensionsRequired || [])]);
  const compressed = COMPRESSED.some((e) => used.has(e));
  const sceneNodes = json.scenes?.[json.scene ?? 0]?.nodes || [];
  const stats = { tris: 0, materials: [], nodeNames: [], meshNames: [], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], height985: 0, extent: 0, approx: compressed, nonTriangles: 0, extensions: [...used] };
  const ys = [], mats = new Set();
  const grow = (p) => { for (let i = 0; i < 3; i++) { if (p[i] < stats.min[i]) stats.min[i] = p[i]; if (p[i] > stats.max[i]) stats.max[i] = p[i]; } };
  const visit = (ni, parent) => {
    const n = json.nodes[ni], m = mul(parent, local(n));
    if (n.name) stats.nodeNames.push(n.name);
    if (n.mesh !== undefined) {
      const mesh = json.meshes[n.mesh];
      if (mesh.name) stats.meshNames.push(mesh.name);
      for (const p of mesh.primitives) {
        if ((p.mode ?? 4) !== 4) { stats.nonTriangles++; continue; }
        const pos = json.accessors[p.attributes.POSITION];
        stats.tris += (p.indices !== undefined ? json.accessors[p.indices].count : pos.count) / 3;
        if (p.material !== undefined) mats.add(json.materials[p.material]?.name ?? `material_${p.material}`);
        const v = !compressed && bin ? readVec3(json, bin, p.attributes.POSITION) : null;
        if (v) for (let i = 0; i < v.length; i += 3) { const q = xf(m, v[i], v[i + 1], v[i + 2]); grow(q); ys.push(q[1]); }
        else if (pos.min && pos.max) for (const x of [pos.min[0], pos.max[0]]) for (const y of [pos.min[1], pos.max[1]]) for (const z of [pos.min[2], pos.max[2]]) { const q = xf(m, x, y, z); grow(q); ys.push(q[1]); stats.approx = true; }
      }
    }
    for (const c of n.children || []) visit(c, m);
  };
  for (const ni of sceneNodes) visit(ni, IDENT);
  stats.materials = [...mats];
  if (stats.tris === 0 || !isFinite(stats.min[0])) return { ...stats, tris: stats.tris, empty: true };
  ys.sort((a, b) => a - b);
  stats.height985 = ys[Math.min(ys.length - 1, Math.floor(0.985 * (ys.length - 1)))];
  stats.extent = Math.max(stats.max[0] - stats.min[0], stats.max[2] - stats.min[2]);
  stats.centre = [(stats.min[0] + stats.max[0]) / 2, (stats.min[2] + stats.max[2]) / 2];
  return stats;
}

// PNG header: { width, height } or null
export function pngSize(file) {
  const b = fs.readFileSync(file);
  if (b.length < 24 || b.toString('latin1', 1, 4) !== 'PNG') return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

// JPEG: { width, height } from the first start-of-frame marker, or null when it is not a JPEG
export function jpegSize(file) {
  const b = fs.readFileSync(file);
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; } // fill byte
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; } // markers without a length
    const len = b.readUInt16BE(i + 2);
    if ((m >= 0xc0 && m <= 0xcf) && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) }; // SOF0..SOF15 (not DHT, JPG, DAC)
    if (m === 0xda) break; // start of scan: no frame header before it
    i += 2 + len;
  }
  return null;
}

// PNG or JPEG: { format: 'png' | 'jpeg', width, height }, or null when the file is neither (header only)
export function imageSize(file) {
  const p = pngSize(file);
  if (p) return { format: 'png', ...p };
  const j = jpegSize(file);
  return j ? { format: 'jpeg', ...j } : null;
}

// OGG/Opus header: { opus, channels } (channels from the OpusHead packet), or null when it is not an Ogg file
export function oggInfo(file) {
  const b = fs.readFileSync(file);
  if (b.length < 40 || b.toString('latin1', 0, 4) !== 'OggS') return null;
  const i = b.subarray(0, 200).indexOf('OpusHead');
  return i < 0 ? { opus: false, channels: null } : { opus: true, channels: b[i + 9] };
}
