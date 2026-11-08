// One outline around a group of units on screen, instead of one ring per unit: forty rings cover the very units they should show.
export const GROUP_LINK_TILES = 9; // on the map: units closer than this form one group
export const GROUP_MIN = 6; // fewer units than this keep their own ring
const median = (a) => [...a].sort((p, q) => p - q)[a.length >> 1];
const near = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
// The biggest connected group: an army split in two gets its outline around the main part, not one long band across the picture.
// Two units belong together when they are closer than a fixed distance or three times the usual gap between neighbours.
export function mainGroup(pts, minLink = 130) {
  const gaps = pts.map((p, i) => Math.min(...pts.map((q, j) => (i === j ? Infinity : near(p, q)))));
  const link = Math.max(minLink, median(gaps) * 3);
  const seen = pts.map(() => false);
  let best = [];
  for (let i = 0; i < pts.length; i++) {
    if (seen[i]) continue;
    const g = [], todo = [i];
    seen[i] = true;
    while (todo.length) {
      const a = todo.pop();
      g.push(pts[a]);
      for (let j = 0; j < pts.length; j++) if (!seen[j] && near(pts[a], pts[j]) <= link) { seen[j] = true; todo.push(j); }
    }
    if (g.length > best.length) best = g;
  }
  return best;
}
const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

// pts: [[x, y], ...] in pixels. Returns the corners of the outline, or null for a group too small for one.
// Stragglers and a smaller second group do not stretch the outline.
export function groupOutline(pts, pad = 22) {
  if (pts.length < GROUP_MIN) return null;
  const kept = mainGroup(pts).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (kept.length < 3) return null;
  const half = (list) => { const h = []; for (const p of list) { while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], p) <= 0) h.pop(); h.push(p); } h.pop(); return h; };
  const hull = [...half(kept), ...half([...kept].reverse())];
  if (hull.length < 3) return null;
  const cx = hull.reduce((s, p) => s + p[0], 0) / hull.length, cy = hull.reduce((s, p) => s + p[1], 0) / hull.length;
  return hull.map((p) => { const d = Math.hypot(p[0] - cx, p[1] - cy) || 1; return [p[0] + ((p[0] - cx) / d) * pad, p[1] + ((p[1] - cy) / d) * pad]; });
}
