import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { express, resolveBehaviors, rollIndividual, tagMatches, DEFAULT_ORDINALS } from "../src";
import type { BehaviorItem, BehaviorOverride, BehaviorSet, Registry } from "../src";
import { fixtureRegistry, ind, miniRegistry } from "./helpers";

const item = (id: string, strength: string, extra: Partial<BehaviorItem> = {}): BehaviorItem => ({ id, label: id, strength, ...extra });
const set = (id: string, role: BehaviorSet["role"], items: BehaviorItem[]): BehaviorSet => ({ id, label: id, role, items });

function world(sets: { inst?: BehaviorItem[]; cult?: BehaviorItem[]; rel?: BehaviorItem[]; extra?: BehaviorSet[] }): Registry {
  return miniRegistry({
    behaviors: [
      set("inst", "instinct", sets.inst ?? []),
      set("cult", "culture", sets.cult ?? []),
      set("rel", "religion", sets.rel ?? []),
      ...(sets.extra ?? []),
    ],
    species: { instincts: "inst" },
  });
}
const who = (over: { overrides?: BehaviorOverride[] } = {}) =>
  ind({ culture: "cult", religions: ["rel"], behavior_overrides: over.overrides });
const ids = (r: ReturnType<typeof resolveBehaviors>) => r.behaviors.filter((b) => b.active).map((b) => b.item);

describe("behavior resolution: collection and conflicts", () => {
  it("collects instincts, then culture, then religions, in order, with layers", () => {
    const reg = world({ inst: [item("i1", "nudge")], cult: [item("c1", "habit")], rel: [item("r1", "drive")] });
    const r = resolveBehaviors(who(), [], reg);
    expect(r.behaviors.map((b) => [b.item, b.layer, b.set])).toEqual([
      ["i1", "instinct", "inst"], ["c1", "culture", "cult"], ["r1", "religion", "rel"],
    ]);
  });

  it("the higher strength wins a conflict regardless of layer", () => {
    const reg = world({
      inst: [item("hunt", "nudge", { provides: ["act:hunt"] })],
      cult: [item("taboo", "drive", { conflicts: ["act:hunt"] })],
    });
    const r = resolveBehaviors(who(), [], reg);
    expect(ids(r)).toEqual(["taboo"]);
    expect(r.suppressed).toEqual([expect.objectContaining({ item: "hunt", by: "taboo", layer: "instinct" })]);
  });

  it("conflicts are symmetric (either side may declare them)", () => {
    const a = world({ inst: [item("x", "habit", { conflicts: ["t:y"] })], cult: [item("y", "habit", { provides: ["t:y"] })] });
    const b = world({ inst: [item("x", "habit", { provides: ["t:x"] })], cult: [item("y", "habit", { conflicts: ["t:x"] })] });
    expect(ids(resolveBehaviors(who(), [], a))).toEqual(["x"]);
    expect(ids(resolveBehaviors(who(), [], b))).toEqual(["x"]);
  });

  it("ties go to the earlier layer: instinct > culture > religion", () => {
    const reg = world({
      inst: [item("i", "drive", { provides: ["t:a"] })],
      cult: [item("c", "drive", { provides: ["t:b"], conflicts: ["t:a"] })],
      rel: [item("r", "drive", { conflicts: ["t:a", "t:b"] })],
    });
    expect(ids(resolveBehaviors(who(), [], reg))).toEqual(["i"]);
  });

  it("ties inside one set go to the earlier item", () => {
    const reg = world({ cult: [item("first", "habit", { provides: ["t:a"] }), item("second", "habit", { conflicts: ["t:a"] })] });
    expect(ids(resolveBehaviors(who(), [], reg))).toEqual(["first"]);
  });

  it("a suppressed item blocks nobody: A>B, B-C conflict leaves A and C active", () => {
    const reg = world({
      inst: [item("A", "compulsion", { provides: ["t:a"] })],
      cult: [item("B", "drive", { provides: ["t:b"], conflicts: ["t:a"] })],
      rel: [item("C", "habit", { conflicts: ["t:b"] })],
    });
    const r = resolveBehaviors(who(), [], reg);
    expect(ids(r)).toEqual(["A", "C"]);
    expect(r.suppressed.map((s) => s.item)).toEqual(["B"]);
  });

  it("respects a world's renamed/extended strength ordinals", () => {
    const reg = world({
      inst: [item("a", "whim", { provides: ["t:a"] })],
      cult: [item("b", "nudge", { conflicts: ["t:a"] })],
    });
    reg.ordinals.strength["whim"] = 0.5;
    expect(ids(resolveBehaviors(who(), [], reg))).toEqual(["b"]);
  });
});

