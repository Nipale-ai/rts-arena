// Small glb files for the tests of the projectile mesh (package C6): a shot made of boxes that lie along +Z, with the materials, glow and vertex colours the test asks for.
// Nothing here is random. Like test-support/theme-glb.mjs, but with real glTF materials (baseColorFactor, emissiveFactor) and COLOR_0, which the projectile mesh reads.

const pad4 = (b, fill) => (b.length % 4 === 0 ? b : Buffer.concat([b, Buffer.alloc(4 - (b.length % 4), fill)]));

// parts: one box per entry, side by side along z over the total `length`; each { color: [r, g, b], emissive?: [r, g, b] } becomes its own material and primitive.
// width: x and y extent of a box. offset: [x, y, z] of the middle of the whole shot. vertexColor: [r, g, b] COLOR_0 for every vertex (null = none).
// repeat: the same box that many times (to build a file with too many triangles). flat: no extent along z (the shot is a card, not a bar: the game cannot use it).
export function makeShotGlb({ length = 1, width = 0.1, offset = [0, 0, 0], parts = [{ color: [1, 1, 1] }], vertexColor = null, repeat = 1, flat = false } = {}) {
  const bins = [], views = [], accs = [], prims = [], materials = [];
  const push = (buf) => { const off = bins.reduce((s, b) => s + b.length, 0); bins.push(pad4(buf, 0)); return off; };
  parts.forEach((part, pi) => {
    const z0 = flat ? 0 : -length / 2 + (length * pi) / parts.length, z1 = flat ? 0 : -length / 2 + (length * (pi + 1)) / parts.length, h = width / 2;
    const corner = (sx, sy, z) => [offset[0] + sx * h, offset[1] + sy * h, offset[2] + z];
    const box = [corner(-1, -1, z0), corner(1, -1, z0), corner(1, 1, z0), corner(-1, 1, z0), corner(-1, -1, z1), corner(1, -1, z1), corner(1, 1, z1), corner(-1, 1, z1)];
    const tri = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
    const pos = new Float32Array(repeat * 24), idx = new Uint16Array(repeat * 36);
    for (let r = 0; r < repeat; r++) {
      box.forEach((c, i) => pos.set(c, r * 24 + i * 3));
      tri.forEach((t, i) => { idx[r * 36 + i] = r * 8 + t; });
    }
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) for (let c = 0; c < 3; c++) { min[c] = Math.min(min[c], pos[i + c]); max[c] = Math.max(max[c], pos[i + c]); }
    const po = push(Buffer.from(pos.buffer)), io = push(Buffer.from(idx.buffer));
    views.push({ buffer: 0, byteOffset: po, byteLength: pos.byteLength, target: 34962 }, { buffer: 0, byteOffset: io, byteLength: idx.byteLength, target: 34963 });
    accs.push({ bufferView: views.length - 2, componentType: 5126, count: repeat * 8, type: 'VEC3', min, max }, { bufferView: views.length - 1, componentType: 5123, count: repeat * 36, type: 'SCALAR' });
    const prim = { attributes: { POSITION: accs.length - 2 }, indices: accs.length - 1, material: pi };
    if (vertexColor) {
      const col = new Float32Array(repeat * 24);
      for (let i = 0; i < repeat * 8; i++) col.set(vertexColor, i * 3);
      const co = push(Buffer.from(col.buffer));
      views.push({ buffer: 0, byteOffset: co, byteLength: col.byteLength, target: 34962 });
      accs.push({ bufferView: views.length - 1, componentType: 5126, count: repeat * 8, type: 'VEC3' });
      prim.attributes.COLOR_0 = accs.length - 1;
    }
    prims.push(prim);
    materials.push({ name: `part${pi}`, pbrMetallicRoughness: { baseColorFactor: [...part.color, 1], metallicFactor: 0, roughnessFactor: 1 }, ...(part.emissive ? { emissiveFactor: part.emissive } : {}) });
  });
  const bin = Buffer.concat(bins);
  const json = { asset: { version: '2.0', generator: 'shot test' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'shot', mesh: 0 }], meshes: [{ name: 'shot', primitives: prims }], materials, accessors: accs, bufferViews: views, buffers: [{ byteLength: bin.length }] };
  const j = pad4(Buffer.from(JSON.stringify(json)), 0x20);
  const total = 12 + 8 + j.length + 8 + bin.length;
  const head = Buffer.alloc(12); head.write('glTF', 0, 'latin1'); head.writeUInt32LE(2, 4); head.writeUInt32LE(total, 8);
  const ch = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
  return Buffer.concat([head, ch(j.length, 0x4e4f534a), j, ch(bin.length, 0x004e4942), bin]);
}

// a glb buffer -> the loaded gltf ({ scene }), the way the page's GLTFLoader gives it (no network, no textures)
export async function parseGlb(buf) {
  const { GLTFLoader } = await import('../render/vendor/jsm/loaders/GLTFLoader.js');
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Promise((resolve, reject) => new GLTFLoader().parse(ab, '', resolve, reject));
}
