import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePack, validateBody, type EntityKind, type Pack } from "@worldforge/core";
import { stringify } from "yaml";
import { HttpError, type Command, type Store } from "./store";

/** Pack section -> entity kind. Individuals are not pack content. */
export const PACK_SECTIONS = {
  slots: "slot",
  traits: "trait",
  conditions: "condition",
  behaviors: "behavior",
  skills: "skill",
  species: "species",
} as const satisfies Record<string, EntityKind>;

type Section = keyof typeof PACK_SECTIONS;

interface Entry {
  kind: EntityKind;
  key: string;
  body: Record<string, unknown>;
}

export interface PackIssue {
  kind: EntityKind;
  key: string;
  issues: { path: string; message: string }[];
}

export interface PackPreview {
  manifest: Pack["manifest"];
  counts: Partial<Record<EntityKind, number>>;
  /** Shown to the user before they confirm: the only content affordance. */
  content_warnings: string[];
  requires_packs: { id: string; installed: boolean }[];
  conflicts: { kind: EntityKind; key: string; existing_id: string; same_content: boolean }[];
  installed_version: string | null;
  issues: PackIssue[];
}

/** Parse YAML or JSON text, or accept an already-parsed object. */
export function readPack(input: unknown): Pack {
  if (typeof input === "string") {
    try {
      return parsePack(input);
    } catch (e) {
      throw new HttpError(422, "invalid_pack", (e as Error).message);
    }
  }
  if (input && typeof input === "object") {
    const m = (input as { manifest?: Partial<Pack["manifest"]> }).manifest;
    if (!m || typeof m.id !== "string" || typeof m.name !== "string" || typeof m.version !== "string") {
      throw new HttpError(422, "invalid_pack", "Pack manifest must have string id, name and version");
    }
    return { ...(input as Pack), manifest: { ...m, content_warnings: m.content_warnings ?? [] } as Pack["manifest"] };
  }
  throw new HttpError(400, "invalid_pack", "Send the pack as YAML/JSON text or an object");
}

function entriesOf(pack: Pack): { entries: Entry[]; issues: PackIssue[] } {
  const entries: Entry[] = [];
  const issues: PackIssue[] = [];
  for (const [section, kind] of Object.entries(PACK_SECTIONS) as [Section, EntityKind][]) {
    for (const item of (pack[section] ?? []) as unknown as Record<string, unknown>[]) {
      const { id, ...body } = item ?? {};
      if (typeof id !== "string" || !id) {
        issues.push({ kind, key: String(id ?? "?"), issues: [{ path: "id", message: "Every pack entry needs a string id" }] });
        continue;
      }
      const v = validateBody(kind, body);
      if (!v.ok) issues.push({ kind, key: id, issues: v.issues });
      else entries.push({ kind, key: id, body: v.body });
    }
  }
  return { entries, issues };
}

export function previewPack(store: Store, worldId: string, pack: Pack): PackPreview {
  const { entries, issues } = entriesOf(pack);
  const installed = store.listPacks(worldId);
  const counts: PackPreview["counts"] = {};
  const conflicts: PackPreview["conflicts"] = [];
  for (const e of entries) {
    counts[e.kind] = (counts[e.kind] ?? 0) + 1;
    const existing = store.findByKey(worldId, e.kind, e.key);
    if (existing) {
      conflicts.push({ kind: e.kind, key: e.key, existing_id: existing.id, same_content: JSON.stringify(sortKeys(existing.body)) === JSON.stringify(sortKeys(e.body)) });
    }
  }
  return {
    manifest: pack.manifest,
    counts,
    content_warnings: pack.manifest.content_warnings,
    requires_packs: (pack.manifest.requires_packs ?? []).map((id) => ({ id, installed: installed.some((p) => p.pack_id === id) })),
    conflicts,
    installed_version: installed.find((p) => p.pack_id === pack.manifest.id)?.version ?? null,
    issues,
  };
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  return v;
}

