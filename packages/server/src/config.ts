import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

export interface Config {
  dataDir: string;
  dbPath: string;
  /** Packs shipped with the app. */
  packsDir: string;
  /** User exporter plugins (template files). */
  pluginsDir: string;
  port: number;
  /** Loopback by default: the tunnel (or you) decides what is exposed. */
  host: string;
}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env, cwd: string = process.cwd()): Config {
  const dataDir = resolve(cwd, env["WORLDFORGE_DATA"] ?? "data");
  const port = Number(env["PORT"] ?? env["WORLDFORGE_PORT"] ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid port "${env["PORT"] ?? env["WORLDFORGE_PORT"]}"`);
  return {
    dataDir,
    dbPath: join(dataDir, "worldforge.db"),
    packsDir: resolve(cwd, env["WORLDFORGE_PACKS"] ?? fileURLToPath(new URL("../../../packs", import.meta.url))),
    pluginsDir: resolve(cwd, env["WORLDFORGE_PLUGINS"] ?? "plugins"),
    port,
    host: env["WORLDFORGE_HOST"] ?? "127.0.0.1",
  };
}
