import { resolveBehaviors, type BehaviorLayer, type BehaviorStatus } from "./behavior";
import { express, type ResolvedCondition } from "./expression";
import { growthFactor } from "./growth";
import type { BehaviorItem, Content, Individual, Link, Pronouns, Registry, Species, Tag, Warning } from "./types";

export const THEY: Pronouns = { subject: "they", object: "them", possessive: "their" };

export interface SnapshotTrait {
  slot: string;
  trait: string;
  label: string;
  expressed: boolean;
  /** Species id, when this pick came from a parent of another species. */
  inherited_from?: string;
  content: Content;
}

export interface SnapshotBehavior {
  item: string;
  label: string;
  /** The behavior set it came from. */
  source: string;
  layer: BehaviorLayer;
  strength: string;
  /** False only for items removed by a `drop` override. */
  active: boolean;
  content: Content;
  overridden?: { action: "keep" | "drop" | "force"; original: BehaviorStatus; note?: string };
}

export interface SnapshotCondition {
  condition: string;
  label: string;
  kind_label?: string;
  target?: Tag;
  since?: number;
  note?: string;
  /** False when dormant (unmet requirement or missing target). */
  active: boolean;
  inactive_reason?: ResolvedCondition["inactive_reason"];
  content: Content;
}

export interface SnapshotSkill {
  skill: string;
  label: string;
  description?: string;
  level: string;
  passion: string;
  focus?: string;
}

export interface SnapshotThought {
  text: string;
  kind: "short" | "formative";
  since: number;
  expires?: number;
}

export interface SnapshotRelation {
  type: string;
  /** The other individual's id. */
  other: string;
  other_name?: string;
  /** `out`: this individual -> other (e.g. "parent of"); `in`: other -> this. */
  direction: "out" | "in";
  feeling?: string;
  since?: number;
}

/** The resolved, read-only view of an individual that exporters consume (spec §12). */
export interface Snapshot {
  individual: { id?: string; name?: string; pronouns: Pronouns };
  species: { id: string; label: string };
  seed: string;
  axis_values: Record<string, string>;
  traits: SnapshotTrait[];
  /** Present `part:` tags. */
  parts: Tag[];
  /** `value` is the size at the current age; `adult_value` is present only while it differs. */
  scalars: Record<string, { value: number; unit?: string; adult_value?: number }>;
  age: number;
  life_stage?: string;
  behaviors: SnapshotBehavior[];
  conditions: SnapshotCondition[];
  skills: SnapshotSkill[];
  thoughts: SnapshotThought[];
  relations: SnapshotRelation[];
  warnings: Warning[];
  /** All present tags. */
  tags: Tag[];
}

export interface SnapshotInput {
  /** Entity id, if stored. */
  id?: string;
  individual: Individual;
  /** Links in the world; only those touching `id` are used. */
  links?: Link[];
  /** id -> display name, to label relations. */
  names?: Record<string, string>;
  /** World-time "now"; thoughts whose `expires` is at or before it are dropped. */
  now?: number;
}

/** Explicit pronouns, else the first axis value (in declared order) that defines them, else they/them. */
export function resolvePronouns(ind: Individual, species: Species | undefined): Pronouns {
  if (ind.pronouns) return ind.pronouns;
  for (const axis of species?.axes ?? []) {
    const value = axis.values.find((v) => v.name === ind.axis_values[axis.name]);
    if (value?.pronouns) return value.pronouns;
  }
  return THEY;
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
}

/**
 * Resolve everything once and hand it to exporters. Exporters must not
 * re-implement resolution: expression, behavior resolution, pronoun defaults,
 * thought expiry and relation direction are all decided here. The result is
 * plain JSON and deeply frozen.
 */
