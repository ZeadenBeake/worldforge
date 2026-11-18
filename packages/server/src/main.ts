import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { runCli } from "./cli";
import { loadConfig } from "./config";
import { openDb } from "./db";
import { createExporters } from "./exporters";
import { loadBundledPacks } from "./packs";
import { Store } from "./store";

function startServer(): void {
  const config = loadConfig();
  const store = new Store(openDb(config.dbPath));
  const exporters = createExporters(config.pluginsDir);
  const bundledPacks = loadBundledPacks(config.packsDir);
  for (const e of exporters.errors) console.warn(`exporter ${e.file}: ${e.message}`);

  const app = createApp({ store, exporters, bundledPacks });
  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    console.log(`worldforge listening on http://${info.address}:${info.port}`);
    console.log(`  data: ${config.dbPath}`);
    console.log(`  bundled packs: ${bundledPacks.map((p) => p.id).join(", ") || "(none)"}`);
    console.log(`  exporters: ${exporters.list().map((e) => e.id).join(", ")}`);
  });

  const shutdown = () => {
    server.close(() => {
      store.close(); // checkpoints the WAL so the database is one clean file
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const [command] = process.argv.slice(2);
if (command === undefined || command === "serve") {
  startServer();
} else {
  runCli(process.argv.slice(2), {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    env: process.env,
  }).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
