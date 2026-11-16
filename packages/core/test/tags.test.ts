import { describe, expect, it } from "vitest";
import { evalReq, evalReqs, expandTag, hasTag, tagMatches } from "../src";

describe("tagMatches", () => {
  it("matches exact tags", () => {
    expect(tagMatches("part:arm.l", "part:arm.l")).toBe(true);
  });
  it("bare pattern matches any instance", () => {
    expect(tagMatches("part:arm", "part:arm.l")).toBe(true);
    expect(tagMatches("part:arm", "part:arm.r")).toBe(true);
    expect(tagMatches("part:arm", "part:arm.2")).toBe(true);
  });
  it("matches only at a dot boundary", () => {
    expect(tagMatches("part:arm", "part:armor")).toBe(false);
    expect(tagMatches("part:arm", "part:armor.l")).toBe(false);
  });
  it("instance-specific patterns do not match siblings or the bare tag", () => {
    expect(tagMatches("part:arm.l", "part:arm.r")).toBe(false);
    expect(tagMatches("part:arm.l", "part:arm")).toBe(false);
  });
  it("values: pattern value must match; no pattern value matches any", () => {
    expect(tagMatches("axis:sex=male", "axis:sex=male")).toBe(true);
    expect(tagMatches("axis:sex=male", "axis:sex=female")).toBe(false);
    expect(tagMatches("axis:sex", "axis:sex=female")).toBe(true);
    expect(tagMatches("axis:sex=male", "axis:sex")).toBe(false);
  });
});

describe("expandTag", () => {
  it("expands one group", () => {
    expect(expandTag("part:arm.{l,r}")).toEqual(["part:arm.l", "part:arm.r"]);
  });
  it("expands multiple groups and trims", () => {
    expect(expandTag("a.{x, y}.{1,2}")).toEqual(["a.x.1", "a.x.2", "a.y.1", "a.y.2"]);
  });
  it("leaves plain tags alone", () => {
    expect(expandTag("part:head")).toEqual(["part:head"]);
  });
});

describe("evalReq", () => {
  const tags = new Set(["part:arm.l", "power:bioelectric"]);
  it("strings", () => {
    expect(evalReq("part:arm", tags)).toBe(true);
    expect(evalReq("part:wing", tags)).toBe(false);
  });
  it("all / any / not", () => {
    expect(evalReq({ all: ["part:arm", "power:bioelectric"] }, tags)).toBe(true);
    expect(evalReq({ all: ["part:arm", "part:wing"] }, tags)).toBe(false);
    expect(evalReq({ any: ["part:wing", "power:bioelectric"] }, tags)).toBe(true);
    expect(evalReq({ any: ["part:wing", "part:tail"] }, tags)).toBe(false);
    expect(evalReq({ not: "part:wing" }, tags)).toBe(true);
    expect(evalReq({ not: "part:arm" }, tags)).toBe(false);
  });
  it("empty all is true, empty any is false", () => {
    expect(evalReq({ all: [] }, tags)).toBe(true);
    expect(evalReq({ any: [] }, tags)).toBe(false);
  });
  it("requirement lists are an implicit AND; empty is true", () => {
    expect(evalReqs(["part:arm", "power:bioelectric"], tags)).toBe(true);
    expect(evalReqs(["part:arm", "part:wing"], tags)).toBe(false);
    expect(evalReqs([], tags)).toBe(true);
    expect(evalReqs(undefined, tags)).toBe(true);
  });
  it("hasTag works on arrays", () => {
    expect(hasTag(["part:arm.l"], "part:arm")).toBe(true);
  });
});
