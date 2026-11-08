// Theme schema "rts-theme-1": what a theme.json may contain and how it is checked.
// A theme re-dresses the game (names, models, clips, projectile look, muzzle flash, hit effect, sound, ground, nature, light). It never changes values
// (hp, damage, speed, cost ...) and never changes the sim ids. See THEME-VERTRAG.md for the contract and who delivers what.
//
// Pure data and pure functions: no DOM, no fs, no imports, no randomness. It runs in the browser (theme-loader.mjs) and in Node
// (tools/theme-check.mjs). The list of sim types is not imported (render/ does not import sim/): the caller passes it in `ctx`.
//
//   validateTheme(json, ctx) -> { errors: [{path, message}], warnings: [{path, message}] }
//   ctx (all optional): { units: { <type>: { shoots, attacks } }, buildings: { <type>: { shoots, attacks } }, techs: [tech ids] | { <id>: ... },
//                         soundEvents: [event ids of render/assets/audio/manifest.json], clipKeys: [renderer clip names], strict: bool }
//   strict: placeholder assets and an unverified name check are errors (the release gate); otherwise they are fine.
//
// Slot families (THEME-VERTRAG.md section 3): by sim id `units`, `buildings` (words, model, look, sound) and `techs` (words); one object each `ground`, `nature`, `light`;
// the table of event sounds `event_sounds`. Every field is optional; whatever is missing is classic (per slot, per field, per file).

export const SCHEMA = 'rts-theme-1';
export const CLASSIC = 'classic';
export const KINDS = ['units', 'buildings']; // slots by sim id that can carry a model, a look and sounds
export const TEXT_KINDS = ['units', 'buildings', 'techs']; // slots by sim id that carry words (techs: words only)
export const WORLD_SLOTS = ['ground', 'nature', 'light']; // one object each, no sim ids
export const EVENT_SOUNDS = 'event_sounds'; // the table of event sounds: manifest event id -> file(s)
export const EFFECTS = 'effects'; // code package 2: the colours of the particle effects (dust, smoke, fire, debris, collapse, healing) and the sapper's fuse and blast. Not a world slot: the list WORLD_SLOTS stays as it was
export const TOP_KEYS = ['schema', 'id', 'version', 'name', 'description', 'fallback', 'status', 'created', 'notes', 'legal', 'assets', ...TEXT_KINDS, ...WORLD_SLOTS, EVENT_SOUNDS, EFFECTS];
export const STATUSES = ['slice', 'complete']; // slice = some slots, the rest falls back to classic; complete = every sim type has name, plural, description and model

// ---- fields per slot ----
export const SLOT_FIELDS = {
  units: ['name', 'plural', 'description', 'model', 'clips', 'projectile', 'muzzle', 'hit', 'sound'],
  buildings: ['name', 'plural', 'description', 'model', 'projectile', 'muzzle', 'hit', 'sound'],
  techs: ['name', 'plural', 'description'], // words only; `plural` is optional here (a tech has no plural in a sentence, it defaults to the name)
};
export const TEXT_FIELDS = ['name', 'plural', 'description']; // all three or none (techs: name and description, plural optional)
export const SOUND_EVENTS = {
  units: ['shot', 'hit', 'death'],
  buildings: ['shot', 'hit', 'place', 'complete', 'collapse'],
};
export const EFFECT_FX = ['flash', 'sparks', 'puff', 'sprite']; // renderer effects of render/fx.mjs; "sprite" needs a sprite file
export const MUZZLE_ANCHORS = ['tool_tip', 'hand', 'muzzle_anchor']; // muzzle_anchor = node of that name in the model
export const EFFECT_PALETTE_KEYS = [ // effects.palette.<key>: a colour like #b5532c. Every key is optional; the default is the colour the renderer always used (render/theme/fx-palette.mjs)
  'dust', 'cloud', 'impact_dust', 'collapse_dust', 'collapse_dust2', 'done_dust', 'shard_stone', 'shard_earth', 'rubble_wood', 'rubble_stone', 'rubble_timber',
  'blast_flash', 'blast_fire', 'blast_fire2', 'blast_smoke', 'smoke_dark', 'smoke_light', 'chimney', 'trail_big', 'trail_small', 'flame', 'flame2', 'ember',
  'flash', 'spark', 'spark2', 'siege_flash', 'heal',
];
export const EFFECT_SAPPER = { fuse: ['flash', 'spark', 'spark2', 'size'], blast: ['flash', 'fire', 'fire2', 'size'] }; // effects.sapper.fuse / .blast: colours (#rrggbb) and a size (fuse: the flash in tiles, blast: a factor, 1 = as before)
export const PROJECTILE_SHAPES = ['bolt', 'mesh']; // bolt = procedural glowing capsule; mesh = own glb. A beam is sim code, not a theme.

// Keys that belong to the value layer or to behaviour (plan B1). A theme that carries one of them is wrong, with a clear message.
export const VALUE_KEYS = ['hp', 'atk', 'dmg', 'damage', 'cd', 'range', 'min_range', 'speed', 'armour', 'armor', 'cost', 'time', 'pop', 'sight', 'bonus',
  'tier', 'size', 'cls', 'from', 'train', 'attack', 'splash', 'projectile_speed', 'beam', 'aura', 'pierce', 'rules'];

// ---- assets ----
export const ASSET_KINDS = {
  model: { dir: 'models/', exts: ['.glb'] },
  atlas: { dir: 'models/', exts: ['.png'] },
  sprite: { dir: 'fx/', exts: ['.png'] },
  texture: { dir: 'textures/', exts: ['.jpg', '.png'] }, // tiling ground textures (ground.textures): seamless, square, power of two
  sound: { dir: 'audio/', exts: ['.ogg'] },
  concept: { dir: 'concept/', exts: ['.png', '.jpg', '.webp'] },
};
export const ASSET_STATUSES = ['placeholder', 'final']; // placeholder = promised, not delivered yet: the loader falls back to classic for it
export const PROVENANCE_FIELDS = ['generator', 'prompt', 'seed', 'license', 'credits', 'sha256']; // every manifest entry carries all six keys (null while placeholder)

// ---- measures (art-v2/3d/SKALA.md, 26.10.2026; 1 tile = 1.0 unit, origin = ground centre, +Y up) ----
// measure: height = top of the model at 98.5 % vertex height (spear tip, plume, hat ignored), extent = longest horizontal extent.
// "derived" = the SKALA table has no line for this exact type; the nearest class is used.
export const SCALE = {
  units: {
    worker: { measure: 'height', tiles: 0.8 }, spearman: { measure: 'height', tiles: 0.9 }, swordsman: { measure: 'height', tiles: 0.9 },
    archer: { measure: 'height', tiles: 0.9 }, skirmisher: { measure: 'height', tiles: 0.9 },
    healer: { measure: 'height', tiles: 0.85, derived: 'SKALA monk' }, sapper: { measure: 'height', tiles: 0.9, derived: 'SKALA military infantry' },
    bulwark: { measure: 'height', tiles: 0.9, derived: 'SKALA infantry' },
    light_cavalry: { measure: 'height', tiles: 1.3 }, heavy_cavalry: { measure: 'height', tiles: 1.4 },
    ram: { measure: 'extent', tiles: 1.8 }, catapult: { measure: 'extent', tiles: 1.6 }, mortar: { measure: 'extent', tiles: 1.0 },
    fishing_boat: { measure: 'extent', tiles: 1.8 }, transport: { measure: 'extent', tiles: 2.6 }, war_boat: { measure: 'extent', tiles: 3.0, derived: 'SKALA galley' },
  },
  buildings: {
    town_center: { measure: 'extent', tiles: 4 }, castle: { measure: 'extent', tiles: 5 }, wonder: { measure: 'extent', tiles: 5 }, harbor: { measure: 'extent', tiles: 4, derived: 'SKALA dock' },
    barracks: { measure: 'extent', tiles: 3 }, archery_range: { measure: 'extent', tiles: 3 }, stables: { measure: 'extent', tiles: 3 }, siege_workshop: { measure: 'extent', tiles: 3 },
    blacksmith: { measure: 'extent', tiles: 3 }, market: { measure: 'extent', tiles: 3 }, mill: { measure: 'extent', tiles: 3 }, farm: { measure: 'extent', tiles: 3 },
    house: { measure: 'extent', tiles: 2 }, lumber_camp: { measure: 'extent', tiles: 2 }, mining_camp: { measure: 'extent', tiles: 2 }, tower: { measure: 'extent', tiles: 2 },
    gate: { measure: 'extent', tiles: 2 }, wall: { measure: 'extent', tiles: 1 }, outpost: { measure: 'extent', tiles: 2 },
  },
};
export const SCALE_TOLERANCE = 0.10; // measured value within +-10 % of the table
export const ORIGIN_TOLERANCE = 0.03; // lowest vertex within +-0.03 tile of the ground

