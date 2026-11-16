import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { evalReqs, express } from "../src";
import { fixtureRegistry, ind, miniRegistry } from "./helpers";

const expressedSlots = (p: ReturnType<typeof express>) => p.traits.filter((t) => t.expressed).map((t) => t.slot).sort();
const state = (p: ReturnType<typeof express>, slot: string) => p.traits.find((t) => t.slot === slot)?.expressed;

describe("expression: traits", () => {
  it("expresses traits with no requirements and marks unmet ones latent", () => {
    const reg = miniRegistry({
      traits: [
        { id: "body", slot: "body_plan", provides: ["part:head"] },
        { id: "horn", slot: "horns", requires: ["part:head"], provides: ["part:horn"] },
        { id: "wing", slot: "wings", requires: ["part:torso"], provides: ["part:wing"] },
      ],
    });
    const p = express(ind({ genotype: { body_plan: "body", horns: "horn", wings: "wing" } }), reg);
    expect(state(p, "horns")).toBe(true);
    expect(state(p, "wings")).toBe(false);
    expect(p.tags).toContain("part:horn");
    expect(p.tags).not.toContain("part:wing");
  });

  it("mutual requirements never bootstrap each other", () => {
    const reg = miniRegistry({
      traits: [
        { id: "a", slot: "sa", provides: ["x:a"], requires: ["x:b"] },
        { id: "b", slot: "sb", provides: ["x:b"], requires: ["x:a"] },
      ],
    });
    const p = express(ind({ genotype: { sa: "a", sb: "b" } }), reg);
    expect(expressedSlots(p)).toEqual([]);
    expect(p.tags).toEqual([]);
  });

  it("resolves requirement chains regardless of declaration order", () => {
    const traits = [
      { id: "t1", slot: "s1", provides: ["x:1"] },
      { id: "t2", slot: "s2", requires: ["x:1"], provides: ["x:2"] },
      { id: "t3", slot: "s3", requires: ["x:2"], provides: ["x:3"] },
      { id: "t4", slot: "s4", requires: ["x:3"] },
    ];
    fc.assert(
      fc.property(fc.shuffledSubarray(traits, { minLength: 4, maxLength: 4 }), (order) => {
        const reg = miniRegistry({ traits: order });
        const genotype = Object.fromEntries(traits.map((t) => [t.slot, t.id]));
        expect(expressedSlots(express(ind({ genotype }), reg))).toEqual(["s1", "s2", "s3", "s4"]);
      }),
    );
  });

  it("supports any-of requirements", () => {
    const reg = miniRegistry({
      traits: [
        { id: "arm", slot: "arms", provides: ["part:arm.l"] },
        { id: "grip", slot: "grip", requires: [{ any: ["part:arm", "part:tentacle"] }] },
      ],
    });
    expect(state(express(ind({ genotype: { arms: "arm", grip: "grip" } }), reg), "grip")).toBe(true);
    expect(state(express(ind({ genotype: { grip: "grip" } }), reg), "grip")).toBe(false);
  });

  it("supports not-requirements", () => {
    const reg = miniRegistry({
      traits: [
        { id: "fur", slot: "coat", provides: ["cover:fur"] },
        { id: "bare", slot: "skin", requires: [{ not: "cover:fur" }] },
      ],
    });
    expect(state(express(ind({ genotype: { skin: "bare" } }), reg), "skin")).toBe(true);
    expect(state(express(ind({ genotype: { coat: "fur", skin: "bare" } }), reg), "skin")).toBe(false);
  });

  it("detects oscillating not-requirements, warns, and keeps neither", () => {
    const reg = miniRegistry({
      traits: [
        { id: "a", slot: "sa", provides: ["x:a"], requires: [{ not: "x:b" }] },
        { id: "b", slot: "sb", provides: ["x:b"], requires: [{ not: "x:a" }] },
      ],
    });
    const p = express(ind({ genotype: { sa: "a", sb: "b" } }), reg);
    expect(p.warnings.map((w) => w.code)).toContain("expression_unstable");
    expect(expressedSlots(p)).toEqual([]);
  });

  it("warns about unknown traits and skips them", () => {
    const reg = miniRegistry({ traits: [{ id: "body", slot: "body_plan" }] });
    const p = express(ind({ genotype: { body_plan: "body", x: "ghost" } }), reg);
    expect(p.warnings.map((w) => w.code)).toContain("unknown_trait");
    expect(p.traits.map((t) => t.slot)).toEqual(["body_plan"]);
  });
});

