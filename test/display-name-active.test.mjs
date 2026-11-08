// The active theme of render/theme/display-name.mjs (package C0, the shim setActiveTheme): places that show a name and are not handed a theme speak the active one,
// 'classic' always means classic, nothing set means classic. Run: nice -n 5 node --test test/display-name-active.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { UNITS, BUILDINGS, TECHS } from '../sim/data.mjs';
import { intentOf } from '../server/spectate.mjs';
import { momentCard } from '../tools/commentary.mjs';
import { resolveSubjects } from '../tools/subjects.mjs';
import { tagParts } from '../tools/story-show.mjs';
import { displayName, displayPlural, displayRole, lexiconOf, themeIdOf, setActiveTheme, getActiveTheme, activeThemeId, LEXICON } from '../render/theme/display-name.mjs';
import { loadTheme, classicTheme } from '../render/theme/theme-loader.mjs';
import { makeThemeDir } from '../test-support/theme-glb.mjs';
import { worldTheme } from '../test-support/theme-world.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const old = (id) => String(id).replace(/_/g, ' ');
const withActive = async (theme, fn) => { setActiveTheme(theme); try { return await fn(); } finally { setActiveTheme(null); } };

test('nothing set: the active theme is classic and every answer is the old one (the shim changes nothing until it is called)', () => {
  assert.equal(getActiveTheme(), null);
  assert.equal(activeThemeId(), 'classic');
  for (const id of [...Object.keys(UNITS), ...Object.keys(BUILDINGS), ...Object.keys(TECHS)]) {
    assert.equal(displayName('any', id), old(id), id);
    assert.equal(displayName('any', id, undefined), old(id)); assert.equal(displayName('any', id, null), old(id)); assert.equal(displayName('any', id, 'classic'), old(id));
  }
  assert.deepEqual(lexiconOf(), lexiconOf('classic'));
});

test('an active theme answers wherever no theme is passed (undefined and null), for name, plural, role and the whole lexicon', async () => {
  await withActive('dustmoon-v1', () => {
    assert.equal(getActiveTheme(), 'dustmoon-v1'); assert.equal(activeThemeId(), 'dustmoon-v1');
    assert.equal(displayName('unit', 'archer'), 'Arc Gunner');
    assert.equal(displayName('unit', 'archer', undefined), 'Arc Gunner');
    assert.equal(displayName('unit', 'archer', null), 'Arc Gunner');
    assert.equal(displayPlural('unit', 'worker'), 'Convoy Hands');
    assert.match(displayRole('building', 'tower'), /pulses/);
    assert.equal(displayName('any', 'town_center'), 'Landing Core');
    assert.equal(displayName('unit', 'spearman'), 'Spike Guard');
    assert.equal(displayName('unit', 'wolf'), 'wolf', 'a thing the world has no name for (a wild animal) shows the classic word'); // C1: the world names every unit, building and tech of the game now
    assert.equal(lexiconOf().unit.archer.name, 'Arc Gunner');
    assert.deepEqual(lexiconOf(), lexiconOf('dustmoon-v1'));
  });
  assert.equal(displayName('unit', 'archer'), 'archer', 'reset: classic again');
  assert.equal(getActiveTheme(), null);
});

test("explicit 'classic' (a string, {id}, a loaded classic Theme) is classic whatever is active; an explicit other theme wins over the active one", async () => {
  await withActive('dustmoon-v1', async () => {
    assert.equal(displayName('unit', 'archer', 'classic'), 'archer');
    assert.equal(displayPlural('unit', 'archer', { id: 'classic' }), 'archers');
    assert.equal(displayName('unit', 'archer', classicTheme()), 'archer', 'the loaded classic Theme has the id classic');
    assert.equal(displayName('unit', 'archer', await loadTheme('classic')), 'archer');
    assert.deepEqual(lexiconOf('classic').unit.archer, LEXICON.classic.unit.archer);
  });
  await withActive('classic', () => assert.equal(displayName('unit', 'archer', 'dustmoon-v1'), 'Arc Gunner'));
  await withActive(null, () => assert.equal(displayName('unit', 'archer', 'dustmoon-v1'), 'Arc Gunner'));
});

test('an unknown active theme is classic, never a crash; the setter takes an id, an object with an id or a loaded Theme and gives back what it set', () => {
  assert.equal(setActiveTheme('no-such-theme-v9'), 'no-such-theme-v9');
  assert.equal(displayName('unit', 'archer'), 'archer');
  assert.equal(activeThemeId(), 'classic');
  assert.deepEqual(setActiveTheme({ id: 'dustmoon-v1' }), { id: 'dustmoon-v1' });
  assert.equal(displayName('unit', 'archer'), 'Arc Gunner');
  assert.equal(setActiveTheme(undefined), null);
  assert.equal(displayName('unit', 'archer'), 'archer');
  assert.equal(themeIdOf(null), 'classic', 'themeIdOf itself does not read the active theme (callers that need it use the answers above)');
});

