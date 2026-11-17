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

## Breeding (§7.4)

- **Same-species parents are symmetric.** The spec weighted the child-species
  parent heavily, which is wrong when both parents are the same species. Each
  parent's pick has weight 1; a parent of *another* species has weight
  `p/(1-p)` for the `off_species` probability `p` (so ~5% at `low`).
- **Expressed bias defaults to 1 (neutral), against the spec.** The spec
  weighted expressed picks above latent ones. That erodes any axis-gated gene:
  a latent copy is transmitted at 1/3 against 1/2 for an expressed copy, so a
  male-only crest gene fell from 31% to ~3% of a 300-strong population in 15
  generations (measured; it survived only through 1% mutation). The axis must
  only enable or disable *expression*, never the gene's chance of being passed
  on, so the default is neutral. `expressed_bias` stays as an opt-in selection
  pressure (per world via `Registry.breeding`); a regression test covers both.
- **Options, not species fields.** `off_species` (default `low`) and
  `mutation` (default `very_low`) are breed-call options, with world defaults
  in `Registry.breeding`. `mutation` = chance a slot ignores the parents and
  draws from the child species' pool.
- **Child species:** one parent's, at random, or forced with `species`.
  Body plan, scalar ranges and instincts come from it. Scalars are sampled
  fresh (not inherited). Conditions are never inherited. Starting age is 0
  unless given.
- **Slots a species never rolls are still inherited.** Considered slots are
  the child pool's slots *plus any slot a parent carries* (this is what lets a
  hand-added flaw like `discharge_tendency` be passed on). For such a slot a
  parent with no pick counts as "none", weighted like an expressed pick, so a
  one-carrier pairing passes it on about half the time and two carriers
  always do. Children without it have no entry in that slot.
- **`inherited_from`:** a pick that came from a parent of a different species
  is recorded as `inherited_from[slot] = species`. A trait carried by any
  parent of the child's own species is never flagged.
- **Heritable axes.** `Axis.heritable` (default false: sex is rerolled each
  time, caste would inherit). A heritable axis takes one parent's value,
  weighted by each value's optional `inherit` ordinal (neutral if omitted),
  so a rare "queen" can pass down far less often than "worker". `mutation`
  rerolls it fresh by `chance`. A parent value the child species lacks falls
  back to a fresh roll.
- **Parent count** is checked against `repro:*` tags as a *warning*
  (`parent_count`), never a block: one parent needs `repro:asexual|both`, two
  need `repro:sexual|both`. Zero or more than two parents throws.

## Snapshot (§12)

`buildSnapshot(registry, { id, individual, links, names, now })` resolves
everything once and returns plain JSON, **deeply frozen**. Exporters must not
re-implement any of it. Decisions:

- **Name and pronouns** were missing from the spec. `Individual.name` and
  `Individual.pronouns` are new; pronouns default from the first axis value
  that defines them (`AxisValue.pronouns`, e.g. sex), else they/them.
  The core never hardcodes a sex-to-pronoun mapping.
- **Scalars** carry their unit: `{ value, unit? }`.
- **Skills** are world-defined (`Registry.skills`, `SkillDef`); entries are
  resolved to labels and sorted by level, then passion (disinterested ranks
  below none). Unknown skills/levels warn but are kept. Ranks are internal.
- **Thoughts** with `expires <= now` are dropped when `now` is given.
- **Relations** come from `links` touching `id`, with `direction` (`out` =
  this -> other) and optional `other_name`. The spec's `{type, other, feeling}`
  could not express "A is B's parent" vs "B is A's parent".
- **Behaviors** include dropped items (`active: false`, with `overridden`) so
  exporters can mention them; suppressed/dormant items are not exposed.
- **Warnings** aggregate expression, behavior and snapshot-level warnings.
- Golden snapshots live in `fixtures/golden/` (explicit individuals, not
  rolled ones, so RNG changes do not churn them).

## Not yet implemented

Everything outside `packages/core`: SQLite storage, the REST API, the pack
import/export endpoints, exporters, and the UI. Also deferred: storing a
birth date instead of a bare age, and "intentionally unusual" acknowledgement
notes on warnings (§8).