// ---- triangle budgets, LOD0 maximum (SKALA.md "Poly budgets used"; PIPELINE.md section 3 planned lower numbers, a model inside those passes too) ----
export const TRI_MAX = { infantry: 2800, cavalry: 3500, siege: 4500, ship: 4500, building_small: 4500, building_production: 8000, building_large: 15000 };
export const BUDGET_CLASS = {
  units: {
    worker: 'infantry', spearman: 'infantry', swordsman: 'infantry', archer: 'infantry', skirmisher: 'infantry', healer: 'infantry', sapper: 'infantry', bulwark: 'infantry',
    light_cavalry: 'cavalry', heavy_cavalry: 'cavalry', scout: 'cavalry', ram: 'siege', catapult: 'siege', mortar: 'siege',
    fishing_boat: 'ship', war_boat: 'ship', transport: 'ship',
  },
  buildings: {
    town_center: 'building_large', castle: 'building_large', wonder: 'building_large',
    barracks: 'building_production', archery_range: 'building_production', stables: 'building_production', siege_workshop: 'building_production', blacksmith: 'building_production', market: 'building_production', harbor: 'building_production',
    house: 'building_small', lumber_camp: 'building_small', mining_camp: 'building_small', mill: 'building_small', farm: 'building_small', tower: 'building_small', wall: 'building_small', gate: 'building_small', outpost: 'building_small',
  },
};
export const LOD_RATIO = { lod1: [0.25, 0.60], lod2: [0.05, 0.25] }; // triangles of a LOD / triangles of LOD0 (pipeline: about 40 % and about 10 to 17 %); outside = warning
export const ATLAS_MAX = { units: 1024, buildings: 2048 }; // pixels per side (SKALA.md)
export const BANNER_BUILDINGS = ['town_center', 'barracks', 'archery_range', 'stables', 'siege_workshop', 'tower', 'castle', 'wonder']; // should carry banner_slot_N (STIL.md)
export const MATERIALS = { body: 'body', team: 'team' }; // canonical lower case; the renderer reads /^TEAM/i, so "TEAM" (what the art pipeline writes today) is accepted too

// ---- world slots (package C0): ground, nature, light. Every name below is a name the renderer already uses; the theme only answers with its own value. ----
export const MAP_TYPES = ['meadow', 'forest', 'desert', 'winter', 'coast']; // sim/world-data.mjs MAP_TYPES = the keys of render/biomes.mjs BIOMES
export const WEATHER_KINDS = ['clear', 'rain', 'fog', 'snow', 'storm']; // sim/world-data.mjs WEATHER_KINDS (render/world-fx.mjs LOOKS)
export const RESOURCES = ['food', 'wood', 'stone', 'gold']; // sim/data.mjs RESOURCES
// ground.palette: the terrain colours of render/terrain.mjs PAL (vertex colours; render/biomes.mjs overrides them per map type)
export const PALETTE_KEYS = ['grassA', 'grassB', 'grassC', 'grassD', 'forest', 'forestB', 'sand', 'sandWet', 'sandDry', 'seabedDeep', 'dirt', 'dirtB', 'soil', 'rockA', 'rockB', 'rockWarm', 'skirt'];
// ground.textures: the tiling ground textures of render/assets/models/MAP.json "ground" (the shader of render/terrain.mjs mixes 8 of them, desert and winter use sand, mud, snow)
export const GROUND_TEXTURES = ['grass_a', 'grass_b', 'grass_c', 'forest', 'sand', 'dirt', 'rock', 'field', 'snow', 'mud'];
export const TEXTURE_SIZES = [256, 512, 1024, 2048]; // pixels per side: square, power of two (the classic textures are 512, SKALA.md says 1024)
export const WATER_KEYS = ['deep', 'shallow', 'foam']; // render/terrain.mjs buildWater: 0x123f63, 0x4fb0cf, 0xe6f4f7
// nature: MAP.json trees (conifer, broadleaf, rare + scale, second; per map type in biomes.<type>.trees), deco + deco_extra, nodes, objects, carry
export const TREE_GROUPS = ['conifer', 'broadleaf', 'rare'];
export const DECO_GROUPS = ['bush', 'fern', 'flowers', 'rock', 'cliff', 'pebbles', 'camp', 'ruin', 'single', 'mushrooms', 'tuft', 'cactus', 'dune', 'dryTuft', 'snow', 'reed', 'wreck', 'bridge', 'cart'];
export const NODE_KINDS = { gold: 3, stone: 3, berries: 2, herd: 1 }; // resource node -> number of states in the classic pack (full ... depleted)
export const OBJECT_IDS = ['relic_shrine', 'caravan', 'scout', 'light_cavalry', 'heavy_cavalry', 'ram']; // relic_shrine = MAP.json objects. caravan = the neutral trade caravan: a unit of the world (drawn from MAP.json units.caravan, a static model), so a theme can not name it under `units` (sim ids only); its model comes from here (render/theme/nature-theme.mjs themedStaticUnit)
// triangle budget of a nature model, LOD0 (SKALA.md "Poly budgets used": trees 1k, bush/rock 250-400, props 150-600; the numbers here have room above the classic models, measured 03.11.2026)
export const NATURE_TRI_MAX = { tree: 1200, plant: 500, rock: 800, cliff: 1100, prop: 900, node: 3500, animal: 2000, object: 3000, vehicle: 4500, carry: 300 }; // vehicle = the caravan, the budget of the siege class (the classic caravan has 3496)
export const NATURE_CLASS = {
  trees: { conifer: 'tree', broadleaf: 'tree', rare: 'tree' },
  deco: { bush: 'plant', fern: 'plant', flowers: 'plant', mushrooms: 'plant', tuft: 'plant', pebbles: 'plant', cactus: 'plant', dune: 'plant', dryTuft: 'plant', snow: 'plant', reed: 'plant', rock: 'rock', cliff: 'cliff', camp: 'prop', ruin: 'prop', single: 'prop', wreck: 'prop', bridge: 'prop', cart: 'prop' },
  nodes: { gold: 'node', stone: 'node', berries: 'prop', herd: 'animal' },
  objects: { relic_shrine: 'object', caravan: 'vehicle', scout: 'vehicle', light_cavalry: 'vehicle', heavy_cavalry: 'vehicle', ram: 'vehicle' },
  carry: { food: 'carry', wood: 'carry', stone: 'carry', gold: 'carry' },
};
// size of a nature model in tiles, as a range [low, high] (a warning outside, never an error: decoration is not a rule). measure: height = 98.5 % vertex height, extent = longest horizontal extent
export const NATURE_SCALE = {
  trees: { conifer: ['height', 1.8, 2.8], broadleaf: ['height', 1.8, 2.8], rare: ['height', 0.4, 2.8] },
  deco: { bush: ['height', 0.3, 0.7], fern: ['height', 0.25, 0.7], flowers: ['height', 0.1, 0.3], mushrooms: ['height', 0.1, 0.3], tuft: ['height', 0.15, 0.4], pebbles: ['height', 0.05, 0.3], rock: ['height', 0.3, 0.8], cliff: ['height', 1.3, 1.9],
    camp: ['height', 0.3, 1.3], ruin: ['height', 0.1, 1.4], single: ['height', 0.4, 1.1], cactus: ['height', 0.7, 1.1], dune: ['height', 0.05, 0.3], dryTuft: ['height', 0.08, 0.25], snow: ['height', 0.05, 0.25], reed: ['height', 0.4, 0.9],
    wreck: ['height', 1.0, 1.6], bridge: ['height', 0.8, 1.3], cart: ['height', 0.4, 0.8] },
  nodes: { gold: ['extent', 1.8, 2.2], stone: ['extent', 1.8, 2.2], berries: ['extent', 0.4, 0.7], herd: ['height', 0.6, 1.2] },
  objects: { relic_shrine: ['height', 1.5, 2.3], caravan: ['extent', 1.6, 2.0], scout: ['extent', 1.0, 1.8], light_cavalry: ['extent', 1.2, 2.2], heavy_cavalry: ['extent', 1.4, 2.6], ram: ['extent', 1.6, 2.4] }, // caravan: the classic model is 1.80 long (MAP.json units.caravan, model 77)
  carry: { food: ['height', 0.2, 0.3], wood: ['height', 0.2, 0.3], stone: ['height', 0.2, 0.3], gold: ['height', 0.2, 0.3] },
};
// a projectile mesh (projectile.mesh): points along +Z, centred on the origin, the game scales it so that its z extent is `length` tiles. Budget in triangles (arrow 0.5, bolt 0.4 tiles: SKALA.md)
export const PROJECTILE_TRI_MAX = 600;
export const MAX_VARIANTS = 8; // files per event sound

