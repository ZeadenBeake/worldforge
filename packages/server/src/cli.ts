import { parseArgs } from "node:util";
import { buildSnapshot, rollIndividual, type Individual } from "@worldforge/core";
import { loadConfig } from "./config";
import { openDb } from "./db";
import { createExporters } from "./exporters";
import { installPack, loadBundledPacks } from "./packs";
import { RegistryCache } from "./registry";
import { snapshotForEntity } from "./snapshots";
import { HttpError, Store, type Entity, type World } from "./store";

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
  env: Record<string, string | undefined>;
  cwd?: string;
}

export const HELP = `worldforge: a character and species workshop

Usage: worldforge <command> [options]

  serve                          Start the HTTP server (default). PORT, WORLDFORGE_HOST
  worlds                         List worlds
  seed [--name N] [--world W] [--pack ID]... [--yes]
                                 Create a world (or use --world) and install bundled packs
                                 (all of them unless --pack is given). Packs that carry
                                 content warnings need --yes.
  roll <species-key> [--world W] [--seed S] [--name N] [--exporter ID] [--save] [--format json]
                                 Roll an individual and print it (default exporter: text-adventure)
  export <individual> [--world W] [--exporter ID] [--format json]
                                 Print a stored individual (id or key) through an exporter
  backup <file>                  Write a consistent copy of the database to <file>
  help                           This text

Environment: WORLDFORGE_DATA (default ./data), WORLDFORGE_PACKS, WORLDFORGE_PLUGINS, PORT.
`;

class UsageError extends Error {}

function pickWorld(store: Store, ref: string | undefined): World {
  const worlds = store.listWorlds();
  if (ref) {
    const hit = worlds.find((w) => w.id === ref) ?? worlds.find((w) => w.name === ref);
    if (!hit) throw new UsageError(`No world "${ref}". Worlds: ${worlds.map((w) => w.name).join(", ") || "(none; run `worldforge seed`)"}`);
    return hit;
  }
  if (worlds.length === 1) return worlds[0]!;
  if (worlds.length === 0) throw new UsageError("There are no worlds yet. Run `worldforge seed` first.");
  throw new UsageError(`Several worlds exist; choose one with --world (${worlds.map((w) => `${w.name} [${w.id}]`).join(", ")})`);
}

function findEntity(store: Store, worldId: string, kind: "species" | "individual", ref: string): Entity {
  const byKey = store.findByKey(worldId, kind, ref);
  if (byKey) return byKey;
  try {
    const e = store.getEntity(ref);
    if (e.world_id === worldId && e.kind === kind) return e;
  } catch {
    /* fall through */
  }
  const keys = store.listEntities(worldId, { kind, limit: 20 }).items.map((e) => e.key);
  throw new UsageError(`No ${kind} "${ref}" in this world.${keys.length ? ` Try: ${keys.join(", ")}` : ""}`);
}

