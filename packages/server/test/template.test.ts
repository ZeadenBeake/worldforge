import { describe, expect, it } from "vitest";
import { TemplateError, parseTemplate, renderTemplate } from "../src/template";

const r = (t: string, ctx: unknown) => renderTemplate(t, ctx);

describe("variables", () => {
  it("substitutes, supports dotted paths, and renders missing values as empty", () => {
    expect(r("Hi {{name}}!", { name: "Wren" })).toBe("Hi Wren!");
    expect(r("{{a.b.c}}", { a: { b: { c: 7 } } })).toBe("7");
    expect(r("[{{missing}}][{{a.nope.x}}]", { a: {} })).toBe("[][]");
    expect(r("{{n}} {{t}} {{f}}", { n: 0, t: true, f: false })).toBe("0 true false");
  });

  it("does not HTML-escape (output is text)", () => {
    expect(r("{{x}}", { x: "<b>&\"'" })).toBe("<b>&\"'");
  });

  it("renders null, objects and arrays as empty rather than [object Object]", () => {
    expect(r("[{{a}}][{{b}}][{{c}}]", { a: null, b: { x: 1 }, c: [1, 2] })).toBe("[][][]");
  });

  it("tolerates whitespace inside tags", () => {
    expect(r("{{  name  }}", { name: "x" })).toBe("x");
  });

  it("does not re-parse substituted data", () => {
    expect(r("{{x}}", { x: "{{y}}", y: "no" })).toBe("{{y}}");
  });
});

describe("sections", () => {
  it("repeats for arrays, with {{.}} for scalars and fields for objects", () => {
    expect(r("{{#xs}}[{{.}}]{{/xs}}", { xs: ["a", "b"] })).toBe("[a][b]");
    expect(r("{{#xs}}{{n}},{{/xs}}", { xs: [{ n: 1 }, { n: 2 }] })).toBe("1,2,");
  });

  it("skips falsy and empty values; renders once for truthy scalars and objects", () => {
    for (const falsyValue of [false, null, 0, "", [], undefined]) expect(r("{{#x}}yes{{/x}}", { x: falsyValue })).toBe("");
    expect(r("{{#x}}yes{{/x}}", { x: true })).toBe("yes");
    expect(r("{{#x}}{{.}}{{/x}}", { x: "str" })).toBe("str");
    expect(r("{{#x}}{{k}}{{/x}}", { x: { k: "v" } })).toBe("v");
  });

  it("inverted sections render only when empty or missing", () => {
    expect(r("{{^x}}none{{/x}}", { x: [] })).toBe("none");
    expect(r("{{^x}}none{{/x}}", {})).toBe("none");
    expect(r("{{^x}}none{{/x}}", { x: [1] })).toBe("");
    expect(r("{{^x}}none{{/x}}", { x: "set" })).toBe("");
  });

  it("looks names up through enclosing scopes", () => {
    expect(r("{{#items}}{{prefix}}{{.}} {{/items}}", { prefix: "#", items: ["a", "b"] })).toBe("#a #b ");
    expect(r("{{#a}}{{#b}}{{x}}{{y}}{{/b}}{{/a}}", { a: { x: 1, b: { y: 2 } } })).toBe("12");
  });

  it("a `true` section keeps the current scope", () => {
    expect(r("{{#flag}}{{name}}{{/flag}}", { flag: true, name: "n" })).toBe("n");
  });
});

