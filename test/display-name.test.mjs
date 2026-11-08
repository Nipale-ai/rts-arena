import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { UNITS, BUILDINGS, TECHS } from '../sim/data.mjs';
import { WILD_UNITS } from '../sim/world-data.mjs';
import { pluralOf } from '../tools/lib/names.mjs';
import { promptHash } from '../agents/llm/prompt.mjs';
import { currentSimVersion } from '../sim-versions/lib.mjs';
import { collectCases } from '../test-support/display-name-cases.mjs';
import { intentOf } from '../server/spectate.mjs';
import { buildScenes } from '../tools/highlights.mjs';
import { momentCard } from '../tools/commentary.mjs';
import { resolveSubjects } from '../tools/subjects.mjs';
import { tagParts } from '../tools/story-show.mjs';
import {
  DEFAULT_THEME, THEMES, LEXICON, KINDS, displayName, displayPlural, displayRole, lexiconOf, themeIdOf,
} from '../render/theme/display-name.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const old = (id) => String(id).replace(/_/g, ' '); // the copy that stood in 20 files before R1: the reference for "classic is unchanged"
const UNIT_IDS = Object.keys(UNITS), BUILDING_IDS = Object.keys(BUILDINGS), TECH_IDS = Object.keys(TECHS);

// ---------------------------------------------------------------------------------------------------- first: nothing the model sees has moved
test('R1 first test: the prompt hash of classic, fast and war is the one from before R1, and sim/ is the frozen version', () => {
  assert.equal(promptHash('classic'), 'c86a9d5219a49bf5');
  assert.equal(promptHash('fast'), 'f6969218d22edbd0');
  assert.equal(promptHash('war'), '42fd1fb59690331f');
  assert.equal(currentSimVersion({ fresh: true }), 'sim-5b029590482b');
});

