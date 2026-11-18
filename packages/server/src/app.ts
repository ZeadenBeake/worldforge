import { randomBytes } from "node:crypto";
import { breed, isEntityKind, rollIndividual, validateRegistry, type EntityKind, type Individual, type Snapshot } from "@worldforge/core";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ExporterSet } from "./exporters";
import { PACK_SECTIONS, exportPack, installPack, packToYaml, previewPack, readPack, type BundledPack } from "./packs";
import { RegistryCache } from "./registry";
import { SCHEMA_VERSION } from "./db";
import { snapshotForEntity } from "./snapshots";
import { HttpError, Store, type Command, type Entity } from "./store";

export interface AppDeps {
  store: Store;
  exporters: ExporterSet;
  bundledPacks?: BundledPack[];
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

function errorResponse(status: number, code: string, message: string, details?: unknown): Response {
  return new Response(JSON.stringify({ error: { code, message, ...(details !== undefined ? { details } : {}) } }), {
    status,
    headers: { "content-type": "application/json; charset=UTF-8" },
  });
}

async function readJson(c: Context, { optional = false } = {}): Promise<Json> {
  const text = await c.req.text();
  if (!text.trim()) {
    if (optional) return {};
    throw new HttpError(400, "invalid_json", "Request body must be a JSON object");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_json", "Request body is not valid JSON");
  }
  if (!isObj(parsed)) throw new HttpError(400, "invalid_json", "Request body must be a JSON object");
  return parsed;
}

function optString(o: Json, k: string): string | undefined {
  const v = o[k];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new HttpError(400, "invalid_option", `"${k}" must be a string`);
  return v;
}
function optBool(o: Json, k: string): boolean | undefined {
  const v = o[k];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw new HttpError(400, "invalid_option", `"${k}" must be true or false`);
  return v;
}
function optNumber(o: Json, k: string): number | undefined {
  const v = o[k];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new HttpError(400, "invalid_option", `"${k}" must be a number`);
  return v;
}
function optObject(o: Json, k: string): Json | undefined {
  const v = o[k];
  if (v === undefined) return undefined;
  if (!isObj(v)) throw new HttpError(400, "invalid_option", `"${k}" must be an object`);
  return v;
}
function seedOf(o: Json): string {
  const v = o["seed"];
  if (v === undefined) return randomBytes(6).toString("hex");
  if (typeof v === "string" || (typeof v === "number" && Number.isFinite(v))) return String(v);
  throw new HttpError(400, "invalid_option", `"seed" must be a string or number`);
}
function queryNumber(c: Context, name: string): number | undefined {
  const raw = c.req.query(name);
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new HttpError(400, "invalid_query", `"${name}" must be a number`);
  return n;
}

export function createApp(deps: AppDeps): Hono {
  const { store, exporters } = deps;
  const bundled = deps.bundledPacks ?? [];
  const cache = new RegistryCache(store);
  const app = new Hono();

  app.use("/api/*", bodyLimit({ maxSize: 10 * 1024 * 1024, onError: () => errorResponse(413, "too_large", "Request body is too large (10 MB max)") }));
  app.onError((err) => {
    if (err instanceof HttpError) return errorResponse(err.status, err.code, err.message, err.details);
    console.error(err);
    return errorResponse(500, "internal", "Internal error");
  });
  app.notFound(() => errorResponse(404, "not_found", "No such route"));

  const entityOfKind = (id: string, kind: EntityKind): Entity => {
    const e = store.getEntity(id);
    if (e.kind !== kind) throw new HttpError(404, "wrong_kind", `"${id}" is a ${e.kind}, not a ${kind}`);
    return e;
  };

  const snapshotFor = (entity: Entity, now?: number): Snapshot => snapshotForEntity(store, cache, entity, now);

  // ---------------------------------------------------------------- meta

  app.get("/", (c) => c.text("worldforge: see /api/health, /api/worlds, /api/exporters\n"));
  app.get("/api/health", (c) => c.json({ ok: true, schema_version: SCHEMA_VERSION }));
  app.get("/api/exporters", (c) =>
    c.json({
      exporters: exporters.list().map(({ id, name, kind, description, content_type, consumes }) => ({ id, name, kind, description, content_type, consumes })),
      errors: exporters.errors,
    }),
  );

  // -------------------------------------------------------------- worlds

  app.get("/api/worlds", (c) => c.json({ worlds: store.listWorlds() }));
  app.post("/api/worlds", async (c) => {
    const b = await readJson(c);
    const name = optString(b, "name");
    if (!name) throw new HttpError(422, "invalid_world", "A world needs a name");
    return c.json(store.createWorld(name, (optObject(b, "settings") ?? {}) as never), 201);
  });
  app.get("/api/worlds/:w", (c) => c.json(store.getWorld(c.req.param("w"))));
  app.patch("/api/worlds/:w", async (c) => {
    const b = await readJson(c);
    return c.json(store.updateWorld(c.req.param("w"), { name: optString(b, "name"), settings: optObject(b, "settings") as never }));
  });
  app.delete("/api/worlds/:w", (c) => {
    if (c.req.query("confirm") !== "true") throw new HttpError(400, "confirmation_required", "Deleting a world removes everything in it; resend with ?confirm=true");
    store.deleteWorld(c.req.param("w"));
    return c.json({ deleted: c.req.param("w") });
  });

  // ------------------------------------------------------------ entities

  app.get("/api/worlds/:w/entities", (c) =>
    c.json(store.listEntities(c.req.param("w"), { kind: c.req.query("kind") || undefined, q: c.req.query("q") || undefined, limit: queryNumber(c, "limit"), offset: queryNumber(c, "offset") })),
  );
  app.post("/api/worlds/:w/entities", async (c) => {
    const b = await readJson(c);
    const kind = optString(b, "kind");
    if (!kind) throw new HttpError(400, "invalid_kind", `"kind" is required`);
    const cmd: Command = { op: "create", kind, key: optString(b, "key"), body: b["body"], notes: optString(b, "notes") ?? null };
    const r = store.apply(c.req.param("w"), [cmd], { actor: optString(b, "actor"), note: optString(b, "note") });
    return c.json(r.changes[0]!.after, 201);
  });
  app.get("/api/entities/:id", (c) => c.json(store.getEntity(c.req.param("id"))));
  app.get("/api/entities/:id/used-by", (c) => c.json(store.usedBy(store.getEntity(c.req.param("id")))));
  const updateEntity = (mode: "body" | "patch") => async (c: Context) => {
    const b = await readJson(c);
    const e = store.getEntity(c.req.param("id")!);
    const payload = mode === "body" ? b["body"] : b["patch"];
    if (payload === undefined && b["notes"] === undefined) throw new HttpError(400, "invalid_command", `Send "${mode}" and/or "notes"`);
    const cmd: Command = { op: "update", id: e.id, ...(payload !== undefined ? { [mode]: payload } : {}), ...(b["notes"] !== undefined ? { notes: optString(b, "notes") ?? null } : {}) };
    const r = store.apply(e.world_id, [cmd], { actor: optString(b, "actor"), note: optString(b, "note") });
    return c.json(r.changes[0]!.after);
  };
  app.put("/api/entities/:id", updateEntity("body"));
  app.patch("/api/entities/:id", updateEntity("patch"));
  app.delete("/api/entities/:id", (c) => {
    const e = store.getEntity(c.req.param("id"));
    const r = store.apply(e.world_id, [{ op: "delete", id: e.id, force: c.req.query("force") === "true" }]);
    return c.json({ deleted: e.id, edit_id: r.changes[0]!.edit_id });
  });

  // ---------------------------------------------------- edits (batch + undo)

  app.post("/api/worlds/:w/edits", async (c) => {
    const b = await readJson(c);
    if (!Array.isArray(b["commands"])) throw new HttpError(400, "invalid_commands", `"commands" must be a list`);
    const r = store.apply(c.req.param("w"), b["commands"] as Command[], { actor: optString(b, "actor"), note: optString(b, "note"), dryRun: optBool(b, "dryRun") });
    return c.json({ ...r, dryRun: b["dryRun"] === true });
  });
  app.get("/api/worlds/:w/edits", (c) => c.json({ edits: store.listEdits(c.req.param("w"), { entity_id: c.req.query("entity") || undefined, limit: queryNumber(c, "limit") }) }));
  app.post("/api/edits/:id/undo", (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) throw new HttpError(400, "invalid_query", "Edit ids are integers");
    return c.json(store.undo(id));
  });

