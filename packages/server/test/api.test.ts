import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createExporters } from "../src/exporters";
import { loadBundledPacks } from "../src/packs";
import { PACKS_DIR, memStore } from "./helpers";

function setup() {
  const store = memStore();
  const app = createApp({ store, exporters: createExporters(), bundledPacks: loadBundledPacks(PACKS_DIR) });
  type Res = { status: number; json: any; text: string; type: string };
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await app.request(path, {
      method,
      ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, json, text, type: res.headers.get("content-type") ?? "" };
  };
  return { store, app, call };
}

async function worldWithExample() {
  const ctx = setup();
  const w = (await ctx.call("POST", "/api/worlds", { name: "Test" })).json;
  const r = await ctx.call("POST", `/api/worlds/${w.id}/packs`, { bundled: "example-avian-humanoid", confirm: true });
  expect(r.status).toBe(201);
  const species = (await ctx.call("GET", `/api/worlds/${w.id}/entities?kind=species`)).json.items[0];
  return { ...ctx, w, species };
}

describe("meta and errors", () => {
  it("health, exporters, and a JSON 404", async () => {
    const { call } = setup();
    expect((await call("GET", "/api/health")).json).toMatchObject({ ok: true });
    const ex = (await call("GET", "/api/exporters")).json;
    expect(ex.exporters.map((e: { id: string }) => e.id)).toEqual(["image-prompt", "text-adventure"]);
    const nf = await call("GET", "/api/nope");
    expect([nf.status, nf.json.error.code]).toEqual([404, "not_found"]);
  });

  it("every error has the same envelope", async () => {
    const { call } = setup();
    const r = await call("GET", "/api/worlds/nope");
    expect(r.status).toBe(404);
    expect(r.json).toEqual({ error: { code: "world_not_found", message: expect.any(String) } });
    expect(r.type).toContain("application/json");
  });

  it("rejects malformed bodies", async () => {
    const { call } = setup();
    expect((await call("POST", "/api/worlds", "{not json")).json.error.code).toBe("invalid_json");
    expect((await call("POST", "/api/worlds", "[1,2]")).json.error.code).toBe("invalid_json");
    expect((await call("POST", "/api/worlds", "")).json.error.code).toBe("invalid_json");
    expect((await call("POST", "/api/worlds", {})).status).toBe(422);
  });

  it("rejects oversized bodies (10 MB)", async () => {
    const { call } = setup();
    const r = await call("POST", "/api/worlds", { name: "x".repeat(11 * 1024 * 1024) });
    expect([r.status, r.json.error.code]).toEqual([413, "too_large"]);
  });
});

describe("worlds", () => {
  it("create, read, rename, settings, and guarded delete", async () => {
    const { call } = setup();
    const w = (await call("POST", "/api/worlds", { name: "A" })).json;
    expect((await call("GET", `/api/worlds/${w.id}`)).json.name).toBe("A");
    const p = (await call("PATCH", `/api/worlds/${w.id}`, { name: "B", settings: { breeding: { mutation: "none" } } })).json;
    expect([p.name, p.settings.breeding.mutation, p.rev]).toEqual(["B", "none", 1]);
    expect((await call("DELETE", `/api/worlds/${w.id}`)).json.error.code).toBe("confirmation_required");
    expect((await call("DELETE", `/api/worlds/${w.id}?confirm=true`)).status).toBe(200);
    expect((await call("GET", `/api/worlds/${w.id}`)).status).toBe(404);
  });
});

