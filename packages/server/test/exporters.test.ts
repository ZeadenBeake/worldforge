import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSnapshot, type Individual, type Link } from "@worldforge/core";
import { describe, expect, it } from "vitest";
import { ExporterSet, createExporters, joinList, loadTemplateExporters, templateContext, templateExporter } from "../src/exporters";
import { exampleRegistry } from "./helpers";

const reg = exampleRegistry();
const ctx = { world: { id: "w", name: "World" } };

const genotype = {
  body_plan: "humanoid_body", wings: "feathered_wings", mouth: "beak", integument: "full_plumage",
  plumage_color: "slate", plumage_pattern: "barred", crest: "display_crest",
  bioelectric: "bioelectric_physiology", emp: "emp_pulse", flight: "winged_flight",
  reproduction_mode: "sexual_reproduction", gestation: "egg_laying",
};
const male: Individual = {
  species: "avian_humanoid", seed: "golden-male", name: "Kestrel", axis_values: { sex: "male" }, genotype,
  scalars: { lifespan: 60, height: 178, weight: 66 }, age: 31, conditions: [], culture: "grounded_culture", religions: ["skyward_faith"],
};
const female: Individual = {
  species: "avian_humanoid", seed: "golden-female", name: "Wren", axis_values: { sex: "female" },
  genotype: { ...genotype, plumage_color: "albino", discharge_tendency: "uncontrolled_discharge" },
  scalars: { lifespan: 55, height: 165, weight: 58 }, age: 44, culture: "grounded_culture",
  conditions: [
    { condition: "wing_loss_left", since: 10, note: "caught in a snare" },
    { condition: "damaged_capacitor", since: 20 },
    { condition: "cybernetic_power_cell", since: 30 },
  ],
  skills: [{ skill: "crafting", level: "competent", passion: "interested", focus: "feather work" }, { skill: "melee", level: "expert", passion: "burning", focus: "knives, close quarters" }],
  thoughts: [{ text: "I should never have gone back for the nest.", kind: "formative", since: 10 }, { text: "The market is loud today.", kind: "short", since: 40 }],
};
const links: Link[] = [{ from: "kestrel", to: "wren", type: "friend", feeling: "old friends", since: 5 }, { from: "wren", to: "pip", type: "parent", since: 12 }];

const snapOf = (i: Individual, id: string) => buildSnapshot(reg, { id, individual: i, links, names: { kestrel: "Kestrel", wren: "Wren", pip: "Pip" }, now: 40 });
const exporters = createExporters();
const render = (id: string, i: Individual, sid: string) => exporters.get(id)!.render(snapOf(i, sid), ctx, {}) as string;

describe("built-in exporters", () => {
  it("ships text-adventure and image-prompt, and loads without errors", () => {
    expect(exporters.list().map((e) => e.id)).toEqual(["image-prompt", "text-adventure"]);
    expect(exporters.errors).toEqual([]);
    expect(exporters.get("image-prompt")!.kind).toBe("image_prompt");
  });

  it("text adventure: a healthy male (golden)", async () => {
    await expect(render("text-adventure", male, "kestrel")).toMatchFileSnapshot("./golden/avian-male-healthy.text-adventure.txt");
  });

  it("text adventure: an injured albino female with skills, thoughts and relations (golden)", async () => {
    await expect(render("text-adventure", female, "wren")).toMatchFileSnapshot("./golden/avian-female-injured.text-adventure.txt");
  });

  it("image prompt: tags of what is expressed, once each", async () => {
    await expect(render("image-prompt", male, "kestrel")).toMatchFileSnapshot("./golden/avian-male-healthy.image-prompt.txt");
    const female_prompt = render("image-prompt", female, "wren").trim();
    expect(female_prompt).toContain("albino");
    expect(female_prompt).not.toContain("feather crest"); // latent in a female
    expect(female_prompt).not.toContain("stray sparks"); // flaw is latent without bioelectric power
    const tags = female_prompt.split(", ");
    expect(new Set(tags).size).toBe(tags.length);
  });
});

