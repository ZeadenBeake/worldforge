import { describe, expect, it } from "vitest";
import { THEY, breed, buildSnapshot, resolvePronouns, rollIndividual } from "../src";
import type { Individual, Link } from "../src";
import { fixtureRegistry, ind, miniRegistry } from "./helpers";

const reg = fixtureRegistry();

const genotype = {
  body_plan: "humanoid_body", wings: "feathered_wings", mouth: "beak", integument: "full_plumage",
  plumage_color: "slate", plumage_pattern: "barred", crest: "display_crest",
  bioelectric: "bioelectric_physiology", emp: "emp_pulse", flight: "winged_flight",
  reproduction_mode: "sexual_reproduction", gestation: "egg_laying",
};
const male = (over: Partial<Individual> = {}): Individual =>
  ind({
    species: "avian_humanoid", seed: "golden-male", name: "Kestrel", axis_values: { sex: "male" }, genotype,
    scalars: { lifespan: 60, height: 178, weight: 66 }, age: 31, culture: "grounded_culture", religions: ["skyward_faith"], ...over,
  });

describe("snapshot: shape", () => {
  const snap = buildSnapshot(reg, { id: "k1", individual: male() });

  it("carries identity, species, seed, axis values, age and life stage", () => {
    expect(snap.individual).toEqual({ id: "k1", name: "Kestrel", pronouns: { subject: "he", object: "him", possessive: "his" } });
    expect(snap.species).toEqual({ id: "avian_humanoid", label: "Avian humanoid" });
    expect(snap.seed).toBe("golden-male");
    expect(snap.axis_values).toEqual({ sex: "male" });
    expect(snap.age).toBe(31);
    expect(snap.life_stage).toBe("adult");
  });

  it("resolves traits with labels, expression and content", () => {
    const crest = snap.traits.find((t) => t.slot === "crest")!;
    expect(crest).toMatchObject({ trait: "display_crest", label: "Display crest", expressed: true });
    expect(crest.content.prose).toMatch(/crest/);
    expect(snap.traits.every((t) => t.expressed)).toBe(true);
  });

  it("exposes parts and tags from the phenotype", () => {
    expect(snap.parts).toEqual(["part:arm.l", "part:arm.r", "part:beak", "part:head", "part:leg.l", "part:leg.r", "part:torso", "part:wing.l", "part:wing.r"]);
    expect(snap.tags).toEqual(expect.arrayContaining(["power:bioelectric", "ability:emp", "move:flight", "stage:adult", "axis:sex=male"]));
  });

  it("attaches units to scalars", () => {
    expect(snap.scalars["height"]).toEqual({ value: 178, unit: "cm" });
    expect(snap.scalars["lifespan"]).toEqual({ value: 60, unit: "years" });
  });

  it("resolves behaviors with labels, sources and content (culture's drive wins)", () => {
    const active = snap.behaviors.filter((b) => b.active).map((b) => [b.item, b.source, b.layer, b.strength]);
    expect(active).toEqual([["preens", "avian_instincts", "instinct", "habit"], ["shuns_heights", "grounded_culture", "culture", "drive"]]);
    expect(snap.behaviors.find((b) => b.item === "shuns_heights")!.content.prose).toMatch(/shameful/);
  });

  it("is plain JSON and deeply frozen (read-only)", () => {
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
    expect(() => { (snap as { age: number }).age = 1; }).toThrow();
    expect(() => { (snap.traits[0] as { expressed: boolean }).expressed = false; }).toThrow();
    expect(() => { (snap.individual.pronouns as { subject: string }).subject = "x"; }).toThrow();
  });

  it("does not mutate its input", () => {
    const i = male({ conditions: [{ condition: "wing_loss_left", since: 3 }], skills: [{ skill: "melee", level: "expert", passion: "burning" }] });
    const before = structuredClone(i);
    buildSnapshot(reg, { individual: i });
    expect(i).toEqual(before);
  });

  it("is deterministic", () => {
    expect(buildSnapshot(reg, { individual: male() })).toEqual(buildSnapshot(reg, { individual: male() }));
  });
});

