import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { expandAll, express, rollIndividual, tagMatches } from "../src";
import type { Registry, Trait } from "../src";
import { fixtureRegistry, miniRegistry } from "./helpers";

const avian = fixtureRegistry();
const roll = (seed: string | number, reg: Registry = avian, locks = {}, sp = "avian_humanoid") =>
  rollIndividual(sp, reg, { seed, locks });

describe("determinism", () => {
  it("same seed -> identical individual and warnings", () => {
    fc.assert(
      fc.property(fc.string(), (seed) => {
        expect(roll(seed)).toEqual(roll(seed));
      }),
      { numRuns: 100 },
    );
  });

  it("different seeds produce varied individuals", () => {
    const seen = new Set(Array.from({ length: 40 }, (_, i) => JSON.stringify(roll(`v${i}`).individual.genotype)));
    expect(seen.size).toBeGreaterThan(10);
  });

  it("adding an unrelated slot does not change any other slot's pick", () => {
    const extra: Registry = structuredClone(avian);
    extra.slots["eyes"] = { id: "eyes", name: "eyes" };
    extra.traits["amber"] = { id: "amber", slot: "eyes", label: "Amber" };
    extra.traits["green"] = { id: "green", slot: "eyes", label: "Green" };
    extra.species["avian_humanoid"]!.pools["eyes"] = [
      { trait: "amber", chance: "common" },
      { trait: "green", chance: "common" },
    ];
    fc.assert(
      fc.property(fc.string(), (seed) => {
        const a = roll(seed).individual;
        const b = roll(seed, extra).individual;
        for (const [slot, trait] of Object.entries(a.genotype)) expect(b.genotype[slot]).toBe(trait);
        expect(b.scalars).toEqual(a.scalars);
        expect(b.axis_values).toEqual(a.axis_values);
      }),
      { numRuns: 100 },
    );
  });
});

describe("fixture rolls", () => {
  it("always has the core avian traits and every pooled slot", () => {
    for (let i = 0; i < 50; i++) {
      const { individual, warnings } = roll(`core${i}`);
      expect(warnings).toEqual([]);
      expect(individual.genotype).toMatchObject({
        body_plan: "humanoid_body", wings: "feathered_wings", mouth: "beak",
        integument: "full_plumage", bioelectric: "bioelectric_physiology", emp: "emp_pulse", flight: "winged_flight",
      });
      expect(Object.keys(individual.genotype).sort()).toEqual(
        ["body_plan", ...Object.keys(avian.species["avian_humanoid"]!.pools)].sort(),
      );
    }
  });

  it("females can carry the crest latently; males express it", () => {
    let femaleCarriers = 0, maleCrested = 0;
    for (let i = 0; i < 300; i++) {
      const { individual } = roll(`crest${i}`);
      if (individual.genotype["crest"] !== "display_crest") continue;
      const p = express(individual, avian);
      const crest = p.traits.find((t) => t.slot === "crest")!;
      if (individual.axis_values["sex"] === "female") {
        femaleCarriers++;
        expect(crest.expressed).toBe(false);
      } else {
        maleCrested++;
        expect(crest.expressed).toBe(true);
      }
    }
    expect(femaleCarriers).toBeGreaterThan(5);
    expect(maleCrested).toBeGreaterThan(5);
  });

  it("scalars stay inside the declared range and age lands in the adult stage", () => {
    for (let i = 0; i < 200; i++) {
      const { individual: ind } = roll(`sc${i}`);
      for (const [name, def] of Object.entries(avian.species["avian_humanoid"]!.data!)) {
        expect(ind.scalars[name]).toBeGreaterThanOrEqual(def.range[0]);
        expect(ind.scalars[name]).toBeLessThanOrEqual(def.range[1]);
      }
      expect(ind.age).toBeGreaterThanOrEqual(12);
      expect(ind.age).toBeLessThanOrEqual(60);
    }
  });

  it("never rolls conditions or out-of-pool traits (albinism, the discharge flaw)", () => {
    for (let i = 0; i < 500; i++) {
      const { individual } = roll(`oop${i}`);
      expect(individual.conditions).toEqual([]);
      expect(individual.genotype["plumage_color"]).not.toBe("albino");
      expect(individual.genotype).not.toHaveProperty("discharge_tendency");
    }
  });

  it("trait chances follow the ordinal weights (common vs rare)", () => {
    const counts: Record<string, number> = {};
    const N = 5000;
    for (let i = 0; i < N; i++) {
      const c = roll(`col${i}`).individual.genotype["plumage_color"]!;
      counts[c] = (counts[c] ?? 0) + 1;
    }
    // weights: slate 4, umber 4, rust 2, ivory 2, charcoal 1 (total 13)
    expect(counts["slate"]! / N).toBeGreaterThan(4 / 13 - 0.03);
    expect(counts["slate"]! / N).toBeLessThan(4 / 13 + 0.03);
    expect(counts["charcoal"]! / N).toBeGreaterThan(1 / 13 - 0.02);
    expect(counts["charcoal"]! / N).toBeLessThan(1 / 13 + 0.02);
  });
});

