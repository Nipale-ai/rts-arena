// Low-power viewer (live and replay): frame cap, adaptive pixel ratio, stale-queue filter, quality toggle.
// Pure logic with no DOM access at import time, so test/perf.test.mjs can load it in node. app.mjs uses it only on the viewer path
// (not broadcast, not ?capture); the frame-exact broadcast renderer never touches this file.

export const QUALITY_KEY = 'rts-quality-v1';
export const MODES = ['auto', 'high']; // auto: 60 fps cap (30 when idle), adaptive pixel ratio, lowpower CSS. high: pixel ratio 2, no adaptive steps, 60 fps cap
export const FPS_BUSY = 60;
export const FPS_IDLE = 30;
export const IDLE_MS = 2000; // no snapshot for this long counts as idle
export const FRAME_TOL_MS = 2; // a tick this much early still draws (display jitter)
export const STALE_MS = 2000; // hidden tab: queued deaths and javelins older than this are dropped when the tab shows again
export const DPR_BASE = [1.25, 1.5, 1.75, 2];
export const DPR_START = 1.5;
export const DPR_MAX = 2;
export const BUDGET_MS = 1000 / 60; // the adaptive controller always measures against the 60 fps budget

// ---------------- frame cap ----------------
export function targetFps({ paused = false, over = false, idleMs = 0, active = false } = {}) {
  if (active) return FPS_BUSY; // the viewer is panning or rotating: keep it smooth even when the match is paused
  return paused || over || idleMs > IDLE_MS ? FPS_IDLE : FPS_BUSY;
}
// Is this animation-frame tick due? `lastDraw` is the scheduled time of the last draw (see nextDraw).
export function shouldDraw(now, lastDraw, fps) {
  return now - lastDraw >= 1000 / fps - FRAME_TOL_MS;
}
// The schedule after a draw: advance by one interval, so the average rate is exact on any refresh rate (75, 120, 144 Hz).
// When the viewer fell more than a whole interval behind, restart from now (no burst of catch-up draws).
export function nextDraw(now, lastDraw, fps) {
  const iv = 1000 / fps, n = lastDraw + iv;
  return now - n > iv ? now : n;
}

// ---------------- adaptive pixel ratio ----------------
// The steps a display can use: 1.25, 1.5, 1.75, 2 up to its own device pixel ratio (a 1x display has the single step 1).
export function dprSteps(deviceDpr) {
  const cap = Math.min(Math.max(+deviceDpr || 1, 1), DPR_MAX);
  return [...DPR_BASE.filter((s) => s < cap - 1e-6), cap];
}
export function startIndex(steps) {
  let i = 0;
  for (let k = 0; k < steps.length; k++) if (steps[k] <= DPR_START + 1e-6) i = k;
  return i;
}
// Cost of one drawn frame in ms. `work` is what we measured (CPU time of frame(), or GPU time when a timer query exists).
// A late frame (a vsync was missed: the interval is well over the target interval) costs the whole interval, because the
// capped loop hides a saturated GPU behind the wait for the next tick.
export function frameCost(workMs, intervalMs, fps) {
  const late = intervalMs > (1000 / fps) * 1.4 ? intervalMs : 0; // 1.4: a 144 Hz display draws every 2nd or 3rd tick (20.8 ms) for 60 fps, which is not late
  return Math.max(workMs, late);
}

// Steps the pixel ratio down when the smoothed frame cost stays above `downAbove` x budget for `downMs`, and up when it stays
// below `upBelow` x budget for `upMs`. At least `gapMs` between two steps. The first `warmupMs` and `settleMs` after a step are ignored.
export class AdaptiveDpr {
  constructor({ steps = DPR_BASE, index = startIndex(steps), budgetMs = BUDGET_MS, downAbove = 0.85, downMs = 2000, upBelow = 0.5, upMs = 10000, gapMs = 3000, warmupMs = 3000, settleMs = 600, alpha = 0.1 } = {}) {
    Object.assign(this, { steps, index, budgetMs, downAbove, downMs, upBelow, upMs, gapMs, warmupMs, settleMs, alpha });
    this.ema = null; this.hotSince = null; this.coolSince = null; this.lastStep = -Infinity; this.ignoreUntil = null;
  }
  get dpr() { return this.steps[this.index]; }
  reset(now, settle = this.settleMs) { this.ema = null; this.hotSince = this.coolSince = null; this.ignoreUntil = now + settle; }
  // Feed the cost of one drawn frame. Returns the new pixel ratio when a step happened, else null.
  push(now, costMs) {
    if (this.ignoreUntil === null) this.ignoreUntil = now + this.warmupMs;
    if (now < this.ignoreUntil) return null;
    this.ema = this.ema === null ? costMs : this.ema + this.alpha * (costMs - this.ema);
    if (this.ema > this.downAbove * this.budgetMs) { if (this.hotSince === null) this.hotSince = now; } else this.hotSince = null;
    if (this.ema < this.upBelow * this.budgetMs) { if (this.coolSince === null) this.coolSince = now; } else this.coolSince = null;
    if (now - this.lastStep < this.gapMs) return null;
    if (this.hotSince !== null && now - this.hotSince >= this.downMs && this.index > 0) return this.step(now, -1);
    if (this.coolSince !== null && now - this.coolSince >= this.upMs && this.index < this.steps.length - 1) return this.step(now, 1);
    return null;
  }
  step(now, d) { this.index += d; this.lastStep = now; this.reset(now); return this.dpr; }
}

