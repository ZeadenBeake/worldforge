import { describe, expect, it } from "vitest";
import { ENTITY_KINDS, KEY_PATTERN, extractRefs, isEntityKind, validateBody, rollIndividual } from "../src";
import type { EntityKind } from "../src";
import { fixtureRegistry } from "./helpers";

const reg = fixtureRegistry();
const strip = <T extends { id: string }>({ id: _id, ...rest }: T) => rest;

describe("body schemas", () => {
  it("accept every entity of the example pack", () => {
    const groups: [EntityKind, { id: string }[]][] = [
      ["slot", Object.values(reg.slots)],
      ["trait", Object.values(reg.traits)],
      ["condition", Object.values(reg.conditions)],
      ["behavior", Object.values(reg.behaviors)],
      ["skill", Object.values(reg.skills)],
      ["species", Object.values(reg.species)],
    ];
    for (const [kind, items] of groups) {
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        const r = validateBody(kind, strip(item));
        expect(r, `${kind}:${item.id}`).toMatchObject({ ok: true });
      }
    }
  });

  it("accept a rolled individual", () => {
    const { individual } = rollIndividual("avian_humanoid", reg, { seed: "s" });
    expect(validateBody("individual", individual)).toMatchObject({ ok: true });
  });

  it("reject wrong shapes with readable paths", () => {
    const bad = validateBody("trait", { slot: "wings" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues.map((i) => i.path)).toContain("label");

    expect(validateBody("behavior", { label: "x", role: "cult", items: [] }).ok).toBe(false);
    expect(validateBody("species", { label: "x", body_plan: "b", pools: { s: [{ trait: "t" }] } }).ok).toBe(false);
    expect(validateBody("species", { label: "x", body_plan: "b", pools: {}, data: { h: { typical: 1, range: [1] } } }).ok).toBe(false);
    expect(validateBody("trait", { slot: "s", label: "l", requires: [{ nope: "x" }] }).ok).toBe(false);
  });

  it("accept the full requirement grammar", () => {
    const r = validateBody("trait", { slot: "s", label: "l", requires: ["a", { any: ["b", { not: "c" }] }, { all: ["d"] }] });
    expect(r.ok).toBe(true);
  });

  it("tolerate unknown keys (forward compatibility)", () => {
    expect(validateBody("skill", { label: "Melee", future_field: 1 })).toMatchObject({ ok: true });
  });
});

describe("keys and kinds", () => {
  it("key pattern", () => {
    for (const ok of ["wings", "a1", "part.arm", "a-b_c"]) expect(KEY_PATTERN.test(ok)).toBe(true);
    for (const bad of ["", "_x", "Wings", "a b", "a/b", "-x"]) expect(KEY_PATTERN.test(bad)).toBe(false);
  });
  it("isEntityKind", () => {
    expect(ENTITY_KINDS.every(isEntityKind)).toBe(true);
    expect(isEntityKind("world")).toBe(false);
  });
});

describe("extractRefs", () => {
  it("a trait points at its slot", () => {
    expect(extractRefs("trait", { slot: "wings", label: "x" })).toEqual([{ kind: "slot", key: "wings" }]);
  });

  it("a species points at body plan, instincts, pool slots and traits, and axis-modifier targets", () => {
    const refs = extractRefs("species", {
      body_plan: "body", instincts: "inst",
      pools: { coat: [{ trait: "fur", chance: "common" }] },
      axes: [{ name: "sex", values: [{ name: "m", chance: "common", modifiers: { add: [{ slot: "horns", trait: "horn", chance: "rare" }], remove: [{ slot: "coat", trait: "fur" }] } }] }],
    });
    expect(refs).toEqual([
      { kind: "behavior", key: "inst" },
      { kind: "slot", key: "coat" },
      { kind: "slot", key: "horns" },
      { kind: "trait", key: "body" },
      { kind: "trait", key: "fur" },
      { kind: "trait", key: "horn" },
    ]);
  });

  it("an individual points at species, genotype, conditions, culture, religions and skills", () => {
    const refs = extractRefs("individual", {
      species: "sp", genotype: { coat: "fur" }, conditions: [{ condition: "scar" }, { condition: "scar" }],
      culture: "c", religions: ["r1", "r2"], skills: [{ skill: "melee" }], behavior_overrides: [{ item: "an_item", action: "drop" }],
    });
    expect(refs.map((r) => `${r.kind}:${r.key}`)).toEqual([
      "behavior:c", "behavior:r1", "behavior:r2", "condition:scar", "skill:melee", "slot:coat", "species:sp", "trait:fur",
    ]);
  });

  it("slots, conditions, behaviors and skills reference nothing", () => {
    for (const kind of ["slot", "condition", "behavior", "skill"] as const) expect(extractRefs(kind, { label: "x", name: "x" })).toEqual([]);
  });

  it("every reference in the example pack resolves to an entity", () => {
    const tables: Record<EntityKind, Record<string, unknown>> = {
      slot: reg.slots, trait: reg.traits, condition: reg.conditions, behavior: reg.behaviors, skill: reg.skills, species: reg.species, individual: {},
    };
    const has = (kind: EntityKind, key: string) => tables[kind][key] !== undefined;
    for (const t of Object.values(reg.traits)) for (const r of extractRefs("trait", strip(t))) expect(has(r.kind, r.key), `${t.id}->${r.kind}:${r.key}`).toBe(true);
    for (const sp of Object.values(reg.species)) for (const r of extractRefs("species", strip(sp))) expect(has(r.kind, r.key), `${sp.id}->${r.kind}:${r.key}`).toBe(true);
  });

  it("is defensive about junk input", () => {
    expect(extractRefs("species", null)).toEqual([]);
    expect(extractRefs("individual", { genotype: "nope", conditions: 3 })).toEqual([]);
  });
});
