# weighme

![weighme: What an npm package really costs your bundle](.github/banner.svg)

**What an npm package really costs your bundle, free and open source.** Search for a package and see its minified, gzip and brotli sizes, what it puts on disk and which packages make up its bundle, measured with a modern bundler. The package's code is never run.

**Not deployed yet:** for now it runs on your own machine. What is still required before a public release is in the [TODO](docs/TODO.md).

[![CI](https://github.com/janszotkowski/weighme/actions/workflows/ci.yml/badge.svg)](https://github.com/janszotkowski/weighme/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

weighme measures a package the first time someone asks for it, and keeps the result. A worker in a locked-down Docker container installs the package without running any of its scripts and bundles it with Rolldown. It needs no paid API and no account, and has no analytics.

[API reference](docs/API.md) · [MCP server](docs/MCP.md) · [Changelog](docs/CHANGELOG.md) · [Architecture](docs/ARCHITECTURE.md) · [Deployment](DEPLOY.md) · [Roadmap](docs/ROADMAP.md) · [Contributing](CONTRIBUTING.md) · [License](LICENSE)

## ✨ Features

- **Measured, not guessed**: every package goes through a real bundler (Rolldown), and the page says which one and which version. Minified, gzip and brotli sizes, and the time they take to download on slow 3G and 4G.
- **What it puts on disk**: the install size and the number of packages it brings along, with peer dependencies named.
- **Composition**: which packages make up the bundle, and what share each has.
- **Exports**: the size of each named export and entry point on its own, for packages that offer more than one.
- **Package health**: deprecation, license, TypeScript types, ESM or CommonJS, last release and install scripts, in what the registry says and with no judgement passed.
- **Version history**: how the size changed from release to release, with any version measured on request.
- **Trends**: up to 4 packages side by side, by size across releases or downloads over time, with GitHub stars.
- **Shareable state**: the tab, the compared packages and the chart's settings live in the URL. Copy it, bookmark it, send it.
- **Badges**: `/badge/<name>.svg` shows a package's gzip size in a README. Showing one never causes a download.
- **A command line**: `weighme react` prints what a package costs in the terminal, or the whole answer with `--json`.
- **Its code never runs**: packages are installed without their scripts, in a Docker container with a read-only root, no capabilities, caps on memory, processors and processes, and a network that reaches only the npm registry; the bundler only reads them. What is downloaded stays on a Docker volume, never on the machine.
- **Made to be found and cited**: every measured package has its own server-rendered page with structured data and a share image; a sitemap, `llms.txt`, and a Markdown version of every measured package for AI agents (`/package/<name>.md` or `Accept: text/markdown`).
- **An MCP server for AI assistants**: connect Claude, Cursor or any other client to `/v1/mcp` and let it check what a dependency costs before adding it, with no key. An agent in the browser finds the same on the site's pages, as WebMCP tools.
- **How it's built**: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), which the site shows at `/architecture`.
- **Accessible**: WCAG 2.2 AA, checked with axe-core; full keyboard use (`Ctrl`/`⌘ K` for the search), screen reader announcements, light and dark themes, reduced motion, and a table view of every chart's numbers.

### How it works

```
 ┌──────────────────────┐              ┌─────────────────────────┐                ┌───────────────────────────────┐
 │ frontend             │ /v1/analyses │ backend                 │ /internal/jobs │ worker (Docker only)          │
 │ TanStack Start (SSR) │─────────────▶│ Hono + SQLite + a queue │◀───────────────│ pnpm install --ignore-scripts │
 └──────────────────────┘              └─────────────────────────┘                │ rolldown, gzip, brotli        │
                                                                                  └───────────────┬───────────────┘
                                                                                                  │ the only way out: a gateway
                                                                                                  ▼
                                                                                         registry.npmjs.org
```

A package page asks the API for its analysis. The API answers from its store, or queues the package and answers "queued"; the worker, polling for work, downloads the package and its dependencies without running any of their scripts, bundles it, measures it and hands the result back. The page polls until the measurement is there. Only the worker ever touches a package; the API and the frontend never do.

| Source                                         | What it adds                                                       | How it is read                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------- |
| [npm registry](https://registry.npmjs.org)     | The packages themselves, versions, search, what a version declares | The worker installs a package; the API reads its documents       |
| [npm's download counts](https://api.npmjs.org) | Downloads over time                                                | Asked for when a page needs them, and kept for a while           |
| [GitHub](https://docs.github.com/en/rest)      | Stars of a package's repository                                    | Asked for when a page needs them, optionally with `GITHUB_TOKEN` |

#### Security and performance

- **Untrusted input, contained.** The worker runs only in Docker, with a read-only root filesystem, no Linux capabilities, no privilege gain and caps on memory, CPU and processes; it refuses to start anywhere else. Its only network has no route out of Docker but a gateway to `registry.npmjs.org`. Packages are installed with `--ignore-scripts` and never executed.
- **Fair use.** Every caller gets 300 requests a minute to `/v1/*`; queueing downloads (`POST /v1/history`) has a far smaller share, so a crawler cannot fill the queue by opening pages. The frontend's rendering proves itself with a token and is limited per visitor instead. `RateLimit-*` headers say where you stand; a `429` carries `Retry-After`.
- **Answers are reused.** A finished measurement stays in the store; pages and answers carry `s-maxage` and an `ETag` for a CDN. Documents for crawlers read with `known=1`, so following them never causes a download.
- **Hardened pages.** A strict Content-Security-Policy that allows inline scripts only by hash and nonce, `frame-ancestors 'none'`, HSTS, `nosniff`, a strict referrer policy.
- **Supply chain.** Exact dependency versions, each at least 7 days old before pnpm installs it; transitive dependencies from the registry only; install scripts allowed one by one; Docker base images pinned by digest; GitHub Actions pinned to a commit; pnpm installed through Corepack and verified by its hash. `pnpm policy` fails when any of it slips.

#### Repository layout

```
apps/backend     HTTP API (Hono on Node 24) and MCP server, SQLite store of measurements and the job queue
apps/worker      The analyzer, run only in Docker: installs, bundles and measures one package at a time
apps/frontend    Web app (TanStack Start, Router, Query, Table, Charts; Tailwind; Nitro)
apps/cli         Command line: asks the API what a package costs and prints it
apps/e2e         Browser tests (Playwright) with an axe-core audit
packages/core    Shared API contract (zod/mini), typed API client, package spec parsing
deploy           The scripts that set up and update a server
docker           The configuration of the worker's network gateway
docs             API reference, MCP guide, changelog, architecture, roadmap
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

## 🚀 Getting Started

You need **Node 24.22.2** (see `.node-version`), **pnpm 12** (the exact version is pinned in `package.json` and fetched automatically) and **Docker**.

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

## 📖 Usage

The API is JSON over HTTP and works directly from a browser, script, or other HTTP client. For example:

```bash
curl "http://127.0.0.1:4100/v1/analyses?package=react"
curl "http://127.0.0.1:4100/v1/analyses?package=react@19.1.0&known=1"
```

**Full reference with examples: [`docs/API.md`](docs/API.md)**, which the site shows at `/api`. OpenAPI 3.1: `/v1/openapi.json`.

Anyone may call it, within a fair-use limit (300 requests a minute per address by default; `RateLimit-*` headers tell you where you stand, and a `429` carries `Retry-After`). Answers carry `Cache-Control` headers suitable for a CDN; please cache on your side too.

| Endpoint               | Returns                                                                                                                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/health`       | `{ status, version }`                                                                                                                                                         |
| `GET /v1/analyses`     | The analysis of `package` (a name, optionally `@version` or `@tag`): queued, running, done or failed. `known=1` reads only what has been measured and never queues a download |
| `GET /v1/history`      | Recent versions of `package`, with the sizes of the measured ones                                                                                                             |
| `POST /v1/history`     | Queues the versions of `package` not measured yet (rate limited on its own, since each means a download)                                                                      |
| `GET /v1/downloads`    | Downloads of `package` per day over `range`                                                                                                                                   |
| `GET /v1/metadata`     | What the registry says about `package@version`: deprecation, license, types, install scripts                                                                                  |
| `GET /v1/stars`        | GitHub stars of `repository` (`owner/name`)                                                                                                                                   |
| `GET /v1/search`       | Packages matching `q`                                                                                                                                                         |
| `GET /v1/packages`     | Every measured package (what the sitemap lists)                                                                                                                               |
| `GET /v1/openapi.json` | The OpenAPI 3.1 description of the API                                                                                                                                        |

Errors share one shape, `{ error: { code, message, requestId } }`, with codes `VALIDATION_FAILED`, `NOT_FOUND`, `RATE_LIMITED`, `UNAUTHORIZED`, `UNAVAILABLE` and `INTERNAL`. The response shapes are defined once, as zod schemas, in [`packages/core/src/contract`](packages/core/src/contract), and [`packages/core/src/client`](packages/core/src/client/api.ts) is a typed client for them.

### MCP server

An AI assistant can use the same data over the [Model Context Protocol](https://modelcontextprotocol.io). The server is free and needs no key. It has limits of its own on top of the API's.

```bash
claude mcp add --transport http weighme http://127.0.0.1:4100/v1/mcp
```

| Tool                   | Answers                                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `get_package_cost`     | Sizes, install size, composition and exports. A package not measured yet is queued, and the answer says so |
| `get_package_metadata` | What the registry says of a version: deprecation, license, types and install scripts                       |

**Other clients and details: [`docs/MCP.md`](docs/MCP.md)**, which the site shows at `/mcp`.

### Badge

The frontend draws a badge with the gzip size at `/badge/<name>.svg`. Showing one never causes a download: a package not measured yet says so. Every package page has a button that copies the Markdown for a README.

### Command line

```bash
pnpm --filter @weighme/cli build
node apps/cli/dist/main.cli.mjs react
node apps/cli/dist/main.cli.mjs react@19.1.0 --json
```

It asks the API, and waits while a package is being measured. Until the site is deployed, it asks the local one; `--api <url>` or `WEIGHME_API_URL` name another. The exit code is 0 with a result, 1 without one and 2 for a command line that makes no sense. It is not on npm yet.

## ⚙️ Configuration

The backend reads its settings from the environment once at start-up and refuses to start with a readable message when one is invalid. The full list, with defaults, is in [`apps/backend/src/config/env.ts`](apps/backend/src/config/env.ts).

| Variable                                                            | Default                          | Meaning                                                                                                                                 |
| ------------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`, `HOST`                                                      | `4100`, `127.0.0.1`              | Where the API listens (on Linux, the worker in Docker needs more than `127.0.0.1`)                                                      |
| `DATABASE_PATH`                                                     | `./data/weighme.db`              | The SQLite file (created when missing); `:memory:` for tests                                                                            |
| `CORS_ORIGINS`                                                      | any localhost port (development) | Comma-separated origins of the frontend; required in production                                                                         |
| `WORKER_TOKEN`                                                      | none (required)                  | What the worker proves itself with (32+ characters); the example value is refused in production                                         |
| `INTERNAL_API_TOKEN`                                                | none                             | Shared with the frontend's server, so its rendering is limited per visitor (32+ characters); the example value is refused in production |
| `RATE_LIMIT_PER_MINUTE`                                             | `300`                            | Requests per caller per minute to `/v1/*` (health excepted)                                                                             |
| `RATE_LIMIT_RENDER_PER_MINUTE`                                      | `600`                            | Requests the frontend's rendering may make per minute for one visitor it names                                                          |
| `RATE_LIMIT_QUEUE_PER_MINUTE`                                       | `10`                             | Times one caller may queue a package's versions (`POST /v1/history`) per minute                                                         |
| `MCP_ENABLED`                                                       | `true`                           | Offer the MCP server at `/v1/mcp`                                                                                                       |
| `RATE_LIMIT_MCP_PER_MINUTE`                                         | `60`                             | Requests to `/v1/mcp` per caller per minute, on top of the general limit                                                                |
| `RATE_LIMIT_MCP_TOTAL_PER_MINUTE`                                   | `1200`                           | Requests to `/v1/mcp` per minute for all callers together                                                                               |
| `CLIENT_IP_HEADER`                                                  | connection address               | Single-value header the proxy overwrites with the visitor's address (`cf-connecting-ip`, `x-real-ip`); `x-forwarded-for` is refused     |
| `QUEUE_MAX_WAITING`                                                 | `200`                            | Packages waiting at most; beyond it the API answers `503`                                                                               |
| `JOB_LEASE_SECONDS`, `JOB_MAX_ATTEMPTS`, `JOB_FAILED_RETRY_MINUTES` | `180`, `2`, `60`                 | How long a worker may be silent about a job, how often a package is retried, and when a failed one is measured again                    |
| `GITHUB_TOKEN`                                                      | none                             | Optional, for the stars in the trends table (60 questions an hour without it; no permissions needed)                                    |
| `LOG_LEVEL`                                                         | `info`                           | pino log level                                                                                                                          |

The worker runs in Docker with the settings of [`docker-compose.yml`](docker-compose.yml); the full list is in [`apps/worker/src/config/env.ts`](apps/worker/src/config/env.ts): `BACKEND_URL`, `WORKER_TOKEN`, `WORKER_CONCURRENCY`, `JOB_TIMEOUT_MS`, `JOB_MEMORY_MB`, `MAX_INSTALL_BYTES`, `STORE_MAX_BYTES` and the like. `WORKER_IN_CONTAINER=true` must be set by the image; the worker refuses to run otherwise.

The frontend's settings are build-time (`VITE_*`, baked into the bundle) plus a few runtime variables for its server:

| Variable              | Meaning                                                                        |
| --------------------- | ------------------------------------------------------------------------------ |
| `VITE_API_URL`        | The API the browser calls (required for a build)                               |
| `VITE_SITE_URL`       | The public origin of the site (canonical links)                                |
| `VITE_ALLOW_INDEXING` | `true` only for the production build; everything else answers `noindex`        |
| `API_INTERNAL_URL`    | Runtime, server only: an internal address of the API for server-side rendering |
| `INTERNAL_API_TOKEN`  | Runtime, server only: the same token as the backend's                          |
| `CLIENT_IP_HEADER`    | Runtime, server only: the header with the visitor's address behind a proxy     |

## 🚢 Deployment

**On your own server:** [DEPLOY.md](DEPLOY.md) is a step-by-step guide for a Hetzner server behind a Cloudflare Tunnel, with a script that sets everything up. weighme has not been deployed yet, so it has not been tried on a real server.

The whole product is the API, the frontend, the worker and its network gateway as containers, with the measurements in one SQLite file on a volume.

```bash
SITE_URL=https://pkg.example.org \
API_URL=https://api.pkg.example.org \
ALLOW_INDEXING=true \
WORKER_TOKEN=a-random-string-of-32-characters-or-more \
INTERNAL_API_TOKEN=another-random-string-of-32-characters-or-more \
BACKEND_URL=http://api:4100 \
docker compose --profile app up -d --build
```

[`docker-compose.yml`](docker-compose.yml) builds the images from the [`Dockerfile`](Dockerfile). The API refuses the example tokens in production. Compose caps the worker at 3 GB of memory and 2 processors, the API at 1 GB and the frontend at 512 MB. It publishes the API and the frontend on `127.0.0.1` only, so put a reverse proxy or a tunnel in front for TLS, and set `CLIENT_IP_HEADER` to the header it overwrites with the visitor's address (both services read it). `pnpm stack` runs the same locally in the foreground, and `pnpm stack:down` stops it.

Serverless platforms without Docker and a persistent disk do not fit: the database, the queue and the worker need long-lived processes.

## 📚 Documentation

- [API reference](docs/API.md) explains every public endpoint and field with examples.
- [MCP server](docs/MCP.md) shows how to connect an AI assistant, and lists its tools.
- [Changelog](docs/CHANGELOG.md) lists what changed on the site and in the API.
- [Architecture](docs/ARCHITECTURE.md) describes one analysis end to end, how packages are handled safely, the rate limit, the threat model, the documents for search engines and agents, the security headers and accessibility.
- [Roadmap](docs/ROADMAP.md) lists the features that come next; the [TODO](docs/TODO.md) what must be done before the first public release.
- [Deployment guide](DEPLOY.md) covers a production deployment behind a Cloudflare Tunnel.
- [Security policy](SECURITY.md) explains how to report a vulnerability in weighme.
- [AGENTS.md](AGENTS.md) spells out the code style, dependency and architecture rules, for coding agents and people.

## 🛠️ Development

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

## 🤝 Contributing

Contributions are welcome: bug reports, wrong measurements, new measurements, new views. Please read [CONTRIBUTING.md](CONTRIBUTING.md) first; everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md). To report a security problem in weighme itself, see [SECURITY.md](SECURITY.md).

## 🐛 Issues & Support

Open an issue for a [bug](https://github.com/janszotkowski/weighme/issues/new?template=bug_report.yml), a [wrong measurement](https://github.com/janszotkowski/weighme/issues/new?template=wrong_measurement.yml), or a [feature request](https://github.com/janszotkowski/weighme/issues/new?template=feature_request.yml). For a security issue in weighme itself, follow the private reporting process in [SECURITY.md](SECURITY.md); never open a public issue for it. A vulnerability in a package that weighme measured is not a weighme issue: report it to that package's maintainers.

## 📋 Code of Conduct

Everyone taking part in the project is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## 📄 License

weighme measures packages as published on npm and shows public data as its sources give it, without warranty of any kind.

- Packages, versions and what a version declares come from the [npm registry](https://registry.npmjs.org), and download counts from [npm's statistics](https://api.npmjs.org).
- Stars come from [GitHub](https://github.com).

[MIT](LICENSE) © Jan Szotkowski. A package's own license stays its own.

## 👥 Authors & Contributors

Created and maintained by [Jan Szotkowski](https://github.com/janszotkowski). See the [contributor graph](https://github.com/janszotkowski/weighme/graphs/contributors) for everyone who has helped improve weighme.
