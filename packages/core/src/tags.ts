import type { Req, Tag } from "./types";

/**
 * Tag grammar: `ns:name[.instance][=value]`.
 *
 * Matching rule (used for requires, removes and conflicts):
 *  - the pattern's name matches a tag's name if equal, or if the tag's name
 *    extends the pattern at a dot boundary (`part:arm` matches `part:arm.l`
 *    but not `part:armor`, and `part:arm.l` does not match `part:arm.r`);
 *  - if the pattern carries a `=value`, the tag must carry the same value;
 *    a pattern without a value matches any value.
 */
export function splitTag(tag: Tag): { name: string; value?: string } {
  const i = tag.indexOf("=");
  return i < 0 ? { name: tag } : { name: tag.slice(0, i), value: tag.slice(i + 1) };
}

export function tagMatches(pattern: Tag, tag: Tag): boolean {
  const p = splitTag(pattern);
  const t = splitTag(tag);
  if (p.value !== undefined && p.value !== t.value) return false;
  return t.name === p.name || t.name.startsWith(p.name + ".");
}

/** True if any tag in `tags` matches `pattern`. */
export function hasTag(tags: Iterable<Tag>, pattern: Tag): boolean {
  for (const t of tags) if (tagMatches(pattern, t)) return true;
  return false;
}

/**
 * Expand brace shorthand: `part:arm.{l,r}` -> [`part:arm.l`, `part:arm.r`].
 * Supports multiple groups. Used for `provides`, `removes` and `conflicts`
 * (not for `requires`, where an expansion would be ambiguous between AND/OR).
 */
export function expandTag(tag: Tag): Tag[] {
  const m = /\{([^{}]*)\}/.exec(tag);
  if (!m) return [tag];
  const head = tag.slice(0, m.index);
  const tail = tag.slice(m.index + m[0].length);
  const out: Tag[] = [];
  for (const alt of m[1]!.split(",")) {
    for (const rest of expandTag(tail)) out.push(head + alt.trim() + rest);
  }
  return out;
}

export function expandAll(tags: readonly Tag[] | undefined): Tag[] {
  return (tags ?? []).flatMap(expandTag);
}

/** Evaluate a requirement expression against a set of present tags. */
export function evalReq(req: Req, tags: Iterable<Tag>): boolean {
  const list = tags instanceof Set || Array.isArray(tags) ? (tags as Iterable<Tag>) : [...tags];
  return evalReqIn(req, list);
}

function evalReqIn(req: Req, tags: Iterable<Tag>): boolean {
  if (typeof req === "string") return hasTag(tags, req);
  if ("all" in req) return req.all.every((r) => evalReqIn(r, tags));
  if ("any" in req) return req.any.some((r) => evalReqIn(r, tags));
  return !evalReqIn(req.not, tags);
}

/** Evaluate an implicit-AND requirement list (the shape used on traits/conditions). */
export function evalReqs(reqs: readonly Req[] | undefined, tags: Iterable<Tag>): boolean {
  if (!reqs || reqs.length === 0) return true;
  const list = tags instanceof Set || Array.isArray(tags) ? tags : [...tags];
  return reqs.every((r) => evalReqIn(r, list));
}