export function buildSnapshot(reg: Registry, input: SnapshotInput): Snapshot {
  const ind = input.individual;
  const species = reg.species[ind.species];
  const warnings: Warning[] = [];

  const pheno = express(ind, reg);
  warnings.push(...pheno.warnings);
  const beh = resolveBehaviors(ind, pheno.tags, reg);
  warnings.push(...beh.warnings);

  // traits
  const traits: SnapshotTrait[] = pheno.traits.map((t) => {
    const def = reg.traits[t.trait]!;
    const from = ind.inherited_from?.[t.slot];
    return { slot: t.slot, trait: t.trait, label: def.label, expressed: t.expressed, ...(from ? { inherited_from: from } : {}), content: def.content ?? {} };
  });

  // behaviors
  const items = new Map<string, BehaviorItem>();
  for (const set of Object.values(reg.behaviors)) for (const i of set.items) if (!items.has(i.id)) items.set(i.id, i);
  const behaviors: SnapshotBehavior[] = beh.behaviors.map((b) => {
    const def = items.get(b.item)!;
    return {
      item: b.item, label: def.label, source: b.set, layer: b.layer, strength: b.strength, active: b.active,
      content: def.content ?? {}, ...(b.overridden ? { overridden: b.overridden } : {}),
    };
  });

  // conditions
  const conditions: SnapshotCondition[] = pheno.conditions.map((c) => {
    const inst = ind.conditions[c.index]!;
    const def = reg.conditions[c.condition];
    return {
      condition: c.condition,
      label: def?.label ?? c.condition,
      ...(def?.kind_label ? { kind_label: def.kind_label } : {}),
      ...(c.target ? { target: c.target } : {}),
      ...(inst.since !== undefined ? { since: inst.since } : {}),
      ...(inst.note ? { note: inst.note } : {}),
      active: c.active,
      ...(c.inactive_reason ? { inactive_reason: c.inactive_reason } : {}),
      content: def?.content ?? {},
    };
  });

  // skills, highest level first
  const rank = (table: Record<string, number>, label: string) => table[label] ?? -Infinity;
  const skills: SnapshotSkill[] = (ind.skills ?? []).map((s) => {
    const def = reg.skills[s.skill];
    if (!def) warnings.push({ code: "unknown_skill", message: `Unknown skill "${s.skill}"`, subject: s.skill });
    if (reg.ordinals.skill_level[s.level] === undefined) warnings.push({ code: "unknown_ordinal", message: `Unknown skill level "${s.level}" on "${s.skill}"`, subject: s.skill });
    if (reg.ordinals.passion[s.passion] === undefined) warnings.push({ code: "unknown_ordinal", message: `Unknown passion "${s.passion}" on "${s.skill}"`, subject: s.skill });
    return {
      skill: s.skill, label: def?.label ?? s.skill, ...(def?.description ? { description: def.description } : {}),
      level: s.level, passion: s.passion, ...(s.focus ? { focus: s.focus } : {}),
    };
  });
  skills.sort(
    (a, b) =>
      rank(reg.ordinals.skill_level, b.level) - rank(reg.ordinals.skill_level, a.level) ||
      rank(reg.ordinals.passion, b.passion) - rank(reg.ordinals.passion, a.passion) ||
      a.skill.localeCompare(b.skill),
  );

  // thoughts: expired ones are dropped when `now` is known
  const thoughts: SnapshotThought[] = (ind.thoughts ?? [])
    .filter((t) => !(input.now !== undefined && t.expires !== undefined && t.expires <= input.now))
    .map((t) => ({ text: t.text, kind: t.kind, since: t.since, ...(t.expires !== undefined ? { expires: t.expires } : {}) }))
    .sort((a, b) => a.since - b.since);

  // relations: links touching this individual
  const relations: SnapshotRelation[] = [];
  if (input.id !== undefined) {
    for (const l of input.links ?? []) {
      if (l.from !== input.id && l.to !== input.id) continue;
      const direction: SnapshotRelation["direction"] = l.from === input.id ? "out" : "in";
      const other: string = direction === "out" ? l.to : l.from;
      const otherName = input.names?.[other];
      relations.push({
        type: l.type, other, ...(otherName ? { other_name: otherName } : {}), direction,
        ...(l.feeling ? { feeling: l.feeling } : {}), ...(l.since !== undefined ? { since: l.since } : {}),
      });
    }
    relations.sort((a, b) => (a.since ?? -Infinity) - (b.since ?? -Infinity) || a.type.localeCompare(b.type) || a.other.localeCompare(b.other));
  }

  // Stored scalars are adult values; the snapshot reports today's size.
  const scalars: Snapshot["scalars"] = {};
  for (const [name, adult] of Object.entries(ind.scalars)) {
    const def = species?.data?.[name];
    const factor = def ? growthFactor(def, ind.age) : 1;
    scalars[name] = {
      value: factor === 1 ? adult : Math.round(adult * factor * 100) / 100,
      ...(def?.unit ? { unit: def.unit } : {}),
      ...(factor !== 1 ? { adult_value: adult } : {}),
    };
  }

  const snapshot: Snapshot = {
    individual: {
      ...(input.id !== undefined ? { id: input.id } : {}),
      ...(ind.name ? { name: ind.name } : {}),
      pronouns: resolvePronouns(ind, species),
    },
    species: { id: ind.species, label: species?.label ?? ind.species },
    seed: ind.seed,
    axis_values: { ...ind.axis_values },
    traits,
    parts: pheno.parts,
    scalars,
    age: ind.age,
    ...(pheno.life_stage ? { life_stage: pheno.life_stage } : {}),
    behaviors,
    conditions,
    skills,
    thoughts,
    relations,
    warnings,
    tags: pheno.tags,
  };
  return deepFreeze(snapshot);
}
