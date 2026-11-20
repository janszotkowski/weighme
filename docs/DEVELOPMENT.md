# Development

How to run weighme on your own computer, how the repository is laid out, and the commands to check a change. Code style, tests and common changes are in [CONTRIBUTING.md](../CONTRIBUTING.md); the design is in [Architecture](ARCHITECTURE.md); every setting is in [Configuration](CONFIGURATION.md).

Contents: [Getting started](#getting-started) · [Repository layout](#repository-layout) · [Commands](#commands)

## Getting started

You need **Node 24.22.3** (see `.node-version`), **pnpm 12** (the exact version is pinned in `package.json` and fetched automatically) and **Docker**.

```bash
git clone https://github.com/janszotkowski/weighme.git
cd weighme
pnpm install
pnpm dev
```

`pnpm dev` creates the local `.env` files from the examples when they are missing (and never changes existing ones), starts the worker in Docker, and then the API and the frontend with reload.

| What    | Address                         |
| ------- | ------------------------------- |
| Web app | http://localhost:3100           |
| API     | http://127.0.0.1:4100/v1/health |

The worker stays idle until you look up a package, and then downloads that package and its dependencies from npm without running any of their scripts. They stay on a Docker volume, never on your machine. The worker and its network gateway keep running after `pnpm dev` ends.

```bash
pnpm worker:logs    # what the worker is doing
pnpm worker:stop    # stop it, keeping what it downloaded
pnpm worker:clean   # stop it and delete everything it downloaded
```

## Repository layout

```
apps/backend     HTTP API (Hono on Node 24) and MCP server, SQLite store of measurements and the job queue
apps/worker      The analyzer, run only in Docker: installs, bundles and measures one package at a time
apps/frontend    Web app (TanStack Start, Router, Query, Table, Charts; Tailwind; Nitro)
apps/cli         Command line: asks the API what a package costs and prints it
apps/e2e         Browser tests (Playwright) with an axe-core audit
packages/core    Shared API contract (zod/mini), typed API client, package spec parsing
deploy           The scripts that set up and update a server
docker           The configuration of the worker's network gateway
docs             The API and MCP reference, features, architecture, configuration, changelog, roadmap
skills           A skill that tells an AI agent when and how to use the MCP server
tools            Policy check, smoke test, .env initializer, oxlint plugin
```

| Technology                                                        | Used for                                                                 |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------ |
| TypeScript 7, Node 24, pnpm workspaces, Turborepo                 | One language end to end, exact dependency pins, 7-day release-age policy |
| Hono, `node:sqlite`, pino, zod                                    | API, storage and the job queue with no native dependency, logging        |
| rolldown                                                          | The bundler that measures a package                                      |
| React 19, TanStack Start / Router / Query / Table / Charts, Nitro | Server-rendered UI, URL-driven state, charts                             |
| Tailwind CSS 4, Base UI, Lucide                                   | Styling and accessible primitives                                        |
| oxlint, oxfmt, Vitest, Playwright, axe-core                       | Lint, format, unit tests, browser tests, accessibility audit             |

How the pieces work together is in [Architecture](ARCHITECTURE.md); the folders of each package are in [CONTRIBUTING.md](../CONTRIBUTING.md#project-structure).

## Commands

Use the commands below while developing or validating a change:

| Command          | What it does                                                                                                                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`       | Worker in Docker, then backend and frontend with reload (creates the `.env` files first)                                                                                                     |
| `pnpm build`     | Production build of every package                                                                                                                                                            |
| `pnpm test`      | Unit tests (Vitest), which download no packages                                                                                                                                              |
| `pnpm smoke`     | Starts the built backend and frontend as production runs them and checks that they work together (health, validation, rate-limit headers, documents, security headers, Markdown negotiation) |
| `pnpm e2e`       | Browser tests (Playwright) of the production builds, desktop and phone, with an axe-core audit; run `pnpm --filter @weighme/e2e exec playwright install chromium` once first                 |
| `pnpm typecheck` | TypeScript across the monorepo                                                                                                                                                               |
| `pnpm lint`      | oxlint, warnings fail                                                                                                                                                                        |
| `pnpm format`    | oxfmt (use `pnpm format:check` to only check)                                                                                                                                                |
| `pnpm policy`    | The dependency, toolchain, Docker, network and workflow rules (`tools/check-policy.js`)                                                                                                      |
| `pnpm verify`    | Everything CI runs before the browser tests: policy, lint, format check, typecheck, tests, build, smoke test                                                                                 |
| `pnpm stack`     | The whole product in Docker (`--profile app`); `pnpm stack:down` stops it                                                                                                                    |