describe("expression: axes and life stages", () => {
  it("axis value tags gate expression", () => {
    const reg = miniRegistry({
      traits: [{ id: "antlers", slot: "antlers", requires: ["axis:sex=male"] }],
    });
    expect(state(express(ind({ genotype: { antlers: "antlers" }, axis_values: { sex: "male" } }), reg), "antlers")).toBe(true);
    expect(state(express(ind({ genotype: { antlers: "antlers" }, axis_values: { sex: "female" } }), reg), "antlers")).toBe(false);
  });

  it("derives life stage and a stage tag from age", () => {
    const reg = miniRegistry({
      traits: [{ id: "down", slot: "down", requires: ["stage:fledgling"] }],
      species: {
        life_stages: [
          { name: "fledgling", from_age: 0, to_age: 12 },
          { name: "adult", from_age: 12, to_age: 60 },
          { name: "elder", from_age: 60 },
        ],
      },
    });
    const young = express(ind({ age: 5, genotype: { down: "down" } }), reg);
    expect(young.life_stage).toBe("fledgling");
    expect(young.tags).toContain("stage:fledgling");
    expect(state(young, "down")).toBe(true);
    const adult = express(ind({ age: 12, genotype: { down: "down" } }), reg);
    expect(adult.life_stage).toBe("adult");
    expect(state(adult, "down")).toBe(false);
    expect(express(ind({ age: 99 }), reg).life_stage).toBe("elder");
  });
});

describe("expression: conditions as ordered layers", () => {
  const reg = miniRegistry({
    traits: [
      { id: "body", slot: "body_plan", provides: ["part:torso", "part:arm.{l,r}"] },
      { id: "grip_l", slot: "grip_l", requires: ["part:arm.l"] },
      { id: "grip_r", slot: "grip_r", requires: ["part:arm.r"] },
    ],
    conditions: [
      { id: "amputation_l", target: "part:arm.l", removes: ["part:arm.l"] },
      { id: "cyber_arm_l", provides: ["part:arm.l", "aug:cyber_arm.l"] },
    ],
  });
  const genotype = { body_plan: "body", grip_l: "grip_l", grip_r: "grip_r" };

  it("amputation removes the part and latent-izes dependents only on that side", () => {
    const p = express(ind({ genotype, conditions: [{ condition: "amputation_l", since: 1 }] }), reg);
    expect(p.parts).not.toContain("part:arm.l");
    expect(p.parts).toContain("part:arm.r");
    expect(state(p, "grip_l")).toBe(false);
    expect(state(p, "grip_r")).toBe(true);
  });

  it("a later prosthesis restores the part", () => {
    const p = express(
      ind({ genotype, conditions: [{ condition: "amputation_l", since: 1 }, { condition: "cyber_arm_l", since: 2 }] }),
      reg,
    );
    expect(p.parts).toContain("part:arm.l");
    expect(p.tags).toContain("aug:cyber_arm.l");
    expect(state(p, "grip_l")).toBe(true);
  });

  it("an amputation after the prosthesis removes it again", () => {
    const p = express(
      ind({ genotype, conditions: [{ condition: "cyber_arm_l", since: 1 }, { condition: "amputation_l", since: 2 }] }),
      reg,
    );
    expect(p.parts).not.toContain("part:arm.l");
    expect(state(p, "grip_l")).toBe(false);
  });

  it("within one condition, removes happen before provides (a swap keeps the part)", () => {
    const swap = miniRegistry({
      traits: [{ id: "body", slot: "body_plan", provides: ["part:arm.l"] }],
      conditions: [{ id: "replace_arm", removes: ["part:arm.l"], provides: ["part:arm.l", "aug:prosthetic"] }],
    });
    const p = express(ind({ genotype: { body_plan: "body" }, conditions: [{ condition: "replace_arm", since: 1 }] }), swap);
    expect(p.parts).toContain("part:arm.l");
    expect(p.tags).toContain("aug:prosthetic");
  });

  it("outcome follows `since`, not array order", () => {
    const a = express(ind({ genotype, conditions: [{ condition: "cyber_arm_l", since: 2 }, { condition: "amputation_l", since: 1 }] }), reg);
    expect(a.parts).toContain("part:arm.l");
  });

  it("a second amputation of an already-missing part is inactive (target_missing)", () => {
    const p = express(
      ind({ genotype, conditions: [{ condition: "amputation_l", since: 1 }, { condition: "amputation_l", since: 2 }] }),
      reg,
    );
    expect(p.conditions.map((c) => c.active)).toEqual([true, false]);
    expect(p.conditions[1]!.inactive_reason).toBe("target_missing");
  });

  it("a condition's own removal never invalidates its own target", () => {
    const p = express(ind({ genotype, conditions: [{ condition: "amputation_l", since: 1 }] }), reg);
    expect(p.conditions[0]!.active).toBe(true);
  });

  it("warns on unknown conditions and treats them as inactive", () => {
    const p = express(ind({ genotype, conditions: [{ condition: "ghost" }] }), reg);
    expect(p.conditions[0]).toMatchObject({ active: false, inactive_reason: "unknown_condition" });
    expect(p.warnings.map((w) => w.code)).toContain("unknown_condition");
  });
});