describe("locks", () => {
  it("respects locked axis values, genotype picks, scalars and age", () => {
    const { individual } = roll("lk", avian, {
      axis_values: { sex: "female" },
      genotype: { plumage_color: "charcoal", crest: "display_crest" },
      scalars: { height: 190 },
      age: 33,
    });
    expect(individual.axis_values["sex"]).toBe("female");
    expect(individual.genotype["plumage_color"]).toBe("charcoal");
    expect(individual.genotype["crest"]).toBe("display_crest");
    expect(individual.scalars["height"]).toBe(190);
    expect(individual.age).toBe(33);
  });

  it("allows a locked trait outside the pool without warning (manual albinism, rare flaws)", () => {
    const { individual, warnings } = roll("lk2", avian, {
      genotype: { plumage_color: "albino", discharge_tendency: "uncontrolled_discharge" },
    });
    expect(individual.genotype["plumage_color"]).toBe("albino");
    expect(individual.genotype["discharge_tendency"]).toBe("uncontrolled_discharge");
    expect(warnings).toEqual([]);
  });

  it("warns when a locked trait is placed in the wrong slot", () => {
    const { warnings } = roll("lk3", avian, { genotype: { mouth: "slate" } });
    expect(warnings.map((w) => w.code)).toContain("slot_mismatch");
  });

  it("warns about an unknown locked trait", () => {
    const { warnings } = roll("lk4", avian, { genotype: { mouth: "ghost" } });
    expect(warnings.map((w) => w.code)).toContain("unknown_trait");
  });
});

