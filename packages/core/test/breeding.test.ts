import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { breed, expandAll, express, rollIndividual, tagMatches } from "../src";
import type { Individual, Registry, Species, Trait } from "../src";
import { fixtureRegistry, ind, miniRegistry } from "./helpers";

const N = 3000;
const count = (n: number, f: (i: number) => boolean) => {
  let c = 0;
  for (let i = 0; i < n; i++) if (f(i)) c++;
  return c;
};
const child = (reg: Registry, seed: string, parents: Individual[], extra: Record<string, unknown> = {}) =>
  breed(reg, { seed, parents, ...extra });

const body: Trait = { id: "body", slot: "body_plan", label: "body" };
const sexual: Trait = { id: "sx", slot: "repro", label: "sexual", provides: ["repro:sexual"] };
const asexual: Trait = { id: "asx", slot: "repro", label: "asexual", provides: ["repro:asexual"] };
const base = { body_plan: "body", repro: "sx" };

describe("breeding: slot inheritance", () => {
  it("is deterministic per seed", () => {
    const reg = fixtureRegistry();
    const a = rollIndividual("avian_humanoid", reg, { seed: "p1" }).individual;
    const b = rollIndividual("avian_humanoid", reg, { seed: "p2" }).individual;
    fc.assert(
      fc.property(fc.string(), (seed) => {
        expect(child(reg, seed, [a, b])).toEqual(child(reg, seed, [a, b]));
      }),
      { numRuns: 50 },
    );
  });

  it("two same-species parents are equally likely to pass on a pick", () => {
    const reg = miniRegistry({
      traits: [body, sexual, { id: "red", slot: "color", label: "" }, { id: "blue", slot: "color", label: "" }],
      species: { pools: { color: [{ trait: "red", chance: "common" }, { trait: "blue", chance: "common" }], repro: [{ trait: "sx", chance: "common" }] } },
    });
    const p1 = ind({ genotype: { ...base, color: "red" } });
    const p2 = ind({ genotype: { ...base, color: "blue" } });
    const reds = count(N, (i) => child(reg, `s${i}`, [p1, p2]).individual.genotype["color"] === "red");
    expect(reds / N).toBeGreaterThan(0.45);
    expect(reds / N).toBeLessThan(0.55);
  });

  it("an expressed pick is favoured over a latent one only when expressed_bias is raised", () => {
    const reg = miniRegistry({
      traits: [
        body, sexual,
        { id: "m1", slot: "mark", label: "", requires: ["axis:sex=male"] },
        { id: "m2", slot: "mark", label: "", requires: ["axis:sex=male"] },
      ],
      species: { pools: { mark: [{ trait: "m1", chance: "common" }, { trait: "m2", chance: "common" }], repro: [{ trait: "sx", chance: "common" }] } },
    });
    const dad = ind({ axis_values: { sex: "male" }, genotype: { ...base, mark: "m1" } }); // expressed
    const mom = ind({ axis_values: { sex: "female" }, genotype: { ...base, mark: "m2" } }); // latent
    expect(express(dad, reg).traits.find((t) => t.slot === "mark")!.expressed).toBe(true);
    expect(express(mom, reg).traits.find((t) => t.slot === "mark")!.expressed).toBe(false);
    const fromDad = () => count(N, (i) => child(reg, `e${i}`, [dad, mom]).individual.genotype["mark"] === "m1") / N;
    // default: neutral, so a latent copy is transmitted exactly as faithfully as an expressed one
    expect(fromDad()).toBeGreaterThan(0.45);
    expect(fromDad()).toBeLessThan(0.55);
    // opt-in selection pressure (2:1)
    reg.breeding = { expressed_bias: 2 };
    expect(fromDad()).toBeGreaterThan(0.62);
    expect(fromDad()).toBeLessThan(0.71);
  });

  it("a sex-limited gene is not eroded over generations (latent copies transmit as well as expressed ones)", () => {
    const reg = fixtureRegistry();
    const crest = (i: Individual) => i.genotype["crest"] === "display_crest";
    const freqAfter = (generations: number) => {
      let pop = Array.from({ length: 200 }, (_, i) => rollIndividual("avian_humanoid", reg, { seed: `g${i}` }).individual);
      const start = pop.filter(crest).length / pop.length;
      for (let g = 0; g < generations; g++) {
        const males = pop.filter((x) => x.axis_values["sex"] === "male");
        const females = pop.filter((x) => x.axis_values["sex"] === "female");
        pop = pop.map((_, i) => breed(reg, { seed: `b${g}-${i}`, parents: [males[(i * 7 + g) % males.length]!, females[(i * 13 + g * 3) % females.length]!] }).individual);
      }
      return { start, end: pop.filter(crest).length / pop.length };
    };
    const neutral = freqAfter(20);
    expect(neutral.start).toBeGreaterThan(0.25);
    expect(neutral.end).toBeGreaterThan(0.2); // holds up (it only drifts randomly)

    // documents the knob: a 2:1 expressed bias makes the gene vanish
    reg.breeding = { expressed_bias: 2 };
    expect(freqAfter(20).end).toBeLessThan(0.1);
  }, 60000);

  it("the child's slots and body plan come from the child's species", () => {
    const reg = fixtureRegistry();
    for (let i = 0; i < 30; i++) {
      const a = rollIndividual("avian_humanoid", reg, { seed: `a${i}` }).individual;
      const b = rollIndividual("avian_humanoid", reg, { seed: `b${i}` }).individual;
      const { individual, warnings } = child(reg, `k${i}`, [a, b]);
      expect(warnings).toEqual([]);
      expect(individual.genotype["body_plan"]).toBe("humanoid_body");
      expect(Object.keys(individual.genotype).sort()).toEqual(Object.keys(a.genotype).sort());
      expect(individual.conditions).toEqual([]);
      expect(individual.age).toBe(0);
      expect(express(individual, reg).life_stage).toBe("fledgling");
      expect(express(individual, reg).warnings).toEqual([]);
      for (const [name, def] of Object.entries(reg.species["avian_humanoid"]!.data!)) {
        expect(individual.scalars[name]).toBeGreaterThanOrEqual(def.range[0]);
        expect(individual.scalars[name]).toBeLessThanOrEqual(def.range[1]);
      }
    }
  });

  it("locks and an explicit starting age are honoured", () => {
    const reg = fixtureRegistry();
    const a = rollIndividual("avian_humanoid", reg, { seed: "a" }).individual;
    const b = rollIndividual("avian_humanoid", reg, { seed: "b" }).individual;
    const c = child(reg, "x", [a, b], { age: 3, locks: { genotype: { plumage_color: "slate" }, axis_values: { sex: "female" } } }).individual;
    expect(c.age).toBe(3);
    expect(c.genotype["plumage_color"]).toBe("slate");
    expect(c.axis_values["sex"]).toBe("female");
  });

  it("never produces conflicting picks, even when the parents' picks conflict across slots", () => {
    const traits: Trait[] = [
      body, sexual,
      { id: "a_none", slot: "A", label: "" },
      { id: "a_fire", slot: "A", label: "", provides: ["elem:fire"], conflicts: ["elem:water"] },
      { id: "b_none", slot: "B", label: "" },
      { id: "b_water", slot: "B", label: "", provides: ["elem:water"] },
    ];
    const reg = miniRegistry({
      traits,
      species: { pools: {
        A: ["a_none", "a_fire"].map((t) => ({ trait: t, chance: "common" })),
        B: ["b_none", "b_water"].map((t) => ({ trait: t, chance: "common" })),
        repro: [{ trait: "sx", chance: "common" }],
      } },
    });
    // dad carries fire, mom carries water: a naive per-slot inheritance could combine them
    const dad = ind({ genotype: { ...base, A: "a_fire", B: "b_none" } });
    const mom = ind({ genotype: { ...base, A: "a_none", B: "b_water" } });
    fc.assert(
      fc.property(fc.string(), (seed) => {
        const { individual: c, warnings } = child(reg, seed, [dad, mom]);
        expect(warnings).toEqual([]);
        const picked = Object.values(c.genotype).map((id) => reg.traits[id]!);
        for (const x of picked) for (const y of picked) {
          if (x === y) continue;
          expect(expandAll(x.conflicts).some((p) => expandAll(y.provides).some((t) => tagMatches(p, t)))).toBe(false);
        }
      }),
      { numRuns: 400 },
    );
  });
});