  // --------------------------------------------------------------- links

  app.get("/api/worlds/:w/links", (c) => c.json({ links: store.listLinks(c.req.param("w"), { entity: c.req.query("entity") || undefined }) }));
  app.post("/api/worlds/:w/links", async (c) => {
    const b = await readJson(c);
    const from = optString(b, "from"), to = optString(b, "to"), type = optString(b, "type");
    if (!from || !to || !type) throw new HttpError(422, "invalid_link", `"from", "to" and "type" are required`);
    return c.json(store.createLink(c.req.param("w"), { from, to, type, feeling: optString(b, "feeling"), since: optNumber(b, "since") }), 201);
  });
  app.delete("/api/links/:id", (c) => {
    store.deleteLink(c.req.param("id"));
    return c.json({ deleted: c.req.param("id") });
  });

  // ------------------------------------------------------ rolling/breeding

  app.post("/api/species/:id/roll", async (c) => {
    const species = entityOfKind(c.req.param("id"), "species");
    const b = await readJson(c, { optional: true });
    const reg = cache.get(species.world_id);
    const { individual, warnings } = rollIndividual(species.key, reg, { seed: seedOf(b), locks: optObject(b, "locks") as never });
    const name = optString(b, "name");
    const result: Individual = name ? { ...individual, name } : individual;
    if (optBool(b, "save")) {
      const saved = store.apply(species.world_id, [{ op: "create", kind: "individual", body: result }], { note: `rolled from ${species.key}` }).changes[0]!.after;
      return c.json({ individual: result, warnings, saved }, 201);
    }
    return c.json({ individual: result, warnings });
  });

