import type { Registry } from "@worldforge/core";
import type { Store } from "./store";

/** Caches the resolver registry per world; a world's `rev` changes on every write. */
export class RegistryCache {
  private cache = new Map<string, { rev: number; reg: Registry }>();
  constructor(private store: Store) {}

  get(worldId: string): Registry {
    const world = this.store.getWorld(worldId);
    const hit = this.cache.get(worldId);
    if (hit && hit.rev === world.rev) return hit.reg;
    const reg = this.store.buildRegistry(worldId);
    this.cache.set(worldId, { rev: world.rev, reg });
    return reg;
  }
}
