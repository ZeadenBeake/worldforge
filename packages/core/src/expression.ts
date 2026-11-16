import { expandAll, evalReqs, hasTag, tagMatches } from "./tags";
import type { Individual, Registry, Species, Tag, Warning } from "./types";

export interface ExpressedTrait {
  slot: string;
  trait: string;
  expressed: boolean;
}

export interface ResolvedCondition {
  /** Index into individual.conditions. */
  index: number;
  condition: string;
  target?: Tag;
  active: boolean;
  inactive_reason?: "target_missing" | "requires_unmet" | "unknown_condition";
}

export interface Phenotype {
  traits: ExpressedTrait[];
  conditions: ResolvedCondition[];
  /** All present tags, sorted. */
  tags: Tag[];
  /** Present `part:` tags, sorted. */
  parts: Tag[];
  life_stage?: string;
  warnings: Warning[];
}

const MAX_ITERATIONS = 64;

export function lifeStageOf(species: Species, age: number): string | undefined {
  let found: string | undefined;
  for (const s of species.life_stages ?? []) {
    if (age >= s.from_age && (s.to_age === undefined || age < s.to_age)) found = s.name;
  }
  return found;
}

interface Layered {
  /** tag -> highest layer providing it */
  provided: Map<Tag, number>;
  removers: { pattern: Tag; layer: number }[];
}

/**
 * Genotype -> phenotype.
 *
 * Model: a *layered* tag set.
 *  - Layer 0: axis tags, stage tag, and tags provided by expressed traits.
 *  - Layer k (k >= 1): the k-th active condition in onset order (`since`
 *    ascending, ties by array order). Within a layer, `removes` happen before
 *    `provides`.
 *  - A tag is present iff its highest providing layer is >= every layer that
 *    removes it. So an amputation (layer 2) beats a body-plan arm (layer 0),
 *    and a prosthesis (layer 3) beats the amputation, but not the reverse.
 *
 * Expression is computed by non-cumulative iteration from the empty state:
 * each round derives the expressed-trait set and active-condition set from the
 * previous round's tags, until nothing changes. For purely positive
 * requirements this is the least fixed point (mutual requirements never
 * bootstrap). If `not` requirements make the system oscillate, the states in
 * the cycle are intersected and an `expression_unstable` warning is emitted.
 */
