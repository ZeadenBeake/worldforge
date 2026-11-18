import type { EntityKind } from "./schemas";

/** A reference from one entity's body to another entity, by kind and key. */
export interface EntityRef {
  kind: EntityKind;
  key: string;
}

type Loose = Record<string, unknown> | undefined;
const arr = <T = Loose>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const s = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/**
 * Every entity a (structurally valid) body points at. Used for "used by"
 * queries and for refusing to delete something that is still in use.
 * Behavior *item* ids (in overrides) are not entity references and are skipped.
 */
export function extractRefs(kind: EntityKind, body: unknown): EntityRef[] {
  const b = obj(body);
  const out = new Map<string, EntityRef>();
  const add = (k: EntityKind, key: unknown) => {
    const id = s(key);
    if (id) out.set(`${k}:${id}`, { kind: k, key: id });
  };

  switch (kind) {
    case "trait":
      add("slot", b["slot"]);
      break;
    case "species":
      add("trait", b["body_plan"]);
      add("behavior", b["instincts"]);
      for (const [slot, entries] of Object.entries(obj(b["pools"]))) {
        add("slot", slot);
        for (const e of arr(entries)) add("trait", e?.["trait"]);
      }
      for (const axis of arr(b["axes"])) {
        for (const v of arr(axis?.["values"])) {
          const m = obj(obj(v)["modifiers"]);
          for (const list of [m["add"], m["remove"], m["reweight"]]) {
            for (const e of arr(list)) {
              add("slot", e?.["slot"]);
              add("trait", e?.["trait"]);
            }
          }
        }
      }
      break;
    case "individual":
      add("species", b["species"]);
      for (const [slot, trait] of Object.entries(obj(b["genotype"]))) {
        add("slot", slot);
        add("trait", trait);
      }
      for (const c of arr(b["conditions"])) add("condition", c?.["condition"]);
      add("behavior", b["culture"]);
      for (const r of arr<unknown>(b["religions"])) add("behavior", r);
      for (const sk of arr(b["skills"])) add("skill", sk?.["skill"]);
      break;
    default:
      break; // slot, condition, behavior, skill reference nothing
  }
  return [...out.values()].sort((a, c) => a.kind.localeCompare(c.kind) || a.key.localeCompare(c.key));
}