export const scaleOf = (kind, type) => SCALE[kind]?.[type] || null;
export const triMaxOf = (kind, type) => TRI_MAX[BUDGET_CLASS[kind]?.[type]] ?? null;

// Words the plan asks to avoid in names (PLAN-VOLL.md B3, "Vermeiden"). Only a warning: the house rule itself is SPEC.md line 6.
export const AVOID_WORDS = ['marine', 'medic', 'zerg', 'protoss', 'command center', 'supply', 'minerals', 'gas'];

// ---- small helpers (also used by tools/theme-check.mjs) ----
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const TYPE_RE = /^[a-z][a-z0-9_]*$/;
const CLIP_RE = /^[a-z][a-z0-9_]*$/;
const PATH_RE = /^[a-z0-9][a-z0-9_]*(\/[a-z0-9][a-z0-9_]*)*\.[a-z0-9]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const ID_RE = /^[a-z][a-z0-9]{1,23}$/;

// "dustmoon-v1" -> { id: 'dustmoon', version: 1, folder: 'dustmoon-v1' }; anything else -> null. "classic" is not a folder.
export function parseThemeId(folder) {
  const m = /^([a-z][a-z0-9]{1,23})-v([1-9][0-9]{0,2})$/.exec(String(folder));
  return m && m[1] !== CLASSIC ? { id: m[1], version: Number(m[2]), folder: `${m[1]}-v${m[2]}` } : null;
}

