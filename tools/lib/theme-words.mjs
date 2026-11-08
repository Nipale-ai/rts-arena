// Words of the ACTIVE theme in the places that match or quote text (package C1). Pure: no I/O, no clock, no randomness.
//
// display-name.mjs answers "what is this id called" (displayName / displayPlural, active theme unless one is passed). Three kinds of places need a little more:
//   1. text that used a fixed English word for a CLASS of things ("preparation for rams", "new archers", "cavalry"): classWord() keeps the old words
//      byte for byte as long as the theme does not rename the thing, and speaks the theme's plural when it does;
//   2. matchers that read a caster line and look for the thing it talks about (tools/show-tags.mjs, tools/subjects.mjs): themeWords() gives the words
//      a themed text may use IN ADDITION to the classic ones (the classic words stay: a note a model wrote is still classic in phase 1);
//   3. the one-word labels of the screen ("ARC GUNNERS", "SETTLERS"): labelPlural().
// With no theme active (or a theme that names nothing) every function answers with the classic word or with an empty list: the classic text does not move.
import { displayName, displayPlural, getActiveTheme } from '../../render/theme/display-name.mjs';
import { UNITS, BUILDINGS, TECHS } from '../../sim/data.mjs';

// a theme other than classic is the active one (a loaded Theme, an id or an {id}; nothing set and 'classic' are not)
export const themeActive = () => { const t = getActiveTheme(); const id = typeof t === 'string' ? t : t && typeof t === 'object' ? t.id : null; return typeof id === 'string' && id !== '' && id !== 'classic'; };

// the active theme calls this thing by another name than classic does
export const isThemed = (kind, id) => displayName(kind, id) !== displayName(kind, id, 'classic');

// The word for a class of things in a sentence that had a fixed word. classic = the old word, as it was written.
//   classWord('rams', 'unit', 'ram')  ->  'rams' (classic)  |  'Auger Rigs' (a theme that renames the ram)
export const classWord = (classic, kind, id) => (isThemed(kind, id) ? displayPlural(kind, id) : classic);

// The name of a thing in a sentence: classic = the old fixed word ("town center"), a theme that renames it = its name.
//   thingWord('town center', 'building', 'town_center')
export const thingWord = (classic, kind, id) => (isThemed(kind, id) ? displayName(kind, id) : classic);

// Words a themed text may use for a thing, besides the classic ones: its name and its plural, as the theme writes them (no case change).
// [] when the thing keeps its classic name. kind 'any' looks in units, buildings, techs, like displayName.
export function themeWords(kind, id) {
  if (!isThemed(kind, id)) return [];
  return [...new Set([displayName(kind, id), displayPlural(kind, id)])].filter(Boolean);
}

// the same as a list of regular-expression alternatives (escaped, longest first), '' when there is nothing to add
const esc = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const themeAlternation = (kind, id) => themeWords(kind, id).sort((a, b) => b.length - a.length).map(esc).join('|');

// One-word label of a group on the screen, upper case: plural of the name. Only for a theme that renames the thing; the caller keeps its old text otherwise
// (the old labels add an "S" to the classic word, which is wrong for "swordsman" or "light cavalry" and is kept as it is for classic).
export const labelPlural = (kind, id) => displayPlural(kind, id).toUpperCase();

// The id of the building that a display name stands for (the way back: some facts carry names, not ids). Classic: the old formula, spaces to underscores.
export function buildingIdOfName(name) {
  const n = String(name);
  for (const id of Object.keys(BUILDINGS)) if (displayName('building', id) === n) return id;
  return n.replace(/ /g, '_');
}

// Every word the active theme gives to a unit, building or tech (names and plurals). [] for classic. The checker of the caster lines (tools/caster-check.mjs) lets a capitalised
// word in the middle of a sentence pass only when the log has it; the classic words are lower case and are never looked at, the theme words are capitalised and would be refused
// ("Skimmers" is a name that is not in the log). They are the vocabulary of the game, so they belong to the words the log has.
export function themeVocabulary() {
  const out = [];
  for (const [kind, table] of [['unit', UNITS], ['building', BUILDINGS], ['tech', TECHS]]) for (const id of Object.keys(table)) out.push(...themeWords(kind, id));
  return out;
}