export interface InstallOptions {
  /** Must be exactly true: the caller has been shown the manifest and content warnings. */
  confirm?: boolean;
  /** What to do with entities whose kind+key already exist. */
  on_conflict?: "abort" | "skip" | "replace";
}

export interface InstallResult {
  preview: PackPreview;
  created: number;
  updated: number;
  skipped: number;
}

/**
 * Copy a pack's content into a world (worlds never reference packs live).
 * Requires an explicit confirm; on a missing confirm the error carries the
 * preview (description and content warnings) for the UI to show.
 */
export function installPack(store: Store, worldId: string, pack: Pack, opts: InstallOptions = {}): InstallResult {
  const preview = previewPack(store, worldId, pack);
  if (opts.confirm !== true) {
    throw new HttpError(400, "confirmation_required", "Review the pack's description and content warnings, then resend with confirm: true", { preview });
  }
  if (preview.issues.length) throw new HttpError(422, "invalid_pack", "The pack has invalid entries", { issues: preview.issues });
  const policy = opts.on_conflict ?? "abort";
  if (preview.conflicts.length && policy === "abort") {
    throw new HttpError(409, "pack_conflict", `${preview.conflicts.length} entit${preview.conflicts.length === 1 ? "y" : "ies"} already exist; choose on_conflict: skip or replace`, { conflicts: preview.conflicts });
  }

  const origin = (key: string) => ({ pack: pack.manifest.id, version: pack.manifest.version, key });
  const commands: Command[] = [];
  let skipped = 0;
  for (const e of entriesOf(pack).entries) {
    const existing = store.findByKey(worldId, e.kind, e.key);
    if (!existing) commands.push({ op: "create", kind: e.kind, key: e.key, body: e.body, origin: origin(e.key) });
    else if (policy === "skip") skipped++;
    else commands.push({ op: "update", id: existing.id, body: e.body, origin: origin(e.key) });
  }

  return store.transaction(() => {
    const changes = commands.length ? store.apply(worldId, commands, { actor: "pack", note: `install ${pack.manifest.id}@${pack.manifest.version}` }).changes : [];
    store.recordPack(worldId, pack.manifest);
    return {
      preview,
      created: changes.filter((c) => c.op === "create").length,
      updated: changes.filter((c) => c.op === "update").length,
      skipped: skipped + changes.filter((c) => c.op === "noop").length,
    };
  });
}

/** Export a world's content (never individuals) as a pack. */
export function exportPack(store: Store, worldId: string, manifest: Pack["manifest"], kinds?: EntityKind[]): Pack {
  const wanted = (kinds ?? Object.values(PACK_SECTIONS)) as EntityKind[];
  const pack: Pack = { manifest: { ...manifest, content_warnings: manifest.content_warnings ?? [] } };
  for (const [section, kind] of Object.entries(PACK_SECTIONS) as [Section, EntityKind][]) {
    if (!wanted.includes(kind)) continue;
    const items = store.entitiesByKinds(worldId, [kind]).map((e) => ({ id: e.key, ...e.body }));
    if (items.length) (pack as unknown as Record<string, unknown[]>)[section] = items;
  }
  return pack;
}

export function packToYaml(pack: Pack): string {
  return stringify(pack, { lineWidth: 0 });
}

export interface BundledPack {
  id: string;
  file: string;
  pack: Pack;
}

/** Packs shipped with the app (the `packs/` directory). */
export function loadBundledPacks(dir: string): BundledPack[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => /\.(ya?ml|json)$/.test(f)).sort();
  } catch {
    return [];
  }
  const out: BundledPack[] = [];
  for (const file of files) {
    try {
      const pack = readPack(readFileSync(join(dir, file), "utf8"));
      out.push({ id: pack.manifest.id, file, pack });
    } catch {
      // a broken bundled file must not stop the server; it simply is not offered
    }
  }
  return out;
}
