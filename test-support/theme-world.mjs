// Synthetic files and a complete theme for the tests of the world slots (package C0): ground textures, nature models, a projectile mesh, event sounds, techs.
// Builds on test-support/theme-glb.mjs (which is not changed). Nothing here is random.
import { makePng, makeOgg, FINAL, HOLE, sha256 } from './theme-glb.mjs';

export { FINAL, HOLE, sha256, makePng, makeOgg };

const pad4 = (b, fill) => (b.length % 4 === 0 ? b : Buffer.concat([b, Buffer.alloc(4 - (b.length % 4), fill)]));

// A glb with `tris` triangles on the corners of a box: x wide, `height` tall (lowest point at minY), z deep (default as wide as x), centred on `centre` [x, z].
// materials: names in order, the first gets most triangles. nodes: empty child nodes of the root.
export function makeBoxGlb({ tris = 400, height = 1, width = 0.6, depth = width, minY = 0, centre = [0, 0], materials = ['body'], nodes = [], meshName = 'lod0' } = {}) {
  const hx = width / 2, hz = depth / 2, cx = centre[0], cz = centre[1];
  const corners = [];
  for (const y of [minY, minY + height]) for (const sx of [-1, 1]) for (const sz of [-1, 1]) corners.push([cx + sx * hx, y, cz + sz * hz]);
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
    asset: { version: '2.0', generator: 'theme world test' },
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

// the header of a baseline JPEG: start of image, one start-of-frame (SOF0) with the size, start of scan
export function makeJpeg(width = 512, height = 512) {
  const sof = Buffer.alloc(19);
  sof[0] = 0xff; sof[1] = 0xc0; sof.writeUInt16BE(17, 2); sof[4] = 8; sof.writeUInt16BE(height, 5); sof.writeUInt16BE(width, 7); sof[9] = 3;
  [[1, 0x22, 0], [2, 0x11, 1], [3, 0x11, 1]].forEach(([id, hv, tq], i) => { sof[10 + i * 3] = id; sof[11 + i * 3] = hv; sof[12 + i * 3] = tq; });
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0xff, 0xd9])]);
}

