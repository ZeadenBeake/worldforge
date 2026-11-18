import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db";
import { Store, mergePatch } from "../src/store";
import { memStore, thrown } from "./helpers";

const slot = (name: string) => ({ name });
const trait = (label: string, slotKey: string, extra: Record<string, unknown> = {}) => ({ slot: slotKey, label, ...extra });

function world() {
  const store = memStore();
  const w = store.createWorld("Test world");
  const create = (kind: string, body: unknown, key?: string) => store.apply(w.id, [{ op: "create", kind, key, body }]).changes[0]!;
  return { store, w, create };
}

describe("worlds", () => {
  it("creates, lists, renames and deletes", () => {
    const store = memStore();
    const a = store.createWorld("  A  ");
    expect(a.name).toBe("A");
    store.createWorld("B");
    expect(store.listWorlds().map((w) => w.name)).toEqual(["A", "B"]);
    expect(store.updateWorld(a.id, { name: "A2" }).name).toBe("A2");
    store.deleteWorld(a.id);
    expect(thrown(() => store.getWorld(a.id)).status).toBe(404);
    expect(thrown(() => store.createWorld("  ")).status).toBe(422);
  });

  it("updating settings bumps rev", () => {
    const store = memStore();
    const w = store.createWorld("w");
    expect(store.updateWorld(w.id, { settings: { breeding: { mutation: "none" } } }).rev).toBe(w.rev + 1);
  });

  it("entities are isolated per world", () => {
    const store = memStore();
    const a = store.createWorld("a");
    const b = store.createWorld("b");
    const e = store.apply(a.id, [{ op: "create", kind: "slot", key: "wings", body: slot("wings") }]).changes[0]!;
    expect(store.findByKey(b.id, "slot", "wings")).toBeUndefined();
    expect(thrown(() => store.apply(b.id, [{ op: "update", id: e.entity_id, patch: { description: "x" } }])).status).toBe(404);
    // the same key is fine in another world
    expect(() => store.apply(b.id, [{ op: "create", kind: "slot", key: "wings", body: slot("wings") }])).not.toThrow();
  });
});

describe("create", () => {
  it("derives name and key, and keeps key out of the body", () => {
    const { create } = world();
    const c = create("trait", trait("Feathered Wings", "wings"));
    expect(c.key).toBe("feathered_wings");
    expect(c.after!.name).toBe("Feathered Wings");
    expect(c.after!.body).not.toHaveProperty("id");
    expect(c.after!.body).not.toHaveProperty("key");
  });

  it("individuals get a unique random suffix, so duplicates never collide", () => {
    const { create } = world();
    const body = { name: "Wren", species: "sp", seed: "s", axis_values: {}, genotype: {}, scalars: {}, age: 3, conditions: [] };
    const a = create("individual", body), b = create("individual", body);
    expect(a.key).toMatch(/^wren_[0-9a-z]{4}$/);
    expect(a.key).not.toBe(b.key);
  });

  it("other kinds conflict on a duplicate key (409), explicit or derived", () => {
    const { store, w, create } = world();
    create("slot", slot("wings"), "wings");
    const e = thrown(() => store.apply(w.id, [{ op: "create", kind: "slot", key: "wings", body: slot("x") }]));
    expect([e.status, e.code]).toEqual([409, "key_conflict"]);
    expect(thrown(() => store.apply(w.id, [{ op: "create", kind: "slot", body: slot("wings") }])).status).toBe(409);
  });

  it("rejects bad kinds, keys and bodies with readable details", () => {
    const { store, w } = world();
    expect(thrown(() => store.apply(w.id, [{ op: "create", kind: "planet", body: {} }])).code).toBe("invalid_kind");
    expect(thrown(() => store.apply(w.id, [{ op: "create", kind: "slot", key: "Bad Key", body: slot("x") }])).code).toBe("invalid_key");
    const e = thrown(() => store.apply(w.id, [{ op: "create", kind: "trait", key: "t", body: { slot: "s" } }]));
    expect([e.status, e.code]).toEqual([422, "invalid_body"]);
    expect(JSON.stringify(e.details)).toContain("label");
    expect(thrown(() => store.apply(w.id, [])).code).toBe("invalid_commands");
  });

  it("records origin when given", () => {
    const { store, w } = world();
    const c = store.apply(w.id, [{ op: "create", kind: "slot", key: "s", body: slot("s"), origin: { pack: "p", version: "1", key: "s" } }]).changes[0]!;
    expect(store.getEntity(c.entity_id).origin).toEqual({ pack: "p", version: "1", key: "s" });
  });
});