test('R1: sim/ and the model prompt do not know the display names (their version and hash stay)', () => {
  const files = [...fs.readdirSync(path.join(ROOT, 'sim')).filter((f) => f.endsWith('.mjs')).map((f) => path.join('sim', f)), 'agents/llm/prompt.mjs'];
  const hits = files.filter((f) => /display-name|render\/theme/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  assert.deepEqual(hits, []);
});

// ---------------------------------------------------------------------------------------------------- golden: same output as before, for every id
test('golden: every text builder gives the words it gave before R1, for every unit, building, tech, wild unit and odd id', () => {
  const golden = JSON.parse(fs.readFileSync(path.join(ROOT, 'test-support/display-name-golden.json'), 'utf8'));
  const now = JSON.parse(JSON.stringify(collectCases())); // through JSON: same shape as the file
  assert.deepEqual(now.ids, golden.ids);
  assert.deepEqual(Object.keys(now.cases), Object.keys(golden.cases));
  const wrong = [];
  for (const id of Object.keys(golden.cases)) for (const k of Object.keys(golden.cases[id])) {
    try { assert.deepEqual(now.cases[id][k], golden.cases[id][k]); } catch { wrong.push(`${id}/${k}`); }
  }
  assert.deepEqual(wrong, []);
  // the golden really covers the game: all ids are in it
  for (const id of [...UNIT_IDS, ...BUILDING_IDS, ...TECH_IDS, ...WILD_UNITS]) assert.ok(id in golden.cases, id);
});

// ---------------------------------------------------------------------------------------------------- classic
test('classic: displayName is the old underscore-to-space text for every id, with and without a theme argument', () => {
  const ids = [...UNIT_IDS, ...BUILDING_IDS, ...TECH_IDS, ...WILD_UNITS, 'berries', 'x_y_z', '', 'constructor', '__proto__', 'toString', 'hasOwnProperty'];
  for (const id of ids) {
    for (const kind of ['unit', 'building', 'tech', 'any', 'nonsense']) {
      for (const theme of [undefined, null, 'classic', { id: 'classic' }, 'no-such-theme', { id: 'no-such-theme' }, 42, {}]) {
        assert.equal(displayName(kind, id, theme), old(id), `${kind}/${id}/${JSON.stringify(theme)}`);
      }
    }
  }
  assert.equal(displayName('unit', undefined), 'undefined', 'same as String(undefined).replace(...) before');
  assert.equal(displayName('unit', 7), '7');
});

test('classic lexicon: every unit and building of the game has an entry, nothing else, and the plural is the one pluralOf makes', () => {
  const L = lexiconOf('classic');
  assert.deepEqual(Object.keys(L.unit), UNIT_IDS);
  assert.deepEqual(Object.keys(L.building), BUILDING_IDS);
  for (const [kind, ids] of [['unit', UNIT_IDS], ['building', BUILDING_IDS]]) {
    for (const id of ids) {
      const e = L[kind][id];
      assert.equal(e.name, old(id), id);
      assert.equal(e.plural, pluralOf(old(id)), `${id}: plural`);
      assert.equal(displayPlural(kind, id), pluralOf(old(id)), `${id}: displayPlural`);
      assert.match(e.role, /^[A-Z][^\n]*\.$/, `${id}: one sentence`);
      assert.equal(displayRole(kind, id), e.role);
    }
  }
});

test('plural and role for ids without an entry: the regular plural, and no invented role', () => {
  for (const id of [...TECH_IDS, ...WILD_UNITS, 'x_y_z', 'berries']) {
    assert.equal(displayPlural('any', id), pluralOf(old(id)), id);
    assert.equal(displayRole('any', id), '', id);
  }
});

test('ids and kinds: no id is both a unit and a building; unknown ids are not read from the prototype', () => {
  assert.deepEqual(UNIT_IDS.filter((u) => BUILDING_IDS.includes(u)), []);
  for (const id of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
    for (const theme of ['classic', 'dustmoon-v1']) {
      assert.equal(displayName('any', id, theme), old(id)); // the old formula, whatever the id is called ('__proto__' becomes '  proto  ' as it always did)
      assert.equal(displayPlural('any', id, theme), pluralOf(old(id)));
      assert.equal(displayRole('any', id, theme), '');
    }
  }
  assert.deepEqual([...KINDS], ['unit', 'building', 'tech']);
});

// ---------------------------------------------------------------------------------------------------- dustmoon-v1
const DUSTMOON_NAMES = {
  worker: 'Convoy Hand', archer: 'Arc Gunner', spearman: 'Spike Guard', swordsman: 'Scrap Cutter', light_cavalry: 'Drift Sled', healer: 'Triage Tech',
  sapper: 'Demolition Drone', town_center: 'Landing Core', barracks: 'Muster Bay', tower: 'Pulse Tower',
};

test('dustmoon-v1: the ten working names the owner gave (02.11.), plural and role for each', () => {
  assert.ok(THEMES.includes('dustmoon-v1') && THEMES[0] === DEFAULT_THEME);
  for (const [id, name] of Object.entries(DUSTMOON_NAMES)) {
    const kind = UNIT_IDS.includes(id) ? 'unit' : 'building';
    assert.equal(displayName(kind, id, 'dustmoon-v1'), name, id);
    assert.equal(displayName('any', id, { id: 'dustmoon-v1' }), name, `${id} any`);
    assert.equal(displayPlural(kind, id, 'dustmoon-v1'), pluralOf(name), `${id}: plural is the regular one`);
    assert.match(displayRole(kind, id, 'dustmoon-v1'), /^[A-Z][^\n]*\.$/, `${id}: one sentence`);
  }
  // C1: the lexicon holds the words of every unit and building of the game (the ten above are the names of the owner, the rest come from the names fragment), no other id
  assert.deepEqual(Object.keys(LEXICON['dustmoon-v1'].unit).sort(), [...UNIT_IDS].sort());
  assert.deepEqual(Object.keys(LEXICON['dustmoon-v1'].building).sort(), [...BUILDING_IDS].sort());
});

test('dustmoon-v1: what the world has no name for shows the classic word (wild animals, odd ids), and an entry is never half themed', () => {
  for (const id of [...WILD_UNITS, 'x_y_z']) assert.equal(displayName('unit', id, 'dustmoon-v1'), old(id), id); // C1: every unit, building and tech of the game is named now (test/theme-names.test.mjs)
  for (const id of ['berries', 'relic_shrine']) assert.equal(displayName('building', id, 'dustmoon-v1'), old(id), id);
  assert.equal(displayName('tech', 'no_such_tech', 'dustmoon-v1'), 'no such tech');
  assert.equal(displayRole('unit', 'wolf', 'dustmoon-v1'), '', 'no invented role');
  for (const kind of ['unit', 'building']) for (const [id, e] of Object.entries(LEXICON['dustmoon-v1'][kind])) {
    assert.ok(e.name && e.plural && e.role, `${id}: name, plural and role are all there`);
    assert.ok(id in lexiconOf('classic')[kind], `${id} is an id of the game`);
  }
});

test('dustmoon-v1: names are unique, differ from the classic words, and stay clear of the words the plan says to avoid', () => {
  const L = lexiconOf('dustmoon-v1');
  const themed = Object.entries(DUSTMOON_NAMES);
  const names = themed.map(([, n]) => n);
  assert.equal(new Set(names).size, names.length);
  for (const [id, n] of themed) assert.notEqual(n.toLowerCase(), old(id), id);
  // PLAN-VOLL.md B3: avoid Marine, Medic, Zerg, Protoss, Command Center, Supply, Minerals, Gas (names of known games) in names and roles
  const AVOID = /\b(marine|medic|zerg|protoss|command cent(?:er|re)|supply|minerals?|gas)\b/i;
  for (const kind of ['unit', 'building']) for (const [id, e] of Object.entries(L[kind])) assert.doesNotMatch(`${e.name} ${e.plural} ${e.role}`, AVOID, id);
  // a themed role does not use the classic word of a unit the world renamed ("archer" next to "Arc Gunner")
  const renamed = themed.map(([id]) => old(id)).filter((w) => w !== 'worker');
  for (const [id] of themed) {
    const kind = UNIT_IDS.includes(id) ? 'unit' : 'building';
    for (const w of renamed) assert.doesNotMatch(displayRole(kind, id, 'dustmoon-v1'), new RegExp(`\\b${w}s?\\b`, 'i'), `${id} role names classic "${w}"`); // regex-safe: w is a game id
  }
});

test('lexiconOf: theme over classic, as a copy', () => {
  const c = lexiconOf('classic'), d = lexiconOf({ id: 'dustmoon-v1' });
  assert.equal(c.unit.archer.name, 'archer');
  assert.equal(d.unit.archer.name, 'Arc Gunner');
  assert.notEqual(d.unit.ram.name, 'ram', 'C1: the ram has a Dustmoon name now'); assert.equal(c.unit.ram.name, 'ram');
  assert.deepEqual(Object.keys(d.unit), Object.keys(c.unit));
  c.unit.archer = null; // a caller may keep and change its copy
  assert.equal(lexiconOf('classic').unit.archer.name, 'archer');
  assert.equal(themeIdOf('dustmoon-v1'), 'dustmoon-v1');
  assert.equal(themeIdOf({ id: 'dustmoon-v1' }), 'dustmoon-v1');
  for (const x of [undefined, null, '', 'nope', {}, { id: 3 }, 5, [], 'constructor', '__proto__']) assert.equal(themeIdOf(x), 'classic', String(x));
});

test('a loaded Theme (theme-loader.mjs of R2a) is read through has() and slot(): its names first, then the lexicon, then classic', () => {
  const json = { units: { archer: { name: 'Bolt Rifleman', plural: 'Bolt Riflemen', description: 'Ranged soldier.' }, ram: {} } };
  const theme = {
    id: 'dustmoon-v1',
    has: (k, t) => !!json[k]?.[t],
    slot: (k, t) => { const r = json[k][t]; return { name: r.name ?? old(t), plural: r.plural ?? old(t) + 's', description: r.description ?? null }; },
  };
  assert.equal(displayName('unit', 'archer', theme), 'Bolt Rifleman');
  assert.equal(displayName('any', 'archer', theme), 'Bolt Rifleman');
  assert.equal(displayPlural('unit', 'archer', theme), 'Bolt Riflemen');
  assert.equal(displayRole('unit', 'archer', theme), 'Ranged soldier.');
  assert.equal(displayName('unit', 'ram', theme), 'ram', 'a slot without a name is the classic word');
  assert.equal(displayName('unit', 'worker', theme), 'Convoy Hand', 'not in theme.json: the lexicon of the same theme id');
  assert.equal(displayName('unit', 'wolf', theme), 'wolf', 'in neither: classic'); // C1: the scout has a lexicon name now, a wild animal has none
  assert.equal(displayName('building', 'archer', theme), 'archer', 'kind is respected: archer is no building');
  assert.equal(displayName('tech', 'archer', theme), 'archer');
});

// ---------------------------------------------------------------------------------------------------- the places that were replaced, one by one
// Each place is called with every id and must give the words of the old copy (old(id)). The golden test above covers hud, overlay, plain-orders,
// story-data, caster-facts and show-tags; these cover the rest. (editor.js needs a browser: it is covered by the "no copy" test and the arena route test.)
test('sites: server/spectate.mjs bot thought (intentOf): "training 2 <unit>", "building <building>", "researching <tech>"', () => {
  const say = (cmd, args) => intentOf('rush', { s: { state: 'build' } }, [{ cmd, args }]);
  for (const id of UNIT_IDS) assert.match(say('train', { unit_type: id, count: 2 }), new RegExp(`: training 2 ${old(id)}$`), id); // regex-safe: ids are [a-z_]
  for (const id of BUILDING_IDS) assert.match(say('build', { building_type: id }), new RegExp(`: building ${old(id)}$`), id); // regex-safe: ids are [a-z_]
  for (const id of TECH_IDS) assert.match(say('research', { tech: id }), new RegExp(`: researching ${old(id)}$`), id); // regex-safe: ids are [a-z_]
});

test('sites: tools/highlights.mjs scene titles name the building with an article', () => {
  const tension = new Array(80).fill(0).map((_, i) => (i > 20 && i < 50 ? 10 : 0));
  const series = { destroyed: new Array(80).fill(0), focus_x: new Array(80).fill(null), focus_y: new Array(80).fill(null), focus_spread: new Array(80).fill(null) };
  for (const id of BUILDING_IDS) {
    const w = old(id), art = /^[aeio]/.test(w) ? 'an' : 'a';
    for (const [type, verb] of [['building_destroyed', 'loses'], ['key_building', 'builds']]) {
      const ev = { players: [{ name: 'Anna' }, { name: 'Ben' }], ticks: 800, series, events: [{ type, t: 300, p: 1, by: 2, building: id, value: 100 }] };
      assert.equal(buildScenes(ev, tension)[0].title, `Anna ${verb} ${art} ${w}`, `${type}/${id}`);
    }
  }
});

test('sites: tools/commentary.mjs decision card names enemy and own types, known enemy buildings and what was hit', () => {
  for (const id of [...UNIT_IDS, ...BUILDING_IDS]) {
    const m = { p: 1, t: 100, tags: [], summary: '', thought: '', seen: { enemy_n: 1, enemy: { [id]: 2 }, own_army_n: 1, own: { [id]: 3 }, army_value: 5, attacked: { n: 2, what: { [id]: 1 } }, res: { food: 1, wood: 2, stone: 3, gold: 4 } } };
    const saw = momentCard(m, [{ name: 'Anna' }]).saw;
    assert.equal(saw[0], `In view: 2x ${old(id)} (enemy)`, id);
    assert.equal(saw[1], `Hit 2x: ${old(id)}`, id);
    assert.equal(saw[2], `Own army 3x ${old(id)} (value 5)`, id);
    const b = momentCard({ ...m, seen: { enemy_n: 0, enemy_buildings: { [id]: 1 }, own_army_n: 0 } }, [{ name: 'Anna' }]).saw[0];
    assert.equal(b, `No enemy unit in view. Known enemy buildings: ${old(id)}`, id);
  }
});

test('sites: tools/subjects.mjs finds the classic word of a type in the note of a model (it asks for classic on purpose)', () => {
  for (const id of UNIT_IDS.filter((u) => !['swordsman'].includes(u))) {
    const obs = { units: [{ type: id, n: 2, xy: [5, 5], ids: '1,2' }], buildings: [], you: 1 };
    const r = resolveSubjects(obs, [{ cmd: 'note', text: `the ${old(id)} moves out` }], 1);
    assert.deepEqual([r[0]?.role, r[0]?.type], ['note', id], id);
  }
  for (const id of BUILDING_IDS) {
    const obs = { units: [], buildings: [{ type: id, id: 7, xy: [8, 8] }], you: 1 };
    const r = resolveSubjects(obs, [{ cmd: 'note', text: `my ${old(id)} is up` }], 1);
    assert.deepEqual([r[0]?.role, r[0]?.type], ['note', id], id);
  }
  const sw = resolveSubjects({ units: [{ type: 'swordsman', n: 2, xy: [5, 5], ids: '1,2' }], buildings: [], you: 1 }, [{ cmd: 'note', text: 'two swordsmen and a swordsman' }], 1);
  assert.equal(sw[0]?.type, 'swordsman');
  const tc = resolveSubjects({ units: [], buildings: [{ type: 'town_center', id: 3, xy: [2, 2] }], you: 1 }, [{ cmd: 'note', text: 'the tc holds' }], 1);
  assert.equal(tc[0]?.type, 'town_center');
});

// since 07.11. the chip says SPEARMEN, SWORDSMEN, LIGHT CAVALRY (not "+ S")
const plural = (u) => (/CAVALRY$/.test(u) ? u : /MAN$/.test(u) ? u.replace(/MAN$/, 'MEN') : `${u}S`);
test('sites: tools/story-show.mjs chips of a follow and a building shot (upper case)', () => {
  const c = { starts: [{ x: 1, z: 1 }, { x: 5, z: 5 }], names: ['Anna', 'Ben'], world: { structure: () => ({ x: 3, z: 3, size: 3, t0: 0, t1: null, n: 1 }), hasPlayer: () => true } };
  for (const id of UNIT_IDS) assert.equal(tagParts({ follow: { sel: { t: 'type', o: 1, ty: id } } }, c, 100)[0].tag.text, `ANNA  ${plural(old(id).toUpperCase())}`, id);
  for (const id of BUILDING_IDS) assert.equal(tagParts({ building: { player: 1, type: id } }, c, 100)[0].tag.text, `ANNA  ${old(id).toUpperCase()}`, id);
});

test('sites: render/god.mjs unit list of the God mode panel (fake DOM)', async () => {
  const fake = () => { const store = {}; const p = new Proxy(function () {}, { get: (t, k) => (k in store ? store[k] : k === Symbol.toPrimitive ? () => '' : p), set: (t, k, v) => { store[k] = v; return true; }, apply: () => p }); return p; };
  const el = fake(), keep = { document: globalThis.document, location: globalThis.location };
  globalThis.document = { querySelector: () => el };
  globalThis.location = { pathname: '/watch/m1/' };
  try {
    const { God } = await import('../render/god.mjs');
    new God({}).init({ mode: 'live', players: [{ name: 'A', color: '#f00' }, { name: 'B', color: '#00f' }], units: [...UNIT_IDS, ...WILD_UNITS] });
    const opts = [...String(el.innerHTML).matchAll(/<option value="([a-z_]+)">([^<]+)<\/option>/g)].map((m) => [m[1], m[2]]).filter(([v]) => UNIT_IDS.includes(v));
    const naval = ['fishing_boat', 'war_boat', 'transport'];
    assert.deepEqual(opts, UNIT_IDS.filter((u) => !naval.includes(u)).map((u) => [u, old(u)]));
  } finally {
    globalThis.document = keep.document;
    globalThis.location = keep.location;
  }
});

// ---------------------------------------------------------------------------------------------------- determinism and the rule "no copy is left"
test('display-name.mjs is pure: no Math.random, no clock, no imports, no DOM', () => {
  const src = fs.readFileSync(path.join(ROOT, 'render/theme/display-name.mjs'), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /Math\.random|Date\.now|new Date|performance\.now|\bdocument\b|\bwindow\b|\bprocess\b|\brequire\(/);
  assert.doesNotMatch(code, /^\s*import\s/m);
  assert.equal(displayName('unit', 'archer', 'dustmoon-v1'), displayName('unit', 'archer', 'dustmoon-v1'));
});

test('no underscore-to-space copy is left in render/, ui/, tools/ or server/ (the one formula lives in render/theme/display-name.mjs)', () => {
  const SKIP_DIR = new Set(['vendor', 'assets', 'screenshots', 'node_modules']);
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (SKIP_DIR.has(e.name) || e.name.startsWith('_alt-') ? [] : walk(path.join(d, e.name))) : /\.(mjs|js|html)$/.test(e.name) ? [path.join(d, e.name)] : []));
  const COPY = /\.replace\(\s*\/_\/g\s*,\s*(['"`]) \1\s*\)|\.replaceAll\(\s*(['"`])_\2\s*,\s*(['"`]) \3\s*\)|\.split\(\s*(['"`])_\4\s*\)\s*\.join\(\s*(['"`]) \5\s*\)/;
  const hits = [];
  for (const dir of ['render', 'ui', 'tools', 'server']) for (const f of walk(path.join(ROOT, dir))) {
    const rel = path.relative(ROOT, f);
    if (rel === 'render/theme/display-name.mjs') continue;
    fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => { if (COPY.test(l)) hits.push(`${rel}:${i + 1}`); });
  }
  assert.deepEqual(hits, []);
});

// ---------------------------------------------------------------------------------------------------- the arena serves the module to the pages of ui/
async function freePort() {
  return new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on('error', reject); });
}
async function get(port, p) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`);
  return { status: res.status, type: res.headers.get('content-type') || '', text: await res.text() };
}

test('arena: /theme/display-name.mjs is served as JavaScript (ui/editor.js imports it), and nothing outside render/theme/ is', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'rts-dn-'));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'server/arena.mjs'), '--port', String(port), '--data', data], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('arena did not start')), 20000);
      child.stdout.on('data', (d) => { if (/Arena: http/.test(String(d))) { clearTimeout(t); resolve(); } });
      child.on('exit', (c) => reject(new Error(`arena exited ${c}`)));
    });
    const ok = await get(port, '/theme/display-name.mjs');
    assert.equal(ok.status, 200);
    assert.match(ok.type, /javascript/);
    assert.match(ok.text, /export function displayName/);
    assert.equal((await get(port, '/theme/..%2Fhud.mjs')).status, 403, 'no way out of render/theme/');
    assert.equal((await get(port, '/theme/..%2F..%2Fpackage.json')).status, 403);
    assert.equal((await get(port, '/theme/')).status, 404, 'a folder is no file');
    assert.equal((await get(port, '/theme/nope.mjs')).status, 404);
    const editor = await get(port, '/ui/editor.js');
    assert.match(editor.text, /from '\/theme\/display-name\.mjs'/);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => { child.on('exit', r); setTimeout(r, 3000); });
    fs.rmSync(data, { recursive: true, force: true });
  }
});