describe("standalone lines", () => {
  it("removes lines that hold only a section or comment tag", () => {
    const t = "A\n{{#xs}}\n- {{.}}\n{{/xs}}\nB\n{{! note }}\nC\n";
    expect(r(t, { xs: [1, 2] })).toBe("A\n- 1\n- 2\nB\nC\n");
    expect(r(t, { xs: [] })).toBe("A\nB\nC\n");
  });

  it("tolerates indentation and CRLF around standalone tags", () => {
    expect(r("a\r\n  {{#x}}  \r\nb\r\n  {{/x}}\r\nc", { x: true })).toBe("a\r\nb\r\nc");
  });

  it("keeps inline sections inline", () => {
    expect(r("a{{#x}}b{{/x}}c\n", { x: true })).toBe("abc\n");
    expect(r("a{{#x}}b{{/x}}c\n", { x: false })).toBe("ac\n");
  });

  it("does not strip lines for plain variables", () => {
    expect(r("a\n{{v}}\nb", { v: "" })).toBe("a\n\nb");
  });

  it("handles a tag at the very start and very end", () => {
    expect(r("{{#x}}\nhi\n{{/x}}", { x: true })).toBe("hi\n");
    expect(r("{{#x}}hi{{/x}}", { x: true })).toBe("hi");
  });
});

describe("safety", () => {
  it("never follows prototype properties", () => {
    expect(r("{{__proto__}}|{{constructor}}|{{a.constructor}}|{{toString}}", { a: {} })).toBe("|||");
    expect(r("{{#constructor}}x{{/constructor}}", {})).toBe("");
    expect(r("{{length}}", [] as unknown)).toBe("");
  });

  it("ignores an own `__proto__`/`constructor` key even when JSON-parsed data carries one", () => {
    const hostile = JSON.parse('{"__proto__": {"x": "leak"}, "constructor": {"y": "leak"}, "ok": "fine"}');
    expect(Object.hasOwn(hostile, "__proto__")).toBe(true); // JSON.parse creates it as an own property
    expect(r("{{ok}}|{{__proto__.x}}|{{constructor.y}}|{{#__proto__}}leak{{/__proto__}}", hostile)).toBe("fine|||");
    const nested = { a: JSON.parse('{"__proto__": {"x": "leak"}}') };
    expect(r("{{a.__proto__.x}}", nested)).toBe("");
  });

  it("only sees own properties", () => {
    const proto = { inherited: "no" };
    const obj = Object.create(proto) as Record<string, unknown>;
    obj["own"] = "yes";
    expect(r("{{own}}{{inherited}}", obj)).toBe("yes");
  });

  it("caps the output size", () => {
    const big = Array.from({ length: 2000 }, () => "x".repeat(1000));
    expect(() => r("{{#a}}{{#b}}{{.}}{{/b}}{{/a}}", { a: [1, 2], b: big })).toThrow(/too large/);
  });

  it("rejects oversized templates", () => {
    expect(() => parseTemplate("x".repeat(300_000))).toThrow(TemplateError);
  });
});

describe("errors", () => {
  const err = (t: string) => {
    try {
      parseTemplate(t);
    } catch (e) {
      return e as TemplateError;
    }
    throw new Error("expected a TemplateError");
  };

  it("reports unclosed, unexpected and mismatched tags with line numbers", () => {
    expect(err("a\n{{#x}}\nb")).toMatchObject({ line: 2 });
    expect(err("a\n{{#x}}\nb")).toBeInstanceOf(TemplateError);
    expect(err("{{/x}}").message).toMatch(/Unexpected closing tag/);
    expect(err("{{#a}}\n{{/b}}").message).toMatch(/does not match/);
  });

  it("rejects unsupported syntax explicitly (partials, triple braces, expressions)", () => {
    expect(err("{{> partial}}").message).toMatch(/Invalid tag name/);
    expect(err("{{{x}}}").message).toMatch(/Triple braces/);
    expect(err("{{a + b}}").message).toMatch(/Invalid tag name/);
    expect(err("{{ foo() }}").message).toMatch(/Invalid tag name/);
    expect(err("{{&x}}").message).toMatch(/Invalid tag name/);
  });

  it("a parsed template can be rendered repeatedly", () => {
    const t = parseTemplate("{{x}}");
    expect(renderTemplate(t, { x: 1 }) + renderTemplate(t, { x: 2 })).toBe("12");
  });
});
