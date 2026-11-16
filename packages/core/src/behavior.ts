import { strengthRank } from "./ordinals";
import { evalReqs, expandAll, tagMatches } from "./tags";
import type { BehaviorItem, BehaviorOverride, Individual, Registry, Tag, Warning } from "./types";

export type BehaviorLayer = "instinct" | "culture" | "religion" | "forced";

/** What resolution decided about an item. */
export type BehaviorStatus = "active" | "suppressed" | "dormant" | "dropped" | "absent";

export interface ResolvedBehavior {
  item: string;
  set: string;
  layer: BehaviorLayer;
  strength: string;
  /** False only for items removed by a `drop` override (kept so exporters can mention them). */
  active: boolean;
  overridden?: {
    action: BehaviorOverride["action"];
    /** The item's status had the override not existed. */
    original: BehaviorStatus;
    note?: string;
  };
}

export interface BehaviorResolution {
  /** In effect (plus dropped items, flagged `active: false`), in layer order. */
  behaviors: ResolvedBehavior[];
  /** Lost a conflict to a stronger / higher-priority item. */
  suppressed: { item: string; set: string; layer: BehaviorLayer; strength: string; by: string }[];
  /** `requires` unmet by the phenotype. */
  dormant: { item: string; set: string; layer: BehaviorLayer }[];
  warnings: Warning[];
}

interface Cand {
  item: BehaviorItem;
  set: string;
  layer: BehaviorLayer;
  /** Collection order: instincts, culture, religions (as listed), then forced extras. */
  order: number;
}

function conflict(a: BehaviorItem, b: BehaviorItem): boolean {
  const hit = (pats: Tag[], tags: Tag[]) => pats.some((p) => tags.some((t) => tagMatches(p, t)));
  return hit(expandAll(a.conflicts), expandAll(b.provides)) || hit(expandAll(b.conflicts), expandAll(a.provides));
}

interface CoreResult {
  status: Map<string, BehaviorStatus>;
  suppressedBy: Map<string, string>;
  active: Cand[];
}

/**
 * Resolve a candidate list.
 *  - requires unmet (and not forced) -> dormant
 *  - dropped -> excluded before conflicts, so they free up their rivals
 *  - pinned (keep/force) items are accepted first, then everything else by
 *    strength descending, ties by collection order (earlier layer wins)
 *  - an item is accepted unless it conflicts with an already-accepted item;
 *    losers are `suppressed` and, being unaccepted, never block anyone else
 *    (so A>B, B-C conflicts leave A and C both active).
 */
function core(cands: Cand[], tags: Tag[], ranks: Map<string, number>, pinned: Set<string>, forced: Set<string>, dropped: Set<string>, warnings: Warning[] | undefined): CoreResult {
  const status = new Map<string, BehaviorStatus>();
  const suppressedBy = new Map<string, string>();
  const live: Cand[] = [];
  for (const c of cands) {
    if (dropped.has(c.item.id)) status.set(c.item.id, "dropped");
    else if (!forced.has(c.item.id) && !evalReqs(c.item.requires, tags)) status.set(c.item.id, "dormant");
    else live.push(c);
  }
  live.sort((a, b) => {
    const pa = pinned.has(a.item.id) ? 0 : 1, pb = pinned.has(b.item.id) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    if (pa === 1) {
      const d = (ranks.get(b.item.id) ?? 0) - (ranks.get(a.item.id) ?? 0);
      if (d) return d;
    }
    return a.order - b.order;
  });
  const active: Cand[] = [];
  for (const c of live) {
    const rival = active.find((a) => conflict(a.item, c.item));
    if (rival) {
      if (pinned.has(c.item.id) && pinned.has(rival.item.id)) {
        warnings?.push({ code: "override_conflict", message: `Pinned items "${rival.item.id}" and "${c.item.id}" conflict; the earlier one wins`, subject: c.item.id });
      }
      status.set(c.item.id, "suppressed");
      suppressedBy.set(c.item.id, rival.item.id);
    } else {
      status.set(c.item.id, "active");
      active.push(c);
    }
  }
  return { status, suppressedBy, active };
}

/**
 * Behavior resolution (spec §7.3). Runs *after* expression and never feeds
 * back into it: `tags` is the phenotype's tag list, and behavior `provides`
 * only matter for conflicts between behavior items.
 */
