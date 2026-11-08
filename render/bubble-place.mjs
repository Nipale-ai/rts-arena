// Where a speech bubble sits on the frame. Pure, no THREE (test/bubble-place.test.mjs). All values in NDC of the picture (-1..1).
// (px, py) = the town centre, (dx, dy) = the bubble size. The result is the sprite centre: (0.5, 0) puts the tail on the town centre, moving it shifts the bubble.
// side = { left, right, below }: overlays lie over the picture left and right of these x values for everything above y = below (-Infinity: the whole height).
// the top margin in NDC that keeps a bubble below the cards over the top of the picture: 4:5 has the plan cards there. bottoms = their lower edges in page pixels
export function topBelowCards({ viewTop, viewHeight, bottoms, base, gap = 8 }) {
  const low = Math.max(0, ...bottoms.filter((b) => Number.isFinite(b)));
  return low > viewTop ? Math.max(base, (2 * (low + gap - viewTop)) / viewHeight) : base;
}

// the vertical centre of the sprite and the free span (left, right) at that height: beside an overlay (4:5 feed, 16:9 columns) or the whole frame
function spot({ px, py, dy, margin, top, bottom = margin, side = null }) {
  const cy = Math.max(Math.min(0, (py + 1 - bottom) / dy), 1 - (1 - top - py) / dy);
  const beside = !!side && py + (1 - cy) * dy > side.below;
  return { cy, L: beside ? side.left : -1 + margin, R: beside ? side.right : 1 - margin };
}

export function bubbleCenter({ px, py, dx, dy, margin, top, bottom = margin, side = null }) {
  const { cy, L, R } = spot({ px, py, dy, margin, top, bottom, side });
  return { cx: Math.min(Math.max(0.5, 1 - (R - px) / dx), (px - L) / dx), cy };
}

// the factor (0.5 to 1) a bubble of width dx must shrink by to fit into the free span at its place (a wide feed line of a theme leaves less room beside it than the bubble needs)
export function bubbleFit({ px, py, dx, dy, margin, top, bottom = margin, side = null }) {
  const { L, R } = spot({ px, py, dy, margin, top, bottom, side });
  return Math.min(1, Math.max(0.5, (R - L) / dx));
}
