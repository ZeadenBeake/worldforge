# Worldforge (working title)

A self-hosted, non-linear **character and species workshop**. Build species from
composable traits, sample individuals from them, breed them, layer on behavior,
conditions, skills and relationships, then **export** the result (prose today;
SillyTavern cards, image prompts and a 3D doll later).

Structured data is the source of truth; prose and images are derived exports.
There are no game mechanics in the core: rules systems come later as mapping packs.

## Try it

Requires Node 22+.

```sh
npm install

# 1. make a world and install the bundled example species
npm run worldforge -- seed --name "My world"

# 2. roll someone and read them
npm run worldforge -- roll avian_humanoid --name Kestrel --save

# 3. or run the HTTP API
npm start            # http://127.0.0.1:8787
```

```sh
curl -s localhost:8787/api/worlds                       # find your world id
curl -s localhost:8787/api/worlds/$W/entities?kind=species
curl -s -X POST localhost:8787/api/species/$SPECIES/roll \
     -H 'content-type: application/json' -d '{"seed":"demo","name":"Wren","save":true}'
curl -s localhost:8787/api/individuals/$ID/export/text-adventure
```

Other CLI commands: `worlds`, `export <individual>`, `backup <file>`, `help`.

## How it fits together

```
packs/                  shipped packs (the example avian humanoid species)
packages/core/          the resolver: pure TypeScript, runs in Node and the browser
packages/server/        SQLite store, REST API, exporters, CLI (embeds core)
fixtures/golden/        reference snapshots used by the tests
docs/spec-changes.md    every decision that differs from, or extends, the original spec
```

**core** is the heart and has no I/O: tags (`part:arm.l`, requires/provides/conflicts),
seeded sampling, genotype-to-phenotype expression with ordered condition layers,
behavior resolution, breeding, and the frozen **snapshot** that exporters consume.
Everything is deterministic given a seed and heavily tested (including property
tests and mutation checks).

**server** stores worlds in a single SQLite file. Every write goes through one
transactional edit path (validate, check references, log, search-index), which gives
dry runs, an edit log and undo. Entities reference each other by `key`; deleting
something still in use is refused with a list of who uses it.

### Packs and content

A pack is a YAML/JSON bundle of slots, traits, conditions, behaviors, skills and
species. Installing **copies** it into a world. The install flow shows the pack's
description and `content_warnings` and requires an explicit confirm; there is no
other content gating. The shipped example carries no warnings.

### Exporters

An exporter is a pure consumer of the snapshot. Two ship built in
(`text-adventure`, `image-prompt`), and both are just template files. Add your own by
dropping `*.exporter.yaml` into `plugins/`:

```yaml
id: one-liner
name: One liner
template: "{{name}}: {{species}}, {{age}} years old"
```

Templates are a logic-less Mustache subset (`{{x}}`, `{{#list}}...{{/list}}`,
`{{^x}}`): no code, helpers or partials, so a template from a pack cannot run anything.

### Configuration

| Variable | Default | |
|---|---|---|
| `PORT` | `8787` | |
| `WORLDFORGE_HOST` | `127.0.0.1` | loopback only; expose it through your tunnel |
| `WORLDFORGE_DATA` | `./data` | holds `worldforge.db`, one file |
| `WORLDFORGE_PLUGINS` | `./plugins` | exporter plugins |
| `WORLDFORGE_PACKS` | `./packs` | bundled packs |

There is **no application-level auth**: run it behind something that provides it
(for example Cloudflare Access) or leave it on loopback.

## API

| | |
|---|---|
| `GET/POST /api/worlds`, `GET/PATCH/DELETE /api/worlds/:w` | worlds and their settings |
| `GET/POST /api/worlds/:w/entities`, `GET/PUT/PATCH/DELETE /api/entities/:id` | entities (`?kind=&q=`) |
| `GET /api/entities/:id/used-by` | what still references this |
| `POST /api/worlds/:w/edits` | batch of create/update/delete, `dryRun` supported |
| `POST /api/edits/:id/undo` | undo the newest edit of an entity |
| `POST /api/species/:id/roll` | `{seed?, locks?, name?, save?}` |
| `POST /api/individuals/breed` | `{parents[], seed?, mutation?, off_species?, locks?, age?, save?}` |
| `GET /api/individuals/:id/snapshot` | the resolved view (`?now=` expires thoughts) |
| `GET /api/individuals/:id/export/:exporter` | `?format=json` for an envelope |
| `GET /api/worlds/:w/warnings` | registry and per-individual warnings |
| `GET /api/packs/bundled`, `POST /api/worlds/:w/packs[/preview\|/export]` | packs |
| `GET /api/exporters` | what is installed (and any plugin that failed to load) |

Errors are always `{ "error": { "code", "message", "details"? } }`.

## Development

```sh
npm test            # core + server
npm run typecheck
```

## Status

Done: the resolver (`core`), storage, API, packs, edit log/undo, template exporters, CLI.
Not yet: the web UI (species/individual editors, warnings panel), the 3D doll,
LLM drafting and the SillyTavern/image exporters, a production build (the CLI
currently runs through `tsx`), and rules-sheet mapping packs.

License: Unlicense.