describe("breeding: traits outside the species pool are inherited (albinism, rare flaws)", () => {
  const reg = fixtureRegistry();
  const mk = (seed: string, locks = {}) => rollIndividual("avian_humanoid", reg, { seed, locks }).individual;

  it("an albino parent passes albinism on about half the time, unflagged", () => {
    const albino = mk("al", { genotype: { plumage_color: "albino" } });
    const plain = mk("pl", { genotype: { plumage_color: "slate" } });
    const n = 800;
    const results = Array.from({ length: n }, (_, i) => child(reg, `c${i}`, [albino, plain]));
    const got = results.filter((r) => r.individual.genotype["plumage_color"] === "albino").length;
    expect(got / n).toBeGreaterThan(0.42);
    expect(got / n).toBeLessThan(0.58);
    expect(results.every((r) => r.individual.inherited_from === undefined)).toBe(true);
    expect(results.every((r) => r.warnings.length === 0)).toBe(true);
  });

  it("a flaw in a slot the species never rolls is still inherited, about half the time", () => {
    const flawed = mk("fl", { genotype: { discharge_tendency: "uncontrolled_discharge" } });
    const normal = mk("nm");
    expect("discharge_tendency" in normal.genotype).toBe(false);
    const n = 800;
    const kids = Array.from({ length: n }, (_, i) => child(reg, `f${i}`, [flawed, normal]));
    const carriers = kids.filter((k) => k.individual.genotype["discharge_tendency"] === "uncontrolled_discharge");
    expect(carriers.length / n).toBeGreaterThan(0.42);
    expect(carriers.length / n).toBeLessThan(0.58);
    // electricity is universal, so an inherited flaw is expressed
    for (const k of carriers.slice(0, 50)) expect(express(k.individual, reg).tags).toContain("flaw:discharge");
    // children without it simply have no entry in that slot
    expect(kids.filter((k) => !carriers.includes(k)).every((k) => !("discharge_tendency" in k.individual.genotype))).toBe(true);
    expect(kids.every((k) => k.warnings.length === 0 && k.individual.inherited_from === undefined)).toBe(true);
  });

  it("two carriers pass the flaw on every time (bar nothing: no 'none' to draw)", () => {
    const flawed = mk("fl2", { genotype: { discharge_tendency: "uncontrolled_discharge" } });
    for (let i = 0; i < 100; i++) {
      expect(child(reg, `tw${i}`, [flawed, flawed]).individual.genotype["discharge_tendency"]).toBe("uncontrolled_discharge");
    }
  });
});

