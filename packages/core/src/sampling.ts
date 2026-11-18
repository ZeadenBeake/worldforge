import { chanceWeight } from "./ordinals";
import { createRng, type Rng } from "./rng";
import { expandAll, tagMatches } from "./tags";
import type { Individual, Ordinal, Registry, Species, Trait, Warning } from "./types";

export interface RollLocks {
  axis_values?: Record<string, string>;
  /** slot -> trait id. Locked picks participate in conflict filtering. */
  genotype?: Record<string, string>;
  scalars?: Record<string, number>;
  age?: number;
}

export interface RollOptions {
  seed: string | number;
  locks?: RollLocks;
}

export interface RollResult {
  individual: Individual;
  warnings: Warning[];
}

export type Pool = Map<string, Map<string, Ordinal>>; // slot -> trait -> chance ordinal

/** Species pools with axis modifiers applied: base -> axes in declared order; removes win over adds. */
export function buildPool(species: Species, axisValues: Record<string, string>, warnings: Warning[]): Pool {
  const pool: Pool = new Map();
  for (const [slot, entries] of Object.entries(species.pools)) {
    pool.set(slot, new Map(entries.map((e) => [e.trait, e.chance])));
  }
  const removes: { slot: string; trait: string }[] = [];
  for (const axis of species.axes ?? []) {
    const chosen = axis.values.find((v) => v.name === axisValues[axis.name]);
    const mods = chosen?.modifiers;
    if (!mods) continue;
    for (const a of mods.add ?? []) {
      if (!pool.has(a.slot)) pool.set(a.slot, new Map());
      pool.get(a.slot)!.set(a.trait, a.chance);
    }
    for (const r of mods.reweight ?? []) {
      const slot = pool.get(r.slot);
      if (slot?.has(r.trait)) slot.set(r.trait, r.chance);
      else warnings.push({ code: "reweight_missing", message: `Axis ${axis.name}=${chosen!.name} reweights ${r.slot}/${r.trait}, which is not in the pool`, subject: r.trait });
    }
    removes.push(...(mods.remove ?? []));
  }
  for (const r of removes) pool.get(r.slot)?.delete(r.trait);
  return pool;
}

/** Do two traits (in different slots) conflict, in either direction? */
function traitsConflict(a: Trait, b: Trait): boolean {
  const hit = (pats: string[], tags: string[]) => pats.some((p) => tags.some((t) => tagMatches(p, t)));
  return (
    hit(expandAll(a.conflicts), expandAll(b.provides)) ||
    hit(expandAll(b.conflicts), expandAll(a.provides))
  );
}

