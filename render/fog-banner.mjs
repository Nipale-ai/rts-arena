// The banner of a fog of war scene: whose eyes the viewer looks through, and what the light and the dark on the map mean.
// Pure parts (bannerSpec, enemyLine, viewTitle) are tested in node; applyBanner writes the spec into the page. No clocks: a pure function of the state
// that tools/story-show.mjs hands over (`view`).
//
//   MINIMAX'S VIEW                       the name of the side in its colour (blue for player 1, orange for player 2 as everywhere in the picture)
//   [light] SEEN NOW  [grey] SEEN BEFORE  [dark] UNKNOWN        the three shades of the map (render/fog-look.mjs: the same numbers as the overlay)
//   ENEMY UNSEEN: ALL 14 UNITS           only when the log (the re-simulated state of this very frame) says it
import { FOG_LEGEND, rgbCss, lum } from './fog-look.mjs';

export const viewTitle = (name) => `${String(name).toUpperCase()}'S VIEW`;
// text on a side colour: dark on a light colour, white on a dark one (same rule as the winner banner)
export const inkOn = (hex) => {
  const v = [1, 3, 5].map((i) => parseInt(String(hex).slice(i, i + 2), 16) / 255);
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2] > 0.45 ? '#0a0e14' : '#ffffff';
};
// seen: { n, total } from tools/story-show.mjs sightOf: units of the other side in sight / alive. Null when the state is not known: no line.
export function enemyLine(seen) {
  if (!seen || !(seen.total > 0)) return null;
  if (seen.total === 1) return seen.n === 0 ? 'ENEMY UNSEEN: 1 UNIT' : 'ENEMY IN SIGHT: 1 UNIT'; // never "1 OF 1 UNITS"
  if (seen.n === 0) return `ENEMY UNSEEN: ALL ${seen.total} UNITS`;
  return `ENEMY IN SIGHT: ${seen.n} OF ${seen.total} UNITS`;
}

// view: Show.at().view ({ p, name, a, swap: { from: {p, name}, to: {p, name}, x } | null, seen }); colorOf(p) -> '#rrggbb'
export function bannerSpec(view, colorOf) {
  if (!view || !(view.a > 0)) return null;
  const side = (o) => { const color = colorOf(o.p); return { p: o.p, title: viewTitle(o.name), color, ink: inkOn(color) }; };
  const now = side(view);
  return {
    a: view.a, ...now,
    swap: view.swap ? { from: side(view.swap.from), to: side(view.swap.to), x: view.swap.x } : null,
    legend: FOG_LEGEND.map((e) => ({ label: e.label, css: rgbCss(e.rgb), lum: +lum(e.rgb).toFixed(3) })),
    enemy: enemyLine(view.seen),
  };
}

const EYE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M1.5 12S5.5 5 12 5s10.5 7 10.5 7-4 7-10.5 7S1.5 12 1.5 12z"/><circle cx="12" cy="12" r="3.3"/></svg>';
export function ensureBanner(root) {
  if (root.dataset.built === '1') return root;
  root.dataset.built = '1';
  root.innerHTML = `<div class="fb-t"><div class="fbl">${EYE}<b></b></div><div class="fbl">${EYE}<b></b></div></div><div class="fb-g"></div><div class="fb-e"></div>`;
  return root;
}

// the title fits its bar: the font shrinks, the name is never cut
function fit(b, min = 0.55) {
  b.style.fontSize = '';
  const base = parseFloat(getComputedStyle(b).fontSize);
  let sc = 1;
  while (b.scrollWidth > b.clientWidth + 1 && sc > min) { sc -= 0.04; b.style.fontSize = (base * sc).toFixed(2) + 'px'; }
}

export function applyBanner(root, spec) {
  ensureBanner(root);
  if (!spec) { root.style.opacity = 0; root.dataset.on = '0'; return; }
  root.dataset.on = '1';
  root.style.opacity = String(spec.a);
  const A = spec.swap ? spec.swap.from : spec, B = spec.swap ? spec.swap.to : null, x = spec.swap ? spec.swap.x : 0;
  const layer = (el, side, alpha, dy) => {
    if (!side || alpha <= 0) { el.style.opacity = 0; return; }
    el.style.setProperty('--c', side.color); el.style.setProperty('--ink', side.ink);
    const b = el.querySelector('b');
    if (b.textContent !== side.title) b.textContent = side.title;
    if (b.dataset.fitted !== side.title || b.scrollWidth > b.clientWidth + 1) { fit(b); b.dataset.fitted = side.title; } // again when the font arrives late
    el.style.opacity = String(+alpha.toFixed(3));
    el.style.transform = `translateY(${dy.toFixed(1)}%)`;
  };
  const [l0, l1] = root.querySelectorAll('.fbl');
  layer(l0, A, 1, -x * 100); // the side that leaves slides up and out
  layer(l1, B, x > 0 ? 1 : 0, (1 - x) * 100); // the side that arrives slides in from below (two opaque bars, no ghost of one text over the other)
  root.style.setProperty('--tc', (B && x >= 0.5 ? B : A).color);
  const g = root.querySelector('.fb-g');
  if (g.dataset.n !== String(spec.legend.length)) {
    g.dataset.n = String(spec.legend.length);
    g.replaceChildren(...spec.legend.map((e) => { const s = document.createElement('span'), i = document.createElement('i'); i.style.background = e.css; s.append(i, e.label); return s; }));
  }
  const e = root.querySelector('.fb-e');
  e.textContent = spec.enemy || '';
}
