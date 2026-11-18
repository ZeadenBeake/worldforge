import { readFileSync } from "node:fs";
import { buildRegistry, parsePack, validateRegistry } from "@worldforge/core";
import { describe, expect, it } from "vitest";
import { exportPack, installPack, loadBundledPacks, packToYaml, previewPack, readPack } from "../src/packs";
import { EXAMPLE_PACK_PATH, PACKS_DIR, examplePack, exampleRegistry, memStore, sortKeys, thrown } from "./helpers";

function fresh() {
  const store = memStore();
  return { store, w: store.createWorld("w") };
}

describe("pack preview", () => {
  it("summarises the example pack with its (empty) content warnings, no conflicts", () => {
    const { store, w } = fresh();
    const p = previewPack(store, w.id, examplePack());
    expect(p.manifest).toMatchObject({ id: "example-avian-humanoid", name: "Avian humanoid (example)" });
    expect(p.content_warnings).toEqual([]);
    expect(p.counts).toMatchObject({ slot: 13, species: 1, skill: 4, behavior: 3 });
    expect(p.conflicts).toEqual([]);
    expect(p.issues).toEqual([]);
    expect(p.installed_version).toBeNull();
  });

  it("surfaces content warnings and missing required packs", () => {
    const { store, w } = fresh();
    const pack = readPack({ manifest: { id: "grim", name: "Grim", version: "1", content_warnings: ["gore", "body horror"], requires_packs: ["base"] }, slots: [{ id: "s", name: "s" }] });
    const p = previewPack(store, w.id, pack);
    expect(p.content_warnings).toEqual(["gore", "body horror"]);
    expect(p.requires_packs).toEqual([{ id: "base", installed: false }]);
  });

  it("reports invalid entries and missing ids without throwing", () => {
    const { store, w } = fresh();
    const pack = readPack({ manifest: { id: "p", name: "p", version: "1" }, traits: [{ id: "bad", slot: "s" }, { slot: "s", label: "no id" }] });
    const p = previewPack(store, w.id, pack);
    expect(p.issues.map((i) => i.key).sort()).toEqual(["?", "bad"]);
  });
});

describe("pack install", () => {
  it("requires an explicit confirm and returns the preview with the refusal", () => {
    const { store, w } = fresh();
    const e = thrown(() => installPack(store, w.id, examplePack()));
    expect([e.status, e.code]).toEqual([400, "confirmation_required"]);
    expect(JSON.stringify(e.details)).toContain("content_warnings");
    expect(thrown(() => installPack(store, w.id, examplePack(), { confirm: "yes" as never })).code).toBe("confirmation_required");
    expect(store.listEntities(w.id).total).toBe(0);
  });

  it("copies everything into the world with origin metadata and records the pack", () => {
    const { store, w } = fresh();
    const r = installPack(store, w.id, examplePack(), { confirm: true });
    expect(r.created).toBeGreaterThan(40);
    expect(r.updated + r.skipped).toBe(0);
    const t = store.findByKey(w.id, "trait", "feathered_wings")!;
    expect(t.origin).toEqual({ pack: "example-avian-humanoid", version: "0.1.0", key: "feathered_wings" });
    expect(store.listPacks(w.id).map((p) => [p.pack_id, p.version])).toEqual([["example-avian-humanoid", "0.1.0"]]);
  });

  it("the installed world resolves to exactly the registry the pack defines", () => {
    const { store, w } = fresh();
    installPack(store, w.id, examplePack(), { confirm: true });
    const fromWorld = store.buildRegistry(w.id);
    const fromFile = exampleRegistry();
    expect(sortKeys(fromWorld)).toEqual(sortKeys(fromFile));
    expect(validateRegistry(fromWorld)).toEqual([]);
  });

  it("conflicts abort by default, listing what clashes and whether the content is identical", () => {
    const { store, w } = fresh();
    installPack(store, w.id, examplePack(), { confirm: true });
    const e = thrown(() => installPack(store, w.id, examplePack(), { confirm: true }));
    expect([e.status, e.code]).toEqual([409, "pack_conflict"]);
    const conflicts = (e.details as { conflicts: { same_content: boolean }[] }).conflicts;
    expect(conflicts.length).toBeGreaterThan(40);
    expect(conflicts.every((c) => c.same_content)).toBe(true);
  });

  it("skip leaves existing entities alone; replace is a no-op for identical content", () => {
    const { store, w } = fresh();
    installPack(store, w.id, examplePack(), { confirm: true });
    const s = installPack(store, w.id, examplePack(), { confirm: true, on_conflict: "skip" });
    expect([s.created, s.updated, s.skipped > 40]).toEqual([0, 0, true]);
    const r = installPack(store, w.id, examplePack(), { confirm: true, on_conflict: "replace" });
    expect([r.created, r.updated, r.skipped > 40]).toEqual([0, 0, true]);
  });

  it("replace updates changed entities and their origin version, and keeps ids", () => {
    const { store, w } = fresh();
    installPack(store, w.id, examplePack(), { confirm: true });
    const before = store.findByKey(w.id, "trait", "beak")!;
    const v2 = examplePack();
    v2.manifest.version = "0.2.0";
    v2.traits!.find((t) => t.id === "beak")!.label = "Strong beak";
    const r = installPack(store, w.id, v2, { confirm: true, on_conflict: "replace" });
    expect(r.updated).toBeGreaterThanOrEqual(1);
    const after = store.findByKey(w.id, "trait", "beak")!;
    expect(after.id).toBe(before.id);
    expect(after.name).toBe("Strong beak");
    expect(after.origin?.version).toBe("0.2.0");
    expect(store.listPacks(w.id)[0]!.version).toBe("0.2.0");
    expect(r.preview.installed_version).toBe("0.1.0");
  });

  it("local edits to a pack entity are visible as a conflict with different content", () => {
    const { store, w } = fresh();
    installPack(store, w.id, examplePack(), { confirm: true });
    const beak = store.findByKey(w.id, "trait", "beak")!;
    store.apply(w.id, [{ op: "update", id: beak.id, patch: { label: "My beak" } }]);
    const p = previewPack(store, w.id, examplePack());
    expect(p.conflicts.find((c) => c.key === "beak")!.same_content).toBe(false);
    expect(p.conflicts.filter((c) => !c.same_content)).toHaveLength(1);
  });

  it("is atomic: an invalid entry installs nothing and records nothing", () => {
    const { store, w } = fresh();
    const pack = readPack({ manifest: { id: "p", name: "p", version: "1" }, slots: [{ id: "ok", name: "ok" }], traits: [{ id: "bad", slot: "s" }] });
    const e = thrown(() => installPack(store, w.id, pack, { confirm: true }));
    expect([e.status, e.code]).toEqual([422, "invalid_pack"]);
    expect(store.listEntities(w.id).total).toBe(0);
    expect(store.listPacks(w.id)).toEqual([]);
  });

  it("installing is one undoable batch per entity in the edit log, actor 'pack'", () => {
    const { store, w } = fresh();
    installPack(store, w.id, examplePack(), { confirm: true });
    const edits = store.listEdits(w.id, { limit: 500 });
    expect(new Set(edits.map((e) => e.actor))).toEqual(new Set(["pack"]));
    expect(new Set(edits.map((e) => e.batch)).size).toBe(1);
    expect(edits[0]!.note).toBe("install example-avian-humanoid@0.1.0");
  });
});

