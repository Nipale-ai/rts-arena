// What the screen may show of a model's note. Pure, no DOM: used by the live HUD (render/hud.mjs) and the videos (tools/lib/thought.mjs).
// A model sometimes writes its tool call into the note text ("</parameter> </function> <tool_call> <function=scout> ..."): that is no thought for a viewer,
// everything from the first such tag on goes. "food<400 wood>10" is no tag and stays.
const TOOL_TAG = /<\/?[a-z_]+(?:=[^<>\s]*)?>/i;
export function stripToolMarkup(text) {
  const t = String(text ?? ''), m = TOOL_TAG.exec(t);
  return (m ? t.slice(0, m.index) : t).trim();
}
