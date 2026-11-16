import { describe, expect, it } from "vitest";
import { buildRegistry, parsePack, validateRegistry } from "../src";
import type { Pack } from "../src";
import { fixtureRegistry } from "./helpers";

describe("packs", () => {
  it("the avian fixture loads and validates with no warnings", () => {
    expect(validateRegistry(fixtureRegistry())).toEqual([]);
  });

  it("requires a manifest with id, name and version", () => {
    expect(() => parsePack("slots: []")).toThrow(/manifest/);
    expect(() => parsePack("manifest: { id: x, name: y }")).toThrow(/manifest/);
  });

  it("defaults content_warnings to an empty list", () => {
    expect(parsePack("manifest: { id: x, name: y, version: '1' }").manifest.content_warnings).toEqual([]);
  });

  it("rejects duplicate ids across packs", () => {
    const p = (id: string): Pack => ({
      manifest: { id, name: id, version: "1", content_warnings: [] },
      slots: [{ id: "s", name: "s" }],
    });
    expect(() => buildRegistry([p("a"), p("b")])).toThrow(/Duplicate slot id "s"/);
  });

  it("reports dangling references as warnings", () => {
    const reg = fixtureRegistry();
    reg.species["avian_humanoid"]!.pools["wings"]!.push({ trait: "ghost", chance: "common" });
    reg.species["avian_humanoid"]!.pools["mouth"]!.push({ trait: "slate", chance: "common" });
    reg.species["avian_humanoid"]!.instincts = "nope";
    reg.traits["beak"]!.slot = "mystery";
    const codes = validateRegistry(reg).map((w) => w.code);
    expect(codes).toEqual(expect.arrayContaining(["unknown_trait", "slot_mismatch", "unknown_behavior_set", "unknown_slot"]));
  });

  it("reports duplicate behavior item ids and unknown strengths", () => {
    const reg = fixtureRegistry();
    reg.behaviors["grounded_culture"]!.items.push({ ...reg.behaviors["avian_instincts"]!.items[0]!, strength: "overwhelming" });
    const codes = validateRegistry(reg).map((w) => w.code);
    expect(codes).toEqual(expect.arrayContaining(["duplicate_behavior_item", "unknown_ordinal"]));
  });

  it("reports unknown ordinal labels", () => {
    const reg = fixtureRegistry();
    reg.species["avian_humanoid"]!.pools["wings"]![0]!.chance = "sometimes";
    expect(validateRegistry(reg).map((w) => w.code)).toContain("unknown_ordinal");
  });
});