describe("what the text-adventure output says (behaviour, not just stability)", () => {
  const out = render("text-adventure", female, "wren");

  it("uses her name, species, age and life stage", () => {
    expect(out.split("\n")[0]).toBe("Wren");
    expect(out).toContain("Avian humanoid, 44 years old (adult).");
  });

  it("lists expressed features and keeps latent ones separate", () => {
    const [features, carried] = out.split("Carried, but not expressed:");
    expect(features).toContain("- a hooked beak in place of a mouth");
    expect(features).toContain("- pure white plumage and pale eyes with no pigment at all");
    expect(features).not.toContain("showy crest");
    expect(carried).toContain("- a showy crest of head feathers");
    expect(carried).toContain("occasionally discharges it into the ground");
  });

  it("explains the injuries, with notes, and uses her pronouns", () => {
    expect(out).toContain("- Left wing lost (part:wing.l) [caught in a snare]");
    expect(out).toContain("Height: 165 cm");
    expect(out).toContain("Weight: 58 kg");
    expect(out).not.toContain("lifespan"); // a species scalar, not a physical measurement
    expect(out).toContain("She tends to:");
  });

  it("phrases relations from her point of view", () => {
    expect(out).toContain("- Kestrel is friend of her (old friends)");
    expect(out).toContain("- She is parent of Pip");
  });

  it("flight is lost with the wing: listed as carried, not as a feature", () => {
    const [features, carried] = out.split("Carried, but not expressed:");
    expect(features).not.toContain("capable of flight");
    expect(carried).toContain("- capable of flight");
  });

  it("omits empty sections entirely", () => {
    const bare = render("text-adventure", { ...male, culture: undefined, religions: undefined }, "k");
    expect(bare).not.toContain("Conditions:");
    expect(bare).not.toContain("Skills:");
    expect(bare).not.toContain("Relationships:");
    expect(bare).not.toContain("Carried, but not expressed:");
  });

  it("an unnamed character falls back to the species", () => {
    const { name: _n, ...unnamed } = male;
    expect(render("text-adventure", unnamed as Individual, "k").split("\n")[0]).toBe("The avian humanoid");
  });
});

describe("templateContext", () => {
  const c = templateContext(snapOf(female, "wren"));

  it("capitalises pronouns and strips the part: prefix", () => {
    expect([c["subject"], c["Subject"], c["object"], c["possessive"]]).toEqual(["she", "She", "her", "her"]);
    expect(c["parts"]).toContain("wing.r");
    expect(c["parts"]).not.toContain("wing.l");
  });

  it("exposes scalars both as a map and a list", () => {
    expect((c["scalars"] as Record<string, { text: string }>)["height"]!.text).toBe("height 165 cm");
    expect((c["scalar_list"] as unknown[]).length).toBe(3);
  });

  it("rounds what people read, but the snapshot keeps full precision", () => {
    const messy = snapOf({ ...male, age: 21.13, scalars: { height: 163.98, weight: 72.22 } }, "k");
    const c2 = templateContext(messy);
    expect(c2["age"]).toBe(21);
    expect((c2["scalars"] as Record<string, { value: number }>)["height"]!.value).toBe(164);
    expect(messy.age).toBe(21.13);
    expect(messy.scalars["height"]!.value).toBe(163.98);
    expect(templateContext(snapOf({ ...male, age: 0.46 }, "k"))["age"]).toBe(0.5);
    expect(templateContext(snapOf({ ...male, age: 1.9 }, "k"))["age"]).toBe(1);
    expect(render("text-adventure", { ...male, age: 21.13, scalars: { height: 163.98 } }, "k")).toContain("Avian humanoid, 21 years old (adult).\nHeight: 164 cm");
  });

  it("shows a child at its current size, and still exposes the adult size", () => {
    const child = { ...male, age: 0, scalars: { lifespan: 60, height: 180, weight: 75 } };
    const text = render("text-adventure", child, "k");
    expect(text).toContain("Height: 45 cm");
    expect(text).toContain("Weight: 3 kg");
    expect(text).toContain("0 years old (fledgling)");
    const c3 = templateContext(snapOf(child, "k"));
    expect((c3["scalars"] as Record<string, { value: number; adult_value: number }>)["height"]).toMatchObject({ value: 45, adult_value: 180 });
    // an adult's two values coincide
    expect((templateContext(snapOf(male, "k"))["scalars"] as Record<string, { value: number; adult_value: number }>)["height"]).toMatchObject({ value: 178, adult_value: 178 });
  });

  it("separates active from dormant conditions", () => {
    const conds = templateContext(snapOf({ ...female, conditions: [{ condition: "wing_loss_left", since: 1 }, { condition: "wing_loss_left", since: 2 }] }, "w"));
    expect((conds["conditions"] as unknown[]).length).toBe(1);
    expect((conds["dormant_conditions"] as { reason: string }[])[0]!.reason).toBe("target_missing");
  });

  it("surfaces dropped behaviors with what they would have been", () => {
    const dropped = templateContext(snapOf({ ...male, behavior_overrides: [{ item: "shuns_heights", action: "drop", note: "raised abroad" }] }, "k"));
    expect(dropped["dropped_behaviors"]).toEqual([{ label: "Shuns heights", note: "raised abroad", would_have_been: "active" }]);
  });

  it("joinList uses an Oxford comma", () => {
    expect([joinList([]), joinList(["a"]), joinList(["a", "b"]), joinList(["a", "b", "c"])]).toEqual(["", "a", "a and b", "a, b, and c"]);
  });
});