/** Run a non-serving command. Returns the process exit code. */
export async function runCli(argv: string[], io: CliIO): Promise<number> {
  const [command = "help", ...rest] = argv;
  if (command === "help" || command === "--help" || command === "-h") {
    io.out(HELP);
    return 0;
  }
  let store: Store | undefined;
  try {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        world: { type: "string" }, seed: { type: "string" }, name: { type: "string" }, exporter: { type: "string" },
        pack: { type: "string", multiple: true }, format: { type: "string" }, save: { type: "boolean" }, yes: { type: "boolean" },
      },
    });
    const config = loadConfig(io.env, io.cwd);
    store = new Store(openDb(config.dbPath));
    const exporters = createExporters(config.pluginsDir);
    const cache = new RegistryCache(store);
    const exporterFor = (id: string | undefined) => {
      const e = exporters.get(id ?? "text-adventure");
      if (!e) throw new UsageError(`No exporter "${id}". Available: ${exporters.list().map((x) => x.id).join(", ")}`);
      return e;
    };
    const wantJson = values.format === "json";
    if (values.format !== undefined && !wantJson) throw new UsageError(`--format must be "json" (or omitted)`);

    switch (command) {
      case "worlds": {
        for (const w of store.listWorlds()) io.out(`${w.id}  ${w.name}  (${store.listEntities(w.id, { limit: 1 }).total} entities)\n`);
        return 0;
      }

      case "seed": {
        const bundled = loadBundledPacks(config.packsDir);
        const wanted = values.pack?.length ? values.pack : bundled.map((p) => p.id);
        const packs = wanted.map((id) => {
          const hit = bundled.find((p) => p.id === id);
          if (!hit) throw new UsageError(`No bundled pack "${id}". Available: ${bundled.map((p) => p.id).join(", ") || "(none)"}`);
          return hit.pack;
        });
        if (packs.length === 0) throw new UsageError(`No packs found in ${config.packsDir}`);
        const world = values.world ? pickWorld(store, values.world) : undefined;
        // Show what is about to be installed and require explicit consent for anything with content warnings.
        for (const pack of packs) {
          const m = pack.manifest;
          io.out(`${m.name} ${m.version}${m.author ? ` by ${m.author}` : ""}\n`);
          if (m.description) io.out(`  ${m.description}\n`);
          io.out(m.content_warnings.length ? `  Content warnings: ${m.content_warnings.join(", ")}\n` : "  Content warnings: none\n");
        }
        if (packs.some((p) => p.manifest.content_warnings.length > 0) && !values.yes) {
          io.err("These packs carry content warnings. Re-run with --yes to install them.\n");
          return 2;
        }
        const w = world ?? store.createWorld(values.name ?? "My world");
        for (const pack of packs) {
          const r = installPack(store, w.id, pack, { confirm: true, on_conflict: world ? "skip" : "abort" });
          io.out(`Installed ${pack.manifest.id}: ${r.created} created, ${r.skipped} skipped.\n`);
        }
        io.out(`World "${w.name}" is ready: ${w.id}\n`);
        return 0;
      }

      case "roll": {
        const ref = positionals[0];
        if (!ref) throw new UsageError("Usage: worldforge roll <species-key> [options]");
        const world = pickWorld(store, values.world);
        const species = findEntity(store, world.id, "species", ref);
        const exporter = exporterFor(values.exporter);
        const reg = cache.get(world.id);
        const seed = values.seed ?? Math.random().toString(16).slice(2, 14).padEnd(12, "0");
        const { individual, warnings } = rollIndividual(species.key, reg, { seed });
        const rolled: Individual = values.name ? { ...individual, name: values.name } : individual;
        for (const w of warnings) io.err(`warning: ${w.message}\n`);
        let id: string | undefined;
        if (values.save) {
          const saved = store.apply(world.id, [{ op: "create", kind: "individual", body: rolled }], { note: `rolled from ${species.key}` }).changes[0]!.after!;
          id = saved.id;
          io.err(`saved: ${saved.id} (${saved.key})\n`);
        }
        if (wantJson) {
          io.out(JSON.stringify({ individual: rolled, warnings, ...(id ? { id } : {}) }, null, 2) + "\n");
        } else {
          const snapshot = buildSnapshot(reg, { ...(id ? { id } : {}), individual: rolled });
          io.out((await exporter.render(snapshot, { world: { id: world.id, name: world.name } }, {})).replace(/\n*$/, "\n"));
        }
        return 0;
      }

      case "export": {
        const ref = positionals[0];
        if (!ref) throw new UsageError("Usage: worldforge export <individual> [options]");
        const world = pickWorld(store, values.world);
        const entity = findEntity(store, world.id, "individual", ref);
        const exporter = exporterFor(values.exporter);
        const snapshot = snapshotForEntity(store, cache, entity);
        io.out(wantJson ? JSON.stringify(snapshot, null, 2) + "\n" : (await exporter.render(snapshot, { world: { id: world.id, name: world.name } }, {})).replace(/\n*$/, "\n"));
        return 0;
      }

      case "backup": {
        const file = positionals[0];
        if (!file) throw new UsageError("Usage: worldforge backup <file>");
        store.backup(file);
        io.out(`Backed up to ${file}\n`);
        return 0;
      }

      default:
        throw new UsageError(`Unknown command "${command}". Run \`worldforge help\`.`);
    }
  } catch (e) {
    if (e instanceof UsageError || (e as { code?: string }).code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" || (e as { code?: string }).code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
      io.err(`${(e as Error).message}\n`);
      return 2;
    }
    if (e instanceof HttpError) {
      io.err(`error: ${e.message}\n`);
      return 1;
    }
    throw e;
  } finally {
    store?.close();
  }
}