describe("pack export", () => {
  it("round-trips: export a world's content, import into a fresh world, same registry", () => {
    const a = fresh();
    installPack(a.store, a.w.id, examplePack(), { confirm: true });
    const exported = exportPack(a.store, a.w.id, { id: "mine", name: "Mine", version: "1.0.0", content_warnings: [] });
    const yaml = packToYaml(exported);
    const b = fresh();
    installPack(b.store, b.w.id, readPack(yaml), { confirm: true });
    expect(sortKeys(b.store.buildRegistry(b.w.id))).toEqual(sortKeys(a.store.buildRegistry(a.w.id)));
  });

  it("exports only the requested kinds, never individuals", () => {
    const a = fresh();
    installPack(a.store, a.w.id, examplePack(), { confirm: true });
    a.store.apply(a.w.id, [{ op: "create", kind: "individual", body: { name: "X", species: "avian_humanoid", seed: "s", axis_values: {}, genotype: {}, scalars: {}, age: 1, conditions: [] } }]);
    const p = exportPack(a.store, a.w.id, { id: "m", name: "m", version: "1", content_warnings: [] }, ["skill", "individual"]);
    expect(Object.keys(p).sort()).toEqual(["manifest", "skills"]);
  });

  it("an exported pack carries the author's content warnings", () => {
    const a = fresh();
    const p = exportPack(a.store, a.w.id, { id: "m", name: "m", version: "1", content_warnings: ["gore"] });
    expect(parsePack(packToYaml(p)).manifest.content_warnings).toEqual(["gore"]);
  });
});

describe("readPack and bundled packs", () => {
  it("reads YAML, JSON and objects; rejects junk", () => {
    const yaml = readFileSync(EXAMPLE_PACK_PATH, "utf8");
    expect(readPack(yaml).manifest.id).toBe("example-avian-humanoid");
    expect(readPack(JSON.stringify({ manifest: { id: "j", name: "j", version: "1" } })).manifest.content_warnings).toEqual([]);
    expect(readPack({ manifest: { id: "o", name: "o", version: "1" } }).manifest.id).toBe("o");
    expect(thrown(() => readPack("slots: []")).status).toBe(422);
    expect(thrown(() => readPack({ manifest: { id: 1 } })).status).toBe(422);
    expect(thrown(() => readPack(42)).status).toBe(400);
  });

  it("finds the bundled example pack", () => {
    const packs = loadBundledPacks(PACKS_DIR);
    expect(packs.map((p) => p.id)).toContain("example-avian-humanoid");
    expect(buildRegistry([packs[0]!.pack]).species["avian_humanoid"]).toBeDefined();
  });

  it("a missing or broken packs directory yields no packs, not a crash", () => {
    expect(loadBundledPacks("/no/such/dir")).toEqual([]);
  });
});