describe("template exporters and plugins", () => {
  const sample = { id: "mine", name: "Mine", template: "{{name}} is {{age}}" };

  it("render a template over the snapshot, with sensible defaults", () => {
    const e = templateExporter(sample);
    expect([e.kind, e.content_type]).toEqual(["prose", "text/plain"]);
    expect(e.render(snapOf(male, "k"), ctx, {})).toBe("Kestrel is 31");
  });

  it("reject bad ids, empty templates and broken templates at load time", () => {
    expect(() => templateExporter({ ...sample, id: "Bad Id" })).toThrow();
    expect(() => templateExporter({ ...sample, template: "" })).toThrow();
    expect(() => templateExporter({ ...sample, template: "{{#x}}" })).toThrow(/Unclosed/);
  });

  it("load plugin files from a directory, reporting bad ones without stopping", () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-plugins-"));
    try {
      writeFileSync(join(dir, "mine.exporter.yaml"), "id: mine\nname: Mine\ntemplate: '{{name}}'\n");
      writeFileSync(join(dir, "broken.exporter.yaml"), "id: broken\nname: B\ntemplate: '{{#x}}'\n");
      writeFileSync(join(dir, "badid.exporter.yaml"), "id: Not Valid\nname: B\ntemplate: x\n");
      writeFileSync(join(dir, "notyaml.exporter.yaml"), "id: [unclosed\n");
      writeFileSync(join(dir, "readme.txt"), "ignored");
      const r = loadTemplateExporters(dir);
      expect(r.exporters.map((e) => e.id)).toEqual(["mine"]);
      expect(r.errors.map((e) => e.file).sort()).toEqual(["badid.exporter.yaml", "broken.exporter.yaml", "notyaml.exporter.yaml"]);
      expect(r.errors.find((e) => e.file === "broken.exporter.yaml")!.message).toMatch(/Unclosed/);

      const set = createExporters(dir);
      expect(set.get("mine")).toBeDefined();
      expect(set.get("text-adventure")).toBeDefined();
      expect(set.errors.length).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a plugin cannot replace a built-in", () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-plugins-"));
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "evil.exporter.yaml"), "id: text-adventure\nname: Evil\ntemplate: 'pwned'\n");
      const set = createExporters(dir);
      expect(set.get("text-adventure")!.name).toBe("Text adventure");
      expect(set.errors[0]!.message).toMatch(/Duplicate exporter id/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a missing plugins directory is fine", () => {
    expect(createExporters("/no/such/dir").errors).toEqual([]);
    expect(new ExporterSet().list()).toEqual([]);
  });

  it("a template cannot reach beyond the data it is given", () => {
    const e = templateExporter({ id: "probe", name: "p", template: "{{process}}|{{require}}|{{__proto__}}|{{constructor}}" });
    expect(e.render(snapOf(male, "k"), ctx, {})).toBe("|||");
  });
});
