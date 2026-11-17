/**
 * Core data contracts. Everything here is plain JSON-serialisable data;
 * the resolver is a set of pure functions over these shapes.
 */

/** Namespaced tag: `ns:name[.instance][=value]`, e.g. `part:arm.l`, `axis:sex=male`. */
export type Tag = string;

/**
 * Requirement expression. A bare string is "this tag must be present".
 * The `requires` array on a trait/condition is an implicit AND of its entries.
 */
export type Req = Tag | { all: Req[] } | { any: Req[] } | { not: Req };

/** Ordinal label such as `common` or `very_low`; resolved to numbers via OrdinalConfig. */
export type Ordinal = string;

export interface Content {
  prose?: string;
  image_tags?: string[];
  summary?: string;
}

export interface Slot {
  id: string;
  name: string;
  description?: string;
  aliases?: string[];
}

export interface Trait {
  id: string;
  slot: string;
  label: string;
  provides?: Tag[];
  requires?: Req[];
  /** Roll-time constraint on the genotype (patterns matched against provides). */
  conflicts?: Tag[];
  content?: Content;
  visual?: unknown;
}

export interface Condition {
  id: string;
  label: string;
  kind_label?: string;
  /**
   * `whole` or a part tag. Evaluated at *onset*: the part must exist given
   * everything that happened before this condition. A condition's own
   * effects therefore never invalidate its own target.
   */
  target?: "whole" | Tag;
  provides?: Tag[];
  /** Live dependency: re-checked against the final tag set. Unmet => dormant. */
  requires?: Req[];
  removes?: Tag[];
  content?: Content;
}

export interface PoolEntry {
  trait: string;
  chance: Ordinal;
}

export interface AxisModifiers {
  add?: { slot: string; trait: string; chance: Ordinal }[];
  remove?: { slot: string; trait: string }[];
  reweight?: { slot: string; trait: string; chance: Ordinal }[];
  scalars?: Record<string, { mult?: number; add?: number }>;
}

export interface Pronouns {
  subject: string;
  object: string;
  possessive: string;
}

export interface AxisValue {
  name: string;
  /** Weight when the value is rolled fresh. */
  chance: Ordinal;
  /** Default pronouns for individuals with this value (overridable on the individual). */
  pronouns?: Pronouns;
  /**
   * Weight when this value is inherited from a parent (heritable axes only).
   * Lets a rare value (a "queen" caste) pass down less often than a common one.
   * Omitted => neutral: every parent's value is equally likely to be passed on.
   */
  inherit?: Ordinal;
  modifiers?: AxisModifiers;
}

export interface Axis {
  name: string;
  /** Children may inherit this axis's value from a parent (caste: yes, sex: no). Default false. */
  heritable?: boolean;
  values: AxisValue[];
}

export interface ScalarDef {
  typical: number;
  range: [number, number];
  unit?: string;
}

export interface LifeStage {
  name: string;
  from_age: number;
  to_age?: number;
}

export interface Species {
  id: string;
  label: string;
  /** Trait id; must belong to a body_plan-style slot. Always present in the genotype. */
  body_plan: string;
  pools: Record<string, PoolEntry[]>;
  axes?: Axis[];
  instincts?: string;
  data?: Record<string, ScalarDef>;
  life_stages?: LifeStage[];
}

/** Behavior strength is an ordinal label (default: nudge < habit < drive < compulsion). */
export type Strength = string;

export interface BehaviorItem {
  /** Unique across the registry; overrides refer to it. */
  id: string;
  label: string;
  content?: Content;
  strength: Strength;
  provides?: Tag[];
  /** Checked against the phenotype's tags. Unmet => dormant (not an error). */
  requires?: Req[];
  /** Patterns matched against other behavior items' `provides`. */
  conflicts?: Tag[];
}

export interface BehaviorSet {
  id: string;
  label: string;
  role: "instinct" | "culture" | "religion" | "other";
  items: BehaviorItem[];
}

export interface BehaviorOverride {
  item: string;
  /** keep: win conflicts if present. drop: remove. force: add even if absent/dormant, and win conflicts. */
  action: "keep" | "drop" | "force";
  note?: string;
}

export interface ConditionInstance {
  condition: string;
  target?: Tag;
  /** World-time of onset (opaque number). Missing => before everything else. */
  since?: number;
  note?: string;
}

/** A world-defined skill. No subskill hierarchy in V1 (a future optional `parent` is non-breaking). */
export interface SkillDef {
  id: string;
  label: string;
  description?: string;
}

export interface SkillEntry {
  skill: string;
  /** Skill-level ordinal (untrained .. master). */
  level: Ordinal;
  /** Passion ordinal (disinterested .. burning). */
  passion: Ordinal;
  /** Optional free text: "knives, close quarters". */
  focus?: string;
}

export interface Thought {
  text: string;
  kind: "short" | "formative";
  /** World-time (opaque number). */
  since: number;
  expires?: number;
}

/** Directional relationship, stored outside the individual. */
export interface Link {
  id?: string;
  from: string;
  to: string;
  /** parent, friend, rival, host, ... */
  type: string;
  feeling?: string;
  since?: number;
}

export interface Individual {
  name?: string;
  /** Overrides the pronouns implied by the axis values. */
  pronouns?: Pronouns;
  species: string;
  seed: string;
  axis_values: Record<string, string>;
  /** slot id -> trait id. Every slot in the species pool is present. */
  genotype: Record<string, string>;
  scalars: Record<string, number>;
  /** Years. */
  age: number;
  conditions: ConditionInstance[];
  /** slot -> species id, for picks that came from a parent of another species. */
  inherited_from?: Record<string, string>;
  skills?: SkillEntry[];
  thoughts?: Thought[];
  /** Behavior set ids. Instincts come from the species. */
  culture?: string;
  religions?: string[];
  behavior_overrides?: BehaviorOverride[];
}

export interface OrdinalConfig {
  /** Relative weights for picking among candidates. */
  chance: Record<string, number>;
  /** Absolute probabilities in [0,1]. */
  probability: Record<string, number>;
  /** Behavior strength rank; higher wins conflicts. */
  strength: Record<string, number>;
  /** Skill level rank (display order only). */
  skill_level: Record<string, number>;
  /** Passion rank (display order only). */
  passion: Record<string, number>;
}

export interface BreedingConfig {
  /** Probability ordinal: chance a slot takes the other-species parent's pick. */
  off_species: Ordinal;
  /** Probability ordinal: chance a slot (or heritable axis) ignores the parents and rolls fresh. */
  mutation: Ordinal;
  /** Weight multiplier for a parent's *expressed* pick over a latent one. Default 1 (neutral): see DEFAULT_BREEDING. */
  expressed_bias: number;
}

export interface Registry {
  slots: Record<string, Slot>;
  traits: Record<string, Trait>;
  conditions: Record<string, Condition>;
  species: Record<string, Species>;
  behaviors: Record<string, BehaviorSet>;
  skills: Record<string, SkillDef>;
  ordinals: OrdinalConfig;
  /** Per-world overrides of DEFAULT_BREEDING. */
  breeding?: Partial<BreedingConfig>;
}

export interface Warning {
  code: string;
  message: string;
  subject?: string;
}