describe("expression: avian fixture", () => {
  const reg = fixtureRegistry();
  const base = {
    species: "avian_humanoid",
    genotype: {
      body_plan: "humanoid_body", wings: "feathered_wings", mouth: "beak", integument: "full_plumage",
      plumage_color: "slate", plumage_pattern: "plain", crest: "display_crest",
      bioelectric: "bioelectric_physiology", emp: "emp_pulse", flight: "winged_flight",
    },
    axis_values: { sex: "male" },
  };

  it("a healthy male expresses everything", () => {
    const p = express(ind(base), reg);
    expect(p.traits.every((t) => t.expressed)).toBe(true);
    expect(p.tags).toEqual(expect.arrayContaining(["power:bioelectric", "ability:emp", "move:flight", "feature:crest", "part:wing.l", "part:wing.r"]));
  });

  it("a female carries the crest latently", () => {
    const p = express(ind({ ...base, axis_values: { sex: "female" } }), reg);
    expect(state(p, "crest")).toBe(false);
    expect(p.traits.find((t) => t.slot === "crest")!.trait).toBe("display_crest");
    expect(p.tags).not.toContain("feature:crest");
  });

  it("losing one wing grounds the individual but keeps the other wing", () => {
    const p = express(ind({ ...base, conditions: [{ condition: "wing_loss_left", since: 10 }] }), reg);
    expect(p.parts).toEqual(expect.arrayContaining(["part:wing.r"]));
    expect(p.parts).not.toContain("part:wing.l");
    expect(state(p, "flight")).toBe(false);
  });

  const flawed = { ...base, genotype: { ...base.genotype, discharge_tendency: "uncontrolled_discharge" } };

  it("the discharge flaw is expressed while electricity exists", () => {
    const p = express(ind(flawed), reg);
    expect(state(p, "discharge_tendency")).toBe(true);
    expect(p.tags).toContain("flaw:discharge");
  });

  it("a damaged capacitor silences electricity, EMP and the discharge flaw (all go latent)", () => {
    const p = express(ind({ ...flawed, conditions: [{ condition: "damaged_capacitor", since: 20 }] }), reg);
    expect(p.tags).not.toContain("power:bioelectric");
    expect(p.tags).not.toContain("ability:shock");
    expect(state(p, "emp")).toBe(false);
    expect(state(p, "discharge_tendency")).toBe(false);
    expect(p.tags).not.toContain("flaw:discharge");
    // still carried in the genotype, so it can be inherited
    expect(p.traits.find((t) => t.slot === "discharge_tendency")!.trait).toBe("uncontrolled_discharge");
  });

  it("a cybernetic power cell revives EMP (any-of) but not the flaw", () => {
    const p = express(
      ind({ ...flawed, conditions: [{ condition: "damaged_capacitor", since: 20 }, { condition: "cybernetic_power_cell", since: 30 }] }),
      reg,
    );
    expect(state(p, "emp")).toBe(true);
    expect(p.tags).toContain("power:cybernetic");
    expect(state(p, "discharge_tendency")).toBe(false);
  });

  it("albinism is an ordinary trait that provides its own tag", () => {
    const p = express(ind({ ...base, genotype: { ...base.genotype, plumage_color: "albino" } }), reg);
    expect(p.tags).toContain("pigment:absent");
  });
});