// Why a file path is not allowed, or null. Lower-case ASCII, snake_case, relative, inside the kind's folder.
export function pathProblem(p, kind) {
  if (!isStr(p)) return 'must be a string';
  if (!PATH_RE.test(p)) return 'must be a relative lower-case ASCII path with letters, digits and underscores, like models/archer.glb';
  const k = ASSET_KINDS[kind];
  if (k && !p.startsWith(k.dir)) return `a ${kind} file must be inside ${k.dir}`;
  if (k && !k.exts.some((e) => p.endsWith(e))) return `a ${kind} file must end with ${k.exts.join(' or ')}`;
  return null;
}
const stemOf = (p) => p.slice(p.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');

const textProblem = (s, min, max) => (!isStr(s) ? 'must be a string' : s.length < min || s.length > max ? `must be ${min} to ${max} characters` : /[^\x20-\x7e]/.test(s) ? 'English printable ASCII only, one line' : null);
const NAME_RE = /^[A-Z][A-Za-z0-9' -]{1,23}$/;

function avoidHits(text) {
  const t = ` ${String(text).toLowerCase().replace(/[^a-z0-9 ]/g, ' ')} `;
  return AVOID_WORDS.filter((w) => t.includes(` ${w} `));
}

class Report {
  constructor() { this.errors = []; this.warnings = []; }
  err(path, message) { this.errors.push({ path, message }); }
  warn(path, message) { this.warnings.push({ path, message }); }
}
const at = (base, key) => (base ? `${base}.${key}` : String(key));

// object with a closed key set; value-layer keys get their own message
function closed(o, allowed, path, r) {
  for (const k of Object.keys(o)) {
    if (allowed.includes(k)) continue;
    if (VALUE_KEYS.includes(k)) r.err(at(path, k), `"${k}" is a value or behaviour key: a theme changes looks, text and sound only (values live in the rules, plan B1)`);
    else r.err(at(path, k), `unknown key "${k}" (allowed: ${allowed.join(', ')})`);
  }
}
function range(v, lo, hi, path, r, what) {
  if (!isNum(v)) { r.err(path, `${what} must be a number`); return false; }
  if (v < lo || v > hi) { r.err(path, `${what} must be between ${lo} and ${hi}`); return false; }
  return true;
}

// ---- validation ----
export function validateTheme(t, ctx = {}) {
  const r = new Report();
  if (!isObj(t)) { r.err('', 'theme.json must be a JSON object'); return r; }
  closed(t, TOP_KEYS, '', r);
  if (t.schema !== SCHEMA) r.err('schema', `must be "${SCHEMA}"`);
  if (!isStr(t.id) || !ID_RE.test(t.id)) r.err('id', 'must be 2 to 24 lower-case letters or digits, starting with a letter (the folder is <id>-v<version>)');
  else if (t.id === CLASSIC) r.err('id', '"classic" is the built-in fallback and cannot be a theme id');
  if (!Number.isInteger(t.version) || t.version < 1 || t.version > 999) r.err('version', 'must be an integer from 1 (a change is a new folder with the next version)');
  else if (isStr(t.id) && ID_RE.test(t.id) && !parseThemeId(`${t.id}-v${t.version}`)) r.err('id', 'id and version do not make a valid folder name');
  { const p = textProblem(t.name, 1, 40); if (p) r.err('name', p); }
  { const p = textProblem(t.description, 1, 300); if (p) r.err('description', p); }
  if (t.fallback !== CLASSIC) r.err('fallback', `must be "${CLASSIC}"`);
  if (!STATUSES.includes(t.status)) r.err('status', `must be one of ${STATUSES.join(', ')}`);
  if (t.created !== undefined && !(isStr(t.created) && DATE_RE.test(t.created))) r.err('created', 'must be a date YYYY-MM-DD');
  if (t.notes !== undefined) { const p = textProblem(t.notes, 1, 600); if (p) r.err('notes', p); }

  // legal: the name check of the new names (SPEC.md line 6: no names, assets, icons or texts from existing games). Unverified is allowed until release.
  if (!isObj(t.legal) || !isObj(t.legal.name_check)) r.err('legal.name_check', 'missing (status "unverified" or "verified")');
  else {
    closed(t.legal, ['name_check'], 'legal', r);
    const n = t.legal.name_check;
    closed(n, ['status', 'date', 'source', 'note'], 'legal.name_check', r);
    if (!['unverified', 'verified'].includes(n.status)) r.err('legal.name_check.status', 'must be "unverified" or "verified"');
    else if (n.status === 'verified') {
      if (!(isStr(n.date) && DATE_RE.test(n.date))) r.err('legal.name_check.date', 'a verified name check needs a date YYYY-MM-DD');
      if (!(isStr(n.source) && n.source.length >= 3)) r.err('legal.name_check.source', 'a verified name check needs a source');
    } else if (ctx.strict) r.err('legal.name_check.status', 'strict: the name check is still "unverified"');
  }

  // assets: the manifest. Key = file path inside the theme folder.
  const assets = isObj(t.assets) ? t.assets : null;
  if (!assets) r.err('assets', 'missing (an object: file path -> provenance)');
  else for (const [file, a] of Object.entries(assets)) validateAsset(file, a, ctx, r);

  // slots
  const refs = new Map(); // file -> { kind, path }
  for (const kind of KINDS) {
    if (t[kind] === undefined) continue;
    if (!isObj(t[kind])) { r.err(kind, 'must be an object: sim type -> slot'); continue; }
    const known = ctx[kind];
    for (const [type, slot] of Object.entries(t[kind])) {
      const p = at(kind, type);
      if (!TYPE_RE.test(type)) { r.err(p, 'sim type ids are lower-case snake_case'); continue; }
      if (known && !known[type]) { r.err(p, `unknown ${kind === 'units' ? 'unit' : 'building'} type: the ids are the sim ids (sim/data.mjs) and cannot be renamed or added by a theme`); continue; }
      validateSlot(kind, type, slot, p, known?.[type] || null, { ...ctx, themeId: isStr(t.id) ? t.id : null }, r, refs);
    }
  }

  // techs: words only
  if (t.techs !== undefined) validateTechs(t.techs, ctx.techs, r);
  // ground, nature, light and the table of event sounds
  const wref = (root, where) => worldRef(root, where, r, refs);
  if (t.ground !== undefined) validateGround(t.ground, 'ground', r, wref);
  if (t.nature !== undefined) validateNature(t.nature, 'nature', r, wref);
  if (t.light !== undefined) validateLight(t.light, 'light', r);
  if (t[EVENT_SOUNDS] !== undefined) validateEventSounds(t[EVENT_SOUNDS], EVENT_SOUNDS, ctx.soundEvents, r, wref);
  if (t[EFFECTS] !== undefined) validateEffects(t[EFFECTS], EFFECTS, r);

  // every referenced file needs a manifest entry of the right kind; entries nobody uses are noted
  if (assets) {
    for (const [file, ref] of refs) {
      const a = assets[file];
      if (!a) r.err(ref.path, `"${file}" has no entry in assets (provenance: generator, prompt, seed, license, credits)`);
      else if (isObj(a) && a.kind !== ref.kind) r.err(ref.path, `"${file}" is used as ${ref.kind} but listed as ${a.kind}`);
    }
    for (const [file, a] of Object.entries(assets)) if (!refs.has(file) && isObj(a) && a.kind !== 'concept') r.warn(`assets["${file}"]`, 'listed but not used by any slot');
  }

  // coverage of a complete theme
  if (t.status === 'complete') {
    for (const kind of KINDS) {
      if (!ctx[kind]) { r.warn(kind, 'status "complete" cannot be checked without the sim type list'); continue; }
      for (const type of Object.keys(ctx[kind])) {
        const s = t[kind]?.[type];
        const miss = !s ? ['name', 'plural', 'description', 'model'] : ['name', 'plural', 'description', 'model'].filter((f) => s[f] === undefined);
        if (miss.length) r.err(at(kind, type), `status "complete" needs ${miss.join(', ')}`);
      }
    }
    if (ctx.techs) for (const id of idsOf(ctx.techs)) {
      const s = t.techs?.[id];
      const miss = ['name', 'description'].filter((f) => s?.[f] === undefined);
      if (miss.length) r.err(at('techs', id), `status "complete" needs ${miss.join(', ')}`);
    }
  }
  return r;
}

function validateAsset(file, a, ctx, r) {
  const p = `assets["${file}"]`;
  if (!isObj(a)) { r.err(p, 'must be an object'); return; }
  closed(a, ['kind', 'status', ...PROVENANCE_FIELDS], p, r);
  if (!ASSET_KINDS[a.kind]) { r.err(at(p, 'kind'), `must be one of ${Object.keys(ASSET_KINDS).join(', ')}`); return; }
  { const pp = pathProblem(file, a.kind); if (pp) r.err(p, pp); }
  if (!ASSET_STATUSES.includes(a.status)) r.err(at(p, 'status'), `must be one of ${ASSET_STATUSES.join(', ')}`);
  const missing = PROVENANCE_FIELDS.filter((k) => a[k] === undefined);
  for (const k of missing) r.err(at(p, k), 'missing (the key is always there; null while the asset is a placeholder)');
  const fin = a.status === 'final';
  if (a.status === 'placeholder' && ctx.strict) r.err(p, 'strict: placeholder asset (not delivered yet)');
  for (const k of ['generator', 'prompt', 'license', 'credits']) {
    if (a[k] === undefined) continue;
    if (a[k] === null) { if (fin) r.err(at(p, k), 'a final asset needs this field'); }
    else if (!isStr(a[k]) || !a[k].trim()) r.err(at(p, k), 'must be a non-empty string or null');
  }
  if (a.seed !== undefined && a.seed !== null && !Number.isInteger(a.seed)) r.err(at(p, 'seed'), 'must be an integer or null (null = no seed, for example hand-made)');
  if (a.sha256 !== undefined) {
    if (a.sha256 === null) { if (fin) r.err(at(p, 'sha256'), 'a final asset needs the sha256 of its file'); }
    else if (!(isStr(a.sha256) && SHA_RE.test(a.sha256))) r.err(at(p, 'sha256'), 'must be 64 lower-case hex characters or null');
  }
}

function validateSlot(kind, type, s, path, sim, ctx, r, refs) {
  if (!isObj(s)) { r.err(path, 'must be an object'); return; }
  closed(s, SLOT_FIELDS[kind], path, r);
  // text: all three or none
  const have = TEXT_FIELDS.filter((f) => s[f] !== undefined);
  if (have.length && have.length < TEXT_FIELDS.length) r.err(path, `name, plural and description come together (missing: ${TEXT_FIELDS.filter((f) => s[f] === undefined).join(', ')})`);
  for (const f of ['name', 'plural']) if (s[f] !== undefined) {
    if (!isStr(s[f]) || !NAME_RE.test(s[f])) r.err(at(path, f), 'must be an English name of 2 to 24 characters, capitalised, letters, digits, space, hyphen or apostrophe');
  }
  if (s.description !== undefined) { const p = textProblem(s.description, 20, 200); if (p) r.err(at(path, 'description'), p); }
  for (const f of TEXT_FIELDS) if (isStr(s[f])) { const hit = avoidHits(s[f]); if (hit.length) r.warn(at(path, f), `contains a word the plan asks to avoid: ${hit.join(', ')} (PLAN-VOLL.md B3)`); }

  const ref = (file, akind, where) => {
    const pp = pathProblem(file, akind);
    if (pp) { r.err(where, pp); return; }
    const stem = stemOf(file);
    if (!(stem === type || stem.startsWith(type + '_'))) r.err(where, `the file name must start with the sim id "${type}" (${type}.glb, ${type}_lod1.glb, ${type}_shot.ogg)`);
    const prev = refs.get(file);
    if (prev && prev.kind !== akind) r.err(where, `"${file}" is already used as ${prev.kind} at ${prev.path}`);
    else if (!prev) refs.set(file, { kind: akind, path: where });
  };

  if (s.model !== undefined) validateModel(kind, type, s.model, at(path, 'model'), r, ref, ctx.themeId);
  if (s.clips !== undefined) {
    const p = at(path, 'clips');
    if (!isObj(s.clips) || !Object.keys(s.clips).length) r.err(p, 'must be an object: renderer clip name -> theme clip name');
    else for (const [from, to] of Object.entries(s.clips)) {
      if (!CLIP_RE.test(from)) r.err(at(p, from), 'clip names are lower-case snake_case');
      else if (ctx.clipKeys && !ctx.clipKeys.includes(from)) r.err(at(p, from), `the renderer has no clip "${from}" (known: ${ctx.clipKeys.join(', ')})`);
      if (!isStr(to) || !CLIP_RE.test(to)) r.err(at(p, from), 'the theme clip name must be lower-case snake_case');
    }
  }
  if (s.projectile !== undefined) {
    if (sim && !sim.shoots) r.err(at(path, 'projectile'), 'this type does not fire projectiles in the sim (a theme cannot change behaviour)');
    validateProjectile(s.projectile, at(path, 'projectile'), r, ref);
  }
  if (s.muzzle !== undefined) {
    if (sim && !sim.shoots) r.err(at(path, 'muzzle'), 'this type does not fire projectiles in the sim');
    validateEffect(s.muzzle, at(path, 'muzzle'), r, ref, true);
  }
  if (s.hit !== undefined) {
    if (sim && !sim.attacks) r.err(at(path, 'hit'), 'this type does not attack in the sim');
    validateEffect(s.hit, at(path, 'hit'), r, ref, false);
  }
  if (s.sound !== undefined) {
    const p = at(path, 'sound');
    if (!isObj(s.sound) || !Object.keys(s.sound).length) r.err(p, 'must be an object: event -> sound file');
    else {
      closed(s.sound, SOUND_EVENTS[kind], p, r);
      for (const [ev, file] of Object.entries(s.sound)) {
        if (!SOUND_EVENTS[kind].includes(ev)) continue;
        if (sim && ev === 'shot' && !sim.shoots) r.err(at(p, ev), 'this type does not fire projectiles in the sim');
        if (sim && ev === 'hit' && !sim.attacks) r.err(at(p, ev), 'this type does not attack in the sim');
        ref(file, 'sound', at(p, ev));
      }
    }
  }
}

// `rig` (units only): the key of the baked game copy of this model in render/assets/models/units/UNITS.json (the rig fit, package R5, writes it: <rig>_0.bin, <rig>.anim, <rig>.jpg).
// It always starts with the theme id (dustmoon_archer): a theme names its own key and can never point at a classic one, so the classic files stay as they are.
export const RIG_RE = /^[a-z][a-z0-9_]{1,31}$/;
function validateModel(kind, type, m, path, r, ref, themeId = null) {
  if (!isObj(m)) { r.err(path, 'must be an object'); return; }
  closed(m, kind === 'buildings' ? ['file', 'lods', 'atlas', 'tiers', 'damage', 'damage_t2', 'damage_t3', 'rot'] : ['file', 'lods', 'atlas', 'rig'], path, r);
  if (m.rot !== undefined && !(Number.isInteger(m.rot) && m.rot >= 0 && m.rot <= 3)) r.err(at(path, 'rot'), 'must be 0, 1, 2 or 3 (quarter turns about the vertical axis, like MAP.json overrides.<id>.rot)');
  if (m.rig !== undefined) {
    if (!isStr(m.rig) || !RIG_RE.test(m.rig)) r.err(at(path, 'rig'), 'must be a rig key: 2 to 32 lower-case letters, digits or underscores, starting with a letter (for example dustmoon_archer)');
    else if (themeId && !m.rig.startsWith(`${themeId}_`)) r.err(at(path, 'rig'), `a theme names its own rig key: it must start with "${themeId}_" (a classic key is never reused, the classic files stay as they are)`);
  }
  if (m.file === undefined) { r.err(at(path, 'file'), 'missing'); return; }
  ref(m.file, 'model', at(path, 'file'));
  if (m.atlas !== undefined) ref(m.atlas, 'atlas', at(path, 'atlas'));
  const list = (key, max, name) => {
    if (m[key] === undefined) return;
    if (!Array.isArray(m[key]) || !m[key].length || m[key].length > max) { r.err(at(path, key), `must be a list of 1 to ${max} files`); return; }
    m[key].forEach((f, i) => {
      ref(f, 'model', `${at(path, key)}[${i}]`);
      if (isStr(f) && stemOf(f) !== name(i)) r.err(`${at(path, key)}[${i}]`, `must be named ${name(i)}.glb`);
    });
  };
  list('lods', 2, (i) => `${type}_lod${i + 1}`);
  list('tiers', 2, (i) => `${type}_t${i + 2}`); // tier 2 and 3 looks; the base file is tier 1
  list('damage', 3, (i) => `${type}_d${i + 1}`); // damage states of tier 1 (hp below 70 / 45 / 22 %, MAP.json buildings.<id>.damage[0])
  list('damage_t2', 3, (i) => `${type}_t2_d${i + 1}`); // damage states of the tier 2 look (MAP.json damage[1])
  list('damage_t3', 3, (i) => `${type}_t3_d${i + 1}`); // damage states of the tier 3 look (MAP.json damage[2])
}

function validateProjectile(p, path, r, ref) {
  if (!isObj(p)) { r.err(path, 'must be an object'); return; }
  closed(p, ['shape', 'mesh', 'color', 'glow', 'length', 'width', 'trail'], path, r);
  if (!PROJECTILE_SHAPES.includes(p.shape)) r.err(at(path, 'shape'), `must be one of ${PROJECTILE_SHAPES.join(', ')} (a beam is sim code, not a theme)`);
  if (p.shape === 'mesh') { if (p.mesh === undefined) r.err(at(path, 'mesh'), 'a mesh projectile needs the glb file'); else ref(p.mesh, 'model', at(path, 'mesh')); }
  else if (p.mesh !== undefined) r.err(at(path, 'mesh'), 'only for shape "mesh"');
  if (p.color === undefined || !COLOR_RE.test(p.color)) r.err(at(path, 'color'), 'must be a colour like #7ff3e0');
  if (p.glow !== undefined && !COLOR_RE.test(p.glow)) r.err(at(path, 'glow'), 'must be a colour like #2fd6c0');
  if (p.length === undefined) r.err(at(path, 'length'), 'missing'); else range(p.length, 0.1, 1.2, at(path, 'length'), r, 'length (tiles)');
  if (p.width === undefined) r.err(at(path, 'width'), 'missing'); else range(p.width, 0.01, 0.3, at(path, 'width'), r, 'width (tiles)');
  if (p.trail !== undefined) {
    const tp = at(path, 'trail');
    if (!isObj(p.trail)) r.err(tp, 'must be an object');
    else {
      closed(p.trail, ['color', 'size'], tp, r);
      if (!COLOR_RE.test(p.trail.color)) r.err(at(tp, 'color'), 'must be a colour like #2fd6c0');
      if (p.trail.size === undefined) r.err(at(tp, 'size'), 'missing'); else range(p.trail.size, 0.02, 0.5, at(tp, 'size'), r, 'size (tiles)');
    }
  }
}

function validateEffect(e, path, r, ref, muzzle) {
  if (!isObj(e)) { r.err(path, 'must be an object'); return; }
  closed(e, muzzle ? ['fx', 'color', 'size', 'life_s', 'sprite', 'anchor', 'core'] : ['fx', 'color', 'size', 'life_s', 'sprite', 'spark'], path, r);
  if (muzzle && e.core !== undefined && !COLOR_RE.test(e.core)) r.err(at(path, 'core'), 'must be a colour like #fff0c0 (the hot centre of the flash; white when it is missing)');
  if (!muzzle && e.spark !== undefined && !COLOR_RE.test(e.spark)) r.err(at(path, 'spark'), 'must be a colour like #fff0c0 (the bright sparks, about a third of them; white when it is missing)');
  if (!EFFECT_FX.includes(e.fx)) r.err(at(path, 'fx'), `must be one of ${EFFECT_FX.join(', ')}`);
  if (!COLOR_RE.test(e.color)) r.err(at(path, 'color'), 'must be a colour like #9ff7ea');
  if (e.size === undefined) r.err(at(path, 'size'), 'missing'); else range(e.size, 0.05, 3, at(path, 'size'), r, 'size (tiles)');
  if (e.life_s !== undefined) range(e.life_s, 0.03, 2, at(path, 'life_s'), r, 'life_s (seconds)');
  if (e.fx === 'sprite') { if (e.sprite === undefined) r.err(at(path, 'sprite'), 'fx "sprite" needs the png file'); else ref(e.sprite, 'sprite', at(path, 'sprite')); }
  else if (e.sprite !== undefined) r.err(at(path, 'sprite'), 'only for fx "sprite"');
  if (muzzle && e.anchor !== undefined && !MUZZLE_ANCHORS.includes(e.anchor)) r.err(at(path, 'anchor'), `must be one of ${MUZZLE_ANCHORS.join(', ')}`);
}

// effects (code package 2): { palette: { <EFFECT_PALETTE_KEYS>: colour }, sapper: { fuse: {...}, blast: {...} } }. Looks only; every field is optional, a missing one is the classic colour.
function validateEffects(e, path, r) {
  if (!isObj(e)) { r.err(path, 'must be an object'); return; }
  closed(e, ['palette', 'sapper'], path, r);
  if (e.palette !== undefined) {
    const p = at(path, 'palette');
    if (!isObj(e.palette) || !Object.keys(e.palette).length) r.err(p, 'must be an object: effect colour name -> colour like #b5532c');
    else { closed(e.palette, EFFECT_PALETTE_KEYS, p, r); for (const [k, v] of Object.entries(e.palette)) if (EFFECT_PALETTE_KEYS.includes(k)) colorField(v, at(p, k), r); }
  }
  if (e.sapper !== undefined) {
    const p = at(path, 'sapper');
    if (!isObj(e.sapper) || !Object.keys(e.sapper).length) r.err(p, 'must be an object with fuse and / or blast');
    else {
      closed(e.sapper, Object.keys(EFFECT_SAPPER), p, r);
      for (const [k, keys] of Object.entries(EFFECT_SAPPER)) {
        const o = e.sapper[k];
        if (o === undefined) continue;
        const q = at(p, k);
        if (!isObj(o) || !Object.keys(o).length) { r.err(q, 'must be an object'); continue; }
        closed(o, keys, q, r);
        for (const f of keys) {
          if (o[f] === undefined) continue;
          if (f === 'size') range(o.size, 0.1, 3, at(q, 'size'), r, k === 'fuse' ? 'size (tiles)' : 'size (factor, 1 = as before)');
          else colorField(o[f], at(q, f), r);
        }
      }
    }
  }
}

// ======================================================================================================================================
// Package C0: techs, event sounds, ground, nature, light
// ======================================================================================================================================
const idsOf = (list) => (Array.isArray(list) ? list : isObj(list) ? Object.keys(list) : []);
const snake = (s) => String(s).replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`); // dryTuft -> dry_tuft (file names are snake_case)

// a file reference of a world slot: the file name must start with `root` (conifer_a.glb for the group conifer, ground_grass_a.jpg ...), the manifest kind is checked later
function worldRef(root, where, r, refs) {
  return (file, akind, at2 = where) => {
    const pp = pathProblem(file, akind);
    if (pp) { r.err(at2, pp); return false; }
    const stem = stemOf(file);
    if (!(stem === root || stem.startsWith(root + '_') || (root.endsWith('_') && stem.startsWith(root)))) { r.err(at2, `the file name must start with "${root.replace(/_$/, '')}" (${root.replace(/_$/, '')}_a.${ASSET_KINDS[akind].exts[0].slice(1)})`); return false; }
    const prev = refs.get(file);
    if (prev && prev.kind !== akind) { r.err(at2, `"${file}" is already used as ${prev.kind} at ${prev.path}`); return false; }
    if (!prev) refs.set(file, { kind: akind, path: at2 });
    return true;
  };
}

function colorField(v, path, r, what = 'colour') { if (!(isStr(v) && COLOR_RE.test(v))) r.err(path, `${what} must be a colour like #c9a46a`); }

// ---- techs: words only. name and description are required, plural is optional (it defaults to the name)
function validateTechs(techs, known, r) {
  if (!isObj(techs)) { r.err('techs', 'must be an object: tech id -> words'); return; }
  const ids = known ? idsOf(known) : null;
  for (const [id, s] of Object.entries(techs)) {
    const p = at('techs', id);
    if (!TYPE_RE.test(id)) { r.err(p, 'tech ids are lower-case snake_case'); continue; }
    if (ids && !ids.includes(id)) { r.err(p, 'unknown tech: the ids are the sim ids (sim/data.mjs TECHS) and cannot be renamed or added by a theme'); continue; }
    if (!isObj(s)) { r.err(p, 'must be an object'); continue; }
    closed(s, SLOT_FIELDS.techs, p, r);
    for (const f of ['name', 'description']) if (s[f] === undefined) r.err(at(p, f), 'missing (a tech needs name and description)');
    for (const f of ['name', 'plural']) if (s[f] !== undefined && (!isStr(s[f]) || !NAME_RE.test(s[f]))) r.err(at(p, f), 'must be an English name of 2 to 24 characters, capitalised, letters, digits, space, hyphen or apostrophe');
    if (s.description !== undefined) { const pr = textProblem(s.description, 20, 200); if (pr) r.err(at(p, 'description'), pr); }
    for (const f of SLOT_FIELDS.techs) if (isStr(s[f])) { const hit = avoidHits(s[f]); if (hit.length) r.warn(at(p, f), `contains a word the plan asks to avoid: ${hit.join(', ')} (PLAN-VOLL.md B3)`); }
  }
}

// ---- event_sounds: manifest event id -> one file or a list of variants (render/assets/audio/manifest.json has 124 events; the theme file plays with the bus, priority, cooldown, distance and level of the classic event of the same id)
function validateEventSounds(tab, path, known, r, wref) {
  if (!isObj(tab) || !Object.keys(tab).length) { r.err(path, 'must be an object: event id -> sound file (or a list of variants)'); return; }
  const ids = known ? idsOf(known) : null;
  for (const [ev, v] of Object.entries(tab)) {
    const p = at(path, ev);
    if (!/^[a-z][a-z0-9_]{1,47}$/.test(ev)) { r.err(p, 'event ids are lower-case snake_case'); continue; }
    if (ids && !ids.includes(ev)) { r.err(p, 'unknown sound event: the ids are the events of render/assets/audio/manifest.json and cannot be added by a theme'); continue; }
    const list = Array.isArray(v) ? v : [v];
    if (!list.length || list.length > MAX_VARIANTS) { r.err(p, `must be a file or a list of 1 to ${MAX_VARIANTS} files`); continue; }
    const seen = new Set();
    list.forEach((f, i) => {
      const where = Array.isArray(v) ? `${p}[${i}]` : p;
      if (isStr(f) && seen.has(f)) r.err(where, `"${f}" is listed twice`);
      seen.add(f);
      wref(ev, where)(f, 'sound', where);
    });
  }
}

// ---- a colour table: closed keys, each a colour
function colorTable(o, keys, path, r) {
  if (!isObj(o) || !Object.keys(o).length) { r.err(path, `must be an object: ${keys.join(', ')} -> colour`); return; }
  closed(o, keys, path, r);
  for (const [k, v] of Object.entries(o)) if (keys.includes(k)) colorField(v, at(path, k), r);
}

// ---- ground: palette (terrain colours), textures (tiling ground textures), water; `maps.<map type>` refines them for one map type
const GROUND_LAYER = ['palette', 'textures', 'water'];
function validateGroundLayer(g, path, r, wref) {
  if (g.palette !== undefined) colorTable(g.palette, PALETTE_KEYS, at(path, 'palette'), r);
  if (g.textures !== undefined) {
    const p = at(path, 'textures');
    if (!isObj(g.textures) || !Object.keys(g.textures).length) r.err(p, `must be an object: ground texture name -> file in textures/ (names: ${GROUND_TEXTURES.join(', ')})`);
    else {
      closed(g.textures, GROUND_TEXTURES, p, r);
      for (const [k, f] of Object.entries(g.textures)) if (GROUND_TEXTURES.includes(k)) wref('ground_', at(p, k))(f, 'texture', at(p, k));
    }
  }
  if (g.water !== undefined) {
    const p = at(path, 'water');
    if (!isObj(g.water) || !Object.keys(g.water).length) r.err(p, 'must be an object: deep, shallow, foam (colours) and opacity');
    else {
      closed(g.water, [...WATER_KEYS, 'opacity'], p, r);
      for (const k of WATER_KEYS) if (g.water[k] !== undefined) colorField(g.water[k], at(p, k), r);
      if (g.water.opacity !== undefined) range(g.water.opacity, 0.2, 1, at(p, 'opacity'), r, 'opacity');
    }
  }
}
function validateGround(g, path, r, wref) {
  if (!isObj(g) || !Object.keys(g).length) { r.err(path, 'must be an object with palette, textures, water and/or maps'); return; }
  closed(g, [...GROUND_LAYER, 'maps'], path, r);
  validateGroundLayer(g, path, r, wref);
  if (g.maps !== undefined) validateMaps(g.maps, at(path, 'maps'), r, (m, p) => { closed(m, GROUND_LAYER, p, r); validateGroundLayer(m, p, r, wref); });
}
function validateMaps(maps, path, r, each) {
  if (!isObj(maps) || !Object.keys(maps).length) { r.err(path, `must be an object: map type -> refinement (map types: ${MAP_TYPES.join(', ')})`); return; }
  closed(maps, MAP_TYPES, path, r);
  for (const [t, m] of Object.entries(maps)) {
    if (!MAP_TYPES.includes(t)) continue;
    const p = at(path, t);
    if (!isObj(m) || !Object.keys(m).length) r.err(p, 'must be a non-empty object');
    else each(m, p);
  }
}

// ---- light: sky, haze (the distance fog), sun, fill, far-field colours, exposure, weather; `maps.<map type>` refines sky, haze, sun and far
const LIGHT_LAYER = ['sky', 'haze', 'sun', 'far'];
function validateLightLayer(l, path, r) {
  if (l.sky !== undefined) {
    const p = at(path, 'sky');
    if (!isObj(l.sky) || !Object.keys(l.sky).length) r.err(p, 'must be an object: zenith, mid (colours)');
    else { closed(l.sky, ['zenith', 'mid'], p, r); for (const k of ['zenith', 'mid']) if (l.sky[k] !== undefined) colorField(l.sky[k], at(p, k), r); }
  }
  if (l.haze !== undefined) {
    const p = at(path, 'haze');
    if (!isObj(l.haze) || !Object.keys(l.haze).length) r.err(p, 'must be an object: color, k');
    else {
      closed(l.haze, ['color', 'k'], p, r);
      if (l.haze.color !== undefined) colorField(l.haze.color, at(p, 'color'), r);
      if (l.haze.k !== undefined) range(l.haze.k, 0, 1, at(p, 'k'), r, 'k (how much of the haze colour replaces the sky colour at the horizon)');
    }
  }
  if (l.sun !== undefined) {
    const p = at(path, 'sun');
    if (!isObj(l.sun) || !Object.keys(l.sun).length) r.err(p, 'must be an object: color, intensity');
    else {
      closed(l.sun, ['color', 'intensity'], p, r);
      if (l.sun.color !== undefined) colorField(l.sun.color, at(p, 'color'), r);
      if (l.sun.intensity !== undefined) range(l.sun.intensity, 0.3, 1.6, at(p, 'intensity'), r, 'intensity (a multiple of the classic sun of the map type)');
    }
  }
  if (l.far !== undefined) colorTable(l.far, ['grass', 'dry', 'forest', 'rock'], at(path, 'far'), r);
}
function validateLight(l, path, r) {
  if (!isObj(l) || !Object.keys(l).length) { r.err(path, 'must be an object with sky, haze, sun, fill, far, exposure, weather and/or maps'); return; }
  closed(l, [...LIGHT_LAYER, 'fill', 'exposure', 'weather', 'maps'], path, r);
  validateLightLayer(l, path, r);
  if (l.fill !== undefined) {
    const p = at(path, 'fill');
    if (!isObj(l.fill) || !Object.keys(l.fill).length) r.err(p, 'must be an object: color, intensity');
    else {
      closed(l.fill, ['color', 'intensity'], p, r);
      if (l.fill.color !== undefined) colorField(l.fill.color, at(p, 'color'), r);
      if (l.fill.intensity !== undefined) range(l.fill.intensity, 0.3, 2, at(p, 'intensity'), r, 'intensity (a multiple of the classic fill light)');
    }
  }
  if (l.exposure !== undefined) range(l.exposure, 0.6, 1.6, at(path, 'exposure'), r, 'exposure (1 = classic)');
  if (l.weather !== undefined) {
    const p = at(path, 'weather');
    if (!isObj(l.weather) || !Object.keys(l.weather).length) r.err(p, `must be an object: weather kind -> look (kinds: ${WEATHER_KINDS.join(', ')})`);
    else {
      closed(l.weather, WEATHER_KINDS, p, r);
      for (const [k, w] of Object.entries(l.weather)) {
        if (!WEATHER_KINDS.includes(k)) continue;
        const wp = at(p, k);
        if (!isObj(w) || !Object.keys(w).length) { r.err(wp, 'must be a non-empty object'); continue; }
        closed(w, k === 'storm' ? ['color', 'fog', 'style'] : ['color', 'fog'], wp, r);
        if (w.color !== undefined) colorField(w.color, at(wp, 'color'), r, 'colour of the cloud cover');
        if (w.fog !== undefined) range(w.fog, 0.3, 1.5, at(wp, 'fog'), r, 'fog (a multiple of the classic fog density)');
        if (w.style !== undefined && !['standard', 'sand'].includes(w.style)) r.err(at(wp, 'style'), 'must be "standard" or "sand" (a dust storm: golden haze, sand streaks, no rain, no wet ground)');
      }
    }
  }
  if (l.maps !== undefined) validateMaps(l.maps, at(path, 'maps'), r, (m, p) => { closed(m, LIGHT_LAYER, p, r); validateLightLayer(m, p, r); });
}

// ---- nature: trees, deco, nodes, objects, carry (the models the world is planted with)
// an entry is { file, lods?, atlas?, weight?, brightness?, scale? }: file = the delivered model (a LOD list stops at the first look that is missing), weight = how often it is picked
// among its group, brightness = a multiple of the model colour (the classic trees are lit up to 3.3), scale = a multiple of the size the game gives this kind of thing,
// rot (objects only) = quarter turns about the vertical axis, 0 to 3 (the caravan: the classic model has its horse at -x and is turned one quarter so that the horse leads along +z; a model with the front at -x needs 1, one with the front at +x needs 3)
function validateNatureEntry(e, path, root, r, wref, withScale = true, withRot = false) {
  if (!isObj(e)) { r.err(path, 'must be an object: { file, lods?, atlas?, weight?, brightness?, scale? }'); return null; }
  closed(e, ['file', 'lods', 'atlas', 'weight', 'brightness', ...(withScale ? ['scale'] : []), ...(withRot ? ['rot'] : [])], path, r);
  const ref = wref(root, path);
  if (e.file === undefined) { r.err(at(path, 'file'), 'missing'); return null; }
  ref(e.file, 'model', at(path, 'file'));
  if (e.atlas !== undefined) ref(e.atlas, 'atlas', at(path, 'atlas'));
  if (e.lods !== undefined) {
    if (!Array.isArray(e.lods) || !e.lods.length || e.lods.length > 2) r.err(at(path, 'lods'), 'must be a list of 1 to 2 files');
    else e.lods.forEach((f, i) => {
      ref(f, 'model', `${at(path, 'lods')}[${i}]`);
      if (isStr(e.file) && isStr(f) && stemOf(f) !== `${stemOf(e.file)}_lod${i + 1}`) r.err(`${at(path, 'lods')}[${i}]`, `must be named ${stemOf(e.file)}_lod${i + 1}.glb`);
    });
  }
  if (e.weight !== undefined) range(e.weight, 0.05, 20, at(path, 'weight'), r, 'weight');
  if (e.brightness !== undefined) range(e.brightness, 0.3, 4, at(path, 'brightness'), r, 'brightness');
  if (e.scale !== undefined && withScale) range(e.scale, 0.3, 3, at(path, 'scale'), r, 'scale');
  if (e.rot !== undefined && withRot && !(Number.isInteger(e.rot) && e.rot >= 0 && e.rot <= 3)) r.err(at(path, 'rot'), 'must be 0, 1, 2 or 3 (quarter turns about the vertical axis)');
  return e;
}
function validateEntryList(list, path, root, r, wref, max = 12) {
  if (!Array.isArray(list) || !list.length || list.length > max) { r.err(path, `must be a list of 1 to ${max} models`); return; }
  const seen = new Set();
  list.forEach((e, i) => {
    const p = `${path}[${i}]`;
    if (validateNatureEntry(e, p, root, r, wref) && isStr(e.file)) { if (seen.has(e.file)) r.err(p, `"${e.file}" is listed twice (use weight to make a model more frequent)`); seen.add(e.file); }
  });
}
function validateTreeGroups(t, path, r, wref, withMaps = false) {
  closed(t, [...TREE_GROUPS, 'scale', 'second', ...(withMaps ? ['maps'] : [])], path, r);
  for (const g of TREE_GROUPS) if (t[g] !== undefined) validateEntryList(t[g], at(path, g), g, r, wref);
  if (t.scale !== undefined) {
    const p = at(path, 'scale');
    if (!Array.isArray(t.scale) || t.scale.length !== 2 || !t.scale.every((x) => isNum(x) && x >= 0.5 && x <= 3) || t.scale[0] > t.scale[1]) r.err(p, 'must be [low, high], two numbers from 0.5 to 3, low not above high (the size range of a tree, like MAP.json trees.scale)');
  }
  if (t.second !== undefined) range(t.second, 0, 1, at(path, 'second'), r, 'second (the chance of a second tree on a forest tile)');
}
function validateNature(n, path, r, wref) {
  if (!isObj(n) || !Object.keys(n).length) { r.err(path, 'must be an object with trees, deco, nodes, objects and/or carry'); return; }
  closed(n, ['trees', 'deco', 'nodes', 'objects', 'carry'], path, r);
  if (n.trees !== undefined) {
    const p = at(path, 'trees');
    if (!isObj(n.trees) || !Object.keys(n.trees).length) r.err(p, 'must be an object: conifer, broadleaf, rare (model lists), scale, second, maps');
    else {
      validateTreeGroups(n.trees, p, r, wref, true);
      if (n.trees.maps !== undefined) validateMaps(n.trees.maps, at(p, 'maps'), r, (m, mp) => validateTreeGroups(m, mp, r, wref));
    }
  }
  if (n.deco !== undefined) {
    const p = at(path, 'deco');
    if (!isObj(n.deco) || !Object.keys(n.deco).length) r.err(p, `must be an object: group -> model list (groups: ${DECO_GROUPS.join(', ')})`);
    else { closed(n.deco, DECO_GROUPS, p, r); for (const [g, list] of Object.entries(n.deco)) if (DECO_GROUPS.includes(g)) validateEntryList(list, at(p, g), snake(g), r, wref); }
  }
  if (n.nodes !== undefined) {
    const p = at(path, 'nodes');
    if (!isObj(n.nodes) || !Object.keys(n.nodes).length) r.err(p, `must be an object: resource node -> { states } (nodes: ${Object.keys(NODE_KINDS).join(', ')})`);
    else {
      closed(n.nodes, Object.keys(NODE_KINDS), p, r);
      for (const [k, v] of Object.entries(n.nodes)) {
        if (!(k in NODE_KINDS)) continue;
        const np = at(p, k);
        if (!isObj(v)) { r.err(np, 'must be an object: { states: [model, ...] }'); continue; }
        closed(v, ['states'], np, r);
        if (v.states === undefined) { r.err(at(np, 'states'), 'missing'); continue; }
        if (!Array.isArray(v.states) || !v.states.length || v.states.length > NODE_KINDS[k]) { r.err(at(np, 'states'), `must be a list of 1 to ${NODE_KINDS[k]} models, full first and depleted last (the classic ${k} has ${NODE_KINDS[k]})`); continue; }
        v.states.forEach((e, i) => validateNatureEntry(e, `${at(np, 'states')}[${i}]`, k, r, wref, false));
      }
    }
  }
  if (n.objects !== undefined) {
    const p = at(path, 'objects');
    if (!isObj(n.objects) || !Object.keys(n.objects).length) r.err(p, `must be an object: object id -> model (objects: ${OBJECT_IDS.join(', ')})`);
    else { closed(n.objects, OBJECT_IDS, p, r); for (const [k, e] of Object.entries(n.objects)) if (OBJECT_IDS.includes(k)) validateNatureEntry(e, at(p, k), k, r, wref, true, true); }
  }
  if (n.carry !== undefined) {
    const p = at(path, 'carry');
    if (!isObj(n.carry) || !Object.keys(n.carry).length) r.err(p, `must be an object: resource -> model (resources: ${RESOURCES.join(', ')})`);
    else { closed(n.carry, RESOURCES, p, r); for (const [k, e] of Object.entries(n.carry)) if (RESOURCES.includes(k)) validateNatureEntry(e, at(p, k), `carry_${k}`, r, wref, false); }
  }
}