describe("packs over HTTP", () => {
  it("lists bundled packs with their description and content warnings", async () => {
    const { call } = setup();
    const p = (await call("GET", "/api/packs/bundled")).json.packs[0];
    expect(p).toMatchObject({ id: "example-avian-humanoid", content_warnings: [] });
    expect(p.description).toMatch(/bioelectricity/);
  });

  it("preview shows warnings; install without confirm is refused with the preview attached", async () => {
    const { call } = setup();
    const w = (await call("POST", "/api/worlds", { name: "w" })).json;
    const pre = await call("POST", `/api/worlds/${w.id}/packs/preview`, { bundled: "example-avian-humanoid" });
    expect(pre.json).toMatchObject({ content_warnings: [], conflicts: [], issues: [] });
    const refused = await call("POST", `/api/worlds/${w.id}/packs`, { bundled: "example-avian-humanoid" });
    expect([refused.status, refused.json.error.code]).toEqual([400, "confirmation_required"]);
    expect(refused.json.error.details.preview.manifest.name).toBe("Avian humanoid (example)");
    expect((await call("GET", `/api/worlds/${w.id}/entities`)).json.total).toBe(0);
  });

  it("installs a pack supplied inline, and reports conflicts on a second install", async () => {
    const { call } = setup();
    const w = (await call("POST", "/api/worlds", { name: "w" })).json;
    const pack = { manifest: { id: "tiny", name: "Tiny", version: "1", content_warnings: ["mild peril"] }, skills: [{ id: "swim", label: "Swim" }] };
    expect((await call("POST", `/api/worlds/${w.id}/packs`, { pack, confirm: true })).status).toBe(201);
    expect((await call("GET", `/api/worlds/${w.id}/packs`)).json.packs[0].manifest.content_warnings).toEqual(["mild peril"]);
    const again = await call("POST", `/api/worlds/${w.id}/packs`, { pack, confirm: true });
    expect([again.status, again.json.error.code]).toEqual([409, "pack_conflict"]);
    expect((await call("POST", `/api/worlds/${w.id}/packs`, { pack, confirm: true, on_conflict: "skip" })).json).toMatchObject({ created: 0, skipped: 1 });
    expect((await call("POST", `/api/worlds/${w.id}/packs`, { pack, confirm: true, on_conflict: "nope" })).status).toBe(400);
  });

  it("rejects unknown bundled ids and missing pack input", async () => {
    const { call } = setup();
    const w = (await call("POST", "/api/worlds", { name: "w" })).json;
    expect((await call("POST", `/api/worlds/${w.id}/packs/preview`, { bundled: "nope" })).status).toBe(404);
    expect((await call("POST", `/api/worlds/${w.id}/packs/preview`, {})).status).toBe(400);
  });

  it("exports content as YAML or JSON and re-imports it", async () => {
    const { call, w } = await worldWithExample();
    const manifest = { id: "mine", name: "Mine", version: "1.0.0" };
    const yaml = await call("POST", `/api/worlds/${w.id}/packs/export`, { manifest, kinds: ["skill"] });
    expect(yaml.type).toContain("text/yaml");
    expect(yaml.text).toContain("id: melee");
    expect(yaml.text).not.toContain("species:");
    const json = await call("POST", `/api/worlds/${w.id}/packs/export`, { manifest, format: "json" });
    expect(json.json.species).toHaveLength(1);
    const w2 = (await call("POST", "/api/worlds", { name: "copy" })).json;
    expect((await call("POST", `/api/worlds/${w2.id}/packs`, { pack: json.json, confirm: true })).status).toBe(201);
    expect((await call("POST", `/api/worlds/${w.id}/packs/export`, { manifest, kinds: ["individual"] })).status).toBe(400);
    expect((await call("POST", `/api/worlds/${w.id}/packs/export`, { manifest: { id: "x" } })).status).toBe(422);
  });
});