describe("update", () => {
  it("replace, merge-patch (null deletes) and notes", () => {
    const { store, w, create } = world();
    const id = create("trait", trait("Horns", "horns", { provides: ["part:horn"], conflicts: ["x:y"] })).entity_id;
    store.apply(w.id, [{ op: "update", id, patch: { provides: ["part:horn", "part:spike"], conflicts: null } }]);
    let e = store.getEntity(id);
    expect(e.body).toMatchObject({ provides: ["part:horn", "part:spike"] });
    expect(e.body).not.toHaveProperty("conflicts");
    store.apply(w.id, [{ op: "update", id, body: trait("Horns v2", "horns") }]);
    e = store.getEntity(id);
    expect(e.name).toBe("Horns v2"); // name follows the body
    expect(e.key).toBe("horns"); // key never changes
    store.apply(w.id, [{ op: "update", id, notes: "check later" }]);
    expect(store.getEntity(id).notes).toBe("check later");
  });

  it("validates the result of a patch", () => {
    const { store, w, create } = world();
    const id = create("trait", trait("T", "s")).entity_id;
    expect(thrown(() => store.apply(w.id, [{ op: "update", id, patch: { label: null } }])).code).toBe("invalid_body");
  });

  it("a no-op update changes nothing: no edit, no rev bump", () => {
    const { store, w, create } = world();
    const id = create("slot", slot("s")).entity_id;
    const rev = store.getWorld(w.id).rev;
    const edits = store.listEdits(w.id).length;
    const c = store.apply(w.id, [{ op: "update", id, patch: { name: "s" } }]).changes[0]!;
    expect(c.op).toBe("noop");
    expect(store.getWorld(w.id).rev).toBe(rev);
    expect(store.listEdits(w.id)).toHaveLength(edits);
  });

  it("rejects body+patch together, and forbidden patch keys", () => {
    const { store, w, create } = world();
    const id = create("slot", slot("s")).entity_id;
    expect(thrown(() => store.apply(w.id, [{ op: "update", id, body: slot("s"), patch: {} }])).code).toBe("invalid_command");
    expect(thrown(() => store.apply(w.id, [{ op: "update", id, patch: JSON.parse('{"__proto__": {"x": 1}}') }])).code).toBe("invalid_patch");
  });

  it("mergePatch follows RFC 7386", () => {
    expect(mergePatch({ a: "b" }, { a: "c" })).toEqual({ a: "c" });
    expect(mergePatch({ a: "b" }, { b: "c" })).toEqual({ a: "b", b: "c" });
    expect(mergePatch({ a: "b", b: "c" }, { a: null })).toEqual({ b: "c" });
    expect(mergePatch({ a: ["b"] }, { a: "c" })).toEqual({ a: "c" });
    expect(mergePatch({ a: { b: "c" } }, { a: { b: "d", c: null } })).toEqual({ a: { b: "d" } });
    expect(mergePatch({ a: "foo" }, "bar")).toBe("bar");
    expect(mergePatch({}, { a: { bb: { ccc: null } } })).toEqual({ a: { bb: {} } });
  });
});