// ---------------- quality mode (Auto / High) ----------------
export function nextMode(m) { return MODES[(MODES.indexOf(m) + 1) % MODES.length]; }
export function loadQuality(storage) {
  try {
    const s = JSON.parse(storage.getItem(QUALITY_KEY) || 'null');
    if (s && MODES.includes(s.mode)) return { mode: s.mode, fps: !!s.fps };
  } catch { /* storage may be blocked */ }
  return null;
}
export function saveQuality(storage, q) { try { storage.setItem(QUALITY_KEY, JSON.stringify({ mode: q.mode, fps: !!q.fps })); } catch { /* ignore */ } }

// Holds the state of the viewer: the mode, the pixel ratio (fixed in High, adaptive in Auto) and the controller.
export class ViewerPerf {
  constructor({ mode = 'auto', deviceDpr = 1 } = {}) {
    this.steps = dprSteps(deviceDpr);
    this.setMode(mode);
  }
  get lowpower() { return this.mode === 'auto'; }
  setMode(mode) {
    this.mode = MODES.includes(mode) ? mode : 'auto';
    const top = this.steps.length - 1;
    this.ctl = new AdaptiveDpr({ steps: this.steps, index: this.mode === 'high' ? top : startIndex(this.steps) });
    return this.dpr;
  }
  get dpr() { return this.ctl.dpr; }
  // one drawn frame; returns the new pixel ratio when it has to change (Auto only)
  frame(now, workMs, intervalMs, fps) {
    if (this.mode !== 'auto') return null;
    if (intervalMs > 250) { this.ctl.reset(now); return null; } // a stall, a hidden tab or a resize hitch is not a load signal
    return this.ctl.push(now, frameCost(workMs, intervalMs, fps));
  }
}

// ---------------- hidden tab ----------------
// Entries queued (qAt, ms) more than `maxAge` ago and never drawn (`pending`) are removed in place; returns how many.
// qAt is 0 in broadcast mode, so nothing is ever dropped there.
export function dropStale(coll, now, maxAge = STALE_MS, pending = () => true) {
  let n = 0;
  const stale = (e) => e && e.qAt > 0 && now - e.qAt > maxAge && pending(e);
  if (Array.isArray(coll)) { for (let i = coll.length - 1; i >= 0; i--) if (stale(coll[i])) { coll.splice(i, 1); n++; } }
  else if (coll instanceof Map) { for (const [k, e] of coll) if (stale(e)) { coll.delete(k); n++; } }
  return n;
}

// ---------------- GPU timer (optional) ----------------
// EXT_disjoint_timer_query_webgl2 around the post chain. It is often missing on macOS Chrome; then `ms` stays 0 and the
// controller works from the CPU time and the late-frame signal alone. Any error switches the timer off.
export class GpuTimer {
  constructor(gl) {
    this.gl = gl; this.ext = null; this.q = null; this.open = false; this.pending = null; this.ms = 0;
    try { this.ext = gl && gl.getExtension ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null; } catch { this.ext = null; }
  }
  get ok() { return !!this.ext; }
  begin() {
    if (!this.ext || this.pending || this.open) return;
    try { this.q = this.gl.createQuery(); this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, this.q); this.open = true; } catch { this.ext = null; }
  }
  end() {
    if (!this.open) return;
    this.open = false;
    try { this.gl.endQuery(this.ext.TIME_ELAPSED_EXT); this.pending = this.q; } catch { this.ext = null; }
  }
  // call once per frame: reads the result of an earlier query when it is ready
  poll() {
    if (!this.ext || !this.pending) return this.ms;
    try {
      const gl = this.gl, q = this.pending, disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
      if (disjoint) { gl.deleteQuery(q); this.pending = null; }
      else if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) { this.ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6; gl.deleteQuery(q); this.pending = null; }
    } catch { this.ext = null; this.pending = null; }
    return this.ms;
  }
}

// ---------------- UI ----------------
export const readout = (fps, dpr, mode) => `${Math.round(fps)} fps · ${+dpr.toFixed(2)}x ${mode === 'auto' ? 'auto' : 'high'}`;

// Button #perf next to #sound: click or key L switches Auto / High. Shift+L (or shift-click) shows or hides a small fps readout.
// onChange({ mode, fps }) is called after every switch. Returns { toggle(shift), setReadout(text), get mode }.
export function mountPerfUI(root, { mode, fps = false, onChange }) {
  if (!root) return null;
  root.innerHTML = '<button type="button" class="pq" title="Quality (L). Auto: smooth and cool. High: sharpest. Shift+L: show fps"></button><span class="pfps"></span>';
  const btn = root.querySelector('.pq'), out = root.querySelector('.pfps');
  const ui = { mode, fps };
  const sync = () => { btn.textContent = ui.mode === 'auto' ? 'Quality: Auto' : 'Quality: High'; btn.classList.toggle('on', ui.mode === 'high'); out.style.display = ui.fps ? '' : 'none'; };
  const toggle = (shift) => {
    if (shift) ui.fps = !ui.fps; else ui.mode = nextMode(ui.mode);
    sync(); onChange && onChange(ui); return ui;
  };
  btn.addEventListener('click', (e) => { toggle(e.shiftKey); btn.blur(); });
  sync();
  return { toggle, ui, setReadout(t) { if (ui.fps) out.textContent = t; } };
}

// One cached colour per owner, made on first use. `players` is G.players: owner o is players[o - 1], and owner 0 (the God mode wolves)
// is players[-1], a property that Array.map does not copy. Looking up per owner covers it.
export function ownerColorCache(players, make) {
  const cache = new Map();
  return (owner) => {
    let c = cache.get(owner);
    if (c === undefined) { c = make(players[owner - 1].color); cache.set(owner, c); }
    return c;
  };
}
