import { express } from "./expression";
import { chanceWeight, probabilityOf } from "./ordinals";
import { createRng } from "./rng";
import {
  applyBodyAndLocks,
  buildPool,
  genotypeBuilder,
  pickFromPool,
  poolCandidates,
  rollAxisValue,
  sampleScalars,
  type RollLocks,
  type RollResult,
} from "./sampling";
import { hasTag } from "./tags";
import type { BreedingConfig, Individual, Ordinal, Registry, Warning } from "./types";

export const DEFAULT_BREEDING: BreedingConfig = { off_species: "low", mutation: "very_low", expressed_bias: 2 };

export interface BreedOptions {
  seed: string | number;
  /** One parent (asexual) or two. The count is checked against `repro:*` tags as a warning, not a block. */
  parents: Individual[];
  /** Force the child's species. Default: one parent's species, chosen at random. */
  species?: string;
  off_species?: Ordinal;
  mutation?: Ordinal;
  locks?: RollLocks;
  /** Starting age in years. Default 0. */
  age?: number;
}

/**
 * Create a child (spec §7.4).
 *
 * - Child species: one parent's species, at random (no true hybrids).
 * - Per slot (random order, conflict-filtered as in sampling): with the
 *   `mutation` probability the pick is drawn from the child species' pool;
 *   otherwise from the parents' picks. A parent of the child's species has
 *   weight 1, a parent of another species has weight p/(1-p) for the
 *   `off_species` probability p, and an *expressed* pick is multiplied by
 *   `expressed_bias`. Picks from another species are flagged in `inherited_from`.
 * - A trait outside the species pool (albinism, a rare flaw) is inherited like
 *   any other pick: the genotype is all that matters. That includes slots the
 *   species never rolls: any slot a parent carries is considered, and a parent
 *   without a pick there counts as "none".
 * - Heritable axes take a parent's value (weighted by each value's `inherit`);
 *   other axes are rolled fresh by `chance`.
 * - Scalars come from the child species' ranges; instincts likewise (they are
 *   a property of the species). Conditions are never inherited.
 */
