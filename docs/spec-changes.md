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

- **Congenital conditions:** `species.congenital: [{condition, chance}]` are
  rolled at sampling time (spec had no step for rolling conditions).
  `condition.heritable` marks which ones breeding may pass on (breeding not
  implemented yet).
- **One probability scale** (`none 0 / very_low 1% / low 5% / medium 15%`)
  serves both off-species inheritance and congenital incidence. `very_low` is
  new.
- **Scalars** sample from a triangular distribution (min, typical, max).
- **Default age** is uniform within the stage named `adult` (else 0..lifespan).
- **No species inheritance** in V1. Variants are cloned in the authoring UI.

## Not yet implemented

Behavior resolution (§7.3), breeding (§7.4), snapshot assembly (§12), and
everything outside `packages/core`.