describe("references and deletion", () => {
  function setup() {
    const ctx = world();
    const slotId = ctx.create("slot", slot("wings"), "wings").entity_id;
    const traitId = ctx.create("trait", trait("Wings", "wings"), "feathered_wings").entity_id;
    const speciesId = ctx.create("species", { label: "Bird", body_plan: "feathered_wings", pools: { wings: [{ trait: "feathered_wings", chance: "common" }] } }, "bird").entity_id;
    return { ...ctx, slotId, traitId, speciesId };
  }

  it("lists what uses an entity", () => {
    const { store, traitId } = setup();
    const use = store.usedBy(store.getEntity(traitId));
    expect(use.referrers.map((r) => r.key)).toEqual(["bird"]);
    expect(use.links).toBe(0);
  });

  it("refuses to delete something in use (409 in_use) and names the users", () => {
    const { store, w, slotId } = setup();
    const e = thrown(() => store.apply(w.id, [{ op: "delete", id: slotId }]));
    expect([e.status, e.code]).toEqual([409, "in_use"]);
    expect(JSON.stringify(e.details)).toContain("feathered_wings");
    expect(JSON.stringify(e.details)).toContain("bird");
  });

  it("deletes with force, leaving dangling references for the validator to flag", () => {
    const { store, w, traitId } = setup();
    store.apply(w.id, [{ op: "delete", id: traitId, force: true }]);
    expect(store.findByKey(w.id, "trait", "feathered_wings")).toBeUndefined();
    expect(store.buildRegistry(w.id).traits["feathered_wings"]).toBeUndefined();
  });

  it("deleting the referrer first frees its targets", () => {
    const { store, w, speciesId, traitId } = setup();
    store.apply(w.id, [{ op: "delete", id: speciesId }]);
    expect(() => store.apply(w.id, [{ op: "delete", id: traitId }])).not.toThrow();
  });

  it("updating a body updates its references", () => {
    const { store, w, speciesId, traitId } = setup();
    // merge-patch: `{}` would merge into the existing pools; removing an entry takes an explicit null
    store.apply(w.id, [{ op: "update", id: speciesId, patch: { body_plan: "other", pools: { wings: null } } }]);
    expect(store.usedBy(store.getEntity(traitId)).referrers).toEqual([]);
    store.apply(w.id, [{ op: "update", id: speciesId, patch: { body_plan: "feathered_wings" } }]);
    expect(store.usedBy(store.getEntity(traitId)).referrers.map((r) => r.key)).toEqual(["bird"]);
  });

  it("links count as use, and cascade away on forced deletion", () => {
    const { store, w, create } = world();
    const body = (n: string) => ({ name: n, species: "sp", seed: "s", axis_values: {}, genotype: {}, scalars: {}, age: 1, conditions: [] });
    const a = create("individual", body("A")).entity_id, b = create("individual", body("B")).entity_id;
    store.createLink(w.id, { from: a, to: b, type: "parent" });
    expect(thrown(() => store.apply(w.id, [{ op: "delete", id: b }])).code).toBe("in_use");
    store.apply(w.id, [{ op: "delete", id: b, force: true }]);
    expect(store.listLinks(w.id)).toEqual([]);
  });
});

describe("batches and dry runs", () => {
  it("a failing command rolls the whole batch back and says which one failed", () => {
    const { store, w } = world();
    const e = thrown(() =>
      store.apply(w.id, [
        { op: "create", kind: "slot", key: "ok", body: slot("ok") },
        { op: "create", kind: "trait", key: "bad", body: { slot: "s" } },
      ]),
    );
    expect(e.code).toBe("invalid_body");
    expect((e.details as { command_index: number }).command_index).toBe(1);
    expect(store.findByKey(w.id, "slot", "ok")).toBeUndefined();
  });

  it("later commands in a batch see earlier ones", () => {
    const { store, w } = world();
    const r = store.apply(w.id, [
      { op: "create", kind: "slot", key: "a", body: slot("a") },
      { op: "create", kind: "slot", key: "b", body: slot("b") },
    ]);
    expect(r.changes.map((c) => c.key)).toEqual(["a", "b"]);
    expect(thrown(() => store.apply(w.id, [{ op: "create", kind: "slot", key: "c", body: slot("c") }, { op: "create", kind: "slot", key: "c", body: slot("c") }])).code).toBe("key_conflict");
  });

  it("dryRun reports exactly what would happen and persists nothing", () => {
    const { store, w, create } = world();
    const id = create("slot", slot("s")).entity_id;
    const rev = store.getWorld(w.id).rev;
    const edits = store.listEdits(w.id).length;
    const r = store.apply(w.id, [{ op: "update", id, patch: { description: "new" } }, { op: "create", kind: "slot", key: "n", body: slot("n") }], { dryRun: true });
    expect(r.changes.map((c) => c.op)).toEqual(["update", "create"]);
    expect(r.changes[0]!.after!.body).toMatchObject({ description: "new" });
    expect(store.getEntity(id).body).not.toHaveProperty("description");
    expect(store.findByKey(w.id, "slot", "n")).toBeUndefined();
    expect(store.getWorld(w.id).rev).toBe(rev);
    expect(store.listEdits(w.id)).toHaveLength(edits);
  });

  it("dryRun fails exactly like the real thing", () => {
    const { store, w, create } = world();
    create("slot", slot("dup"), "dup");
    const cmds = [{ op: "create" as const, kind: "slot", key: "dup", body: slot("x") }];
    expect(thrown(() => store.apply(w.id, cmds, { dryRun: true })).code).toBe(thrown(() => store.apply(w.id, cmds)).code);
  });
});