describe("breeding: other species and mutation", () => {
  const A: Species = { id: "A", label: "A", body_plan: "body", pools: { skin: [{ trait: "a1", chance: "common" }], repro: [{ trait: "sx", chance: "common" }] } };
  const B: Species = { id: "B", label: "B", body_plan: "body", pools: { skin: [{ trait: "b1", chance: "common" }], repro: [{ trait: "sx", chance: "common" }] } };
  const reg = miniRegistry({ traits: [body, sexual, { id: "a1", slot: "skin", label: "" }, { id: "b1", slot: "skin", label: "" }] });
  reg.species = { A, B };
  const pa = ind({ species: "A", genotype: { ...base, skin: "a1" } });
  const pb = ind({ species: "B", genotype: { ...base, skin: "b1" } });

  it("child species is one parent's, about evenly", () => {
    const asA = count(N, (i) => child(reg, `sp${i}`, [pa, pb]).individual.species === "A");
    expect(asA / N).toBeGreaterThan(0.46);
    expect(asA / N).toBeLessThan(0.54);
  });

  it("takes the other species' pick at the off-species rate (default 'low' = 5%) and flags it", () => {
    let nA = 0, foreign = 0;
    for (let i = 0; i < 4000; i++) {
      const { individual: c } = child(reg, `o${i}`, [pa, pb]);
      if (c.species !== "A") continue;
      nA++;
      if (c.genotype["skin"] === "b1") {
        foreign++;
        expect(c.inherited_from).toEqual({ skin: "B" });
      } else {
        expect(c.inherited_from).toBeUndefined();
      }
    }
    expect(foreign / nA).toBeGreaterThan(0.03);
    expect(foreign / nA).toBeLessThan(0.075);
  });

  it("off_species 'none' never crosses species; 'medium' (15%) does so more often", () => {
    const rate = (off: string) => {
      let nA = 0, foreign = 0;
      for (let i = 0; i < 3000; i++) {
        const { individual: c } = child(reg, `m${i}`, [pa, pb], { off_species: off });
        if (c.species !== "A") continue;
        nA++;
        if (c.genotype["skin"] === "b1") foreign++;
      }
      return foreign / nA;
    };
    expect(rate("none")).toBe(0);
    expect(rate("medium")).toBeGreaterThan(0.11);
    expect(rate("medium")).toBeLessThan(0.19);
  });

  it("a slot only the other species rolls is carried at the off-species rate, and flagged", () => {
    const greg = miniRegistry({ traits: [body, sexual, { id: "a1", slot: "skin", label: "" }, { id: "g1", slot: "gills", label: "" }] });
    greg.species = {
      A: { ...A, pools: { skin: [{ trait: "a1", chance: "common" }], repro: [{ trait: "sx", chance: "common" }] } },
      B: { ...B, pools: { gills: [{ trait: "g1", chance: "common" }], repro: [{ trait: "sx", chance: "common" }] } },
    };
    const x = ind({ species: "A", genotype: { ...base, skin: "a1" } });
    const y = ind({ species: "B", genotype: { ...base, gills: "g1" } });
    let nA = 0, gilled = 0;
    for (let i = 0; i < 4000; i++) {
      const c = child(greg, `gl${i}`, [x, y], { species: "A" }).individual;
      nA++;
      if (c.genotype["gills"]) {
        gilled++;
        expect(c.inherited_from).toEqual({ gills: "B" });
      }
    }
    expect(gilled / nA).toBeGreaterThan(0.03);
    expect(gilled / nA).toBeLessThan(0.075);
  });

  it("a forced child species is honoured", () => {
    for (let i = 0; i < 50; i++) expect(child(reg, `fs${i}`, [pa, pb], { species: "B" }).individual.species).toBe("B");
  });

  it("mutation draws from the child species' pool at the given rate", () => {
    const mreg = miniRegistry({
      traits: [body, sexual, { id: "z", slot: "mark", label: "" }, { id: "p2", slot: "mark", label: "" }],
      species: { pools: { mark: [{ trait: "p2", chance: "common" }], repro: [{ trait: "sx", chance: "common" }] } },
    });
    const parent = ind({ genotype: { ...base, mark: "z" } }); // z is not in the pool
    const rate = (mutation: string) => count(N, (i) => child(mreg, `mu${i}`, [parent, parent], { mutation }).individual.genotype["mark"] === "p2") / N;
    expect(rate("none")).toBe(0);
    expect(rate("medium")).toBeGreaterThan(0.12);
    expect(rate("medium")).toBeLessThan(0.18);
    // world-level default, overridable per call
    mreg.breeding = { mutation: "none" };
    expect(count(500, (i) => child(mreg, `w${i}`, [parent, parent]).individual.genotype["mark"] === "p2")).toBe(0);
    expect(count(500, (i) => child(mreg, `w${i}`, [parent, parent], { mutation: "medium" }).individual.genotype["mark"] === "p2")).toBeGreaterThan(30);
  });
});

