import {
  KEY_PATTERN,
  buildRegistry,
  extractRefs,
  isEntityKind,
  validateBody,
  type BreedingConfig,
  type EntityKind,
  type OrdinalConfig,
  type Registry,
} from "@worldforge/core";
import type { Db } from "./db";
import { newId, shortRandom, slugify } from "./ids";

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export interface WorldSettings {
  ordinals?: Partial<OrdinalConfig>;
  breeding?: Partial<BreedingConfig>;
}

export interface World {
  id: string;
  name: string;
  settings: WorldSettings;
  rev: number;
  created_at: string;
  updated_at: string;
}

export interface Origin {
  pack: string;
  version: string;
  key: string;
}

export interface Entity {
  id: string;
  world_id: string;
  kind: EntityKind;
  key: string;
  name: string;
  body: Record<string, unknown>;
  notes: string | null;
  origin: Origin | null;
  schema_version: number;
  created_at: string;
  updated_at: string;
}

export interface Link {
  id: string;
  world_id: string;
  from: string;
  to: string;
  type: string;
  feeling?: string;
  since?: number;
  created_at: string;
}

export type Command =
  | { op: "create"; kind: string; key?: string; body: unknown; notes?: string | null; origin?: Origin }
  | { op: "update"; id: string; body?: unknown; patch?: unknown; notes?: string | null; origin?: Origin | null }
  | { op: "delete"; id: string; force?: boolean };

export interface ApplyOptions {
  actor?: string;
  note?: string;
  /** Run everything (validation, conflicts, reference checks) and roll back. */
  dryRun?: boolean;
}

export interface Change {
  op: "create" | "update" | "delete" | "noop";
  entity_id: string;
  kind: EntityKind;
  key: string;
  before: Entity | null;
  after: Entity | null;
  edit_id?: number;
}

export interface EditRow {
  id: number;
  world_id: string;
  batch: string;
  entity_id: string;
  op: "create" | "update" | "delete";
  before: Snapshot | null;
  after: Snapshot | null;
  actor: string;
  note: string | null;
  undone_by: number | null;
  at: string;
}

/** What an edit stores about an entity: enough to restore it exactly. */
interface Snapshot {
  kind: EntityKind;
  key: string;
  name: string;
  body: Record<string, unknown>;
  notes: string | null;
  origin: Origin | null;
  created_at: string;
}

class Rollback extends Error {
  constructor(public changes: Change[]) {
    super("rollback");
  }
}

const SCHEMA_VERSION_OF_BODIES = 1;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const REGISTRY_KINDS: EntityKind[] = ["slot", "trait", "condition", "behavior", "skill", "species"];

const now = () => new Date().toISOString();
const json = (v: unknown) => JSON.stringify(v);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** RFC 7386 JSON Merge Patch. Arrays and scalars replace; `null` deletes. */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isObj(patch)) return patch;
  const out: Record<string, unknown> = isObj(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (FORBIDDEN_KEYS.has(k)) throw new HttpError(400, "invalid_patch", `Forbidden key "${k}" in patch`);
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
  return v;
}

function searchText(name: string, key: string, body: unknown): string {
  const parts = [name, key];
  const walk = (v: unknown) => {
    if (typeof v === "string") parts.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (isObj(v)) Object.values(v).forEach(walk);
  };
  walk(body);
  return parts.join(" ");
}

/** Entity names are derived, never set directly: `label` (or `name` for slots/individuals), else the key. */
export function displayName(kind: EntityKind, body: Record<string, unknown>, key: string): string {
  const v = kind === "slot" || kind === "individual" ? body["name"] : body["label"];
  return typeof v === "string" && v ? v : key;
}

function ftsQuery(q: string): string | null {
  const tokens = q.match(/[\p{L}\p{N}_]+/gu);
  return tokens && tokens.length ? tokens.map((t) => `"${t}"*`).join(" ") : null;
}

export class Store {
  constructor(public readonly db: Db) {}

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /** Consistent copy of the whole database (a single file) to `path`. */
  backup(path: string): void {
    this.db.prepare("VACUUM INTO ?").run(path);
  }