export function breed(reg: Registry, opts: BreedOptions): RollResult {
  const n = opts.parents.length;
  if (n < 1 || n > 2) throw new Error(`breed needs one or two parents, got ${n}`);
  const warnings: Warning[] = [];
  const seed = String(opts.seed);
  const root = createRng(seed);
  const locks = opts.locks ?? {};
  const cfg = { ...DEFAULT_BREEDING, ...reg.breeding };
  const pMut = probabilityOf(reg.ordinals, opts.mutation ?? cfg.mutation, warnings);
  const pOff = Math.min(0.99, probabilityOf(reg.ordinals, opts.off_species ?? cfg.off_species, warnings));
  const offWeight = pOff / (1 - pOff);

  const phenos = opts.parents.map((p) => express(p, reg));

  // Parent count vs reproduction tags (soft).
  const can = (i: number, ...tags: string[]) => tags.some((t) => hasTag(phenos[i]!.tags, t));
  const countOk =
    n === 1 ? can(0, "repro:asexual", "repro:both") : can(0, "repro:sexual", "repro:both") && can(1, "repro:sexual", "repro:both");
  if (!countOk) {
    warnings.push({
      code: "parent_count",
      message:
        n === 1
          ? "A single parent was given, but the parent does not express repro:asexual or repro:both"
          : "Two parents were given, but not both express repro:sexual or repro:both",
    });
  }

  // Child species.
  const mainIdx = opts.species
    ? Math.max(0, opts.parents.findIndex((p) => p.species === opts.species))
    : root.fork("species").int(n);
  const speciesId = opts.species ?? opts.parents[mainIdx]!.species;
  const species = reg.species[speciesId];
  if (!species) throw new Error(`Unknown species "${speciesId}"`);

  // Axis values.
  const axis_values: Record<string, string> = {};
  for (const axis of species.axes ?? []) {
    const locked = locks.axis_values?.[axis.name];
    if (locked !== undefined) { axis_values[axis.name] = locked; continue; }
    const rng = root.fork(`axis:${axis.name}`);
    let picked: string | undefined;
    if (axis.heritable && !rng.fork("mut").chance(pMut)) {
      const names = new Set(axis.values.map((v) => v.name));
      const fromParents = opts.parents.map((p) => p.axis_values[axis.name]).filter((v): v is string => v !== undefined && names.has(v));
      picked = rng.fork("inherit").weighted(fromParents, (name) => {
        const inherit = axis.values.find((v) => v.name === name)!.inherit;
        return inherit ? chanceWeight(reg.ordinals, inherit, warnings) : 1;
      });
    }
    picked ??= rollAxisValue(axis, rng.fork("fresh"), reg, warnings);
    if (picked !== undefined) axis_values[axis.name] = picked;
  }
  const axisTags = Object.entries(axis_values).map(([k, v]) => `axis:${k}=${v}`);

  // Genotype.
  const pool = buildPool(species, axis_values, warnings);
  const gb = genotypeBuilder(reg, axisTags, warnings);
  applyBodyAndLocks(gb, species, reg, locks, warnings);
  const inherited_from: Record<string, string> = {};

  // Slots to fill: the child species' pool slots, plus any slot a parent carries.
  // The latter is how traits added by hand outside the pool (a rare flaw in a
  // slot the species never rolls) get passed on.
  const slotsToRoll = [...new Set([...pool.keys(), ...opts.parents.flatMap((p) => Object.keys(p.genotype))])]
    .filter((s) => !(s in gb.genotype))
    .sort();
  const ABSENT = "\0absent";
  for (const slot of root.fork("order").shuffle(slotsToRoll)) {
    const rng = root.fork(`slot:${slot}`);
    const optional = !pool.has(slot); // not a slot this species rolls: "none" is a real outcome
    const fromPool = () => {
      const picked = pickFromPool(slot, poolCandidates(slot, pool, reg, warnings), gb, rng.fork("pool"), reg, warnings);
      if (picked !== undefined) gb.take(slot, picked);
    };
    if (!optional && rng.fork("mut").chance(pMut)) { fromPool(); continue; }

    // Parents' picks, merged by trait id (a trait both parents carry counts once, summed).
    // For an optional slot, a parent with no pick contributes "none" (weighted like an expressed pick).
    const groups = new Map<string, { weight: number; foreign?: string }>();
    opts.parents.forEach((p, i) => {
      const speciesFactor = p.species === speciesId ? 1 : offWeight;
      const traitId = p.genotype[slot];
      if (!traitId) {
        if (optional) {
          const g = groups.get(ABSENT) ?? { weight: 0 };
          g.weight += speciesFactor * cfg.expressed_bias;
          groups.set(ABSENT, g);
        }
        return;
      }
      const trait = reg.traits[traitId];
      if (!trait || gb.blocked(trait)) return;
      const expressed = phenos[i]!.traits.find((t) => t.slot === slot)?.expressed ?? false;
      const g = groups.get(traitId) ?? { weight: 0, foreign: p.species };
      g.weight += speciesFactor * (expressed ? cfg.expressed_bias : 1);
      if (p.species === speciesId) delete g.foreign; // some parent of the child's species carries it
      groups.set(traitId, g);
    });
    const pick = rng.fork("src").weighted([...groups.entries()], ([, g]) => g.weight);
    if (!pick) { if (!optional) fromPool(); continue; }
    if (pick[0] === ABSENT) continue;
    gb.take(slot, pick[0]);
    if (pick[1].foreign) inherited_from[slot] = pick[1].foreign;
  }

  const scalars = sampleScalars(species, axis_values, root, locks.scalars);
  return {
    individual: {
      species: speciesId,
      seed,
      axis_values,
      genotype: gb.genotype,
      scalars,
      age: locks.age ?? opts.age ?? 0,
      conditions: [],
      ...(Object.keys(inherited_from).length ? { inherited_from } : {}),
    },
    warnings,
  };
}