export function express(ind: Individual, reg: Registry): Phenotype {
  const warnings: Warning[] = [];
  const species = reg.species[ind.species];
  if (!species) {
    warnings.push({ code: "unknown_species", message: `Unknown species "${ind.species}"`, subject: ind.species });
  }

  // --- base (layer 0) tags that do not depend on expression
  const baseTags: Tag[] = [];
  for (const [axis, value] of Object.entries(ind.axis_values)) baseTags.push(`axis:${axis}=${value}`);
  const life_stage = species ? lifeStageOf(species, ind.age) : undefined;
  if (life_stage) baseTags.push(`stage:${life_stage}`);

  // --- genotype entries (stable order)
  const geno: { slot: string; traitId: string }[] = [];
  for (const slot of Object.keys(ind.genotype).sort()) {
    const traitId = ind.genotype[slot]!;
    if (!reg.traits[traitId]) {
      warnings.push({ code: "unknown_trait", message: `Genotype slot "${slot}" references unknown trait "${traitId}"`, subject: traitId });
      continue;
    }
    geno.push({ slot, traitId });
  }

  // --- conditions in onset order; layer = position + 1
  const ordered = ind.conditions
    .map((c, index) => ({ c, index }))
    .sort((a, b) => (a.c.since ?? -Infinity) - (b.c.since ?? -Infinity) || a.index - b.index);

  type State = { traits: Set<string>; conds: Set<number> };

  const layered = (state: State, maxLayer: number): Layered => {
    const provided = new Map<Tag, number>();
    const removers: Layered["removers"] = [];
    const put = (tag: Tag, layer: number) => {
      if ((provided.get(tag) ?? -1) < layer) provided.set(tag, layer);
    };
    for (const t of baseTags) put(t, 0);
    for (const g of geno) {
      if (!state.traits.has(g.slot)) continue;
      for (const t of expandAll(reg.traits[g.traitId]!.provides)) put(t, 0);
    }
    ordered.forEach(({ c }, pos) => {
      const layer = pos + 1;
      if (layer > maxLayer || !state.conds.has(pos)) return;
      const def = reg.conditions[c.condition];
      if (!def) return;
      for (const r of expandAll(def.removes)) removers.push({ pattern: r, layer });
      for (const t of expandAll(def.provides)) put(t, layer);
    });
    return { provided, removers };
  };

  const present = (state: State, maxLayer: number): Set<Tag> => {
    const { provided, removers } = layered(state, maxLayer);
    const out = new Set<Tag>();
    for (const [tag, layer] of provided) {
      if (!removers.some((r) => r.layer > layer && tagMatches(r.pattern, tag))) out.add(tag);
    }
    return out;
  };

  const step = (state: State): State => {
    const tags = present(state, Infinity);
    const traits = new Set<string>();
    for (const g of geno) {
      if (evalReqs(reg.traits[g.traitId]!.requires, tags)) traits.add(g.slot);
    }
    const conds = new Set<number>();
    ordered.forEach(({ c }, pos) => {
      const def = reg.conditions[c.condition];
      if (!def) return;
      const target = c.target ?? (def.target && def.target !== "whole" ? def.target : undefined);
      if (target) {
        // Onset view: only layers strictly below this condition.
        if (!hasTag(present(state, pos), target)) return;
      }
      if (evalReqs(def.requires, tags)) conds.add(pos);
    });
    return { traits, conds };
  };

  const key = (s: State) => `${[...s.traits].sort().join(",")}|${[...s.conds].sort((a, b) => a - b).join(",")}`;
  const same = (a: State, b: State) => key(a) === key(b);

  let state: State = { traits: new Set(), conds: new Set() };
  const history: State[] = [state];
  let stable = false;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const next = step(state);
    if (same(state, next)) { stable = true; break; }
    const seenAt = history.findIndex((h) => same(h, next));
    if (seenAt >= 0) {
      const cycle = history.slice(seenAt);
      const traits = new Set([...cycle[0]!.traits].filter((s) => cycle.every((c) => c.traits.has(s))));
      const conds = new Set([...cycle[0]!.conds].filter((p) => cycle.every((c) => c.conds.has(p))));
      state = { traits, conds };
      warnings.push({
        code: "expression_unstable",
        message: "Requirements oscillate (likely mutually-exclusive `not` requirements); only entries expressed in every state are kept.",
      });
      stable = true;
      break;
    }
    history.push(next);
    state = next;
  }
  if (!stable) {
    warnings.push({ code: "expression_unstable", message: `Expression did not converge in ${MAX_ITERATIONS} iterations.` });
  }

  const tags = present(state, Infinity);
  const finalTags = [...tags].sort();

  // Reasons for inactive conditions.
  const resolvedConditions: ResolvedCondition[] = ind.conditions.map((c, index) => {
    const def = reg.conditions[c.condition];
    if (!def) {
      warnings.push({ code: "unknown_condition", message: `Unknown condition "${c.condition}"`, subject: c.condition });
      return { index, condition: c.condition, target: c.target, active: false, inactive_reason: "unknown_condition" as const };
    }
    const pos = ordered.findIndex((o) => o.index === index);
    const active = state.conds.has(pos);
    const target = c.target ?? (def.target && def.target !== "whole" ? def.target : undefined);
    let inactive_reason: ResolvedCondition["inactive_reason"];
    if (!active) {
      inactive_reason = target && !hasTag(present(state, pos), target) ? "target_missing" : "requires_unmet";
    }
    return { index, condition: c.condition, target, active, ...(inactive_reason ? { inactive_reason } : {}) };
  });

  return {
    traits: geno.map((g) => ({ slot: g.slot, trait: g.traitId, expressed: state.traits.has(g.slot) })),
    conditions: resolvedConditions,
    tags: finalTags,
    parts: finalTags.filter((t) => t.startsWith("part:")),
    ...(life_stage ? { life_stage } : {}),
    warnings,
  };
}
