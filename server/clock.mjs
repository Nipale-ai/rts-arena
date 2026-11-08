// Fixed-step pacing for real-time matches. The number of ticks that are due is computed from the wall clock
// (target = elapsed * speed * hz) and never from a timer interval, so late timers, slow ticks, background throttling
// (nice, App Nap) or a busy event loop cannot make the game slower: they only make ticks come in bigger bursts.
// A burst is capped (default 5 s of game time); ticks beyond the cap are dropped and counted in `dropped`.
// Nothing here ever waits for a model call: LLM I/O is asynchronous and only queues commands.
import { TICK_HZ } from '../sim/util.mjs';

export class Pacer {
  constructor({ hz = TICK_HZ, now = () => performance.now(), maxBurstS = 5 } = {}) {
    this.hz = hz;
    this.now = now;
    this.maxBurst = Math.round(maxBurstS * hz);
    this.issued = 0; // ticks handed out in total
    this.dropped = 0;
    this.speed = 1;
    this.rebase(1);
  }
  rebase(speed = this.speed) {
    this.speed = speed;
    this.t0 = this.now();
    this.base = this.issued;
  }
  // call while paused / finished / waiting for the first viewer: time stops counting
  hold() { this.rebase(this.speed); }
  // ticks to run now
  take(speed = this.speed) {
    if (speed !== this.speed) this.rebase(speed);
    const target = this.base + ((this.now() - this.t0) / 1000) * this.speed * this.hz;
    let due = Math.floor(target) - this.issued;
    if (due <= 0) return 0;
    if (due > this.maxBurst) {
      const skip = due - this.maxBurst;
      this.dropped += skip;
      this.issued += skip;
      due = this.maxBurst;
    }
    this.issued += due;
    return due;
  }
}

// Calls fn every periodMs on an absolute schedule: a late call does not shift the following ones.
export function driftTimer(fn, periodMs) {
  let next = performance.now() + periodMs, stopped = false, handle = null;
  const run = () => {
    if (stopped) return;
    try { fn(); } finally {
      next += periodMs;
      const now = performance.now();
      if (next < now - 10 * periodMs) next = now; // far behind (laptop sleep): do not fire a storm
      handle = setTimeout(run, Math.max(1, next - now));
    }
  };
  handle = setTimeout(run, periodMs);
  return { stop() { stopped = true; clearTimeout(handle); } };
}