describe("edits and undo", () => {
  it("logs every change with actor, note, before and after", () => {
    const { store, w, create } = world();
    const id = create("slot", slot("s")).entity_id;
    store.apply(w.id, [{ op: "update", id, patch: { description: "d" } }], { actor: "llm", note: "proposal 7" });
    const [latest, first] = store.listEdits(w.id);
    expect(first).toMatchObject({ op: "create", actor: "user", before: null });
    expect(latest).toMatchObject({ op: "update", actor: "llm", note: "proposal 7" });
    expect(latest!.before!.body).not.toHaveProperty("description");
    expect(latest!.after!.body).toMatchObject({ description: "d" });
    expect(store.listEdits(w.id, { entity_id: id })).toHaveLength(2);
  });

  it("undoes an update", () => {
    const { store, w, create } = world();
    const id = create("slot", slot("s")).entity_id;
    const edit = store.apply(w.id, [{ op: "update", id, patch: { description: "d" } }]).changes[0]!.edit_id!;
    store.undo(edit);
    expect(store.getEntity(id).body).not.toHaveProperty("description");
    expect(thrown(() => store.undo(edit)).code).toBe("already_undone");
  });

  it("undoes a create (deletes) and a delete (restores with the same id, key and body)", () => {
    const { store, w, create } = world();
    const c = create("slot", slot("s"), "s");
    const del = store.apply(w.id, [{ op: "delete", id: c.entity_id }]).changes[0]!.edit_id!;
    store.undo(del);
    const back = store.findByKey(w.id, "slot", "s")!;
    expect(back.id).toBe(c.entity_id);
    expect(back.body).toEqual({ name: "s" });
    // and undoing the restoring create removes it again
    const restored = store.listEdits(w.id)[0]!;
    expect(restored.op).toBe("create");
    store.undo(restored.id);
    expect(store.findByKey(w.id, "slot", "s")).toBeUndefined();
  });

  it("only the newest edit of an entity can be undone", () => {
    const { store, w, create } = world();
    const id = create("slot", slot("s")).entity_id;
    const first = store.apply(w.id, [{ op: "update", id, patch: { description: "1" } }]).changes[0]!.edit_id!;
    store.apply(w.id, [{ op: "update", id, patch: { description: "2" } }]);
    expect(thrown(() => store.undo(first)).code).toBe("not_latest");
  });

  it("cannot restore a deleted entity if its key has been taken", () => {
    const { store, w, create } = world();
    const c = create("slot", slot("s"), "s");
    const del = store.apply(w.id, [{ op: "delete", id: c.entity_id }]).changes[0]!.edit_id!;
    create("slot", slot("other"), "s");
    expect(thrown(() => store.undo(del)).code).toBe("key_conflict");
  });

  it("undoing a create that is now in use is refused", () => {
    const { store, w, create } = world();
    const t = create("trait", trait("T", "s"), "t");
    create("species", { label: "S", body_plan: "t", pools: {} }, "sp");
    expect(thrown(() => store.undo(t.edit_id!)).code).toBe("in_use");
  });
});

describe("search", () => {
  function seeded() {
    const ctx = world();
    ctx.create("trait", trait("Feathered wings", "wings", { content: { prose: "a pair of broad feathered wings" } }));
    ctx.create("trait", trait("Beak", "mouth", { content: { prose: "a hooked beak" } }));
    ctx.create("slot", slot("wings"), "wings");
    return ctx;
  }
  const keys = (store: Store, worldId: string, q: string, kind?: string) => store.listEntities(worldId, { q, kind }).items.map((e) => e.key);

  it("finds by name, key and body text, with prefix and stemming", () => {
    const { store, w } = seeded();
    expect(keys(store, w.id, "beak")).toEqual(["beak"]);
    expect(keys(store, w.id, "hook")).toEqual(["beak"]); // prefix of body text
    expect(keys(store, w.id, "feather").sort()).toEqual(["feathered_wings"]);
    expect(keys(store, w.id, "wing", "trait")).toEqual(["feathered_wings"]);
    expect(keys(store, w.id, "wing").sort()).toEqual(["feathered_wings", "wings"]);
  });

  it("tracks updates and deletes", () => {
    const { store, w } = seeded();
    const beak = store.findByKey(w.id, "trait", "beak")!;
    store.apply(w.id, [{ op: "update", id: beak.id, patch: { content: { prose: "a stubby bill" } } }]);
    expect(keys(store, w.id, "hooked")).toEqual([]);
    expect(keys(store, w.id, "bill")).toEqual(["beak"]);
    store.apply(w.id, [{ op: "delete", id: beak.id }]);
    expect(keys(store, w.id, "bill")).toEqual([]);
  });

  it("is safe against FTS syntax and injection in the query", () => {
    const { store, w } = seeded();
    for (const q of ['wing" OR "x', "wing*", "(", '"', "NEAR(a b)", "wing; DROP TABLE entities;--", "AND", "'"]) {
      expect(() => store.listEntities(w.id, { q })).not.toThrow();
    }
    expect(store.listEntities(w.id, { q: "!!!" }).total).toBe(3); // no usable tokens: no filter
    expect(store.listEntities(w.id).total).toBe(3);
  });

  it("pages and counts", () => {
    const { store, w } = seeded();
    const page = store.listEntities(w.id, { limit: 2, offset: 0 });
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(3);
    expect(store.listEntities(w.id, { limit: 2, offset: 2 }).items).toHaveLength(1);
    expect(thrown(() => store.listEntities(w.id, { kind: "planet" })).code).toBe("invalid_kind");
  });
});