export function resolveBehaviors(ind: Individual, tags: readonly Tag[], reg: Registry): BehaviorResolution {
  const warnings: Warning[] = [];

  // 1. collect, in priority order
  const cands: Cand[] = [];
  const seenItems = new Map<string, string>();
  const collect = (setId: string | undefined, layer: BehaviorLayer) => {
    if (!setId) return;
    const set = reg.behaviors[setId];
    if (!set) {
      warnings.push({ code: "unknown_behavior_set", message: `Unknown behavior set "${setId}"`, subject: setId });
      return;
    }
    for (const item of set.items) {
      if (seenItems.has(item.id)) {
        warnings.push({ code: "duplicate_behavior_item", message: `Item "${item.id}" appears in "${seenItems.get(item.id)}" and "${setId}"; keeping the first`, subject: item.id });
        continue;
      }
      seenItems.set(item.id, setId);
      cands.push({ item, set: setId, layer, order: cands.length });
    }
  };
  collect(reg.species[ind.species]?.instincts, "instinct");
  collect(ind.culture, "culture");
  for (const r of ind.religions ?? []) collect(r, "religion");

  const lookupSet = new Map<string, string>();
  for (const s of Object.values(reg.behaviors)) for (const i of s.items) if (!lookupSet.has(i.id)) lookupSet.set(i.id, s.id);
  const findItem = (id: string): BehaviorItem | undefined => {
    const setId = lookupSet.get(id);
    return setId ? reg.behaviors[setId]?.items.find((i) => i.id === id) : undefined;
  };

  // 2. overrides (last one per item wins)
  const byItem = new Map<string, BehaviorOverride>();
  for (const o of ind.behavior_overrides ?? []) {
    if (!findItem(o.item)) {
      warnings.push({ code: "unknown_behavior_item", message: `Override refers to unknown behavior item "${o.item}"`, subject: o.item });
      continue;
    }
    if (byItem.has(o.item)) warnings.push({ code: "duplicate_override", message: `Several overrides for "${o.item}"; the last one wins`, subject: o.item });
    byItem.set(o.item, o);
  }
  const inLayers = new Set(cands.map((c) => c.item.id));
  for (const o of byItem.values()) {
    if (o.action === "keep" && !inLayers.has(o.item)) {
      warnings.push({ code: "keep_not_present", message: `"keep" on "${o.item}", which is in none of this individual's layers; use "force" to add it`, subject: o.item });
    }
  }

  // forced extras not already in a layer
  const allCands = cands.slice();
  for (const o of byItem.values()) {
    if (o.action !== "force" || inLayers.has(o.item)) continue;
    allCands.push({ item: findItem(o.item)!, set: lookupSet.get(o.item)!, layer: "forced", order: allCands.length });
  }

  const ranks = new Map<string, number>();
  for (const c of allCands) ranks.set(c.item.id, strengthRank(reg.ordinals, c.item.strength, warnings));

  // 3. baseline (no overrides) and final
  const baseline = core(cands, [...tags], ranks, new Set(), new Set(), new Set(), undefined);
  const pinned = new Set([...byItem.values()].filter((o) => o.action !== "drop").map((o) => o.item));
  const forced = new Set([...byItem.values()].filter((o) => o.action === "force").map((o) => o.item));
  const dropped = new Set([...byItem.values()].filter((o) => o.action === "drop").map((o) => o.item));
  const final = core(allCands, [...tags], ranks, pinned, forced, dropped, warnings);

  // 4. assemble
  const behaviors: ResolvedBehavior[] = [];
  const suppressed: BehaviorResolution["suppressed"] = [];
  const dormant: BehaviorResolution["dormant"] = [];
  for (const c of allCands) {
    const st = final.status.get(c.item.id)!;
    const ov = byItem.get(c.item.id);
    const original: BehaviorStatus = baseline.status.get(c.item.id) ?? "absent";
    const overridden = ov ? { action: ov.action, original, ...(ov.note ? { note: ov.note } : {}) } : undefined;
    const base = { item: c.item.id, set: c.set, layer: c.layer, strength: c.item.strength };
    if (st === "active") behaviors.push({ ...base, active: true, ...(overridden ? { overridden } : {}) });
    else if (st === "dropped") behaviors.push({ ...base, active: false, ...(overridden ? { overridden } : {}) });
    else if (st === "suppressed") suppressed.push({ ...base, by: final.suppressedBy.get(c.item.id)! });
    else dormant.push({ item: c.item.id, set: c.set, layer: c.layer });
  }
  return { behaviors, suppressed, dormant, warnings };
}
