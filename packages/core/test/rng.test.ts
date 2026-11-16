import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createRng } from "../src";

describe("rng", () => {
  it("is deterministic for a seed", () => {
    const a = createRng("abc"), b = createRng("abc");
    expect(Array.from({ length: 20 }, () => a.next())).toEqual(Array.from({ length: 20 }, () => b.next()));
  });
  it("differs across seeds", () => {
    expect(createRng("a").next()).not.toBe(createRng("b").next());
  });
  it("numeric and string seeds with the same text agree", () => {
    expect(createRng(42).next()).toBe(createRng("42").next());
  });
  it("outputs lie in [0, 1)", () => {
    const r = createRng("range");
    for (let i = 0; i < 5000; i++) {
      const x = r.next();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
  it("fork depends on the seed path, not on consumed state", () => {
    const fresh = createRng("s").fork("x").next();
    const used = createRng("s");
    for (let i = 0; i < 100; i++) used.next();
    expect(used.fork("x").next()).toBe(fresh);
  });
  it("different fork labels are independent streams", () => {
    const r = createRng("s");
    expect(r.fork("a").next()).not.toBe(r.fork("b").next());
  });
  it("weighted never returns zero-weight items and returns undefined when empty", () => {
    const r = createRng("w");
    for (let i = 0; i < 500; i++) expect(r.weighted(["a", "b"], (x) => (x === "a" ? 0 : 1))).toBe("b");
    expect(r.weighted([], () => 1)).toBeUndefined();
    expect(r.weighted(["a"], () => 0)).toBeUndefined();
  });
  it("weighted roughly follows 4:2:1", () => {
    const r = createRng("dist");
    const counts: Record<string, number> = { c: 0, u: 0, r: 0 };
    const w = { c: 4, u: 2, r: 1 } as const;
    const N = 21000;
    for (let i = 0; i < N; i++) counts[r.weighted(["c", "u", "r"] as const, (k) => w[k])!]!++;
    expect(counts.c! / N).toBeGreaterThan(4 / 7 - 0.02);
    expect(counts.c! / N).toBeLessThan(4 / 7 + 0.02);
    expect(counts.r! / N).toBeGreaterThan(1 / 7 - 0.02);
    expect(counts.r! / N).toBeLessThan(1 / 7 + 0.02);
  });
  it("shuffle is a permutation and does not mutate its input", () => {
    fc.assert(
      fc.property(fc.array(fc.integer(), { maxLength: 30 }), fc.string(), (xs, seed) => {
        const copy = xs.slice();
        const out = createRng(seed).shuffle(xs);
        expect(xs).toEqual(copy);
        expect([...out].sort((a, b) => a - b)).toEqual([...xs].sort((a, b) => a - b));
      }),
    );
  });
});