  // ---------------------------------------------------------------- worlds

  private worldFrom(r: any): World {
    return { id: r.id, name: r.name, settings: JSON.parse(r.settings), rev: r.rev, created_at: r.created_at, updated_at: r.updated_at };
  }

  createWorld(name: string, settings: WorldSettings = {}): World {
    if (!name.trim()) throw new HttpError(422, "invalid_world", "A world needs a name");
    const id = newId();
    const t = now();
    this.db.prepare("INSERT INTO worlds (id, name, settings, rev, created_at, updated_at) VALUES (?,?,?,?,?,?)").run(id, name.trim(), json(settings), 0, t, t);
    return this.getWorld(id);
  }

  getWorld(id: string): World {
    const r = this.db.prepare("SELECT * FROM worlds WHERE id = ?").get(id);
    if (!r) throw new HttpError(404, "world_not_found", `No world "${id}"`);
    return this.worldFrom(r);
  }

  listWorlds(): World[] {
    return this.db.prepare("SELECT * FROM worlds ORDER BY created_at, id").all().map((r) => this.worldFrom(r));
  }

  updateWorld(id: string, patch: { name?: string; settings?: WorldSettings }): World {
    const w = this.getWorld(id);
    const name = patch.name?.trim() || w.name;
    const settings = patch.settings ?? w.settings;
    this.db.prepare("UPDATE worlds SET name = ?, settings = ?, rev = rev + 1, updated_at = ? WHERE id = ?").run(name, json(settings), now(), id);
    return this.getWorld(id);
  }

  deleteWorld(id: string): void {
    this.getWorld(id);
    this.transaction(() => {
      this.db.prepare("DELETE FROM entities_fts WHERE world_id = ?").run(id);
      this.db.prepare("DELETE FROM edits WHERE world_id = ?").run(id);
      this.db.prepare("DELETE FROM worlds WHERE id = ?").run(id);
    });
  }

  private bump(worldId: string): void {
    this.db.prepare("UPDATE worlds SET rev = rev + 1, updated_at = ? WHERE id = ?").run(now(), worldId);
  }

  // -------------------------------------------------------------- entities

  private entityFrom(r: any): Entity {
    return {
      id: r.id, world_id: r.world_id, kind: r.kind, key: r.key, name: r.name, body: JSON.parse(r.body), notes: r.notes,
      origin: r.origin ? JSON.parse(r.origin) : null, schema_version: r.schema_version, created_at: r.created_at, updated_at: r.updated_at,
    };
  }

  getEntity(id: string): Entity {
    const r = this.db.prepare("SELECT * FROM entities WHERE id = ?").get(id);
    if (!r) throw new HttpError(404, "entity_not_found", `No entity "${id}"`);
    return this.entityFrom(r);
  }

  findByKey(worldId: string, kind: EntityKind, key: string): Entity | undefined {
    const r = this.db.prepare("SELECT * FROM entities WHERE world_id = ? AND kind = ? AND key = ?").get(worldId, kind, key);
    return r ? this.entityFrom(r) : undefined;
  }

