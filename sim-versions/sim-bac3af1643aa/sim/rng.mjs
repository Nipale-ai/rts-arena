// Seeded RNG (mulberry32). Pure 32 bit integer math, identical on every platform.
export class RNG {
  constructor(seed) {
    this.s = seed >>> 0;
  }
  next() {
    let t = (this.s = (this.s + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }
  int(n) {
    return this.next() % n;
  }
  range(a, b) {
    return a + this.int(b - a + 1);
  }
  pct(p) {
    return this.int(100) < p;
  }
}