describe("entities over HTTP", () => {
  it("lists by kind and searches", async () => {
    const { call, w } = await worldWithExample();
    const traits = (await call("GET", `/api/worlds/${w.id}/entities?kind=trait&limit=2`)).json;
    expect([traits.items.length, traits.total > 10]).toEqual([2, true]);
    const hits = (await call("GET", `/api/worlds/${w.id}/entities?q=beak`)).json.items.map((e: { key: string }) => e.key);
    expect(hits).toContain("beak");
    expect((await call("GET", `/api/worlds/${w.id}/entities?kind=planet`)).json.error.code).toBe("invalid_kind");
    expect((await call("GET", `/api/worlds/${w.id}/entities?limit=abc`)).json.error.code).toBe("invalid_query");
  });

  it("create, read, replace, patch, and delete", async () => {
    const { call, w } = await worldWithExample();
    const created = await call("POST", `/api/worlds/${w.id}/entities`, { kind: "skill", key: "swim", body: { label: "Swim" } });
    expect([created.status, created.json.name]).toEqual([201, "Swim"]);
    const id = created.json.id;
    expect((await call("PUT", `/api/entities/${id}`, { body: { label: "Swimming" } })).json.name).toBe("Swimming");
    const patched = (await call("PATCH", `/api/entities/${id}`, { patch: { description: "in water" }, notes: "todo" })).json;
    expect([patched.body.description, patched.notes]).toEqual(["in water", "todo"]);
    expect((await call("PATCH", `/api/entities/${id}`, {})).json.error.code).toBe("invalid_command");
    expect((await call("DELETE", `/api/entities/${id}`)).status).toBe(200);
    expect((await call("GET", `/api/entities/${id}`)).status).toBe(404);
  });

  it("validation failures are 422 with paths; duplicate keys are 409", async () => {
    const { call, w } = await worldWithExample();
    const bad = await call("POST", `/api/worlds/${w.id}/entities`, { kind: "trait", key: "t1", body: { slot: "wings" } });
    expect([bad.status, bad.json.error.code]).toEqual([422, "invalid_body"]);
    expect(bad.json.error.details.issues[0].path).toBe("label");
    const dup = await call("POST", `/api/worlds/${w.id}/entities`, { kind: "slot", key: "wings", body: { name: "x" } });
    expect([dup.status, dup.json.error.code]).toEqual([409, "key_conflict"]);
    expect((await call("POST", `/api/worlds/${w.id}/entities`, { body: {} })).json.error.code).toBe("invalid_kind");
  });

  it("refuses to delete something in use, names the users, and force overrides", async () => {
    const { call, w } = await worldWithExample();
    const beak = (await call("GET", `/api/worlds/${w.id}/entities?q=beak&kind=trait`)).json.items.find((e: { key: string }) => e.key === "beak");
    const used = (await call("GET", `/api/entities/${beak.id}/used-by`)).json;
    expect(used.referrers.map((r: { key: string }) => r.key)).toEqual(["avian_humanoid"]);
    const refused = await call("DELETE", `/api/entities/${beak.id}`);
    expect([refused.status, refused.json.error.code]).toEqual([409, "in_use"]);
    expect(refused.json.error.details.referrers[0].key).toBe("avian_humanoid");
    expect((await call("DELETE", `/api/entities/${beak.id}?force=true`)).status).toBe(200);
    // the validator now flags the dangling reference
    const warnings = (await call("GET", `/api/worlds/${w.id}/warnings`)).json;
    expect(warnings.registry.map((x: { code: string }) => x.code)).toContain("unknown_trait");
  });
});

describe("edits and undo over HTTP", () => {
  it("dry run previews a batch without persisting; the real run is atomic; undo reverts", async () => {
    const { call, w } = await worldWithExample();
    const cmds = [
      { op: "create", kind: "skill", key: "swim", body: { label: "Swim" } },
      { op: "create", kind: "skill", key: "dive", body: { label: "Dive" } },
    ];
    const dry = await call("POST", `/api/worlds/${w.id}/edits`, { commands: cmds, dryRun: true });
    expect([dry.json.dryRun, dry.json.changes.map((c: { op: string }) => c.op)]).toEqual([true, ["create", "create"]]);
    expect((await call("GET", `/api/worlds/${w.id}/entities?q=swim`)).json.total).toBe(0);

    const bad = await call("POST", `/api/worlds/${w.id}/edits`, { commands: [cmds[0], { op: "create", kind: "trait", key: "x", body: {} }] });
    expect([bad.status, bad.json.error.details.command_index]).toEqual([422, 1]);
    expect((await call("GET", `/api/worlds/${w.id}/entities?q=swim`)).json.total).toBe(0);

    const real = await call("POST", `/api/worlds/${w.id}/edits`, { commands: cmds, actor: "llm", note: "proposal 1" });
    expect(real.status).toBe(200);
    const edits = (await call("GET", `/api/worlds/${w.id}/edits?limit=2`)).json.edits;
    expect(edits[0]).toMatchObject({ actor: "llm", note: "proposal 1", op: "create" });
    const undone = await call("POST", `/api/edits/${edits[0].id}/undo`);
    expect(undone.json.change.op).toBe("delete");
    expect((await call("POST", `/api/edits/${edits[0].id}/undo`)).json.error.code).toBe("already_undone");
    expect((await call("POST", "/api/edits/abc/undo")).status).toBe(400);
    expect((await call("POST", "/api/edits/99999/undo")).status).toBe(404);
  });

  it("rejects bad command lists", async () => {
    const { call, w } = await worldWithExample();
    expect((await call("POST", `/api/worlds/${w.id}/edits`, { commands: "x" })).json.error.code).toBe("invalid_commands");
    expect((await call("POST", `/api/worlds/${w.id}/edits`, { commands: [] })).json.error.code).toBe("invalid_commands");
    expect((await call("POST", `/api/worlds/${w.id}/edits`, { commands: [{ op: "explode" }] })).json.error.code).toBe("invalid_command");
  });

  it("cannot touch another world's entities through this world's batch endpoint", async () => {
    const { call, species } = await worldWithExample();
    const other = (await call("POST", "/api/worlds", { name: "other" })).json;
    const r = await call("POST", `/api/worlds/${other.id}/edits`, { commands: [{ op: "delete", id: species.id, force: true }] });
    expect(r.status).toBe(404);
    expect((await call("GET", `/api/entities/${species.id}`)).status).toBe(200);
  });
});

