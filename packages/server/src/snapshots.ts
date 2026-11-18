import { buildSnapshot, type Individual, type Snapshot } from "@worldforge/core";
import type { RegistryCache } from "./registry";
import { HttpError, type Entity, type Store } from "./store";

/** The snapshot of a stored individual: resolved once, with its links and the names of whoever it links to. */
export function snapshotForEntity(store: Store, cache: RegistryCache, entity: Entity, now?: number): Snapshot {
  if (entity.kind !== "individual") throw new HttpError(404, "wrong_kind", `"${entity.id}" is a ${entity.kind}, not an individual`);
  const reg = cache.get(entity.world_id);
  const links = store.listLinks(entity.world_id, { entity: entity.id });
  const names: Record<string, string> = {};
  for (const l of links) for (const id of [l.from, l.to]) if (id !== entity.id && !(id in names)) names[id] = store.getEntity(id).name;
  return buildSnapshot(reg, {
    id: entity.id,
    individual: entity.body as unknown as Individual,
    links: links.map((l) => ({
      id: l.id, from: l.from, to: l.to, type: l.type,
      ...(l.feeling ? { feeling: l.feeling } : {}),
      ...(l.since !== undefined ? { since: l.since } : {}),
    })),
    names,
    now,
  });
}
