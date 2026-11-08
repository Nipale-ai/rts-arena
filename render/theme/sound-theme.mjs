// Theme sounds, the generic hook (package C3 of the reskin). What a theme may say about sound, and how the sound code reads it.
//
//   event_sounds.<event>        the table of THEME-VERTRAG.md 3.5: any of the 124 events of render/assets/audio/manifest.json gets the theme's files (1 to 8 variants).
//                               The event keeps its id, so every trigger of the sound director (and the thunder, the finale, the deer cry ...) stays as it was; only the files change.
//   units.<t>.sound.death       the sound of one type (THEME-VERTRAG.md 3.3), read here: death (units), place, complete, collapse (buildings). shot and hit of the shooters stay in
//   buildings.<t>.sound.<slot>  render/shooter-theme.mjs. A type sound has its own trigger id (theme_u_<type>_death, theme_b_<type>_collapse ...) and wins over the event table for that type.
//
// Fallback, event by event and file by file (the classic clip never goes away):
//   - an event or slot none of whose files is delivered (the loader leaves placeholders out) is not here at all: the classic clips play;
//   - a type sound travels with `alt` = the classic clip id the director would have played, so a sound that is not in the event table (not loaded, not decodable) plays that clip;
//   - pruneEvents() takes out the files that are not there (the mix: not on disk; the live page: the fetch or the decoding failed) and with them the event, if no file is left.
// Level and rules: a theme sound plays with everything the classic event of the same job has (bus, group, priority, cooldown, voices, distance, pitch spread and the trim
// `gain_db`), see themedEvent(). The file is made to the loudness of the classic one (THEME-VERTRAG.md 3.5); nothing here changes a level on playback, so the live page and
// the broadcast mix hear the same. level_rms_db of a theme event is the loudest level of the classic event (the level the sound pipeline aims at, tools/audio/make-sounds.mjs).
//
// Pure data and pure functions: no DOM, no fs, no THREE, no Math.random, no clock. It reads a theme through getThemeSlot (a loaded Theme, or a plain test theme as in
// render/theme/placeholder-themes.mjs). The sound director (render/audio-core.mjs) takes the result as option `sounds`; the live engine (render/audio.mjs) and the mix
// (tools/audio-mix.mjs) ask the director for the events (SoundDirector.soundEvents), so both build the same table.
import { getThemeSlot } from './theme-loader.mjs';
import { EVENT_SOUNDS, MAX_VARIANTS } from './theme-schema.mjs';

// the sound slots of a type that this module reads (THEME-VERTRAG.md 3.3: units shot, hit, death; buildings shot, hit, place, complete, collapse; shot and hit: shooter-theme.mjs)
export const TYPE_SLOTS = { units: ['death'], buildings: ['place', 'complete', 'collapse'] };
export const LEVEL_DEFAULT_DB = -19; // level of a theme event whose classic event has no level list
const TYPE_RE = /^[a-z][a-z0-9_]{0,31}$/;

// A sound value of a slot: a clip id of the manifest (test themes) or a file (url or path). Same rules as render/shooter-theme.mjs: returns { id, file } or null; a file gets its own trigger id.
export function soundValue(v, tag) {
  if (typeof v !== 'string' || !v || v.length > 400) return null;
  if (/^[a-z0-9_]{1,48}$/.test(v)) return { id: v, file: null };
  if (/^(?:https?:|file:|\/|[a-z0-9_\-.]+\/)[^\s]*\.ogg$/i.test(v) && !v.includes('..')) return { id: `theme_${tag}`, file: v };
  return null;
}
const fileOf = (v) => { const s = soundValue(v, 'x'); return s && s.file ? s.file : null; };

const typesOf = (theme, kind) => (typeof theme.types === 'function' ? theme.types(kind) : Object.keys(theme[kind] && typeof theme[kind] === 'object' && !Array.isArray(theme[kind]) ? theme[kind] : {}));
export const slotKey = (isBuilding, type, slot) => `${isBuilding ? 'b' : 'u'}.${type}.${slot}`;

