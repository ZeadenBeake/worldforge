import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildRegistry, parsePack, type Registry } from "@worldforge/core";
import { openDb } from "../src/db";
import { readPack } from "../src/packs";
import { HttpError, Store } from "../src/store";

export const PACKS_DIR = fileURLToPath(new URL("../../../packs", import.meta.url));
export const EXAMPLE_PACK_PATH = `${PACKS_DIR}/example-avian-humanoid.yaml`;

export const memStore = () => new Store(openDb(":memory:"));
export const examplePack = () => readPack(readFileSync(EXAMPLE_PACK_PATH, "utf8"));
export const exampleRegistry = (): Registry => buildRegistry([parsePack(readFileSync(EXAMPLE_PACK_PATH, "utf8"))]);

export function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  return v;
}

/** The error a callback throws, for asserting on status/code/details. */
export function thrown(fn: () => unknown): HttpError {
  try {
    fn();
  } catch (e) {
    if (e instanceof HttpError) return e;
    throw e;
  }
  throw new Error("expected the callback to throw an HttpError");
}