describe("behavior resolution: requirements", () => {
  it("items with unmet requirements are dormant and do not suppress anyone", () => {
    const reg = world({
      inst: [item("fly_hunt", "compulsion", { requires: ["move:flight"], provides: ["t:hunt"] })],
      cult: [item("lie_low", "habit", { conflicts: ["t:hunt"] })],
    });
    const grounded = resolveBehaviors(who(), ["part:torso"], reg);
    expect(ids(grounded)).toEqual(["lie_low"]);
    expect(grounded.dormant.map((d) => d.item)).toEqual(["fly_hunt"]);
    const flying = resolveBehaviors(who(), ["move:flight"], reg);
    expect(ids(flying)).toEqual(["fly_hunt"]);
  });
});

describe("behavior resolution: overrides", () => {
  const reg = world({
    inst: [item("hunt", "nudge", { provides: ["act:hunt"] })],
    cult: [item("taboo", "drive", { conflicts: ["act:hunt"] })],
    extra: [set("misc", "other", [item("extra_fear", "compulsion", { conflicts: ["act:hunt"] }), item("dormant_thing", "habit", { requires: ["x:never"] })])],
  });

  it("drop: the item is kept in the output as inactive, with its original outcome", () => {
    const r = resolveBehaviors(who({ overrides: [{ item: "taboo", action: "drop", note: "raised abroad" }] }), [], reg);
    const taboo = r.behaviors.find((b) => b.item === "taboo")!;
    expect(taboo.active).toBe(false);
    expect(taboo.overridden).toEqual({ action: "drop", original: "active", note: "raised abroad" });
    // dropping the winner frees the loser
    expect(ids(r)).toEqual(["hunt"]);
  });

  it("drop of an item that would have lost anyway reports original 'suppressed'", () => {
    const r = resolveBehaviors(who({ overrides: [{ item: "hunt", action: "drop" }] }), [], reg);
    expect(r.behaviors.find((b) => b.item === "hunt")!.overridden).toMatchObject({ action: "drop", original: "suppressed" });
  });

  it("keep: pins an item so it wins conflicts it would have lost", () => {
    const r = resolveBehaviors(who({ overrides: [{ item: "hunt", action: "keep" }] }), [], reg);
    expect(ids(r)).toEqual(["hunt"]);
    expect(r.behaviors[0]!.overridden).toMatchObject({ action: "keep", original: "suppressed" });
    expect(r.suppressed.map((s) => s.item)).toEqual(["taboo"]);
  });

  it("force: adds an item that is in none of the layers and beats stronger rivals", () => {
    const r = resolveBehaviors(who({ overrides: [{ item: "extra_fear", action: "force" }] }), [], reg);
    const fear = r.behaviors.find((b) => b.item === "extra_fear")!;
    expect(fear).toMatchObject({ active: true, layer: "forced", set: "misc" });
    expect(fear.overridden).toMatchObject({ action: "force", original: "absent" });
  });

  it("force: overrides unmet requirements", () => {
    const r = resolveBehaviors(who({ overrides: [{ item: "dormant_thing", action: "force" }] }), [], reg);
    expect(ids(r)).toContain("dormant_thing");
  });

  it("force on an item already in a layer but dormant reports original 'dormant'", () => {
    const r2 = world({ inst: [item("fly", "habit", { requires: ["move:flight"] })] });
    const r = resolveBehaviors(who({ overrides: [{ item: "fly", action: "force" }] }), [], r2);
    expect(r.behaviors[0]!.overridden).toMatchObject({ original: "dormant", action: "force" });
    expect(r.behaviors[0]!.layer).toBe("instinct");
  });

  it("two conflicting pinned items: earlier wins, with a warning", () => {
    const r = resolveBehaviors(who({ overrides: [{ item: "hunt", action: "keep" }, { item: "taboo", action: "keep" }] }), [], reg);
    expect(ids(r)).toEqual(["hunt"]);
    expect(r.warnings.map((w) => w.code)).toContain("override_conflict");
  });

  it("warns on unknown items, keep-not-present, duplicate overrides, unknown sets and duplicate item ids", () => {
    const r = resolveBehaviors(
      ind({
        culture: "ghost_culture",
        behavior_overrides: [
          { item: "nope", action: "drop" },
          { item: "extra_fear", action: "keep" },
          { item: "hunt", action: "drop" },
          { item: "hunt", action: "keep" },
        ],
      }),
      [],
      reg,
    );
    const codes = r.warnings.map((w) => w.code);
    expect(codes).toEqual(expect.arrayContaining(["unknown_behavior_item", "keep_not_present", "duplicate_override", "unknown_behavior_set"]));
    // last override wins
    expect(r.behaviors.find((b) => b.item === "hunt")!.overridden!.action).toBe("keep");

    const dup = world({ inst: [item("same", "nudge")], cult: [item("same", "drive")] });
    expect(resolveBehaviors(who(), [], dup).warnings.map((w) => w.code)).toContain("duplicate_behavior_item");
  });

  it("is deterministic", () => {
    const o = who({ overrides: [{ item: "hunt", action: "keep" }] });
    expect(resolveBehaviors(o, [], reg)).toEqual(resolveBehaviors(o, [], reg));
  });
});