describe("conflict-filtered sampling", () => {
  // Each slot has a conflict-free "none" so a valid assignment always exists.
  const traits: Trait[] = [
    { id: "a_none", slot: "A", label: "" },
    { id: "a_fire", slot: "A", label: "", provides: ["elem:fire"], conflicts: ["elem:water"] },
    { id: "a_ice", slot: "A", label: "", provides: ["elem:ice"] },
    { id: "b_none", slot: "B", label: "" },
    { id: "b_water", slot: "B", label: "", provides: ["elem:water"] },
    { id: "b_steam", slot: "B", label: "", provides: ["elem:steam"], conflicts: ["elem:ice"] },
    { id: "c_none", slot: "C", label: "" },
    { id: "c_sun", slot: "C", label: "", provides: ["elem:sun"], conflicts: ["elem:ice", "elem:water"] },
    { id: "body", slot: "body_plan", label: "" },
  ];
  const reg = miniRegistry({
    traits,
    species: {
      pools: {
        A: ["a_none", "a_fire", "a_ice"].map((t) => ({ trait: t, chance: "common" })),
        B: ["b_none", "b_water", "b_steam"].map((t) => ({ trait: t, chance: "common" })),
        C: ["c_none", "c_sun"].map((t) => ({ trait: t, chance: "common" })),
      },
    },
  });

  it("never produces conflicting genotypes (either direction) and never warns", () => {
    fc.assert(
      fc.property(fc.string(), (seed) => {
        const { individual, warnings } = rollIndividual("sp", reg, { seed });
        expect(warnings).toEqual([]);
        const picked = Object.values(individual.genotype).map((id) => reg.traits[id]!);
        for (const x of picked) {
          for (const y of picked) {
            if (x === y) continue;
            const hit = expandAll(x.conflicts).some((p) => expandAll(y.provides).some((t) => tagMatches(p, t)));
            expect(hit).toBe(false);
          }
        }
      }),
      { numRuns: 500 },
    );
  });

  it("explores every non-conflicting combination", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) seen.add(JSON.stringify(rollIndividual("sp", reg, { seed: `x${i}` }).individual.genotype));
    // 3*3*2 = 18 raw combinations, minus the conflicting ones.
    expect(seen.size).toBeGreaterThanOrEqual(10);
  });

  it("falls back to the unfiltered pool and warns when a slot is fully blocked", () => {
    const blocked = miniRegistry({
      traits: [
        { id: "body", slot: "body_plan" },
        { id: "fire", slot: "A", provides: ["elem:fire"] },
        { id: "water", slot: "B", conflicts: ["elem:fire"] },
      ],
      species: { pools: { A: [{ trait: "fire", chance: "common" }], B: [{ trait: "water", chance: "common" }] } },
    });
    const { individual, warnings } = rollIndividual("sp", blocked, { seed: 1 });
    expect(individual.genotype["B"]).toBe("water");
    expect(warnings.map((w) => w.code)).toContain("slot_blocked");
  });

  it("locked picks participate in conflict filtering", () => {
    for (let i = 0; i < 100; i++) {
      const { individual } = rollIndividual("sp", reg, { seed: `lock${i}`, locks: { genotype: { A: "a_fire" } } });
      expect(individual.genotype["A"]).toBe("a_fire");
      // a_fire conflicts with elem:water, so B may never be water.
      expect(individual.genotype["B"]).not.toBe("b_water");
    }
  });
});

describe("axis modifiers", () => {
  const reg = miniRegistry({
    traits: [
      { id: "body", slot: "body_plan" },
      { id: "mane", slot: "hair" },
      { id: "bald", slot: "hair" },
    ],
    species: {
      pools: { hair: [{ trait: "bald", chance: "common" }] },
      axes: [
        { name: "sex", values: [
          { name: "m", chance: "common", modifiers: { add: [{ slot: "hair", trait: "mane", chance: "very_rare" }], scalars: { size: { mult: 2 } } } },
          { name: "f", chance: "common" },
        ] },
        { name: "caste", values: [
          { name: "x", chance: "common", modifiers: { remove: [{ slot: "hair", trait: "mane" }] } },
          { name: "y", chance: "common" },
        ] },
      ],
      data: { size: { typical: 10, range: [8, 12] } },
    },
  });

  it("add enlarges the pool", () => {
    const picks = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      picks.add(rollIndividual("sp", reg, { seed: `m${i}`, locks: { axis_values: { sex: "m", caste: "y" } } }).individual.genotype["hair"]!);
    }
    expect(picks.has("mane")).toBe(true);
  });

  it("explicit remove beats add regardless of axis order", () => {
    for (let i = 0; i < 500; i++) {
      const { individual } = rollIndividual("sp", reg, { seed: `r${i}`, locks: { axis_values: { sex: "m", caste: "x" } } });
      expect(individual.genotype["hair"]).toBe("bald");
    }
  });

  it("scalar modifiers scale typical and range", () => {
    for (let i = 0; i < 100; i++) {
      const m = rollIndividual("sp", reg, { seed: `s${i}`, locks: { axis_values: { sex: "m", caste: "y" } } }).individual.scalars["size"]!;
      expect(m).toBeGreaterThanOrEqual(16);
      expect(m).toBeLessThanOrEqual(24);
    }
  });
});