describe("expression: properties", () => {
  const reg = fixtureRegistry();
  const slots = Object.keys(reg.species["avian_humanoid"]!.pools);
  const condIds = Object.keys(reg.conditions);

  const individualArb = fc.record({
    genotype: fc
      .tuple(
        fc.record(
          Object.fromEntries(
            slots.map((s) => [s, fc.constantFrom(...reg.species["avian_humanoid"]!.pools[s]!.map((e) => e.trait))]),
          ),
        ),
        fc.boolean(), // manually added flaw
        fc.boolean(), // manually added albinism
      )
      .map(([g, flaw, albino]) => ({
        ...g,
        ...(flaw ? { discharge_tendency: "uncontrolled_discharge" } : {}),
        ...(albino ? { plumage_color: "albino" } : {}),
      })),
    sex: fc.constantFrom("male", "female"),
    age: fc.integer({ min: 0, max: 90 }),
    conds: fc.array(fc.record({ condition: fc.constantFrom(...condIds), since: fc.integer({ min: 0, max: 50 }) }), { maxLength: 5 }),
  });

  it("is a sound and complete fixed point: expressed <=> requirements hold in the final tags", () => {
    fc.assert(
      fc.property(individualArb, (a) => {
        const i = ind({
          species: "avian_humanoid",
          genotype: { body_plan: "humanoid_body", ...a.genotype },
          axis_values: { sex: a.sex },
          age: a.age,
          conditions: a.conds,
        });
        const p = express(i, reg);
        expect(p.warnings).toEqual([]);
        for (const t of p.traits) {
          expect(t.expressed).toBe(evalReqs(reg.traits[t.trait]!.requires, p.tags));
        }
        for (const c of p.conditions) {
          const def = reg.conditions[c.condition]!;
          if (c.active) expect(evalReqs(def.requires, p.tags)).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("is deterministic and independent of genotype key order", () => {
    fc.assert(
      fc.property(individualArb, (a) => {
        const g1 = { body_plan: "humanoid_body", ...a.genotype };
        const g2 = Object.fromEntries(Object.entries(g1).reverse());
        const mk = (genotype: Record<string, string>) =>
          express(ind({ species: "avian_humanoid", genotype, axis_values: { sex: a.sex }, age: a.age, conditions: a.conds }), reg);
        expect(mk(g1)).toEqual(mk(g2));
      }),
      { numRuns: 100 },
    );
  });

  it("removing a part latent-izes everything that requires it", () => {
    fc.assert(
      fc.property(fc.constantFrom("wing_loss_left", "wing_loss_right"), fc.integer({ min: 0, max: 10 }), (cond, since) => {
        const genotype = { body_plan: "humanoid_body", wings: "feathered_wings", flight: "winged_flight" };
        const p = express(ind({ species: "avian_humanoid", genotype, conditions: [{ condition: cond, since }] }), reg);
        expect(state(p, "flight")).toBe(false);
        expect(state(p, "wings")).toBe(true);
      }),
    );
  });
});