describe("behavior resolution: avian fixture", () => {
  const reg = fixtureRegistry();
  const base = {
    species: "avian_humanoid",
    genotype: rollIndividual("avian_humanoid", reg, { seed: "bh" }).individual.genotype,
    axis_values: { sex: "male" },
    culture: "grounded_culture",
    religions: ["skyward_faith"],
  };
  const resolve = (over: Parameters<typeof ind>[0] = {}) => {
    const i = ind({ ...base, ...over });
    return resolveBehaviors(i, express(i, reg).tags, reg);
  };

  it("the culture's drive beats both the instinct nudge and the religion on ties-by-layer", () => {
    const r = resolve();
    expect(ids(r).sort()).toEqual(["preens", "shuns_heights"]);
    expect(r.suppressed.map((s) => [s.item, s.by]).sort()).toEqual([["roosts_high", "shuns_heights"], ["sky_worship", "shuns_heights"]]);
  });

  it("dropping the cultural taboo frees both the instinct and the faith (they agree with each other)", () => {
    const r = resolve({ behavior_overrides: [{ item: "shuns_heights", action: "drop" }] });
    expect(ids(r).sort()).toEqual(["preens", "roosts_high", "sky_worship"]);
    expect(r.suppressed).toEqual([]);
    expect(r.behaviors.find((b) => b.item === "shuns_heights")!.overridden).toMatchObject({ original: "active" });
  });

  it("losing both wings makes the wing-dependent instinct dormant", () => {
    const r = resolve({ conditions: [{ condition: "wing_loss_left", since: 1 }, { condition: "wing_loss_right", since: 2 }] });
    expect(r.dormant.map((d) => d.item)).toEqual(["roosts_high"]);
  });
});