  listEntities(worldId: string, opts: { kind?: string; q?: string; limit?: number; offset?: number } = {}): { items: Entity[]; total: number } {
    this.getWorld(worldId);
    if (opts.kind !== undefined && !isEntityKind(opts.kind)) throw new HttpError(400, "invalid_kind", `Unknown kind "${opts.kind}"`);
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const offset = Math.max(opts.offset ?? 0, 0);
    const match = opts.q ? ftsQuery(opts.q) : null;
    const where = ["e.world_id = ?"];
    const args: unknown[] = [worldId];
    if (opts.kind) { where.push("e.kind = ?"); args.push(opts.kind); }
    let from = "entities e";
    let order = "e.kind, e.name COLLATE NOCASE, e.key";
    if (match) {
      from = "entities e JOIN entities_fts f ON f.entity_id = e.id";
      where.push("entities_fts MATCH ?");
      args.push(match);
      order = "bm25(entities_fts), e.name COLLATE NOCASE";
    }
    const sql = `FROM ${from} WHERE ${where.join(" AND ")}`;
    const total = (this.db.prepare(`SELECT COUNT(*) AS n ${sql}`).get(...args) as { n: number }).n;
    const rows = this.db.prepare(`SELECT e.* ${sql} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, limit, offset);
    return { items: rows.map((r) => this.entityFrom(r)), total };
  }

  entitiesByKinds(worldId: string, kinds: EntityKind[]): Entity[] {
    const marks = kinds.map(() => "?").join(",");
    return this.db.prepare(`SELECT * FROM entities WHERE world_id = ? AND kind IN (${marks}) ORDER BY kind, key`).all(worldId, ...kinds).map((r) => this.entityFrom(r));
  }

  /** Entities (and link counts) that still point at this one. */
  usedBy(entity: Entity): { referrers: { id: string; kind: EntityKind; key: string; name: string }[]; links: number } {
    const referrers = this.db
      .prepare(
        `SELECT DISTINCT e.id, e.kind, e.key, e.name FROM refs r JOIN entities e ON e.id = r.from_id
         WHERE r.world_id = ? AND r.to_kind = ? AND r.to_key = ? AND e.id != ? ORDER BY e.kind, e.name`,
      )
      .all(entity.world_id, entity.kind, entity.key, entity.id) as { id: string; kind: EntityKind; key: string; name: string }[];
    const links = (this.db.prepare("SELECT COUNT(*) AS n FROM links WHERE from_id = ? OR to_id = ?").get(entity.id, entity.id) as { n: number }).n;
    return { referrers, links };
  }

  // ----------------------------------------------------------------- edits

  /**
   * The single write path. All commands in a batch succeed or none do.
   * Every UI action and (later) every accepted LLM proposal goes through here.
   */
  apply(worldId: string, commands: Command[], opts: ApplyOptions = {}): { batch: string; changes: Change[] } {
    this.getWorld(worldId);
    if (!Array.isArray(commands) || commands.length === 0) throw new HttpError(400, "invalid_commands", "Send a non-empty list of commands");
    const batch = newId();
    const run = () => {
      const changes: Change[] = [];
      commands.forEach((cmd, index) => {
        try {
          changes.push(this.applyOne(worldId, cmd, batch, opts));
        } catch (e) {
          if (e instanceof HttpError) throw new HttpError(e.status, e.code, e.message, { command_index: index, ...(isObj(e.details) ? e.details : { details: e.details }) });
          throw e;
        }
      });
      if (changes.some((c) => c.op !== "noop")) this.bump(worldId);
      if (opts.dryRun) throw new Rollback(changes);
      return changes;
    };
    try {
      return { batch, changes: this.transaction(run) };
    } catch (e) {
      if (e instanceof Rollback) return { batch, changes: e.changes };
      throw e;
    }
  }

  private snapshotOf(e: Entity): Snapshot {
    return { kind: e.kind, key: e.key, name: e.name, body: e.body, notes: e.notes, origin: e.origin, created_at: e.created_at };
  }

  private logEdit(worldId: string, batch: string, entityId: string, op: EditRow["op"], before: Snapshot | null, after: Snapshot | null, opts: ApplyOptions): number {
    const r = this.db
      .prepare("INSERT INTO edits (world_id, batch, entity_id, op, before, after, actor, note, at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(worldId, batch, entityId, op, before ? json(before) : null, after ? json(after) : null, opts.actor ?? "user", opts.note ?? null, now());
    return Number(r.lastInsertRowid);
  }

  private writeDerived(e: Entity): void {
    this.db.prepare("DELETE FROM refs WHERE from_id = ?").run(e.id);
    const ins = this.db.prepare("INSERT INTO refs (world_id, from_id, to_kind, to_key) VALUES (?,?,?,?)");
    for (const r of extractRefs(e.kind, e.body)) ins.run(e.world_id, e.id, r.kind, r.key);
    this.db.prepare("DELETE FROM entities_fts WHERE entity_id = ?").run(e.id);
    this.db.prepare("INSERT INTO entities_fts (entity_id, world_id, text) VALUES (?,?,?)").run(e.id, e.world_id, searchText(e.name, e.key, e.body));
  }

  private checkBody(kind: EntityKind, body: unknown): Record<string, unknown> {
    const v = validateBody(kind, body);
    if (!v.ok) throw new HttpError(422, "invalid_body", `Invalid ${kind} body`, { issues: v.issues });
    return v.body;
  }

  private insertEntity(worldId: string, id: string, snap: Snapshot): Entity {
    this.db
      .prepare("INSERT INTO entities (id, world_id, kind, key, name, body, notes, origin, schema_version, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, worldId, snap.kind, snap.key, snap.name, json(snap.body), snap.notes, snap.origin ? json(snap.origin) : null, SCHEMA_VERSION_OF_BODIES, snap.created_at, now());
    const e = this.getEntity(id);
    this.writeDerived(e);
    return e;
  }

  private applyOne(worldId: string, cmd: Command, batch: string, opts: ApplyOptions): Change {
    if (!isObj(cmd)) throw new HttpError(400, "invalid_command", "A command must be an object");
    switch (cmd.op) {
      case "create": {
        if (typeof cmd.kind !== "string" || !isEntityKind(cmd.kind)) throw new HttpError(400, "invalid_kind", `Unknown kind "${String(cmd.kind)}"`);
        const kind = cmd.kind;
        const body = this.checkBody(kind, cmd.body);
        let key = cmd.key;
        if (key === undefined) {
          const base = slugify(displayName(kind, body, "x") === "x" ? kind : displayName(kind, body, "x"));
          key = kind === "individual" ? `${base}_${shortRandom()}` : base;
        }
        if (!KEY_PATTERN.test(key)) throw new HttpError(422, "invalid_key", `"${key}" is not a valid key (lowercase letters, digits, _ . -)`);
        if (this.findByKey(worldId, kind, key)) throw new HttpError(409, "key_conflict", `A ${kind} with key "${key}" already exists`, { kind, key });
        const t = now();
        const e = this.insertEntity(worldId, newId(), { kind, key, name: displayName(kind, body, key), body, notes: cmd.notes ?? null, origin: cmd.origin ?? null, created_at: t });
        const edit_id = this.logEdit(worldId, batch, e.id, "create", null, this.snapshotOf(e), opts);
        return { op: "create", entity_id: e.id, kind, key, before: null, after: e, edit_id };
      }
      case "update": {
        const before = this.getEntity(cmd.id);
        if (before.world_id !== worldId) throw new HttpError(404, "entity_not_found", `No entity "${cmd.id}" in this world`);
        if (cmd.body !== undefined && cmd.patch !== undefined) throw new HttpError(400, "invalid_command", "Send either `body` or `patch`, not both");
        const nextBody = cmd.body !== undefined ? this.checkBody(before.kind, cmd.body) : cmd.patch !== undefined ? this.checkBody(before.kind, mergePatch(before.body, cmd.patch)) : before.body;
        const nextNotes = cmd.notes !== undefined ? cmd.notes : before.notes;
        const nextOrigin = cmd.origin !== undefined ? cmd.origin : before.origin;
        if (deepEqual(nextBody, before.body) && nextNotes === before.notes && deepEqual(nextOrigin, before.origin)) {
          return { op: "noop", entity_id: before.id, kind: before.kind, key: before.key, before, after: before };
        }
        const name = displayName(before.kind, nextBody, before.key);
        this.db
          .prepare("UPDATE entities SET name = ?, body = ?, notes = ?, origin = ?, updated_at = ? WHERE id = ?")
          .run(name, json(nextBody), nextNotes, nextOrigin ? json(nextOrigin) : null, now(), before.id);
        const after = this.getEntity(before.id);
        this.writeDerived(after);
        const edit_id = this.logEdit(worldId, batch, after.id, "update", this.snapshotOf(before), this.snapshotOf(after), opts);
        return { op: "update", entity_id: after.id, kind: after.kind, key: after.key, before, after, edit_id };
      }
      case "delete": {
        const before = this.getEntity(cmd.id);
        if (before.world_id !== worldId) throw new HttpError(404, "entity_not_found", `No entity "${cmd.id}" in this world`);
        const use = this.usedBy(before);
        if ((use.referrers.length || use.links) && !cmd.force) {
          throw new HttpError(409, "in_use", `"${before.name}" is still referenced by ${use.referrers.length} entit${use.referrers.length === 1 ? "y" : "ies"} and ${use.links} link(s)`, use);
        }
        this.db.prepare("DELETE FROM entities_fts WHERE entity_id = ?").run(before.id);
        this.db.prepare("DELETE FROM entities WHERE id = ?").run(before.id); // refs and links cascade
        const edit_id = this.logEdit(worldId, batch, before.id, "delete", this.snapshotOf(before), null, opts);
        return { op: "delete", entity_id: before.id, kind: before.kind, key: before.key, before, after: null, edit_id };
      }
      default:
        throw new HttpError(400, "invalid_command", `Unknown op "${String((cmd as { op?: unknown }).op)}"`);
    }
  }

  private editFrom(r: any): EditRow {
    return { ...r, before: r.before ? JSON.parse(r.before) : null, after: r.after ? JSON.parse(r.after) : null };
  }

  listEdits(worldId: string, opts: { entity_id?: string; limit?: number } = {}): EditRow[] {
    this.getWorld(worldId);
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const rows = opts.entity_id
      ? this.db.prepare("SELECT * FROM edits WHERE world_id = ? AND entity_id = ? ORDER BY id DESC LIMIT ?").all(worldId, opts.entity_id, limit)
      : this.db.prepare("SELECT * FROM edits WHERE world_id = ? ORDER BY id DESC LIMIT ?").all(worldId, limit);
    return rows.map((r) => this.editFrom(r));
  }

  /**
   * Undo an edit by applying its inverse as a new edit. Only the newest edit
   * of an entity can be undone (undo the later ones first). Links removed by
   * a deletion are not restored.
   */
  undo(editId: number, opts: ApplyOptions = {}): { batch: string; change: Change } {
    const row = this.db.prepare("SELECT * FROM edits WHERE id = ?").get(editId);
    if (!row) throw new HttpError(404, "edit_not_found", `No edit ${editId}`);
    const edit = this.editFrom(row);
    if (edit.undone_by !== null) throw new HttpError(409, "already_undone", `Edit ${editId} was already undone`);
    const latest = (this.db.prepare("SELECT MAX(id) AS id FROM edits WHERE entity_id = ?").get(edit.entity_id) as { id: number }).id;
    if (latest !== edit.id) throw new HttpError(409, "not_latest", `A later edit (${latest}) touched this entity; undo that first`, { latest });

    const batch = newId();
    const worldId = edit.world_id;
    const undoOpts: ApplyOptions = { ...opts, note: opts.note ?? `undo of edit ${editId}` };
    const change = this.transaction((): Change => {
      let c: Change;
      if (edit.op === "create") {
        c = this.applyOne(worldId, { op: "delete", id: edit.entity_id }, batch, undoOpts);
      } else if (edit.op === "update") {
        c = this.applyOne(worldId, { op: "update", id: edit.entity_id, body: edit.before!.body, notes: edit.before!.notes }, batch, undoOpts);
      } else {
        const snap = edit.before!;
        if (this.findByKey(worldId, snap.kind, snap.key)) throw new HttpError(409, "key_conflict", `Cannot restore: a ${snap.kind} with key "${snap.key}" now exists`);
        const e = this.insertEntity(worldId, edit.entity_id, snap);
        const edit_id = this.logEdit(worldId, batch, e.id, "create", null, this.snapshotOf(e), undoOpts);
        c = { op: "create", entity_id: e.id, kind: e.kind, key: e.key, before: null, after: e, edit_id };
      }
      this.db.prepare("UPDATE edits SET undone_by = ? WHERE id = ?").run(c.edit_id ?? null, editId);
      this.bump(worldId);
      return c;
    });
    return { batch, change };
  }

  // ----------------------------------------------------------------- links

  private linkFrom(r: any): Link {
    const body = JSON.parse(r.body) as { feeling?: string; since?: number };
    return { id: r.id, world_id: r.world_id, from: r.from_id, to: r.to_id, type: r.type, ...(body.feeling ? { feeling: body.feeling } : {}), ...(body.since !== undefined ? { since: body.since } : {}), created_at: r.created_at };
  }

  createLink(worldId: string, input: { from: string; to: string; type: string; feeling?: string; since?: number }): Link {
    this.getWorld(worldId);
    if (!input.type?.trim()) throw new HttpError(422, "invalid_link", "A link needs a type");
    for (const id of [input.from, input.to]) {
      const e = this.db.prepare("SELECT world_id FROM entities WHERE id = ?").get(id) as { world_id: string } | undefined;
      if (!e || e.world_id !== worldId) throw new HttpError(404, "entity_not_found", `No entity "${id}" in this world`);
    }
    const id = newId();
    const body = { ...(input.feeling ? { feeling: input.feeling } : {}), ...(input.since !== undefined ? { since: input.since } : {}) };
    this.db.prepare("INSERT INTO links (id, world_id, from_id, to_id, type, body, created_at) VALUES (?,?,?,?,?,?,?)").run(id, worldId, input.from, input.to, input.type.trim(), json(body), now());
    return this.linkFrom(this.db.prepare("SELECT * FROM links WHERE id = ?").get(id));
  }

  listLinks(worldId: string, opts: { entity?: string } = {}): Link[] {
    this.getWorld(worldId);
    const rows = opts.entity
      ? this.db.prepare("SELECT * FROM links WHERE world_id = ? AND (from_id = ? OR to_id = ?) ORDER BY created_at, id").all(worldId, opts.entity, opts.entity)
      : this.db.prepare("SELECT * FROM links WHERE world_id = ? ORDER BY created_at, id").all(worldId);
    return rows.map((r) => this.linkFrom(r));
  }

  deleteLink(id: string): void {
    const r = this.db.prepare("DELETE FROM links WHERE id = ?").run(id);
    if (r.changes === 0) throw new HttpError(404, "link_not_found", `No link "${id}"`);
  }

  // ----------------------------------------------------------------- packs

  recordPack(worldId: string, manifest: { id: string; name: string; version: string }): void {
    this.db
      .prepare("INSERT INTO packs (world_id, pack_id, version, name, manifest, installed_at) VALUES (?,?,?,?,?,?) ON CONFLICT (world_id, pack_id) DO UPDATE SET version = excluded.version, name = excluded.name, manifest = excluded.manifest, installed_at = excluded.installed_at")
      .run(worldId, manifest.id, manifest.version, manifest.name, json(manifest), now());
  }

  listPacks(worldId: string): { pack_id: string; version: string; name: string; manifest: unknown; installed_at: string }[] {
    this.getWorld(worldId);
    return this.db.prepare("SELECT pack_id, version, name, manifest, installed_at FROM packs WHERE world_id = ? ORDER BY installed_at, pack_id").all(worldId).map((r: any) => ({ ...r, manifest: JSON.parse(r.manifest) }));
  }

  // -------------------------------------------------------------- registry

  /** Build the resolver's registry from the world's entities (keys become ids). */
  buildRegistry(worldId: string): Registry {
    const world = this.getWorld(worldId);
    const rows = this.entitiesByKinds(worldId, REGISTRY_KINDS);
    const defs = (kind: EntityKind) => rows.filter((r) => r.kind === kind).map((r) => ({ id: r.key, ...r.body }));
    const reg = buildRegistry(
      [
        {
          manifest: { id: "world", name: world.name, version: String(world.rev), content_warnings: [] },
          slots: defs("slot") as never,
          traits: defs("trait") as never,
          conditions: defs("condition") as never,
          behaviors: defs("behavior") as never,
          skills: defs("skill") as never,
          species: defs("species") as never,
        },
      ],
      world.settings.ordinals,
    );
    if (world.settings.breeding) reg.breeding = world.settings.breeding;
    return reg;
  }
}