  app.post("/api/individuals/breed", async (c) => {
    const b = await readJson(c);
    const ids = b["parents"];
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 2 || !ids.every((x) => typeof x === "string")) {
      throw new HttpError(400, "invalid_parents", `"parents" must be a list of one or two individual ids`);
    }
    const parents = (ids as string[]).map((id) => entityOfKind(id, "individual"));
    const worldId = parents[0]!.world_id;
    if (parents.some((p) => p.world_id !== worldId)) throw new HttpError(400, "invalid_parents", "Parents must be in the same world");
    const reg = cache.get(worldId);
    const forced = optString(b, "species");
    if (forced && !reg.species[forced]) throw new HttpError(422, "unknown_species", `No species "${forced}" in this world`);
    const { individual, warnings } = breed(reg, {
      seed: seedOf(b),
      parents: parents.map((p) => p.body as unknown as Individual),
      species: forced,
      off_species: optString(b, "off_species"),
      mutation: optString(b, "mutation"),
      locks: optObject(b, "locks") as never,
      age: optNumber(b, "age"),
    });
    const name = optString(b, "name");
    const result: Individual = name ? { ...individual, name } : individual;
    if (optBool(b, "save")) {
      const saved = store.transaction(() => {
        const e = store.apply(worldId, [{ op: "create", kind: "individual", body: result }], { note: "bred" }).changes[0]!.after!;
        for (const p of parents) store.createLink(worldId, { from: p.id, to: e.id, type: "parent" });
        return e;
      });
      return c.json({ individual: result, warnings, saved }, 201);
    }
    return c.json({ individual: result, warnings });
  });

  // ------------------------------------------------- snapshot and exporting

  app.get("/api/individuals/:id/snapshot", (c) => c.json(snapshotFor(entityOfKind(c.req.param("id"), "individual"), queryNumber(c, "now"))));

  app.get("/api/individuals/:id/export/:exporter", async (c) => {
    const entity = entityOfKind(c.req.param("id"), "individual");
    const exporter = exporters.get(c.req.param("exporter"));
    if (!exporter) throw new HttpError(404, "exporter_not_found", `No exporter "${c.req.param("exporter")}"`);
    const { now: _now, format, ...options } = c.req.query();
    const world = store.getWorld(entity.world_id);
    let body: string;
    try {
      body = await exporter.render(snapshotFor(entity, queryNumber(c, "now")), { world: { id: world.id, name: world.name } }, options);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(500, "export_failed", `Exporter "${exporter.id}" failed: ${(e as Error).message}`);
    }
    if (format === "json") return c.json({ exporter: exporter.id, content_type: exporter.content_type, body });
    return c.body(body, 200, { "content-type": `${exporter.content_type}; charset=UTF-8` });
  });

  // ------------------------------------------------------------ validation

  app.get("/api/worlds/:w/warnings", (c) => {
    const worldId = c.req.param("w");
    const reg = cache.get(worldId);
    const individuals = store
      .listEntities(worldId, { kind: "individual", limit: 500 })
      .items.map((e) => ({ id: e.id, name: e.name, warnings: snapshotFor(e).warnings }))
      .filter((x) => x.warnings.length > 0);
    return c.json({ registry: validateRegistry(reg), individuals });
  });

  // ---------------------------------------------------------------- packs

  const summary = (p: BundledPack) => {
    const m = p.pack.manifest;
    return { id: m.id, name: m.name, version: m.version, author: m.author, description: m.description, content_warnings: m.content_warnings, requires_packs: m.requires_packs ?? [] };
  };
  const packFrom = (b: Json) => {
    const id = optString(b, "bundled");
    if (id !== undefined) {
      const hit = bundled.find((p) => p.id === id);
      if (!hit) throw new HttpError(404, "pack_not_found", `No bundled pack "${id}"`);
      return hit.pack;
    }
    if (b["pack"] === undefined) throw new HttpError(400, "invalid_pack", `Send "pack" (YAML/JSON text or object) or "bundled" (a bundled pack id)`);
    return readPack(b["pack"]);
  };

  app.get("/api/packs/bundled", (c) => c.json({ packs: bundled.map(summary) }));
  app.get("/api/worlds/:w/packs", (c) => c.json({ packs: store.listPacks(c.req.param("w")) }));
  app.post("/api/worlds/:w/packs/preview", async (c) => c.json(previewPack(store, c.req.param("w"), packFrom(await readJson(c)))));
  app.post("/api/worlds/:w/packs", async (c) => {
    const b = await readJson(c);
    const onConflict = optString(b, "on_conflict");
    if (onConflict !== undefined && !["abort", "skip", "replace"].includes(onConflict)) throw new HttpError(400, "invalid_option", `"on_conflict" must be abort, skip or replace`);
    const result = installPack(store, c.req.param("w"), packFrom(b), { confirm: b["confirm"] === true, on_conflict: onConflict as never });
    return c.json(result, 201);
  });
  app.post("/api/worlds/:w/packs/export", async (c) => {
    const b = await readJson(c);
    const m = optObject(b, "manifest");
    if (!m || typeof m["id"] !== "string" || typeof m["name"] !== "string" || typeof m["version"] !== "string") {
      throw new HttpError(422, "invalid_pack", `"manifest" needs string id, name and version`);
    }
    const kinds = b["kinds"];
    if (kinds !== undefined && !(Array.isArray(kinds) && kinds.every((k) => typeof k === "string" && isEntityKind(k) && k !== "individual"))) {
      throw new HttpError(400, "invalid_kind", `"kinds" must be a list of ${Object.values(PACK_SECTIONS).join(", ")}`);
    }
    const pack = exportPack(store, c.req.param("w"), { content_warnings: [], ...m } as never, kinds as EntityKind[] | undefined);
    if (optString(b, "format") === "json") return c.json(pack);
    return c.body(packToYaml(pack), 200, { "content-type": "text/yaml; charset=UTF-8" });
  });

  return app;
}