describe("behavior resolution: properties", () => {
  const TAGS = ["t:a", "t:b", "t:c"];
  const STRENGTHS = Object.keys(DEFAULT_ORDINALS.strength);
  const itemArb = fc.record({
    strength: fc.constantFrom(...STRENGTHS),
    layer: fc.constantFrom("inst", "cult", "rel"),
    provides: fc.subarray(TAGS),
    conflicts: fc.subarray(TAGS),
    needsFlight: fc.boolean(),
  });

  type ItemSpec = { strength: string; layer: "inst" | "cult" | "rel"; provides: string[]; conflicts: string[]; needsFlight: boolean };
  const build = (items: ItemSpec[]) => {
    const per: Record<string, BehaviorItem[]> = { inst: [], cult: [], rel: [] };
    items.forEach((it, n) =>
      per[it.layer]!.push(item(`b${n}`, it.strength, { provides: it.provides, conflicts: it.conflicts, ...(it.needsFlight ? { requires: ["move:flight"] } : {}) })),
    );
    return world({ inst: per["inst"], cult: per["cult"], rel: per["rel"] });
  };
  const conflicts = (a: BehaviorItem, b: BehaviorItem) =>
    (a.conflicts ?? []).some((p) => (b.provides ?? []).some((t) => tagMatches(p, t))) ||
    (b.conflicts ?? []).some((p) => (a.provides ?? []).some((t) => tagMatches(p, t)));

  it("without overrides: no active pair conflicts, and each loser is beaten by an active rival that outranks it", () => {
    fc.assert(
      fc.property(fc.array(itemArb, { minLength: 1, maxLength: 9 }), fc.boolean(), (items, flies) => {
        const reg = build(items);
        const r = resolveBehaviors(who(), flies ? ["move:flight"] : [], reg);
        const all = new Map(Object.values(reg.behaviors).flatMap((s) => s.items).map((i) => [i.id, i]));
        const order = new Map([...["inst", "cult", "rel"].flatMap((s) => reg.behaviors[s]!.items)].map((i, n) => [i.id, n]));
        const rank = (id: string) => DEFAULT_ORDINALS.strength[all.get(id)!.strength]!;
        const active = ids(r);

        for (const a of active) for (const b of active) if (a !== b) expect(conflicts(all.get(a)!, all.get(b)!)).toBe(false);

        for (const s of r.suppressed) {
          expect(active).toContain(s.by);
          expect(conflicts(all.get(s.item)!, all.get(s.by)!)).toBe(true);
          expect(rank(s.by) > rank(s.item) || (rank(s.by) === rank(s.item) && order.get(s.by)! < order.get(s.item)!)).toBe(true);
        }

        // partition: every item is exactly one of active / suppressed / dormant
        const seen = [...active, ...r.suppressed.map((s) => s.item), ...r.dormant.map((d) => d.item)].sort();
        expect(seen).toEqual([...all.keys()].sort());
        expect(r.warnings).toEqual([]);
      }),
      { numRuns: 400 },
    );
  });

  it("with random drops: dropped items are inactive, nothing active conflicts, and nothing else is lost", () => {
    fc.assert(
      fc.property(fc.array(itemArb, { minLength: 2, maxLength: 9 }), fc.array(fc.nat(8), { maxLength: 4 }), (items, dropIdx) => {
        const reg = build(items);
        const dropIds = [...new Set(dropIdx.filter((n) => n < items.length).map((n) => `b${n}`))];
        const r = resolveBehaviors(who({ overrides: dropIds.map((item) => ({ item, action: "drop" as const })) }), ["move:flight"], reg);
        const all = new Map(Object.values(reg.behaviors).flatMap((s) => s.items).map((i) => [i.id, i]));
        const active = ids(r);
        for (const d of dropIds) {
          expect(active).not.toContain(d);
          expect(r.behaviors.find((b) => b.item === d)).toMatchObject({ active: false, overridden: { action: "drop" } });
        }
        for (const a of active) for (const b of active) if (a !== b) expect(conflicts(all.get(a)!, all.get(b)!)).toBe(false);
      }),
      { numRuns: 300 },
    );
  });
});
