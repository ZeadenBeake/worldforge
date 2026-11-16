import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildRegistry, parsePack, mergeOrdinals } from "../src";
import type { Condition, Individual, Registry, Species, Trait } from "../src";

export function fixtureRegistry(): Registry {
  const path = fileURLToPath(new URL("../../../fixtures/avian-humanoid.yaml", import.meta.url));
  return buildRegistry([parsePack(readFileSync(path, "utf8"))]);
}

type TraitIn = Omit<Trait, "label"> & { label?: string };
type CondIn = Omit<Condition, "label"> & { label?: string };

/** Build a small registry for unit tests. Slots are created implicitly. */
export function miniRegistry(spec: {
  traits: TraitIn[];
  conditions?: CondIn[];
  species?: Partial<Species>;
}): Registry {
  const traits: Record<string, Trait> = {};
  const slots: Registry["slots"] = {};
  for (const t of spec.traits) {
    traits[t.id] = { label: t.id, ...t };
    slots[t.slot] ??= { id: t.slot, name: t.slot };
  }
  const conditions: Registry["conditions"] = {};
  for (const c of spec.conditions ?? []) conditions[c.id] = { label: c.id, ...c };
  const species: Species = { id: "sp", label: "sp", body_plan: "body", pools: {}, ...spec.species };
  return { slots, traits, conditions, species: { sp: species }, ordinals: mergeOrdinals() };
}

export function ind(over: Partial<Individual> = {}): Individual {
  return {
    species: "sp",
    seed: "t",
    axis_values: {},
    genotype: {},
    scalars: {},
    age: 30,
    conditions: [],
    ...over,
  };
}
