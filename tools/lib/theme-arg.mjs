// The --theme option of the tools that make a video (tools/render-story.mjs) or serve a match (server/spectate.mjs): ONE place that turns an id into everything
// such a run needs, so that picture, words and sound can never name three different themes (package C2 of the reskin).
//
//   picture  the page is opened with ?theme=<id>: tools/render-broadcast.mjs puts the environment variable RTS_QUERY into the page URL, so it gets theme=<id> (once)
//   words    every place that SHOWS a name asks render/theme/display-name.mjs, which speaks the ACTIVE theme (setActiveTheme); the places that MATCH what a model wrote ask for classic
//   sound    dirOpts.shooters (a ShooterTable) for the SoundDirector of tools/audio-mix.mjs: pass `dirOpts` to every mixCutFromReplay of the run
//
// Two steps, because a bad id must stop the run at once and the replay folder must stay look-neutral (events.json and highlights.json are written next to the replay):
//   const T = await resolveThemeArg(A.theme);   // reads and checks the theme; no side effect; throws a ThemeArgError whose message is the whole sentence to show
//   ... write what belongs to the replay ...
//   const { dirOpts } = applyThemeArg(T);       // RTS_QUERY, the active theme; dirOpts for the sound
// classic (no --theme, '' or classic) changes nothing at all: no environment, no active theme, dirOpts = {}. The sound director then runs exactly as before.
// --theme-names classic keeps the picture and the sound of the theme but not its words: for a script that is already written (and maybe already spoken) with the classic words,
// where theme names on the cards and labels would stand next to "archers" in the voice. Without the option the words follow the theme.
// A server (server/spectate.mjs) passes { video: false }: it only needs the words; the page it serves gets its picture from ?theme= in its own URL.
// Not here: the Arena (server/arena.mjs) serves many matches in one process and has no theme per match yet (package C8, the start line).
import '../../server/local-env.mjs'; // RTS_* defaults from local-env.json
import { themeById } from '../../render/theme/placeholder-themes.mjs'; // the built-in test theme of the hooks (no names)
import { loadTheme, Theme } from '../../render/theme/theme-loader.mjs'; // a theme folder such as dustmoon-v1: render/assets/themes/<id>/theme.json
import { setActiveTheme } from '../../render/theme/display-name.mjs';
import { ShooterTable } from '../../render/shooter-theme.mjs';

export const THEME_NAMES = ['theme', 'classic'];

export class ThemeArgError extends Error {
  constructor(message) { super(message); this.name = 'ThemeArgError'; }
}

// theme=<id> of a query string such as the value of RTS_QUERY, or null
export const queryTheme = (query) => new URLSearchParams(query || '').get('theme');

// The same id once: RTS_QUERY keeps every other parameter, and a theme that is already in it is not added a second time (a chunk of a parallel render gets both, the variable and --theme).
export function queryWithTheme(query, id) {
  if (queryTheme(query) !== null) return query;
  return [query, `theme=${encodeURIComponent(id)}`].filter(Boolean).join('&');
}

// arg: the value of --theme (undefined = not given, true = given without a value). opts.env: where RTS_QUERY is read (tests); opts.base: the folder of the themes (tests), as in loadTheme;
// opts.video: false for a server (it has no RTS_QUERY of a video run to agree with). opts.names: the value of --theme-names (undefined = not given): 'theme' (default) or 'classic'.
// Returns { id, classic, theme, test, key, names }: theme = the loaded Theme, the built-in test theme (test: true) or null (classic).
export async function resolveThemeArg(arg, { env = process.env, base, video = true, names } = {}) {
  if (arg === true) throw new ThemeArgError('--theme needs a theme id, such as dustmoon-v1 (or classic)');
  const given = typeof arg === 'string' && arg !== '';
  const id = given ? arg : 'classic';
  if (names !== undefined && !THEME_NAMES.includes(names)) throw new ThemeArgError(`--theme-names must be theme or classic${names === true ? '' : `, not ${names}`}`);
  if (names !== undefined && !given) throw new ThemeArgError('--theme-names needs --theme');
  const inQuery = video ? queryTheme(env.RTS_QUERY) : null;
  if (given && inQuery !== null && inQuery !== id) throw new ThemeArgError(`RTS_QUERY says theme=${inQuery} but --theme says ${id}: a run has exactly one theme`);
  const speak = names !== 'classic' ? 'theme' : 'classic';
  if (id === 'classic') return { id, classic: true, theme: null, test: false, key: 'classic', names: speak };
  const test = themeById(id);
  if (test) return { id, classic: false, theme: test, test: true, key: id, names: speak };
  let theme;
  try { theme = await loadTheme(id, base ? { base } : undefined); } catch (e) { throw new ThemeArgError(`theme "${id}": ${e.message}`); }
  return { id, classic: false, theme, test: false, key: theme.key, names: speak };
}

// Makes the run speak the theme: the words (the active theme) and, for a video run, the picture (RTS_QUERY). Gives back the options of the sound director.
// opts.video: false for a server that only needs the words; opts.env, opts.log, opts.warn: for tests.
export function applyThemeArg(resolved, { env = process.env, video = true, log = () => {}, warn = console.warn } = {}) {
  if (resolved.classic) {
    const inQuery = queryTheme(env.RTS_QUERY);
    // the old way "RTS_QUERY=theme=<id> node tools/render-story.mjs ..." themes the picture only: say so, once, instead of a half-themed video in silence
    if (video && inQuery !== null && inQuery !== 'classic') warn(`RTS_QUERY sets theme=${inQuery}: the picture is themed, the names and the sound are not. Use --theme ${inQuery} for all three.`);
    return { ...resolved, dirOpts: {} };
  }
  if (video) env.RTS_QUERY = queryWithTheme(env.RTS_QUERY, resolved.id);
  // a loaded Theme brings its own words (theme.json, then the lexicon of display-name.mjs); the built-in test theme has none, so it leaves the words classic; --theme-names classic does too
  setActiveTheme(resolved.names !== 'classic' && resolved.theme instanceof Theme ? resolved.theme : null);
  const words = resolved.names === 'classic' ? 'words classic (--theme-names classic)' : resolved.test ? 'no words (test theme of the hooks)' : 'words (active theme)';
  log(video ? `theme ${resolved.key}: picture (RTS_QUERY), ${words}, sound (shooter table)` : `theme ${resolved.key}: ${words}; open the page with ?theme=${resolved.id} for the picture`);
  return { ...resolved, dirOpts: { shooters: new ShooterTable(resolved.theme) } };
}