describe("rolling", () => {
  it("rolls reproducibly, honours locks (even outside the pool), applies a name", async () => {
    const { call, species } = await worldWithExample();
    const a = await call("POST", `/api/species/${species.id}/roll`, { seed: "abc" });
    const b = await call("POST", `/api/species/${species.id}/roll`, { seed: "abc" });
    expect(a.status).toBe(200);
    expect(a.json).toEqual(b.json);
    expect(a.json.warnings).toEqual([]);
    expect(a.json.individual.genotype.mouth).toBe("beak");
    const locked = await call("POST", `/api/species/${species.id}/roll`, {
      seed: 1, name: "Pale", locks: { axis_values: { sex: "female" }, genotype: { plumage_color: "albino", discharge_tendency: "uncontrolled_discharge" } },
    });
    expect(locked.json.individual).toMatchObject({ name: "Pale", axis_values: { sex: "female" }, genotype: { plumage_color: "albino", discharge_tendency: "uncontrolled_discharge" } });
    expect(locked.json.warnings).toEqual([]);
  });

  it("a roll with no body works and picks a random seed; saving creates an individual", async () => {
    const { call, species, w } = await worldWithExample();
    const r = await call("POST", `/api/species/${species.id}/roll`);
    expect(r.status).toBe(200);
    expect(r.json.individual.seed).toMatch(/^[0-9a-f]{12}$/);
    const saved = await call("POST", `/api/species/${species.id}/roll`, { seed: "s", name: "Kes", save: true });
    expect(saved.status).toBe(201);
    expect(saved.json.saved).toMatchObject({ kind: "individual", name: "Kes" });
    expect(saved.json.saved.key).toMatch(/^kes_/);
    expect((await call("GET", `/api/worlds/${w.id}/entities?kind=individual`)).json.total).toBe(1);
  });

  it("rejects bad options and non-species ids", async () => {
    const { call, species, w } = await worldWithExample();
    expect((await call("POST", `/api/species/${species.id}/roll`, { seed: [1] })).json.error.code).toBe("invalid_option");
    expect((await call("POST", `/api/species/${species.id}/roll`, { locks: "x" })).json.error.code).toBe("invalid_option");
    expect((await call("POST", `/api/species/${species.id}/roll`, { save: "yes" })).json.error.code).toBe("invalid_option");
    const skill = (await call("GET", `/api/worlds/${w.id}/entities?kind=skill`)).json.items[0];
    expect((await call("POST", `/api/species/${skill.id}/roll`, {})).json.error.code).toBe("wrong_kind");
    expect((await call("POST", `/api/species/nope/roll`, {})).status).toBe(404);
  });
});

