import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { KEY_PATTERN, type Snapshot } from "@worldforge/core";
import { parse } from "yaml";
import { z } from "zod";
import { TemplateError, parseTemplate, renderTemplate } from "./template";

export type ExporterKind = "prose" | "llm" | "image_prompt" | "sheet" | "view";

export interface RenderContext {
  world: { id: string; name: string };
}

/** An exporter is a pure consumer of a snapshot. It must not re-implement resolution. */
export interface Exporter {
  id: string;
  name: string;
  description?: string;
  kind: ExporterKind;
  content_type: string;
  /** What it understands (informational; every exporter degrades gracefully on unknown content). */
  consumes?: { tags?: string[]; packs?: string[] };
  render(snapshot: Snapshot, ctx: RenderContext, options: Record<string, unknown>): string | Promise<string>;
}

// ---------------------------------------------------------------- context

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const lowerFirst = (s: string) => (s ? s[0]!.toLowerCase() + s.slice(1) : s);

export function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

const nonEmpty = (s: string | undefined): s is string => typeof s === "string" && s.trim() !== "";

/**
 * Flatten a snapshot into the data templates see. All resolution (what is
 * expressed, which behaviors won, pronouns, thought expiry) already happened
 * in the snapshot; this only reshapes and phrases it.
 */
export function templateContext(s: Snapshot): Record<string, unknown> {
  const p = s.individual.pronouns;
  const speciesLower = lowerFirst(s.species.label);
  const name = s.individual.name ?? `The ${speciesLower}`;

  const expressed = s.traits.filter((t) => t.expressed && nonEmpty(t.content.prose)).map((t) => ({ slot: t.slot, label: t.label, prose: t.content.prose!, summary: t.content.summary ?? "" }));
  const latent = s.traits.filter((t) => !t.expressed && nonEmpty(t.content.prose)).map((t) => ({ slot: t.slot, label: t.label, prose: t.content.prose! }));

  const conditionView = (c: Snapshot["conditions"][number]) => ({
    label: c.label,
    kind: c.kind_label ?? "",
    target: c.target ?? "",
    prose: c.content.prose ?? "",
    note: c.note ?? "",
    reason: c.inactive_reason ?? "",
  });
  const conditions = s.conditions.filter((c) => c.active).map(conditionView);
  const dormantConditions = s.conditions.filter((c) => !c.active).map(conditionView);

  const behaviors = s.behaviors.filter((b) => b.active).map((b) => ({ label: b.label, prose: b.content.prose ?? b.label, strength: b.strength, layer: b.layer, source: b.source, forced: b.overridden?.action === "force" }));
  const droppedBehaviors = s.behaviors.filter((b) => !b.active).map((b) => ({ label: b.label, note: b.overridden?.note ?? "", would_have_been: b.overridden?.original ?? "" }));

  const relations = s.relations.map((r) => {
    const other = r.other_name ?? r.other;
    const text = r.direction === "out" ? `${cap(p.subject)} is ${r.type} of ${other}` : `${other} is ${r.type} of ${p.object}`;
    return { type: r.type, other, direction: r.direction, feeling: r.feeling ?? "", text };
  });

  // Snapshots keep full precision; what people read is rounded.
  const scalarList = Object.entries(s.scalars).map(([n, v]) => {
    const value = Math.round(v.value * 10) / 10;
    const adult = Math.round((v.adult_value ?? v.value) * 10) / 10;
    return { name: n, value, adult_value: adult, unit: v.unit ?? "", text: `${n} ${value}${v.unit ? ` ${v.unit}` : ""}` };
  });

  const imageTags = [
    ...new Set([
      ...s.traits.filter((t) => t.expressed).flatMap((t) => t.content.image_tags ?? []),
      ...s.conditions.filter((c) => c.active).flatMap((c) => c.content.image_tags ?? []),
      ...s.behaviors.filter((b) => b.active).flatMap((b) => b.content.image_tags ?? []),
    ]),
  ].filter(nonEmpty);

  return {
    id: s.individual.id ?? "",
    seed: s.seed,
    name,
    has_name: s.individual.name !== undefined,
    species: s.species.label,
    species_lower: speciesLower,
    // whole years from age 1 on; a single decimal for infants
    age: s.age >= 1 ? Math.floor(s.age) : Math.round(s.age * 10) / 10,
    life_stage: s.life_stage ?? "",
    axis: s.axis_values,
    axes: Object.entries(s.axis_values).map(([n, v]) => ({ name: n, value: v })),
    subject: p.subject,
    Subject: cap(p.subject),
    object: p.object,
    Object: cap(p.object),
    possessive: p.possessive,
    Possessive: cap(p.possessive),
    expressed,
    has_expressed: expressed.length > 0,
    expressed_list: joinList(expressed.map((e) => e.prose)),
    latent,
    has_latent: latent.length > 0,
    conditions,
    has_conditions: conditions.length > 0,
    dormant_conditions: dormantConditions,
    has_dormant_conditions: dormantConditions.length > 0,
    behaviors,
    has_behaviors: behaviors.length > 0,
    dropped_behaviors: droppedBehaviors,
    has_dropped_behaviors: droppedBehaviors.length > 0,
    skills: s.skills.map((k) => ({ label: k.label, level: k.level, passion: k.passion, focus: k.focus ?? "", description: k.description ?? "" })),
    has_skills: s.skills.length > 0,
    formative_thoughts: s.thoughts.filter((t) => t.kind === "formative").map((t) => ({ text: t.text })),
    has_formative_thoughts: s.thoughts.some((t) => t.kind === "formative"),
    short_thoughts: s.thoughts.filter((t) => t.kind === "short").map((t) => ({ text: t.text })),
    has_short_thoughts: s.thoughts.some((t) => t.kind === "short"),
    relations,
    has_relations: relations.length > 0,
    parts: s.parts.map((t) => t.replace(/^part:/, "")),
    scalars: Object.fromEntries(scalarList.map((x) => [x.name, x])),
    scalar_list: scalarList,
    scalar_summary: scalarList.map((x) => x.text).join(", "),
    tags: s.tags,
    image_tags: imageTags,
    image_tag_list: imageTags.join(", "),
    warnings: s.warnings.map((w) => w.message),
    has_warnings: s.warnings.length > 0,
  };
}