// the loudest classic level of an event: the level the pipeline aims at (peak-limited clips sit lower)
export function levelOf(tpl) {
  const l = Array.isArray(tpl?.level_rms_db) ? tpl.level_rms_db.filter((x) => Number.isFinite(x)) : [];
  return l.length ? Math.max(...l) : LEVEL_DEFAULT_DB;
}
// a theme event: the classic event `tpl` (its settings, its trim) with the theme's files. `from` = the id of the classic event it was made from.
export function themedEvent(tpl, files, from) {
  return { ...tpl, files: [...files], level_rms_db: files.map(() => levelOf(tpl)), source: { generator: 'theme', files: [...files] }, licence: 'theme file', theme: from };
}
// takes out the files for which ok(file) is false, and every event that is left without a file (it stays or becomes classic: the caller keeps the classic entry)
export function pruneEvents(table, ok) {
  const out = {};
  for (const [id, e] of Object.entries(table)) {
    const keep = e.files.map((f) => !!ok(f));
    if (!keep.some(Boolean)) continue;
    out[id] = keep.every(Boolean) ? e : { ...e, files: e.files.filter((_, i) => keep[i]), level_rms_db: (e.level_rms_db || []).filter((_, i) => keep[i]), source: { ...e.source, files: e.files.filter((_, i) => keep[i]) } };
  }
  return out;
}

export class SoundTheme {
  constructor(theme) {
    this.theme = theme || null;
    this.eventFiles = new Map(); // manifest event id -> the theme's files (delivered ones only, at most MAX_VARIANTS, no duplicates), ids in sorted order
    this.slots = new Map(); // slotKey -> { isBuilding, type, slot, id, file }; file null = a clip id of the manifest (test themes)
    if (!this.theme || this.theme.isClassic) return;
    const table = getThemeSlot(this.theme, EVENT_SOUNDS);
    if (table && typeof table === 'object' && !Array.isArray(table)) {
      for (const id of Object.keys(table).sort()) {
        if (!/^[a-z][a-z0-9_]{1,47}$/.test(id)) continue;
        const files = [...new Set((Array.isArray(table[id]) ? table[id] : [table[id]]).map(fileOf).filter(Boolean))].slice(0, MAX_VARIANTS);
        if (files.length) this.eventFiles.set(id, files);
      }
    }
    for (const [kind, slots] of Object.entries(TYPE_SLOTS)) {
      const isBuilding = kind === 'buildings';
      for (const type of [...typesOf(this.theme, kind)].sort()) {
        if (!TYPE_RE.test(type)) continue;
        for (const slot of slots) {
          const s = soundValue(getThemeSlot(this.theme, `${kind}.${type}.sound.${slot}`), `${isBuilding ? 'b' : 'u'}_${type}_${slot}`);
          if (s) this.slots.set(slotKey(isBuilding, type, slot), { isBuilding, type, slot, id: s.id, file: s.file });
        }
      }
    }
  }
  get active() { return this.eventFiles.size > 0 || this.slots.size > 0; }
  // the sound of one type and slot: { id, file } (id = the trigger id; file null = a clip id that is in the manifest already) or null = classic
  typeSound(isBuilding, type, slot) { return this.slots.get(slotKey(isBuilding, type, slot)) || null; }
  // The events this theme adds to the manifest or replaces in it. `events` = the classic manifest events (never an already merged table); the caller merges the result over them.
  //   event_sounds: the same id as the classic event, its settings, the theme's files (an id the manifest does not have is ignored: a theme cannot add an event)
  //   type sounds with a file: their own id, the settings of the classic clip that the director plays for that type (classicOf(isBuilding, type, slot) -> clip id)
  events(events, classicOf = () => null) {
    const out = {};
    for (const [id, files] of this.eventFiles) if (events[id]) out[id] = themedEvent(events[id], files, id);
    for (const s of this.slots.values()) {
      if (!s.file) continue;
      const cid = classicOf(s.isBuilding, s.type, s.slot), tpl = cid && events[cid];
      if (tpl) out[s.id] = themedEvent(tpl, [s.file], cid);
    }
    return out;
  }
}

// the sound theme of a theme, or null when it says nothing about sound (classic, no theme, only looks)
export function soundThemeOf(theme) {
  const s = new SoundTheme(theme);
  return s.active ? s : null;
}
// options of a SoundDirector: a shooter table carries its theme, so a caller that has one (the video path: tools/render-broadcast.mjs, tools/render-story.mjs) gets the sound theme with it
export function withSounds(opts = {}) {
  if (opts.sounds !== undefined || !opts.shooters || !opts.shooters.theme) return opts;
  const sounds = soundThemeOf(opts.shooters.theme);
  return sounds ? { ...opts, sounds } : opts;
}