// A theme with one thing in every new slot, all files delivered and matching: returns { theme, files }. Everything passes the schema and the check (no errors, no warnings).
export function worldTheme() {
  const files = {}, kinds = {};
  const put = (rel, buf, kind) => { files[rel] = buf; kinds[rel] = kind; };
  const tree = (name, o = {}) => makeBoxGlb({ tris: 900, height: 2.3, width: 1, materials: ['body'], ...o, nodes: [] });
  // ground
  put('textures/ground_grass_a.jpg', makeJpeg(512, 512), 'texture');
  put('textures/ground_sand.png', makePng(1024, 1024), 'texture');
  put('textures/ground_sand_desert.jpg', makeJpeg(512, 512), 'texture');
  // nature
  put('models/conifer_a.glb', tree('a'), 'model'); put('models/conifer_a_lod1.glb', tree('a', { tris: 400 }), 'model'); put('models/conifer_a_lod2.glb', tree('a', { tris: 120 }), 'model');
  put('models/conifer_b.glb', tree('b', { height: 2.5 }), 'model');
  put('models/broadleaf_a.glb', tree('c', { height: 2.1, width: 1.6 }), 'model');
  put('models/rare_palm.glb', tree('d', { height: 2 }), 'model');
  put('models/rock_a.glb', makeBoxGlb({ tris: 300, height: 0.5, width: 0.6, materials: ['body'] }), 'model');
  put('models/dry_tuft_a.glb', makeBoxGlb({ tris: 150, height: 0.14, width: 0.13, materials: ['body'] }), 'model');
  put('models/gold_full.glb', makeBoxGlb({ tris: 3000, height: 1.4, width: 2, materials: ['body'] }), 'model');
  put('models/gold_half.glb', makeBoxGlb({ tris: 3000, height: 1.3, width: 2, materials: ['body'] }), 'model');
  put('models/gold_empty.glb', makeBoxGlb({ tris: 3000, height: 1.2, width: 2, materials: ['body'] }), 'model');
  put('models/relic_shrine.glb', makeBoxGlb({ tris: 2400, height: 1.9, width: 1.2, materials: ['body', 'team'] }), 'model');
  put('models/carry_wood.glb', makeBoxGlb({ tris: 250, height: 0.24, width: 0.3, materials: ['body'] }), 'model');
  // a projectile mesh (slim, along +Z, centred) for the archer, a tower with tiers and damage states
  put('models/archer_bolt.glb', makeBoxGlb({ tris: 120, height: 0.05, width: 0.05, depth: 0.45, minY: -0.025, materials: ['body'] }), 'model');
  const bld = (o = {}) => makeBoxGlb({ tris: 3000, height: 3, width: 2, materials: ['body', 'team'], ...o });
  for (const f of ['tower', 'tower_t2', 'tower_t3', 'tower_d1', 'tower_d2', 'tower_d3', 'tower_t2_d1', 'tower_t2_d2', 'tower_t3_d1']) put(`models/${f}.glb`, bld({ tris: 3000 + f.length, nodes: f === 'tower' ? ['banner_slot_0'] : [] }), 'model');
  // event sounds
  put('audio/bow_shot_1.ogg', makeOgg(1), 'sound'); put('audio/bow_shot_2.ogg', makeOgg(1), 'sound'); put('audio/death_human.ogg', makeOgg(1), 'sound');
  const theme = {
    schema: 'rts-theme-1', id: 'worldmoon', version: 1, name: 'Worldmoon', description: 'A theme made by the tests of the world slots.', fallback: 'classic', status: 'slice',
    legal: { name_check: { status: 'unverified' } },
    assets: Object.fromEntries(Object.entries(files).map(([f, b]) => [f, FINAL(b, kinds[f])])),
    units: { archer: { projectile: { shape: 'mesh', mesh: 'models/archer_bolt.glb', color: '#7ff3e0', length: 0.45, width: 0.05 } } },
    buildings: { tower: { model: {
      file: 'models/tower.glb', tiers: ['models/tower_t2.glb', 'models/tower_t3.glb'], damage: ['models/tower_d1.glb', 'models/tower_d2.glb', 'models/tower_d3.glb'],
      damage_t2: ['models/tower_t2_d1.glb', 'models/tower_t2_d2.glb'], damage_t3: ['models/tower_t3_d1.glb'], rot: 1 } } },
    techs: {
      wood_axe: { name: 'Dust Axes', plural: 'Dust Axes', description: 'Sharper blades for the wood gatherers: they cut faster.' },
      carry_1: { name: 'Deep Packs', description: 'Bigger packs: workers carry more per trip.' },
    },
    ground: {
      palette: { grassA: '#a8743a', grassB: '#b98446', sand: '#d9b27a' },
      textures: { grass_a: 'textures/ground_grass_a.jpg', sand: 'textures/ground_sand.png' },
      water: { deep: '#3a2a22', shallow: '#8a6a4a', foam: '#f0e0c0', opacity: 0.7 },
      maps: { desert: { palette: { sand: '#e8c48a' }, textures: { sand: 'textures/ground_sand_desert.jpg' } } },
    },
    nature: {
      trees: {
        conifer: [{ file: 'models/conifer_a.glb', lods: ['models/conifer_a_lod1.glb', 'models/conifer_a_lod2.glb'], weight: 3, brightness: 1.1 }, { file: 'models/conifer_b.glb' }],
        broadleaf: [{ file: 'models/broadleaf_a.glb' }],
        scale: [1.1, 1.5], second: 0.4,
        maps: { desert: { rare: [{ file: 'models/rare_palm.glb', weight: 0.5 }], scale: [1, 1.4] } },
      },
      deco: { rock: [{ file: 'models/rock_a.glb', scale: 1.2 }], dryTuft: [{ file: 'models/dry_tuft_a.glb' }] },
      nodes: { gold: { states: [{ file: 'models/gold_full.glb' }, { file: 'models/gold_half.glb' }, { file: 'models/gold_empty.glb' }] } },
      objects: { relic_shrine: { file: 'models/relic_shrine.glb' } },
      carry: { wood: { file: 'models/carry_wood.glb' } },
    },
    light: {
      sky: { zenith: '#3a2a4a', mid: '#c08a6a' }, haze: { color: '#d8b090', k: 0.5 }, sun: { color: '#ffb070', intensity: 0.9 }, fill: { color: '#8a7aa0', intensity: 0.8 },
      far: { grass: '#a07a48', dry: '#b89060', forest: '#7a5a38', rock: '#9a6c48' }, exposure: 1.05,
      weather: { storm: { color: '#a07a50', fog: 0.8, style: 'sand' }, rain: { color: '#8a7a70' } },
      maps: { winter: { sky: { zenith: '#4a4a6a' }, haze: { k: 0.4 } } },
    },
    event_sounds: { bow_shot: ['audio/bow_shot_1.ogg', 'audio/bow_shot_2.ogg'], death_human: 'audio/death_human.ogg' },
  };
  return { theme, files };
}
