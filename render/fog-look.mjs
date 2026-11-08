// The look of the fog of war on the map: one source for the dark overlay in the 3D view (render/app.mjs) and for the legend of the
// fog banner in the broadcast (render/fog-banner.mjs). Pure data and arithmetic, no DOM, no THREE.
//
// The overlay is one dark tint laid over the ground. Its strength per tile comes from the sim state of the player whose view it is
// (tools/render-broadcast.mjs fogMsg: 2 = in sight now, 1 = explored earlier, 0 = never seen):
//   in sight now   no overlay: the ground as it is
//   seen before    a light veil: the ground is still known, but nothing that moves there is shown (a unit of the enemy is only drawn in sight)
//   unknown        a heavy veil: the player has never seen this ground
export const FOG_TINT = [6, 9, 14];
export const FOG_ALPHA = { visible: 0, seen: 105, unknown: 225 }; // 0..255, as written into the overlay texture (live spectator page)
// The broadcast draws the scene through tone mapping and an sRGB curve: a dark veil of 225/255 over bright ground still came out at about 60 % of the
// brightness of the ground ("dark" was only dim), so the veils are heavier there. The legend reads these numbers too.
export const FOG_ALPHA_BROADCAST = { visible: 0, seen: 125, unknown: 242 };

export const FOG_STATE = { 2: 'visible', 1: 'seen', 0: 'unknown' };

// The broadcast lifts the blacks (tone mapping, colour grade and bloom): even a fully covered tile does not go below about 4 % of full light. Measured on
// the frames of match 8 (ground in sight (100, 118, 98), never seen (57, 62, 70)). The legend swatches are made with the same arithmetic.
export const BLACK_LIFT = 0.04;
const toLin = (v) => Math.pow(v / 255, 2.2), toDisp = (l) => Math.round(255 * Math.pow(Math.max(0, Math.min(1, l)), 1 / 2.2));
// the colour a tile has on screen when the ground in sight shows `ground` ([r, g, b], 0..255): the veil is mixed in light (not in display values)
export function fogShade(state, ground, alphas = FOG_ALPHA_BROADCAST) {
  const a = (alphas[state] ?? 0) / 255;
  return ground.map((g, i) => toDisp(toLin(FOG_TINT[i]) * a + Math.max(0, toLin(g) - BLACK_LIFT) * (1 - a) + BLACK_LIFT));
}

// legend of the banner: what each shade means, in the words of the picture (a typical stretch of grass as the ground)
export const LEGEND_GROUND = [100, 118, 98];
export const FOG_LEGEND = [
  { state: 'visible', label: 'SEEN NOW' },
  { state: 'seen', label: 'SEEN BEFORE' },
  { state: 'unknown', label: 'UNKNOWN' },
].map((e) => ({ ...e, rgb: fogShade(e.state, LEGEND_GROUND) }));

export const rgbCss = (c) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
export const lum = (c) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