describe("breeding: parent count", () => {
  const reg = miniRegistry({
    traits: [body, sexual, asexual, { id: "z", slot: "mark", label: "" }, { id: "y", slot: "mark", label: "" }],
    species: { pools: { mark: [{ trait: "z", chance: "common" }, { trait: "y", chance: "common" }], repro: [{ trait: "sx", chance: "common" }, { trait: "asx", chance: "common" }] } },
  });
  const sex = ind({ genotype: { body_plan: "body", repro: "sx", mark: "z" } });
  const asex = ind({ genotype: { body_plan: "body", repro: "asx", mark: "z" } });

  it("an asexual parent alone produces a copy (no mutation), without warnings", () => {
    for (let i = 0; i < 50; i++) {
      const { individual, warnings } = child(reg, `as${i}`, [asex], { mutation: "none" });
      expect(warnings).toEqual([]);
      expect(individual.genotype).toEqual(asex.genotype);
    }
  });

  it("warns, but still breeds, when the count contradicts the repro tags", () => {
    expect(child(reg, "w1", [sex]).warnings.map((w) => w.code)).toContain("parent_count");
    expect(child(reg, "w2", [asex, asex]).warnings.map((w) => w.code)).toContain("parent_count");
    expect(child(reg, "w3", [sex, asex]).warnings.map((w) => w.code)).toContain("parent_count");
    expect(child(reg, "ok", [sex, sex]).warnings).toEqual([]);
  });

  it("rejects zero or more than two parents", () => {
    expect(() => child(reg, "n0", [])).toThrow(/one or two parents/);
    expect(() => child(reg, "n3", [sex, sex, sex])).toThrow(/one or two parents/);
  });

  it("repro:both parents satisfy either count", () => {
    const both: Trait = { id: "bt", slot: "repro", label: "", provides: ["repro:both"] };
    const r = miniRegistry({ traits: [body, both], species: { pools: { repro: [{ trait: "bt", chance: "common" }] } } });
    const p = ind({ genotype: { body_plan: "body", repro: "bt" } });
    expect(child(r, "b1", [p]).warnings).toEqual([]);
    expect(child(r, "b2", [p, p]).warnings).toEqual([]);
  });
});