describe("snapshot: golden files", () => {
  it("a healthy crested male", async () => {
    await expect(JSON.stringify(buildSnapshot(reg, { id: "kestrel", individual: male() }), null, 2) + "\n").toMatchFileSnapshot(
      "../../../fixtures/golden/avian-male-healthy.snapshot.json",
    );
  });

  it("an injured albino female carrier with skills, thoughts and relations", async () => {
    const i = ind({
      species: "avian_humanoid", seed: "golden-female", name: "Wren", axis_values: { sex: "female" },
      genotype: { ...genotype, plumage_color: "albino", discharge_tendency: "uncontrolled_discharge" },
      scalars: { lifespan: 55, height: 165, weight: 58 }, age: 44, culture: "grounded_culture",
      conditions: [
        { condition: "wing_loss_left", since: 10, note: "caught in a snare" },
        { condition: "damaged_capacitor", since: 20 },
        { condition: "cybernetic_power_cell", since: 30 },
      ],
      skills: [
        { skill: "crafting", level: "competent", passion: "interested", focus: "feather work" },
        { skill: "melee", level: "expert", passion: "burning", focus: "knives, close quarters" },
      ],
      thoughts: [
        { text: "I should never have gone back for the nest.", kind: "formative", since: 10 },
        { text: "The market is loud today.", kind: "short", since: 40, expires: 41 },
      ],
      inherited_from: { gestation: "some_other_species" },
    });
    const links: Link[] = [
      { from: "kestrel", to: "wren", type: "friend", feeling: "trusts him", since: 5 },
      { from: "wren", to: "pip", type: "parent", since: 12 },
    ];
    const snap = buildSnapshot(reg, { id: "wren", individual: i, links, names: { kestrel: "Kestrel", pip: "Pip" }, now: 40 });
    await expect(JSON.stringify(snap, null, 2) + "\n").toMatchFileSnapshot("../../../fixtures/golden/avian-female-injured.snapshot.json");
  });
});

describe("snapshot: latent traits and conditions", () => {
  it("a female carries the crest latently; inherited_from is carried onto the trait", () => {
    const snap = buildSnapshot(reg, { individual: male({ axis_values: { sex: "female" }, inherited_from: { crest: "other" } }) });
    expect(snap.traits.find((t) => t.slot === "crest")).toMatchObject({ expressed: false, inherited_from: "other" });
    expect(snap.tags).not.toContain("feature:crest");
  });

  it("conditions carry labels, kind, onset, note and why they are dormant", () => {
    const snap = buildSnapshot(reg, {
      individual: male({
        genotype: { ...genotype, discharge_tendency: "uncontrolled_discharge" },
        conditions: [{ condition: "wing_loss_left", since: 5, note: "snare" }, { condition: "wing_loss_left", since: 6 }, { condition: "ghost" }],
      }),
    });
    expect(snap.conditions[0]).toMatchObject({ condition: "wing_loss_left", label: "Left wing lost", kind_label: "amputation", target: "part:wing.l", since: 5, note: "snare", active: true });
    expect(snap.conditions[1]).toMatchObject({ active: false, inactive_reason: "target_missing" });
    expect(snap.conditions[2]).toMatchObject({ condition: "ghost", label: "ghost", active: false, inactive_reason: "unknown_condition" });
    expect(snap.warnings.map((w) => w.code)).toContain("unknown_condition");
    expect(snap.traits.find((t) => t.slot === "flight")!.expressed).toBe(false);
  });

  it("dropped behaviors stay visible, flagged, with their original outcome", () => {
    const snap = buildSnapshot(reg, { individual: male({ behavior_overrides: [{ item: "shuns_heights", action: "drop", note: "raised abroad" }] }) });
    const dropped = snap.behaviors.find((b) => b.item === "shuns_heights")!;
    expect(dropped).toMatchObject({ active: false, overridden: { action: "drop", original: "active", note: "raised abroad" } });
    expect(snap.behaviors.filter((b) => b.active).map((b) => b.item)).toContain("sky_worship");
  });
});

describe("snapshot: pronouns", () => {
  const sp = reg.species["avian_humanoid"];
  it("come from the axis value, are overridable, and default to they/them", () => {
    expect(resolvePronouns(male(), sp).subject).toBe("he");
    expect(resolvePronouns(male({ axis_values: { sex: "female" } }), sp).subject).toBe("she");
    expect(resolvePronouns(male({ pronouns: { subject: "ze", object: "zir", possessive: "zirs" } }), sp).subject).toBe("ze");
    expect(resolvePronouns(male({ axis_values: {} }), sp)).toEqual(THEY);
    // with no species there is nothing to derive pronouns from
    expect(resolvePronouns(male(), undefined)).toEqual(THEY);
  });

  it("an unknown species degrades to a warning, not a throw", () => {
    const snap = buildSnapshot(reg, { individual: ind({ species: "nope" }) });
    expect(snap.species).toEqual({ id: "nope", label: "nope" });
    expect(snap.individual.pronouns).toEqual(THEY);
    expect(snap.warnings.map((w) => w.code)).toContain("unknown_species");
  });
});

