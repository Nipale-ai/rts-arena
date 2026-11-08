// The theme of a PAGE (package C2 of the reskin): tells render/theme/display-name.mjs which words the page speaks, once, before any text is built.
//
//   bindPageTheme(theme)         render/assets3d.mjs Pack.init() calls it with the theme the pack loader read (?theme=<id>-vN). From then on every place of the page that SHOWS a name and is
//                                not handed a theme (render/hud.mjs, render/god.mjs, and the broadcast page, which loads the same pack) speaks that theme.
//   bindThemeFromSearch(search)  a page that has no pack (ui/editor.js, served by server/arena.mjs) loads the same theme from its own ?theme=<id>-vN and binds it: the same file, the same words.
//
// classic (no ?theme=, a theme that could not be loaded, ?theme=classic) sets NO active theme: the old words, byte for byte, and the picture and the sound do not change either.
// No DOM, no clock, no random, so it runs in the browser and in Node (tests). It never throws: a theme that does not load is classic (loadThemeSafe says why on the console).
import { setActiveTheme } from './display-name.mjs';
import { themeIdFromSearch, loadThemeSafe } from './theme-loader.mjs';

// a loaded Theme (render/theme/theme-loader.mjs) -> the active theme; classic -> none. Returns what was set (null = classic).
export function bindPageTheme(theme) {
  return setActiveTheme(theme && theme.isClassic === false ? theme : null);
}

// '?theme=dustmoon-v1' -> the theme is loaded (theme.json first, then the lexicon, then classic) and bound. Returns what was set (null = classic).
export async function bindThemeFromSearch(search) {
  return bindPageTheme(await loadThemeSafe(themeIdFromSearch(search)));
}
