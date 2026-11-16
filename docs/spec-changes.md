# Spec changes and decisions made while building `core`

Deviations from / additions to the original build spec, with the reason for each.

## Resolver

- **Conditions are ordered layers (replaces §7.2's "subtract removes").**
  Layer 0 = axis tags, stage tag, tags from expressed traits. Layer *k* = the
  *k*-th active condition by `since` (ties by array order). Within a layer,
  `removes` happen before `provides`. A tag is present iff its highest
  providing layer is >= every layer that removes it. This makes
  amputation -> prosthesis work (and prosthesis -> amputation remove it).
- **`target` vs `requires` on conditions.** `target` is checked at *onset*
  (against layers strictly below the condition), so a condition's own removal
  never invalidates itself. `requires` is a *live dependency* checked against
  the final tag set: a discharge disorder that requires `power:bioelectric`
  goes dormant if a later condition removes electricity.
- **Requirement grammar:** `requires` entries may be a tag string or
  `{all: [...]}`, `{any: [...]}`, `{not: ...}`. The list itself is an AND.
- **Expression algorithm:** non-cumulative iteration from the empty state, so
  mutual requirements never bootstrap. `not` requirements can make a system
  oscillate; the states in the cycle are intersected and an
  `expression_unstable` warning is emitted.
- **Tag matching:** `part:arm` matches `part:arm.l`/`.r` at a dot boundary
  (never `part:armor`); `part:arm.l` matches only itself and deeper instances.
  A pattern with `=value` must match the value; without one it matches any.
  `provides`/`removes`/`conflicts` accept brace shorthand: `part:arm.{l,r}`.
- **Conflicts** are evaluated at genotype level (latent picks count), in both
  directions, and also against axis tags.

## Determinism

- Own PRNG (sfc32 seeded via cyrb128), not `Math.random`.
- `fork(label)` derives streams from the *seed path*, not consumed state, so
  adding a slot/scalar to a species does not change other slots' rolls.
- The seed is **provenance**; the stored genotype is the source of truth. A
  seed only reproduces a roll while the species definition is unchanged.

## Data model

- **Rare genetic deviations are traits, not conditions.** Albinism or a
  discharge flaw lives in the genotype like any other pick, so breeding
  inherits it through the normal path. It is *not* in the species pool; it is
  added to an individual by locking it into the genotype. (A deviation that
  is unusually common for a species belongs in the pool with a "none"
  majority.) Conditions are therefore never rolled and never inherited, and
  there is no `heritable` flag and no `species.congenital`.
- **Locks are explicit intent.** Locking a trait that is outside the species
  pool is silent; locking a trait into the wrong slot (`slot_mismatch`) or an
  unknown trait (`unknown_trait`) warns.
- **One probability scale** (`none 0 / very_low 1% / low 5% / medium 15%`)
  for off-species inheritance and similar. `very_low` is new.
- **Scalars** sample from a triangular distribution (min, typical, max).
- **Default age** is uniform within the stage named `adult` (else 0..lifespan).
- **No species inheritance** in V1. Variants are cloned in the authoring UI.

## Behavior resolution (§7.3)

- Runs *after* expression and never feeds back into it. `requires` on an item
  is checked against the phenotype's tags; unmet => `dormant` (reported, not
  an error). Item `provides` only matter for conflicts between items.
- Priority: strength descending, ties by collection order (instinct, culture,
  religions as listed; within a set, item order). Items are accepted greedily,
  and a *suppressed* item never blocks anyone else, so with A>B and a B-C
  conflict, A and C both stay active.
- Strength is an ordinal (`nudge<habit<drive<compulsion` by default) and is
  renameable per world through `OrdinalConfig.strength`.
- Item ids must be unique across the registry (overrides refer to them);
  `validateRegistry` reports duplicates.
- Overrides, last one per item wins:
  - `drop`: removed *before* conflicts, so it frees its rivals. The item stays
    in the output as `active: false`, so exporters can mention it.
  - `keep`: pinned, wins conflicts it would have lost. Requirements still apply.
  - `force`: pinned, may be an item in none of the layers (layer `forced`),
    and ignores unmet requirements.
  - Every overridden item carries `original`, the status resolution would have
    given it without the override (`active | suppressed | dormant | dropped | absent`).
    It is computed by actually running resolution twice, not inferred.
  - Two pinned items that conflict: earlier wins, with `override_conflict`.

## Not yet implemented

Breeding (§7.4), snapshot assembly (§12), and everything outside
`packages/core`.
