import { z } from "zod";
import type { Req } from "./types";

/**
 * Body schemas for stored entities, shared by the server and (later) the
 * browser editor. They check *structure* only (types, required fields):
 * referential and semantic problems are warnings elsewhere, never blocks.
 * Unknown keys are tolerated so newer data does not break older readers.
 *
 * A stored body never contains `id`: an entity's `key` plays that role and is
 * what other bodies reference.
 */
export const ENTITY_KINDS = ["slot", "trait", "condition", "behavior", "skill", "species", "individual"] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

/** Keys are lowercase, start alphanumeric, and may contain `_ . -`. */
export const KEY_PATTERN = /^[a-z0-9][a-z0-9_.-]*$/;

const str = z.string().min(1);
const tags = z.array(str);
const ordinal = str;

const req: z.ZodType<Req> = z.lazy(() =>
  z.union([
    str,
    z.strictObject({ all: z.array(req) }),
    z.strictObject({ any: z.array(req) }),
    z.strictObject({ not: req }),
  ]),
);
const reqs = z.array(req);

const content = z.looseObject({
  prose: z.string().optional(),
  image_tags: z.array(z.string()).optional(),
  summary: z.string().optional(),
});

const pronouns = z.looseObject({ subject: str, object: str, possessive: str });

const poolEntry = z.looseObject({ trait: str, chance: ordinal });
const slotTrait = z.looseObject({ slot: str, trait: str, chance: ordinal });
const slotTraitRef = z.looseObject({ slot: str, trait: str });

const axisValue = z.looseObject({
  name: str,
  chance: ordinal,
  inherit: ordinal.optional(),
  pronouns: pronouns.optional(),
  modifiers: z
    .looseObject({
      add: z.array(slotTrait).optional(),
      remove: z.array(slotTraitRef).optional(),
      reweight: z.array(slotTrait).optional(),
      scalars: z.record(z.string(), z.looseObject({ mult: z.number().optional(), add: z.number().optional() })).optional(),
    })
    .optional(),
});

const axis = z.looseObject({ name: str, heritable: z.boolean().optional(), values: z.array(axisValue).min(1) });

const scalarDef = z.looseObject({
  typical: z.number(),
  range: z.tuple([z.number(), z.number()]),
  unit: z.string().optional(),
  growth: z.array(z.tuple([z.number(), z.number()])).optional(),
});
const lifeStage = z.looseObject({ name: str, from_age: z.number(), to_age: z.number().optional() });

const behaviorItem = z.looseObject({
  id: str,
  label: str,
  strength: ordinal,
  content: content.optional(),
  provides: tags.optional(),
  requires: reqs.optional(),
  conflicts: tags.optional(),
});

export const bodySchemas = {
  slot: z.looseObject({ name: str, description: z.string().optional(), aliases: z.array(z.string()).optional() }),
  trait: z.looseObject({
    slot: str,
    label: str,
    provides: tags.optional(),
    requires: reqs.optional(),
    conflicts: tags.optional(),
    content: content.optional(),
    visual: z.unknown().optional(),
  }),
  condition: z.looseObject({
    label: str,
    kind_label: z.string().optional(),
    target: str.optional(),
    provides: tags.optional(),
    requires: reqs.optional(),
    removes: tags.optional(),
    content: content.optional(),
  }),
  behavior: z.looseObject({
    label: str,
    role: z.enum(["instinct", "culture", "religion", "other"]),
    items: z.array(behaviorItem),
  }),
  skill: z.looseObject({ label: str, description: z.string().optional() }),
  species: z.looseObject({
    label: str,
    body_plan: str,
    pools: z.record(z.string(), z.array(poolEntry)),
    axes: z.array(axis).optional(),
    instincts: str.optional(),
    data: z.record(z.string(), scalarDef).optional(),
    life_stages: z.array(lifeStage).optional(),
  }),
  individual: z.looseObject({
    name: z.string().optional(),
    pronouns: pronouns.optional(),
    species: str,
    seed: z.string(),
    axis_values: z.record(z.string(), z.string()),
    genotype: z.record(z.string(), z.string()),
    scalars: z.record(z.string(), z.number()),
    age: z.number(),
    conditions: z.array(
      z.looseObject({ condition: str, target: z.string().optional(), since: z.number().optional(), note: z.string().optional() }),
    ),
    inherited_from: z.record(z.string(), z.string()).optional(),
    skills: z
      .array(z.looseObject({ skill: str, level: ordinal, passion: ordinal, focus: z.string().optional() }))
      .optional(),
    thoughts: z
      .array(
        z.looseObject({
          text: z.string(),
          kind: z.enum(["short", "formative"]),
          since: z.number(),
          expires: z.number().optional(),
        }),
      )
      .optional(),
    culture: str.optional(),
    religions: z.array(str).optional(),
    behavior_overrides: z
      .array(z.looseObject({ item: str, action: z.enum(["keep", "drop", "force"]), note: z.string().optional() }))
      .optional(),
  }),
} satisfies Record<EntityKind, z.ZodType>;

export interface BodyIssue {
  path: string;
  message: string;
}

export type BodyValidation = { ok: true; body: Record<string, unknown> } | { ok: false; issues: BodyIssue[] };

export function isEntityKind(kind: string): kind is EntityKind {
  return (ENTITY_KINDS as readonly string[]).includes(kind);
}

export function validateBody(kind: EntityKind, body: unknown): BodyValidation {
  const r = bodySchemas[kind].safeParse(body);
  if (r.success) return { ok: true, body: r.data as Record<string, unknown> };
  return { ok: false, issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) };
}
