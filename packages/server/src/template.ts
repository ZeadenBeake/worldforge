/**
 * A small logic-less template language (a Mustache subset) for exporters.
 * Templates can come from packs and plugins, so they must never run code:
 * there are no helpers, no partials, no expressions, and lookups only follow
 * own properties of the data (never `__proto__`/`constructor`).
 *
 *   {{name}}            value (dotted paths ok: {{pronouns.subject}}); missing -> empty
 *   {{.}}               the current item inside a section
 *   {{#list}}..{{/list}} repeat for arrays; render once for objects/strings/true; skip if empty/false
 *   {{^list}}..{{/list}} render only if empty/false/missing
 *   {{! comment }}
 *
 * A section/comment tag alone on its line removes that whole line, so
 * templates stay readable.
 */
export class TemplateError extends Error {
  constructor(
    message: string,
    public line: number,
  ) {
    super(`${message} (line ${line})`);
  }
}

type Node =
  | { t: "text"; v: string }
  | { t: "var"; name: string; line: number }
  | { t: "sec"; name: string; inverted: boolean; children: Node[]; line: number };

const TAG = /\{\{\s*([#^/!]?)\s*([^{}]*?)\s*\}\}/g;
const NAME = /^(\.|[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*)$/;
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);
const MAX_OUTPUT = 1_000_000;
const MAX_TEMPLATE = 200_000;

const lineOf = (src: string, index: number) => src.slice(0, index).split("\n").length;

export function parseTemplate(src: string): Node[] {
  if (src.length > MAX_TEMPLATE) throw new TemplateError("Template is too large", 1);
  const bad = src.indexOf("{{{");
  if (bad >= 0) throw new TemplateError("Triple braces are not supported", lineOf(src, bad));

  const root: Node[] = [];
  const stack: { name: string; inverted: boolean; children: Node[]; line: number }[] = [];
  const top = () => (stack.length ? stack[stack.length - 1]!.children : root);
  let cursor = 0;

  for (const m of src.matchAll(TAG)) {
    const [whole, sigil = "", rawName = ""] = m;
    const start = m.index!;
    const end = start + whole.length;
    const line = lineOf(src, start);
    const isBlock = sigil !== "";

    // Standalone block tag: nothing but whitespace around it on its line.
    let textEnd = start;
    let next = end;
    if (isBlock) {
      const ls = src.lastIndexOf("\n", start - 1) + 1;
      const le = src.indexOf("\n", end);
      const prefix = src.slice(ls, start);
      const suffix = src.slice(end, le < 0 ? src.length : le);
      if (/^[ \t]*$/.test(prefix) && /^[ \t\r]*$/.test(suffix) && ls >= cursor) {
        textEnd = ls;
        next = le < 0 ? src.length : le + 1;
      }
    }
    if (textEnd > cursor) top().push({ t: "text", v: src.slice(cursor, textEnd) });
    cursor = next;

    if (sigil === "!") continue;
    if (!NAME.test(rawName)) throw new TemplateError(`Invalid tag name "${rawName}"`, line);
    if (sigil === "") {
      top().push({ t: "var", name: rawName, line });
    } else if (sigil === "#" || sigil === "^") {
      stack.push({ name: rawName, inverted: sigil === "^", children: [], line });
    } else {
      const open = stack.pop();
      if (!open) throw new TemplateError(`Unexpected closing tag {{/${rawName}}}`, line);
      if (open.name !== rawName) throw new TemplateError(`Closing tag {{/${rawName}}} does not match {{#${open.name}}} from line ${open.line}`, line);
      top().push({ t: "sec", name: open.name, inverted: open.inverted, children: open.children, line: open.line });
    }
  }
  if (stack.length) {
    const open = stack[stack.length - 1]!;
    throw new TemplateError(`Unclosed section {{#${open.name}}}`, open.line);
  }
  if (cursor < src.length) top().push({ t: "text", v: src.slice(cursor) });
  return root;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function lookup(stack: unknown[], name: string): unknown {
  if (name === ".") return stack[stack.length - 1];
  const [head, ...rest] = name.split(".") as [string, ...string[]];
  if (FORBIDDEN.has(head)) return undefined;
  let found: unknown;
  let ok = false;
  for (let i = stack.length - 1; i >= 0; i--) {
    const c = stack[i];
    if (isObj(c) && Object.hasOwn(c, head)) {
      found = c[head];
      ok = true;
      break;
    }
  }
  if (!ok) return undefined;
  for (const seg of rest) {
    if (FORBIDDEN.has(seg) || !isObj(found) || !Object.hasOwn(found, seg)) return undefined;
    found = found[seg];
  }
  return found;
}

const falsy = (v: unknown) => v === undefined || v === null || v === false || v === 0 || v === "" || (Array.isArray(v) && v.length === 0);

function show(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" ? String(v) : "";
}

function renderNodes(nodes: Node[], stack: unknown[], out: { s: string }): void {
  for (const n of nodes) {
    if (n.t === "text") out.s += n.v;
    else if (n.t === "var") out.s += show(lookup(stack, n.name));
    else {
      const v = lookup(stack, n.name);
      if (n.inverted) {
        if (falsy(v)) renderNodes(n.children, stack, out);
      } else if (!falsy(v)) {
        if (Array.isArray(v)) for (const item of v) renderNodes(n.children, [...stack, item], out);
        else renderNodes(n.children, v === true ? stack : [...stack, v], out);
      }
    }
    if (out.s.length > MAX_OUTPUT) throw new TemplateError("Output is too large", 1);
  }
}

export function renderTemplate(template: string | ReturnType<typeof parseTemplate>, context: unknown): string {
  const nodes = typeof template === "string" ? parseTemplate(template) : template;
  const out = { s: "" };
  renderNodes(nodes, [context], out);
  return out.s;
}