describe("links", () => {
  it("validates endpoints and type, and filters by entity", () => {
    const { store, w, create } = world();
    const body = (n: string) => ({ name: n, species: "sp", seed: "s", axis_values: {}, genotype: {}, scalars: {}, age: 1, conditions: [] });
    const a = create("individual", body("A")).entity_id, b = create("individual", body("B")).entity_id, c = create("individual", body("C")).entity_id;
    const l = store.createLink(w.id, { from: a, to: b, type: "friend", feeling: "warm", since: 3 });
    expect(l).toMatchObject({ from: a, to: b, type: "friend", feeling: "warm", since: 3 });
    store.createLink(w.id, { from: b, to: c, type: "rival" });
    expect(store.listLinks(w.id, { entity: a })).toHaveLength(1);
    expect(store.listLinks(w.id, { entity: b })).toHaveLength(2);
    expect(thrown(() => store.createLink(w.id, { from: a, to: "nope", type: "x" })).status).toBe(404);
    expect(thrown(() => store.createLink(w.id, { from: a, to: b, type: " " })).status).toBe(422);
    store.deleteLink(l.id);
    expect(thrown(() => store.deleteLink(l.id)).status).toBe(404);
  });

  it("cannot link entities from another world", () => {
    const store = memStore();
    const a = store.createWorld("a"), b = store.createWorld("b");
    const e = store.apply(a.id, [{ op: "create", kind: "slot", key: "s", body: slot("s") }]).changes[0]!.entity_id;
    const f = store.apply(b.id, [{ op: "create", kind: "slot", key: "s", body: slot("s") }]).changes[0]!.entity_id;
    expect(thrown(() => store.createLink(a.id, { from: e, to: f, type: "x" })).status).toBe(404);
  });
});

describe("registry and backup", () => {
  it("the registry follows the world's entities and settings", () => {
    const { store, w, create } = world();
    create("slot", slot("wings"), "wings");
    create("trait", trait("Wings", "wings"), "wings_t");
    let reg = store.buildRegistry(w.id);
    expect(Object.keys(reg.traits)).toEqual(["wings_t"]);
    expect(reg.traits["wings_t"]).toMatchObject({ id: "wings_t", slot: "wings", label: "Wings" });
    store.updateWorld(w.id, { settings: { ordinals: { chance: { legendary: 9 } }, breeding: { mutation: "none" } } });
    reg = store.buildRegistry(w.id);
    expect(reg.ordinals.chance["legendary"]).toBe(9);
    expect(reg.ordinals.chance["common"]).toBe(4); // defaults kept
    expect(reg.breeding).toEqual({ mutation: "none" });
  });

  it("backs up to a single file that opens as a complete database", () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-backup-"));
    try {
      const { store, w, create } = world();
      create("slot", slot("wings"), "wings");
      const file = join(dir, "copy.db");
      store.backup(file);
      const copy = new Store(openDb(file));
      expect(copy.getWorld(w.id).name).toBe("Test world");
      expect(copy.findByKey(w.id, "slot", "wings")).toBeDefined();
      expect(copy.listEntities(w.id, { q: "wings" }).total).toBe(1); // search index came along
      copy.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migrations are idempotent when reopening a database", () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-mig-"));
    try {
      const file = join(dir, "a.db");
      const s1 = new Store(openDb(file));
      s1.createWorld("persisted");
      s1.close();
      const s2 = new Store(openDb(file));
      expect(s2.listWorlds().map((w) => w.name)).toEqual(["persisted"]);
      s2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
