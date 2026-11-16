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
  /** Whether breeding can pass this condition on. */
  heritable?: boolean;
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

export interface AxisValue {
  name: string;
  chance: Ordinal;
  modifiers?: AxisModifiers;
}

export interface Axis {
  name: string;
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
  /** Conditions rolled at birth. `chance` is a *probability* ordinal. */
  congenital?: { condition: string; chance: Ordinal }[];
}

export interface ConditionInstance {
  condition: string;
  target?: Tag;
  /** World-time of onset (opaque number). Missing => before everything else (e.g. congenital). */
  since?: number;
  note?: string;
  congenital?: boolean;
}

export interface Individual {
  species: string;
  seed: string;
  axis_values: Record<string, string>;
  /** slot id -> trait id. Every slot in the species pool is present. */
  genotype: Record<string, string>;
  scalars: Record<string, number>;
  /** Years. */
  age: number;
  conditions: ConditionInstance[];
}

export interface OrdinalConfig {
  /** Relative weights for picking among candidates. */
  chance: Record<string, number>;
  /** Absolute probabilities in [0,1]. */
  probability: Record<string, number>;
}

export interface Registry {
  slots: Record<string, Slot>;
  traits: Record<string, Trait>;
  conditions: Record<string, Condition>;
  species: Record<string, Species>;
  ordinals: OrdinalConfig;
}

export interface Warning {
  code: string;
  message: string;
  subject?: string;
}
