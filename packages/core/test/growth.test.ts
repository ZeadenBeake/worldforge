import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { breed, buildSnapshot, growthFactor, rollIndividual, validateRegistry } from "../src";
import { fixtureRegistry, ind } from "./helpers";

describe("growthFactor", () => {
  const curve = { growth: [[0, 0.25], [12, 1]] as [number, number][] };

  it("is 1 with no curve or an empty one", () => {
    expect(growthFactor({}, 5)).toBe(1);
    expect(growthFactor({ growth: [] }, 5)).toBe(1);
  });

  it("is flat before the first point and after the last", () => {
    expect(growthFactor(curve, -3)).toBe(0.25);
    expect(growthFactor(curve, 0)).toBe(0.25);
    expect(growthFactor(curve, 12)).toBe(1);
    expect(growthFactor(curve, 90)).toBe(1);
  });

  it("interpolates linearly, with no jump at a stage boundary", () => {
    expect(growthFactor(curve, 6)).toBeCloseTo(0.625);
    expect(growthFactor(curve, 11.99)).toBeGreaterThan(0.99);
    expect(growthFactor(curve, 11.99)).toBeLessThan(1);
  });

  it("supports several points, including shrinking in old age", () => {
    const c = { growth: [[0, 0.2], [10, 1], [60, 1], [90, 0.9]] as [number, number][] };
    expect(growthFactor(c, 5)).toBeCloseTo(0.6);
    expect(growthFactor(c, 30)).toBe(1);
    expect(growthFactor(c, 75)).toBeCloseTo(0.95);
    expect(growthFactor(c, 120)).toBe(0.9);
  });

  it("does not care about point order, and a repeated age is a step, never NaN", () => {
    expect(growthFactor({ growth: [[12, 1], [0, 0.25]] }, 6)).toBeCloseTo(0.625);
    const step = { growth: [[0, 0.5], [10, 0.5], [10, 1], [20, 1]] as [number, number][] };
    for (const age of [0, 5, 10, 10.0001, 15, 25]) expect(Number.isFinite(growthFactor(step, age))).toBe(true);
  });

  it("stays within the range of its points, and never decreases when the points don't (property)", () => {
    const point = fc.tuple(fc.integer({ min: 0, max: 100 }), fc.double({ min: 0.01, max: 3, noNaN: true }));
    fc.assert(
      fc.property(fc.array(point, { minLength: 1, maxLength: 6 }), fc.double({ min: -10, max: 150, noNaN: true }), (pts, age) => {
        const f = growthFactor({ growth: pts }, age);
        const ys = pts.map((p) => p[1]);
        expect(f).toBeGreaterThanOrEqual(Math.min(...ys) - 1e-9);
        expect(f).toBeLessThanOrEqual(Math.max(...ys) + 1e-9);
      }),
      { numRuns: 400 },
    );
    fc.assert(
      fc.property(fc.uniqueArray(fc.integer({ min: 0, max: 100 }), { minLength: 2, maxLength: 6 }), fc.double({ min: 0, max: 5, noNaN: true }), (ages, step) => {
        const sorted = [...ages].sort((a, b) => a - b);
        let y = 0.1;
        const pts: [number, number][] = sorted.map((a) => [a, (y += step / 10)]); // non-decreasing
        let prev = -Infinity;
        for (let age = -5; age <= 110; age += 1.5) {
          const f = growthFactor({ growth: pts }, age);
          expect(f).toBeGreaterThanOrEqual(prev - 1e-9);
          prev = f;
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe("snapshot sizes follow age", () => {
  const reg = fixtureRegistry();
  const base = { species: "avian_humanoid", scalars: { lifespan: 60, height: 180, weight: 75 }, genotype: { body_plan: "humanoid_body" } };
  const snap = (age: number) => buildSnapshot(reg, { individual: ind({ ...base, age }) }).scalars;

  it("a newborn is a quarter of adult height and 4% of adult weight, and says what the adult value is", () => {
    const s = snap(0);
    expect(s["height"]).toEqual({ value: 45, unit: "cm", adult_value: 180 });
    expect(s["weight"]).toEqual({ value: 3, unit: "kg", adult_value: 75 });
  });

  it("grows smoothly and reaches the adult value exactly at the end of the curve", () => {
    expect(snap(6)["height"]!.value).toBeCloseTo(112.5);
    expect(snap(11.5)["height"]!.value).toBeGreaterThan(170);
    expect(snap(12)["height"]).toEqual({ value: 180, unit: "cm" }); // no adult_value once it no longer differs
    expect(snap(44)["height"]).toEqual({ value: 180, unit: "cm" });
  });

  it("scalars without a curve (lifespan) never change with age", () => {
    for (const age of [0, 5, 40]) expect(snap(age)["lifespan"]).toEqual({ value: 60, unit: "years" });
  });

  it("the stored individual keeps adult values, so age can change without re-rolling", () => {
    const young = ind({ ...base, age: 1 });
    const old = { ...young, age: 30 };
    expect(buildSnapshot(reg, { individual: old }).scalars["height"]!.value).toBe(180);
    expect(young.scalars["height"]).toBe(180);
  });

  it("a bred child is born small even though its stored size is adult-range", () => {
    const a = rollIndividual("avian_humanoid", reg, { seed: "pa" }).individual;
    const b = rollIndividual("avian_humanoid", reg, { seed: "pb" }).individual;
    const { individual } = breed(reg, { seed: "kid", parents: [a, b] });
    const [min, max] = reg.species["avian_humanoid"]!.data!["height"]!.range;
    expect(individual.scalars["height"]).toBeGreaterThanOrEqual(min); // genetic potential: adult range
    const shown = buildSnapshot(reg, { individual }).scalars["height"]!;
    expect(shown.value).toBeCloseTo(individual.scalars["height"]! * 0.25, 1);
    expect(shown.value).toBeLessThan(min / 2);
    expect(shown.adult_value).toBe(individual.scalars["height"]);
    expect(max).toBeGreaterThan(shown.value);
  });
});

describe("growth validation", () => {
  const issues = (growth: unknown) => {
    const reg = fixtureRegistry();
    reg.species["avian_humanoid"]!.data!["height"]!.growth = growth as never;
    return validateRegistry(reg).filter((w) => w.code === "invalid_growth").map((w) => w.message);
  };

  it("accepts the example curve", () => {
    expect(issues([[0, 0.25], [12, 1]])).toEqual([]);
  });
  it("flags empty curves, non-positive factors, duplicate ages and non-numbers", () => {
    expect(issues([])[0]).toMatch(/no points/);
    expect(issues([[0, 0], [12, 1]])[0]).toMatch(/above 0/);
    expect(issues([[0, -1], [12, 1]])[0]).toMatch(/above 0/);
    expect(issues([[5, 0.5], [5, 1]])[0]).toMatch(/share an age/);
    expect(issues([[0, Number.NaN], [12, 1]])[0]).toMatch(/numbers/);
  });
});