describe("snapshot: skills", () => {
  it("resolves labels, sorts by level then passion, and keeps focus", () => {
    const snap = buildSnapshot(reg, {
      individual: male({
        skills: [
          { skill: "social", level: "novice", passion: "none" },
          { skill: "crafting", level: "expert", passion: "interested", focus: "feathers" },
          { skill: "melee", level: "expert", passion: "burning" },
        ],
      }),
    });
    expect(snap.skills.map((s) => [s.skill, s.label])).toEqual([["melee", "Melee"], ["crafting", "Crafting"], ["social", "Social"]]);
    expect(snap.skills[0]!.description).toBe("Close combat");
    expect(snap.skills[1]!.focus).toBe("feathers");
  });

  it("warns on unknown skills and ordinals but keeps the entry", () => {
    const snap = buildSnapshot(reg, { individual: male({ skills: [{ skill: "basketweaving", level: "godlike", passion: "obsessed" }] }) });
    expect(snap.skills).toHaveLength(1);
    expect(snap.skills[0]!.label).toBe("basketweaving");
    expect(snap.warnings.map((w) => w.code).sort()).toEqual(["unknown_ordinal", "unknown_ordinal", "unknown_skill"]);
  });

  it("a disinterested passion ranks below none", () => {
    const snap = buildSnapshot(reg, {
      individual: male({ skills: [{ skill: "melee", level: "novice", passion: "disinterested" }, { skill: "social", level: "novice", passion: "none" }] }),
    });
    expect(snap.skills.map((s) => s.skill)).toEqual(["social", "melee"]);
  });
});

describe("snapshot: thoughts", () => {
  const thoughts = [
    { text: "old worry", kind: "short" as const, since: 1, expires: 5 },
    { text: "formative memory", kind: "formative" as const, since: 0 },
    { text: "fresh idea", kind: "short" as const, since: 9, expires: 20 },
  ];
  it("without `now`, nothing is dropped; sorted by onset", () => {
    expect(buildSnapshot(reg, { individual: male({ thoughts }) }).thoughts.map((t) => t.text)).toEqual(["formative memory", "old worry", "fresh idea"]);
  });
  it("with `now`, expired thoughts are dropped (expires <= now)", () => {
    expect(buildSnapshot(reg, { individual: male({ thoughts }), now: 5 }).thoughts.map((t) => t.text)).toEqual(["formative memory", "fresh idea"]);
    expect(buildSnapshot(reg, { individual: male({ thoughts }), now: 4 }).thoughts).toHaveLength(3);
  });
});

describe("snapshot: relations", () => {
  const links: Link[] = [
    { from: "a", to: "b", type: "friend", feeling: "warm", since: 3 },
    { from: "c", to: "a", type: "parent", since: 1 },
    { from: "x", to: "y", type: "rival" },
    { from: "a", to: "d", type: "host" },
  ];
  const snap = buildSnapshot(reg, { id: "a", individual: male(), links, names: { b: "Bea", c: "Cal" } });

  it("includes only links touching this individual, with direction and names", () => {
    expect(snap.relations).toEqual([
      { type: "host", other: "d", direction: "out" },
      { type: "parent", other: "c", other_name: "Cal", direction: "in", since: 1 },
      { type: "friend", other: "b", other_name: "Bea", direction: "out", feeling: "warm", since: 3 },
    ]);
  });

  it("without an id there are no relations", () => {
    expect(buildSnapshot(reg, { individual: male(), links }).relations).toEqual([]);
  });
});

describe("snapshot: warnings", () => {
  it("aggregates expression and behavior warnings", () => {
    const snap = buildSnapshot(reg, {
      individual: male({ culture: "ghost_culture", genotype: { ...genotype, extra: "ghost_trait" } }),
    });
    expect(snap.warnings.map((w) => w.code).sort()).toEqual(["unknown_behavior_set", "unknown_trait"]);
  });
});

describe("snapshot: integration", () => {
  it("a rolled-and-bred child snapshots cleanly with inheritance flags and no warnings", () => {
    const a = rollIndividual("avian_humanoid", reg, { seed: "pa" }).individual;
    const b = rollIndividual("avian_humanoid", reg, { seed: "pb" }).individual;
    const { individual } = breed(reg, { seed: "kid", parents: [a, b] });
    const snap = buildSnapshot(reg, { id: "kid", individual: { ...individual, name: "Pip" } });
    expect(snap.warnings).toEqual([]);
    expect(snap.life_stage).toBe("fledgling");
    expect(snap.traits.every((t) => t.inherited_from === undefined)).toBe(true);
  });

  it("works on the mini registry too (no species data, no behaviors)", () => {
    const mini = miniRegistry({ traits: [{ id: "body", slot: "body_plan", provides: ["part:head"] }] });
    const snap = buildSnapshot(mini, { individual: ind({ genotype: { body_plan: "body" } }) });
    expect(snap.parts).toEqual(["part:head"]);
    expect(snap.behaviors).toEqual([]);
    expect(snap.skills).toEqual([]);
  });
});