function triangular(rng: Rng, min: number, typical: number, max: number): number {
  if (max <= min) return typical;
  const u = rng.next();
  const c = (typical - min) / (max - min);
  return u < c
    ? min + Math.sqrt(u * (max - min) * (typical - min))
    : max - Math.sqrt((1 - u) * (max - min) * (max - typical));
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// Shared building blocks (used by rollIndividual and breed)

/** Accumulates genotype picks and answers "would this trait conflict with what is already chosen?". */
export interface GenotypeBuilder {
  genotype: Record<string, string>;
  chosen: Trait[];
  take(slot: string, traitId: string): void;
  blocked(cand: Trait): boolean;
}

export function genotypeBuilder(reg: Registry, axisTags: string[], warnings: Warning[]): GenotypeBuilder {
  const genotype: Record<string, string> = {};
  const chosen: Trait[] = [];
  return {
    genotype,
    chosen,
    take(slot, traitId) {
      const t = reg.traits[traitId];
      if (!t) {
        warnings.push({ code: "unknown_trait", message: `Unknown trait "${traitId}" for slot "${slot}"`, subject: traitId });
        return;
      }
      genotype[slot] = traitId;
      chosen.push(t);
    },
    blocked(cand) {
      if (expandAll(cand.conflicts).some((p) => axisTags.some((t) => tagMatches(p, t)))) return true;
      return chosen.some((c) => c.slot !== cand.slot && traitsConflict(cand, c));
    },
  };
}

/** Body plan first, then locks. A lock is explicit intent: out-of-pool traits are allowed silently. */
export function applyBodyAndLocks(
  gb: GenotypeBuilder,
  species: Species,
  reg: Registry,
  locks: RollLocks | undefined,
  warnings: Warning[],
): void {
  const body = reg.traits[species.body_plan];
  if (!body) warnings.push({ code: "unknown_body_plan", message: `Unknown body plan trait "${species.body_plan}"`, subject: species.body_plan });
  else gb.take(body.slot, body.id);

  for (const [slot, traitId] of Object.entries(locks?.genotype ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (slot === body?.slot) continue;
    const locked = reg.traits[traitId];
    if (locked && locked.slot !== slot) {
      warnings.push({ code: "slot_mismatch", message: `Locked trait "${traitId}" belongs to slot "${locked.slot}", not "${slot}"`, subject: traitId });
    }
    gb.take(slot, traitId);
  }
}

export interface PoolCandidate {
  trait: Trait;
  traitId: string;
  chance: Ordinal;
}

export function poolCandidates(slot: string, pool: Pool, reg: Registry, warnings: Warning[]): PoolCandidate[] {
  const out: PoolCandidate[] = [];
  for (const [traitId, chance] of pool.get(slot)?.entries() ?? []) {
    const trait = reg.traits[traitId];
    if (!trait) warnings.push({ code: "unknown_trait", message: `Pool for "${slot}" references unknown trait "${traitId}"`, subject: traitId });
    else out.push({ trait, traitId, chance });
  }
  return out;
}

/**
 * Conflict-filtered weighted pick from a slot's pool. A fully blocked slot
 * falls back to the unfiltered pool with a warning. Returns undefined (and
 * warns) if there is nothing to pick.
 */
export function pickFromPool(
  slot: string,
  entries: PoolCandidate[],
  gb: GenotypeBuilder,
  rng: Rng,
  reg: Registry,
  warnings: Warning[],
): string | undefined {
  if (entries.length === 0) {
    warnings.push({ code: "slot_empty", message: `Slot "${slot}" has no candidates`, subject: slot });
    return undefined;
  }
  let candidates = entries.filter((e) => !gb.blocked(e.trait));
  if (candidates.length === 0) {
    warnings.push({ code: "slot_blocked", message: `Every candidate for slot "${slot}" conflicts with earlier picks; falling back to the unfiltered pool`, subject: slot });
    candidates = entries;
  }
  const pick = rng.weighted(candidates, (e) => chanceWeight(reg.ordinals, e.chance, warnings));
  if (!pick) {
    warnings.push({ code: "slot_empty", message: `Slot "${slot}" has no candidate with positive chance`, subject: slot });
    return undefined;
  }
  return pick.traitId;
}

/** Fresh axis roll by value `chance`. */
export function rollAxisValue(axis: { values: { name: string; chance: Ordinal }[] }, rng: Rng, reg: Registry, warnings: Warning[]): string | undefined {
  return rng.weighted(axis.values, (v) => chanceWeight(reg.ordinals, v.chance, warnings))?.name;
}

/** Scalars within [min, max] (triangular around `typical`), after axis modifiers. */
export function sampleScalars(
  species: Species,
  axisValues: Record<string, string>,
  root: Rng,
  locked?: Record<string, number>,
): Record<string, number> {
  const scalars: Record<string, number> = {};
  for (const [name, def] of Object.entries(species.data ?? {})) {
    const lock = locked?.[name];
    if (lock !== undefined) { scalars[name] = lock; continue; }
    let [min, max] = def.range;
    let typical = def.typical;
    for (const axis of species.axes ?? []) {
      const m = axis.values.find((v) => v.name === axisValues[axis.name])?.modifiers?.scalars?.[name];
      if (!m) continue;
      const mult = m.mult ?? 1, add = m.add ?? 0;
      min = min * mult + add; max = max * mult + add; typical = typical * mult + add;
    }
    scalars[name] = round2(triangular(root.fork(`scalar:${name}`), min, typical, max));
  }
  return scalars;
}

/** Default age: uniform within the stage named "adult" (else 0..lifespan). */
export function sampleAge(species: Species, scalars: Record<string, number>, root: Rng): number {
  const adult = species.life_stages?.find((s) => s.name === "adult");
  const lo = adult?.from_age ?? 0;
  const hi = adult?.to_age ?? scalars["lifespan"] ?? lo + 20;
  return round2(lo + root.fork("age").next() * Math.max(0, hi - lo));
}

/**
 * Sample an individual from a species (spec §7.1).
 *
 * Randomness is split into forked streams (`order`, `axis:*`, `slot:*`,
 * `scalar:*`, `age`) so editing one part of a species does not shift the
 * rolls of unrelated parts.
 */
export function rollIndividual(speciesId: string, reg: Registry, opts: RollOptions): RollResult {
  const species = reg.species[speciesId];
  if (!species) throw new Error(`Unknown species "${speciesId}"`);
  const warnings: Warning[] = [];
  const seed = String(opts.seed);
  const root = createRng(seed);
  const locks = opts.locks ?? {};

  // 1. axis values
  const axis_values: Record<string, string> = {};
  for (const axis of species.axes ?? []) {
    const locked = locks.axis_values?.[axis.name];
    if (locked !== undefined) { axis_values[axis.name] = locked; continue; }
    const pick = rollAxisValue(axis, root.fork(`axis:${axis.name}`), reg, warnings);
    if (pick !== undefined) axis_values[axis.name] = pick;
  }
  const axisTags = Object.entries(axis_values).map(([k, v]) => `axis:${k}=${v}`);

  // 2. working pool
  const pool = buildPool(species, axis_values, warnings);

  // 3. genotype: body plan + locks first, then remaining slots in shuffled order
  const gb = genotypeBuilder(reg, axisTags, warnings);
  applyBodyAndLocks(gb, species, reg, locks, warnings);
  const slotsToRoll = [...pool.keys()].filter((s) => !(s in gb.genotype)).sort();
  for (const slot of root.fork("order").shuffle(slotsToRoll)) {
    const picked = pickFromPool(slot, poolCandidates(slot, pool, reg, warnings), gb, root.fork(`slot:${slot}`), reg, warnings);
    if (picked !== undefined) gb.take(slot, picked);
  }

  // 4. scalars and age
  const scalars = sampleScalars(species, axis_values, root, locks.scalars);
  const age = locks.age ?? sampleAge(species, scalars, root);

  // Conditions are never rolled: injuries and the like are added by hand. Rare
  // genetic deviations are traits, added by locking them into the genotype.
  return {
    individual: { species: speciesId, seed, axis_values, genotype: gb.genotype, scalars, age, conditions: [] },
    warnings,
  };
}
