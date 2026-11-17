import { parse } from "yaml";
import { mergeOrdinals } from "./ordinals";
import type { BehaviorSet, Condition, OrdinalConfig, Registry, SkillDef, Slot, Species, Trait, Warning } from "./types";

export interface PackManifest {
  id: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  content_warnings: string[];
  requires_packs?: string[];
}

export interface Pack {
  manifest: PackManifest;
  slots?: Slot[];
  traits?: Trait[];
  conditions?: Condition[];
  behaviors?: BehaviorSet[];
  skills?: SkillDef[];
  species?: Species[];
}

export function parsePack(yamlText: string): Pack {
  const raw = parse(yamlText) as Partial<Pack> | null;
  const m = raw?.manifest;
  if (!m || typeof m.id !== "string" || typeof m.name !== "string" || typeof m.version !== "string") {
    throw new Error("Pack manifest must have string id, name and version");
  }
  return { ...raw, manifest: { ...m, content_warnings: m.content_warnings ?? [] } } as Pack;
}

/** Merge packs into one registry. Duplicate ids within a kind are an error. */
export function buildRegistry(packs: Pack[], ordinals?: Partial<OrdinalConfig>): Registry {
  const reg: Registry = { slots: {}, traits: {}, conditions: {}, species: {}, behaviors: {}, skills: {}, ordinals: mergeOrdinals(ordinals) };
  const add = <T extends { id: string }>(kind: string, into: Record<string, T>, items: T[] | undefined, pack: string) => {
    for (const item of items ?? []) {
      if (item.id in into) throw new Error(`Duplicate ${kind} id "${item.id}" (pack "${pack}")`);
      into[item.id] = item;
    }
  };
  for (const p of packs) {
    add("slot", reg.slots, p.slots, p.manifest.id);
    add("trait", reg.traits, p.traits, p.manifest.id);
    add("condition", reg.conditions, p.conditions, p.manifest.id);
    add("behavior set", reg.behaviors, p.behaviors, p.manifest.id);
    add("skill", reg.skills, p.skills, p.manifest.id);
    add("species", reg.species, p.species, p.manifest.id);
  }
  return reg;
}

/** Authoring-time referential checks. All results are warnings, never blocks. */
export function validateRegistry(reg: Registry): Warning[] {
  const out: Warning[] = [];
  const w = (code: string, message: string, subject?: string) => out.push({ code, message, ...(subject ? { subject } : {}) });

  for (const t of Object.values(reg.traits)) {
    if (!reg.slots[t.slot]) w("unknown_slot", `Trait "${t.id}" uses unknown slot "${t.slot}"`, t.id);
  }
  for (const sp of Object.values(reg.species)) {
    if (!reg.traits[sp.body_plan]) w("unknown_trait", `Species "${sp.id}" body plan "${sp.body_plan}" is not a trait`, sp.id);
    if (sp.instincts && !reg.behaviors[sp.instincts]) w("unknown_behavior_set", `Species "${sp.id}" instincts "${sp.instincts}" is not a behavior set`, sp.id);
    for (const [slot, entries] of Object.entries(sp.pools)) {
      if (!reg.slots[slot]) w("unknown_slot", `Species "${sp.id}" pool uses unknown slot "${slot}"`, sp.id);
      for (const e of entries) {
        const t = reg.traits[e.trait];
        if (!t) w("unknown_trait", `Species "${sp.id}" pool "${slot}" references unknown trait "${e.trait}"`, sp.id);
        else if (t.slot !== slot) w("slot_mismatch", `Trait "${t.id}" belongs to slot "${t.slot}" but is pooled under "${slot}" in "${sp.id}"`, t.id);
        if (reg.ordinals.chance[e.chance] === undefined) w("unknown_ordinal", `Unknown chance "${e.chance}" in "${sp.id}"`, sp.id);
      }
    }
    for (const axis of sp.axes ?? []) {
      for (const v of axis.values) {
        if (reg.ordinals.chance[v.chance] === undefined) w("unknown_ordinal", `Unknown chance "${v.chance}" on axis "${axis.name}"`, sp.id);
      }
    }
  }
  // Behavior item ids must be globally unique: overrides refer to them.
  const seen = new Map<string, string>();
  for (const set of Object.values(reg.behaviors)) {
    for (const item of set.items) {
      const prev = seen.get(item.id);
      if (prev) w("duplicate_behavior_item", `Behavior item id "${item.id}" appears in both "${prev}" and "${set.id}"`, item.id);
      else seen.set(item.id, set.id);
      if (reg.ordinals.strength[item.strength] === undefined) w("unknown_ordinal", `Unknown strength "${item.strength}" on "${item.id}"`, item.id);
    }
  }
  return out;
}