describe("breeding over HTTP", () => {
  async function parents() {
    const ctx = await worldWithExample();
    const mk = async (name: string, seed: string) =>
      (await ctx.call("POST", `/api/species/${ctx.species.id}/roll`, { seed, name, save: true })).json.saved;
    return { ...ctx, mum: await mk("Mum", "m"), dad: await mk("Dad", "d") };
  }

  it("breeds, optionally saves the child, and links both parents", async () => {
    const { call, w, mum, dad } = await parents();
    const preview = await call("POST", "/api/individuals/breed", { parents: [mum.id, dad.id], seed: "k" });
    expect([preview.status, preview.json.individual.age, preview.json.warnings]).toEqual([200, 0, []]);
    expect((await call("GET", `/api/worlds/${w.id}/links`)).json.links).toEqual([]);

    const saved = await call("POST", "/api/individuals/breed", { parents: [mum.id, dad.id], seed: "k", name: "Pip", save: true });
    expect(saved.status).toBe(201);
    const links = (await call("GET", `/api/worlds/${w.id}/links?entity=${saved.json.saved.id}`)).json.links;
    expect(links.map((l: { type: string; from: string }) => [l.type, l.from]).sort()).toEqual([["parent", dad.id], ["parent", mum.id]].sort());

    // the snapshot's relations come straight from those links
    const snap = (await call("GET", `/api/individuals/${saved.json.saved.id}/snapshot`)).json;
    expect(snap.individual.name).toBe("Pip");
    expect(snap.relations.map((r: { direction: string; other_name: string }) => [r.direction, r.other_name]).sort()).toEqual([["in", "Dad"], ["in", "Mum"]]);
    expect(snap.life_stage).toBe("fledgling");
  });

  it("validates the parent list", async () => {
    const { call, mum, species } = await parents();
    for (const bad of [[], [mum.id, mum.id, mum.id], "x", [1]]) {
      expect((await call("POST", "/api/individuals/breed", { parents: bad })).json.error.code).toBe("invalid_parents");
    }
    expect((await call("POST", "/api/individuals/breed", { parents: [species.id] })).json.error.code).toBe("wrong_kind");
    expect((await call("POST", "/api/individuals/breed", { parents: [mum.id, "nope"] })).status).toBe(404);
    expect((await call("POST", "/api/individuals/breed", { parents: [mum.id, mum.id], species: "nope" })).json.error.code).toBe("unknown_species");
  });

  it("refuses parents from different worlds", async () => {
    const a = await parents();
    const other = (await a.call("POST", "/api/worlds", { name: "other" })).json;
    await a.call("POST", `/api/worlds/${other.id}/packs`, { bundled: "example-avian-humanoid", confirm: true });
    const sp = (await a.call("GET", `/api/worlds/${other.id}/entities?kind=species`)).json.items[0];
    const stranger = (await a.call("POST", `/api/species/${sp.id}/roll`, { save: true })).json.saved;
    expect((await a.call("POST", "/api/individuals/breed", { parents: [a.mum.id, stranger.id] })).json.error.code).toBe("invalid_parents");
  });

  it("passes the breeding options through", async () => {
    const { call, mum, dad } = await parents();
    const r = await call("POST", "/api/individuals/breed", { parents: [mum.id, dad.id], seed: 5, age: 7, mutation: "none", off_species: "none", locks: { genotype: { plumage_color: "slate" } } });
    expect([r.json.individual.age, r.json.individual.genotype.plumage_color]).toEqual([7, "slate"]);
    expect((await call("POST", "/api/individuals/breed", { parents: [mum.id, dad.id], age: "old" })).json.error.code).toBe("invalid_option");
  });
});

