// What a viewer must never see in a broadcast frame: text cut off, a panel under the footer, two labels on top of each other.
// The renderer asks this once per second of video (tools/render-broadcast.mjs) and reports every fault it finds.
const CUT = ['.mu b', '.pname', '.fl span', '#versus .vn', '#showtag', '#ticker span', '.kv span', '.seg span'];
const BOXES = ['#timebox', '#showtag', '#fogban', '#tag', '#ticker', '#feed', '#versus', '#sc0', '#sc1', '#split', '#inset', '#caps'];
// the fog banner never covers the class and the match-up on top, the captions and the decision card, the player cards, the chapter bar or the footer
export const BANNER_MIN = 0.25;
export const BANNER_KEEP_OFF = ['#head', '#cls', '#caps .cap', '#mom', '#pn0', '#pn1', '#tlbar', '#foot'];

export const overlap = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;

// labels on the map never lie on each other: a label that would cover an earlier one moves up until it is free
export function spreadLabels(boxes, gap = 4, avoid = []) {
  const placed = [];
  for (const b of boxes) {
    const q = { ...b };
    const clash = (p) => q.x < p.x + p.w + gap && p.x < q.x + q.w + gap && q.y < p.y + p.h + gap && p.y < q.y + q.h + gap;
    for (let n = 0; n <= boxes.length + avoid.length; n++) {
      const hit = placed.find(clash) || avoid.find(clash);
      if (!hit) break;
      const up = hit.y - q.h - gap; // up unless that leaves the picture
      q.y = up >= 4 ? up : hit.y + hit.h + gap;
    }
    q.blocked = !!(placed.find(clash) || avoid.find(clash)); // no free place near it: the page leaves this one out, half a label behind a card is worse than none
    placed.push(q);
  }
  return placed;
}

// the overlay boxes that labels must keep off, in the coordinates of the given rectangle (the picture)
export const LABEL_AVOID = ['#timebox', '#showtag', '#fogban', '#caps .cap', '#sc0', '#sc1', '#split', '#versus', '#inset', '#feed > *'];
export const LABEL_AVOID_CLEAN = ['#timebox', '#showtag', '#fogban', '#caps .cap'];
export function overlayBoxes(doc, r, list = LABEL_AVOID) {
  const win = doc.defaultView, out = [];
  for (const sel of list) for (const el of doc.querySelectorAll(sel)) {
    if (!shown(win, el)) continue;
    const q = el.getBoundingClientRect();
    out.push({ x: q.left - r.left, y: q.top - r.top, w: q.width, h: q.height });
  }
  return out;
}

// min: an element that is still fading in (or already out) below this opacity is not there yet (nobody sees it): the fog banner counts from a quarter on, while the cards it replaces are gone
function shown(win, el, min = 0) {
  for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
    const s = win.getComputedStyle(e);
    if (s.display === 'none' || s.visibility === 'hidden' || (min > 0 ? +s.opacity < min : +s.opacity === 0)) return false;
  }
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

export function layoutFaults(doc) {
  const win = doc.defaultView, out = [];
  for (const sel of CUT) for (const el of doc.querySelectorAll(sel)) {
    if (shown(win, el) && el.scrollWidth > el.clientWidth + 1) out.push(`text cut in ${sel}: ${String(el.textContent).trim().slice(0, 60)}`);
  }
  const foot = doc.querySelector('#foot');
  if (foot && shown(win, foot)) {
    const top = foot.getBoundingClientRect().top;
    for (const el of doc.querySelectorAll('.pn .kv')) if (shown(win, el) && el.getBoundingClientRect().bottom > top + 1) out.push('panel lies under the footer');
    for (const el of doc.querySelectorAll('.pn')) if (shown(win, el) && el.scrollHeight > el.clientHeight + 1) out.push(`panel content cut off (${el.scrollHeight} > ${el.clientHeight})`);
  }
  const boxes = BOXES.map((sel) => [sel, doc.querySelector(sel)]).filter(([sel, el]) => el && el.childNodes.length && shown(win, el, sel === '#fogban' || sel === '#inset' ? BANNER_MIN : 0));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    if (overlap(boxes[i][1].getBoundingClientRect(), boxes[j][1].getBoundingClientRect())) out.push(`${boxes[i][0]} over ${boxes[j][0]}`);
  }
  // 16:9 story cut: the two decision cards sit in the lower corners, each on the side of its team, off the footer and the captions, the player cards and the picture edge
  if (doc.body.classList.contains('story') && doc.body.classList.contains('preset-yt')) {
    const W = doc.body.getBoundingClientRect(), ft = foot && shown(win, foot) ? foot.getBoundingClientRect().top : W.height;
    const cards = ['#sc0', '#sc1'].map((sel) => [sel, doc.querySelector(sel)]).filter(([, el]) => el && el.childNodes.length && shown(win, el));
    for (const [sel, el] of cards) {
      const r = el.getBoundingClientRect(), side = sel === '#sc0' ? r.right <= W.width / 2 : r.left >= W.width / 2;
      if (!side) out.push(`${sel} is not on its own side of the picture`);
      if (r.bottom > ft - 8) out.push(`${sel} lies on the footer`);
      if (r.left < 8 || r.right > W.width - 8 || r.top < 0) out.push(`${sel} leaves the picture`);
      for (const other of ['#pn0', '#pn1', '#lower .cap', '#feed > *']) for (const o of doc.querySelectorAll(other)) {
        if (!shown(win, o)) continue;
        const q = o.getBoundingClientRect();
        if (overlap({ left: r.left - 8, right: r.right + 8, top: r.top - 8, bottom: r.bottom + 8 }, q)) out.push(`${sel} too close to ${other}`);
      }
    }
  }
  const ban = doc.querySelector('#fogban');
  if (ban && shown(win, ban, BANNER_MIN)) {
    const r = ban.getBoundingClientRect();
    for (const sel of BANNER_KEEP_OFF) for (const el of doc.querySelectorAll(sel)) if (shown(win, el) && overlap(r, el.getBoundingClientRect())) out.push(`#fogban over ${sel}`);
    const body = doc.body.getBoundingClientRect();
    if (r.left < 0 || r.top < 0 || r.right > body.width || r.bottom > body.height) out.push('#fogban leaves the picture');
    for (const b of ban.querySelectorAll('.fbl b')) if (shown(win, b) && b.scrollWidth > b.clientWidth + 1) out.push(`text cut in #fogban: ${String(b.textContent).trim()}`);
  }
  return [...new Set(out)];
}