test('a loaded Theme is the active theme: its theme.json words first (units, buildings and techs), then the lexicon, then classic', async () => {
  const { theme, files } = worldTheme();
  theme.units.archer.name = 'Bolt Gunner'; theme.units.archer.plural = 'Bolt Gunners'; theme.units.archer.description = 'Ranged infantry that fires glowing bolts from a distance.';
  const t = await loadTheme('worldmoon-v1', { base: pathToFileURL(path.dirname(makeThemeDir(theme, files)) + '/') });
  await withActive(t, () => {
    assert.equal(displayName('unit', 'archer'), 'Bolt Gunner');
    assert.equal(displayPlural('unit', 'archer'), 'Bolt Gunners');
    assert.equal(displayName('tech', 'wood_axe'), 'Dust Axes');
    assert.equal(displayName('any', 'carry_1'), 'Deep Packs');
    assert.equal(displayPlural('tech', 'carry_1'), 'Deep Packs', 'no plural in theme.json: the name');
    assert.match(displayRole('tech', 'wood_axe'), /wood gatherers/);
    assert.equal(displayName('tech', 'plough'), 'plough', 'a tech the theme does not name is classic');
    assert.equal(displayName('unit', 'spearman'), 'spearman', 'a loaded theme with no entry for the id: classic (the lexicon is of the theme id dustmoon-v1 only)');
    assert.equal(displayName('unit', 'archer', 'classic'), 'archer');
  });
});

test('the call sites that SHOW a name follow the active theme; the two that match what a model wrote match the classic word, and the theme word as well (C1)', async () => {
  const say = (cmd, args) => intentOf('rush', { s: { state: 'build' } }, [{ cmd, args }]);
  const card = () => momentCard({ p: 1, t: 100, tags: [], summary: '', thought: '', seen: { enemy_n: 1, enemy: { archer: 2 }, own_army_n: 1, own: { archer: 3 }, army_value: 5, attacked: { n: 2, what: { town_center: 1 } }, res: { food: 1, wood: 2, stone: 3, gold: 4 } } }, [{ name: 'Anna' }]).saw;
  const c = { starts: [{ x: 1, z: 1 }, { x: 5, z: 5 }], names: ['Anna', 'Ben'], world: { structure: () => ({ x: 3, z: 3, size: 3, t0: 0, t1: null, n: 1 }), hasPlayer: () => true } };
  assert.match(say('train', { unit_type: 'archer', count: 2 }), /training 2 archer$/);
  await withActive('dustmoon-v1', () => {
    assert.match(say('train', { unit_type: 'archer', count: 2 }), /training 2 Arc Gunner$/, 'the thought of a bot in the HUD');
    assert.deepEqual(card().slice(0, 2), ['In view: 2x Arc Gunner (enemy)', 'Hit 2x: Landing Core'], 'the decision card');
    assert.equal(tagParts({ building: { player: 1, type: 'tower' } }, c, 100)[0].tag.text, 'ANNA  PULSE TOWER', 'a chip of the video');
    // matching: a model writes classic words in phase 1 (tools/subjects.mjs, tools/show-tags.mjs ask for classic on purpose)
    const r = resolveSubjects({ units: [{ type: 'archer', n: 2, xy: [5, 5], ids: '1,2' }], buildings: [], you: 1 }, [{ cmd: 'note', text: 'the archer moves out' }], 1);
    assert.deepEqual([r[0]?.role, r[0]?.type], ['note', 'archer']);
    // C1: the words of the active theme are matched IN ADDITION (a themed script or a phase 2 note says "Arc Gunner"); the classic word above still works
    const themed = resolveSubjects({ units: [{ type: 'archer', n: 2, xy: [5, 5], ids: '1,2' }], buildings: [], you: 1 }, [{ cmd: 'note', text: 'the Arc Gunner moves out' }], 1);
    assert.deepEqual([themed[0]?.role, themed[0]?.type], ['note', 'archer'], 'the theme word is found as well (C1)');
  });
  // nothing active: only the classic word is what a note says
  const none = resolveSubjects({ units: [{ type: 'archer', n: 2, xy: [5, 5], ids: '1,2' }], buildings: [], you: 1 }, [{ cmd: 'note', text: 'the Arc Gunner moves out' }], 1);
  assert.notEqual(none[0]?.type, 'archer', 'without an active theme the theme word is nothing');
  assert.match(say('train', { unit_type: 'archer', count: 2 }), /training 2 archer$/, 'back to classic');
});

test('the only state of display-name.mjs is the active theme: the pure-code rules of the file still hold', () => {
  const src = fs.readFileSync(path.join(ROOT, 'render/theme/display-name.mjs'), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /Math\.random|Date\.now|new Date|performance\.now|\bdocument\b|\bwindow\b|\bprocess\b|\brequire\(/);
  assert.doesNotMatch(code, /^\s*import\s/m);
  assert.equal([...code.matchAll(/^\s*let\s+(\w+)/gm)].map((m) => m[1]).join(','), 'ACTIVE', 'one mutable variable and no other');
});
