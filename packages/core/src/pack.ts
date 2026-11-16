import { parse } from "yaml";
import { mergeOrdinals } from "./ordinals";
import type { Condition, OrdinalConfig, Registry, Slot, Species, Trait, Warning } from "./types";

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
  const reg: Registry = { slots: {}, traits: {}, conditions: {}, species: {}, ordinals: mergeOrdinals(ordinals) };
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
    for (const [slot, entries] of Object.entries(sp.pools)) {
      if (!reg.slots[slot]) w("unknown_slot", `Species "${sp.id}" pool uses unknown slot "${slot}"`, sp.id);
      for (const e of entries) {
        const t = reg.traits[e.trait];
        if (!t) w("unknown_trait", `Species "${sp.id}" pool "${slot}" references unknown trait "${e.trait}"`, sp.id);
        else if (t.slot !== slot) w("slot_mismatch", `Trait "${t.id}" belongs to slot "${t.slot}" but is pooled under "${slot}" in "${sp.id}"`, t.id);
        if (reg.ordinals.chance[e.chance] === undefined) w("unknown_ordinal", `Unknown chance "${e.chance}" in "${sp.id}"`, sp.id);
      }
    }
    for (const c of sp.congenital ?? []) {
      if (!reg.conditions[c.condition]) w("unknown_condition", `Species "${sp.id}" congenital list references unknown condition "${c.condition}"`, sp.id);
      if (reg.ordinals.probability[c.chance] === undefined) w("unknown_ordinal", `Unknown probability "${c.chance}" in "${sp.id}"`, sp.id);
    }
    for (const axis of sp.axes ?? []) {
      for (const v of axis.values) {
        if (reg.ordinals.chance[v.chance] === undefined) w("unknown_ordinal", `Unknown chance "${v.chance}" on axis "${axis.name}"`, sp.id);
      }
    }
  }
  return out;
}