describe("breeding: axes", () => {
  const axReg = (queenInherit?: string): Registry =>
    miniRegistry({
      traits: [body, sexual],
      species: {
        pools: { repro: [{ trait: "sx", chance: "common" }] },
        axes: [
          { name: "sex", values: [{ name: "male", chance: "common" }, { name: "female", chance: "common" }] },
          {
            name: "caste",
            heritable: true,
            values: [
              { name: "worker", chance: "common", ...(queenInherit ? { inherit: "common" } : {}) },
              { name: "queen", chance: "common", ...(queenInherit ? { inherit: queenInherit } : {}) },
            ],
          },
        ],
      },
    });
  const parent = (sex: string, caste: string) => ind({ axis_values: { sex, caste }, genotype: base });

  it("a non-heritable axis (sex) is rolled fresh, not copied from the parents", () => {
    const reg = axReg();
    const males = count(2000, (i) => child(reg, `sx${i}`, [parent("female", "worker"), parent("female", "worker")]).individual.axis_values["sex"] === "male");
    expect(males / 2000).toBeGreaterThan(0.45);
    expect(males / 2000).toBeLessThan(0.55);
  });

  it("a heritable axis is inherited: identical parents give identical children (bar mutation)", () => {
    const reg = axReg();
    const same = count(2000, (i) => child(reg, `h${i}`, [parent("male", "queen"), parent("female", "queen")]).individual.axis_values["caste"] === "queen");
    // mutation (1%) re-rolls fresh, and fresh is 50/50
    expect(same / 2000).toBeGreaterThan(0.98);
  });

  it("with no `inherit` weights, differing parents are equally likely to pass their value", () => {
    const reg = axReg();
    const queens = count(N, (i) => child(reg, `d${i}`, [parent("male", "queen"), parent("female", "worker")]).individual.axis_values["caste"] === "queen");
    expect(queens / N).toBeGreaterThan(0.45);
    expect(queens / N).toBeLessThan(0.55);
  });

  it("`inherit` weights make a rare value pass down less often than a common one", () => {
    const reg = axReg("very_rare"); // queen 0.25 vs worker 4 => about 6%
    const queens = count(N, (i) => child(reg, `iw${i}`, [parent("male", "queen"), parent("female", "worker")]).individual.axis_values["caste"] === "queen");
    expect(queens / N).toBeGreaterThan(0.03);
    expect(queens / N).toBeLessThan(0.1);
  });

  it("a parent value the child species lacks falls back to a fresh roll", () => {
    const reg = axReg();
    const alien = ind({ axis_values: { sex: "male", caste: "drone" }, genotype: base });
    for (let i = 0; i < 50; i++) {
      const c = child(reg, `al${i}`, [alien, alien]).individual;
      expect(["worker", "queen"]).toContain(c.axis_values["caste"]);
    }
  });

  it("axis locks win", () => {
    const reg = axReg();
    expect(child(reg, "l", [parent("male", "queen"), parent("male", "queen")], { locks: { axis_values: { caste: "worker" } } }).individual.axis_values["caste"]).toBe("worker");
  });
});
