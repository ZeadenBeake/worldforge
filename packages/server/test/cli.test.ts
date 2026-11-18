import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { Store } from "../src/store";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wf-cli-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function cli(args: string[], env: Record<string, string> = {}) {
  let out = "", err = "";
  const code = await runCli(args, {
    out: (s) => (out += s),
    err: (s) => (err += s),
    env: { WORLDFORGE_DATA: join(dir, "data"), WORLDFORGE_PLUGINS: join(dir, "plugins"), ...env },
  });
  return { code, out, err };
}

describe("help and usage errors", () => {
  it("prints help by default and for help/--help", async () => {
    for (const args of [[], ["help"], ["--help"]]) {
      const r = await cli(args);
      expect(r.code).toBe(0);
      expect(r.out).toContain("worldforge <command>");
      expect(r.out).toContain("seed");
    }
  });

  it("unknown commands and options exit 2 with a message, not a stack trace", async () => {
    expect((await cli(["frobnicate"])).code).toBe(2);
    const bad = await cli(["roll", "--nope"]);
    expect(bad.code).toBe(2);
    expect(bad.err).toMatch(/nope/i);
    expect((await cli(["worlds", "--format", "xml"])).code).toBe(2);
  });

  it("commands that need a world explain how to get one", async () => {
    const r = await cli(["roll", "avian_humanoid"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("worldforge seed");
  });
});

describe("seed", () => {
  it("creates a world and installs the bundled pack, showing its description and warnings", async () => {
    const r = await cli(["seed", "--name", "Demo"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Avian humanoid (example)");
    expect(r.out).toContain("Content warnings: none");
    expect(r.out).toMatch(/Installed example-avian-humanoid: \d+ created, 0 skipped/);
    expect((await cli(["worlds"])).out).toMatch(/Demo\s+\(\d+ entities\)/);
  });

  it("seeding into an existing world skips what is already there", async () => {
    await cli(["seed", "--name", "Demo"]);
    const again = await cli(["seed", "--world", "Demo"]);
    expect(again.code).toBe(0);
    expect(again.out).toMatch(/0 created, \d+ skipped/);
  });

  it("refuses unknown packs", async () => {
    const r = await cli(["seed", "--pack", "nope"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("example-avian-humanoid");
  });

  describe("a pack with content warnings", () => {
    let packs: string;
    beforeEach(() => {
      packs = join(dir, "packs");
      mkdirSync(packs);
      writeFileSync(join(packs, "grim.yaml"), "manifest: { id: grim, name: Grim, version: '1', description: Dark stuff, content_warnings: [gore, body horror] }\nskills: [{ id: scream, label: Scream }]\n");
    });

    it("shows the warnings, installs nothing and creates no world without --yes", async () => {
      const r = await cli(["seed"], { WORLDFORGE_PACKS: packs });
      expect(r.code).toBe(2);
      expect(r.out).toContain("Content warnings: gore, body horror");
      expect(r.err).toContain("--yes");
      expect((await cli(["worlds"], { WORLDFORGE_PACKS: packs })).out).toBe("");
    });

    it("installs it once the user has confirmed with --yes", async () => {
      const r = await cli(["seed", "--yes", "--name", "G"], { WORLDFORGE_PACKS: packs });
      expect(r.code).toBe(0);
      expect(r.out).toContain("Installed grim: 1 created");
    });
  });
});

describe("roll and export", () => {
  beforeEach(async () => {
    await cli(["seed", "--name", "Demo"]);
  });

  it("rolls reproducibly and prints the text adventure by default", async () => {
    const a = await cli(["roll", "avian_humanoid", "--seed", "abc", "--name", "Kestrel"]);
    const b = await cli(["roll", "avian_humanoid", "--seed", "abc", "--name", "Kestrel"]);
    expect(a.code).toBe(0);
    expect(a.out).toBe(b.out);
    expect(a.out.split("\n")[0]).toBe("Kestrel");
    expect(a.out).toContain("Features:");
    expect(a.out.endsWith("\n")).toBe(true);
    expect(a.out.endsWith("\n\n")).toBe(false);
  });

  it("picks other exporters and prints JSON on request", async () => {
    const tags = await cli(["roll", "avian_humanoid", "--seed", "abc", "--exporter", "image-prompt"]);
    expect(tags.out).toContain("beak");
    const json = JSON.parse((await cli(["roll", "avian_humanoid", "--seed", "abc", "--format", "json"])).out);
    expect(json.individual.seed).toBe("abc");
    expect(json.warnings).toEqual([]);
  });

  it("does not save unless asked; --save stores it and reports the id on stderr", async () => {
    await cli(["roll", "avian_humanoid", "--seed", "x", "--name", "Ghost"]);
    const store = new Store(openDb(join(dir, "data", "worldforge.db")));
    const w = store.listWorlds()[0]!;
    expect(store.listEntities(w.id, { kind: "individual" }).total).toBe(0);
    store.close();

    const saved = await cli(["roll", "avian_humanoid", "--seed", "x", "--name", "Kes", "--save"]);
    expect(saved.err).toMatch(/saved: \w+ \(kes_\w+\)/);
    const key = /\((kes_\w+)\)/.exec(saved.err)![1]!;

    const exported = await cli(["export", key]);
    expect(exported.code).toBe(0);
    expect(exported.out.split("\n")[0]).toBe("Kes");
    const snap = JSON.parse((await cli(["export", key, "--format", "json"])).out);
    expect(snap.individual.name).toBe("Kes");
    expect(snap.individual.id).toBeTruthy();
  });

  it("explains a wrong species, individual or exporter by listing the choices", async () => {
    const sp = await cli(["roll", "nope"]);
    expect([sp.code, sp.err]).toEqual([2, expect.stringContaining("avian_humanoid")]);
    const ex = await cli(["roll", "avian_humanoid", "--exporter", "nope"]);
    expect([ex.code, ex.err]).toEqual([2, expect.stringContaining("text-adventure")]);
    expect((await cli(["export", "nope"])).code).toBe(2);
    expect((await cli(["roll"])).code).toBe(2);
    expect((await cli(["export"])).code).toBe(2);
  });

  it("with several worlds it asks which, and accepts a name or id", async () => {
    await cli(["seed", "--name", "Second"]);
    const ambiguous = await cli(["roll", "avian_humanoid"]);
    expect(ambiguous.code).toBe(2);
    expect(ambiguous.err).toContain("--world");
    expect((await cli(["roll", "avian_humanoid", "--world", "Second", "--seed", "s"])).code).toBe(0);
    expect((await cli(["roll", "avian_humanoid", "--world", "Nowhere"])).code).toBe(2);
  });

  it("picks up user exporter plugins", async () => {
    mkdirSync(join(dir, "plugins"));
    writeFileSync(join(dir, "plugins", "one-liner.exporter.yaml"), "id: one-liner\nname: One liner\ntemplate: '{{name}}: {{species}}'\n");
    const r = await cli(["roll", "avian_humanoid", "--seed", "s", "--name", "Wren", "--exporter", "one-liner"]);
    expect(r.out).toBe("Wren: Avian humanoid\n");
  });
});

describe("backup", () => {
  it("writes a database copy that opens with the same content", async () => {
    await cli(["seed", "--name", "Demo"]);
    const file = join(dir, "copy.db");
    const r = await cli(["backup", file]);
    expect(r.code).toBe(0);
    const copy = new Store(openDb(file));
    expect(copy.listWorlds().map((w) => w.name)).toEqual(["Demo"]);
    copy.close();
    expect((await cli(["backup"])).code).toBe(2);
  });
});

describe("config", () => {
  it("defaults to loopback, ./data and port 8787", () => {
    const c = loadConfig({}, "/work");
    expect(c).toMatchObject({ dataDir: "/work/data", dbPath: "/work/data/worldforge.db", pluginsDir: "/work/plugins", port: 8787, host: "127.0.0.1" });
    expect(c.packsDir).toMatch(/packs$/);
  });

  it("reads the environment, and rejects a bad port", () => {
    const c = loadConfig({ WORLDFORGE_DATA: "d", PORT: "9000", WORLDFORGE_HOST: "0.0.0.0", WORLDFORGE_PACKS: "/p", WORLDFORGE_PLUGINS: "/x" }, "/w");
    expect(c).toMatchObject({ dataDir: "/w/d", port: 9000, host: "0.0.0.0", packsDir: "/p", pluginsDir: "/x" });
    expect(() => loadConfig({ PORT: "99999" })).toThrow(/Invalid port/);
    expect(() => loadConfig({ PORT: "abc" })).toThrow(/Invalid port/);
  });
});
