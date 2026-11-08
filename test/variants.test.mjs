import test from "node:test";
import assert from "node:assert/strict";
import { variant } from "../render/variants.mjs";
test("variants: fixed per id, inside the range, not all equal", () => {
  const seen = new Set();
  for (let id = 0; id < 500; id++) {
    const a = variant(id), b = variant(id);
    assert.deepEqual(a, b);
    assert.ok(a.s >= 0.95 && a.s <= 1.05 && a.tone >= 0.92 && a.tone <= 1.08);
    seen.add(a.s.toFixed(5));
  }
  assert.ok(seen.size > 100);
});