// ------------------------------------------------------- template exporters

const templateDef = z.object({
  id: z.string().regex(KEY_PATTERN, "id must be lowercase letters, digits, _ . -"),
  name: z.string().min(1),
  kind: z.enum(["prose", "llm", "image_prompt", "sheet", "view"]).default("prose"),
  description: z.string().optional(),
  content_type: z.string().default("text/plain"),
  consumes: z.object({ tags: z.array(z.string()).optional(), packs: z.array(z.string()).optional() }).optional(),
  template: z.string().min(1),
});

export type TemplateExporterDef = z.input<typeof templateDef>;

/** An exporter that is just a template file. Parsed once; a bad template fails at load. */
export function templateExporter(input: unknown): Exporter {
  const def = templateDef.parse(input);
  const nodes = parseTemplate(def.template);
  return {
    id: def.id,
    name: def.name,
    kind: def.kind,
    content_type: def.content_type,
    ...(def.description ? { description: def.description } : {}),
    ...(def.consumes ? { consumes: def.consumes } : {}),
    render: (snapshot) => renderTemplate(nodes, templateContext(snapshot)),
  };
}

export interface LoadError {
  file: string;
  message: string;
}

/** Load `*.exporter.yaml|yml|json` files from a directory. One bad file never stops the rest. */
export function loadTemplateExporters(dir: string): { exporters: Exporter[]; errors: LoadError[] } {
  const exporters: Exporter[] = [];
  const errors: LoadError[] = [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => /\.exporter\.(ya?ml|json)$/.test(f)).sort();
  } catch {
    return { exporters, errors };
  }
  for (const file of files) {
    try {
      exporters.push(templateExporter(parse(readFileSync(join(dir, file), "utf8"))));
    } catch (e) {
      const message = e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".") || "(file)"}: ${i.message}`).join("; ") : e instanceof TemplateError ? e.message : (e as Error).message;
      errors.push({ file, message });
    }
  }
  return { exporters, errors };
}

export const BUILTIN_EXPORTERS_DIR = fileURLToPath(new URL("../builtin", import.meta.url));

export class ExporterSet {
  private byId = new Map<string, Exporter>();
  readonly errors: LoadError[] = [];

  add(e: Exporter, source = e.id): void {
    if (this.byId.has(e.id)) {
      this.errors.push({ file: source, message: `Duplicate exporter id "${e.id}"; keeping the first` });
      return;
    }
    this.byId.set(e.id, e);
  }

  get(id: string): Exporter | undefined {
    return this.byId.get(id);
  }

  list(): Exporter[] {
    return [...this.byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
}

/** Built-ins first, then plugins from `pluginsDir` (a plugin cannot replace a built-in). */
export function createExporters(pluginsDir?: string): ExporterSet {
  const set = new ExporterSet();
  const builtin = loadTemplateExporters(BUILTIN_EXPORTERS_DIR);
  builtin.exporters.forEach((e) => set.add(e));
  set.errors.push(...builtin.errors);
  if (pluginsDir) {
    const plugins = loadTemplateExporters(pluginsDir);
    plugins.exporters.forEach((e) => set.add(e, `plugins/${e.id}`));
    set.errors.push(...plugins.errors.map((e) => ({ ...e, file: `plugins/${e.file}` })));
  }
  return set;
}