describe("snapshot, export and warnings", () => {
  async function kestrel() {
    const ctx = await worldWithExample();
    const saved = (await ctx.call("POST", `/api/species/${ctx.species.id}/roll`, {
      seed: "k", name: "Kestrel", save: true, locks: { axis_values: { sex: "male" }, genotype: { crest: "display_crest" }, age: 31 },
    })).json.saved;
    return { ...ctx, saved };
  }

  it("serves the resolved snapshot", async () => {
    const { call, saved } = await kestrel();
    const s = (await call("GET", `/api/individuals/${saved.id}/snapshot`)).json;
    expect(s.individual).toMatchObject({ id: saved.id, name: "Kestrel", pronouns: { subject: "he" } });
    expect(s.traits.find((t: { slot: string }) => t.slot === "crest")).toMatchObject({ trait: "display_crest", expressed: true });
    expect(s.tags).toContain("ability:emp");
    expect(Object.isFrozen(s)).toBe(false); // JSON over the wire, of course
  });

  it("applies `now` to thoughts and rejects a bad one", async () => {
    const { call, saved } = await kestrel();
    await call("PATCH", `/api/entities/${saved.id}`, { patch: { thoughts: [{ text: "fleeting", kind: "short", since: 1, expires: 5 }, { text: "lasting", kind: "formative", since: 0 }] } });
    expect((await call("GET", `/api/individuals/${saved.id}/snapshot`)).json.thoughts).toHaveLength(2);
    expect((await call("GET", `/api/individuals/${saved.id}/snapshot?now=9`)).json.thoughts.map((t: { text: string }) => t.text)).toEqual(["lasting"]);
    expect((await call("GET", `/api/individuals/${saved.id}/snapshot?now=soon`)).json.error.code).toBe("invalid_query");
  });

  it("exports as text, JSON envelope, and image prompt", async () => {
    const { call, saved } = await kestrel();
    const text = await call("GET", `/api/individuals/${saved.id}/export/text-adventure`);
    expect(text.type).toContain("text/plain");
    expect(text.text.split("\n")[0]).toBe("Kestrel");
    expect(text.text).toContain("- a showy crest of head feathers");
    expect(text.text).toContain("He tends to:");
    const env = (await call("GET", `/api/individuals/${saved.id}/export/text-adventure?format=json`)).json;
    expect([env.exporter, env.content_type, env.body]).toEqual(["text-adventure", "text/plain", text.text]);
    expect((await call("GET", `/api/individuals/${saved.id}/export/image-prompt`)).text).toContain("feather crest");
    expect((await call("GET", `/api/individuals/${saved.id}/export/nope`)).json.error.code).toBe("exporter_not_found");
  });

  it("reflects edits immediately (the registry cache follows the world's revision)", async () => {
    const { call, saved, w } = await kestrel();
    const crest = (await call("GET", `/api/worlds/${w.id}/entities?kind=trait&q=crest`)).json.items.find((t: { key: string }) => t.key === "display_crest");
    await call("PATCH", `/api/entities/${crest.id}`, { patch: { content: { prose: "a regal plume" } } });
    expect((await call("GET", `/api/individuals/${saved.id}/export/text-adventure`)).text).toContain("- a regal plume");
  });

  it("an individual with a dangling reference shows up in the warnings panel", async () => {
    const { call, saved, w } = await kestrel();
    expect((await call("GET", `/api/worlds/${w.id}/warnings`)).json).toEqual({ registry: [], individuals: [] });
    await call("PATCH", `/api/entities/${saved.id}`, { patch: { genotype: { extra: "ghost_trait" } } });
    const warnings = (await call("GET", `/api/worlds/${w.id}/warnings`)).json;
    expect(warnings.individuals[0]).toMatchObject({ name: "Kestrel" });
    expect(warnings.individuals[0].warnings.map((x: { code: string }) => x.code)).toContain("unknown_trait");
  });

  it("snapshot and export only work on individuals", async () => {
    const { call, species } = await kestrel();
    expect((await call("GET", `/api/individuals/${species.id}/snapshot`)).json.error.code).toBe("wrong_kind");
    expect((await call("GET", `/api/individuals/${species.id}/export/text-adventure`)).status).toBe(404);
  });
});

describe("the whole journey", () => {
  it("fresh world -> install example -> roll -> save -> breed -> export, using nothing but HTTP", async () => {
    const { call } = setup();
    const w = (await call("POST", "/api/worlds", { name: "Journey" })).json;
    const bundled = (await call("GET", "/api/packs/bundled")).json.packs[0];
    expect(bundled.content_warnings).toEqual([]); // the shipped default is tame
    expect((await call("POST", `/api/worlds/${w.id}/packs`, { bundled: bundled.id, confirm: true })).status).toBe(201);
    const species = (await call("GET", `/api/worlds/${w.id}/entities?kind=species`)).json.items[0];
    const a = (await call("POST", `/api/species/${species.id}/roll`, { seed: "one", name: "Ash", save: true })).json.saved;
    const b = (await call("POST", `/api/species/${species.id}/roll`, { seed: "two", name: "Birch", save: true })).json.saved;
    const kid = (await call("POST", "/api/individuals/breed", { parents: [a.id, b.id], seed: "three", name: "Cedar", save: true })).json;
    expect(kid.warnings).toEqual([]);
    const text = (await call("GET", `/api/individuals/${kid.saved.id}/export/text-adventure`)).text;
    expect(text).toMatch(/^Cedar\nAvian humanoid, 0 years old \(fledgling\)\./);
    expect(text).toContain("Relationships:");
    expect(text).toMatch(/- (Ash|Birch) is parent of (him|her|them)/);
    // a newborn is nowhere near adult size (the example pack's adults are 150+ cm)
    expect(Number(/Height: ([\d.]+) cm/.exec(text)![1])).toBeLessThan(60);
  });
});
