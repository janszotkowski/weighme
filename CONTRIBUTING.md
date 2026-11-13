# Contributing to weighme

Thank you for helping. Bug reports, wrong measurements, ideas and code are all welcome. By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to help

- **Report a bug** in the app, the API or the worker: [open a bug report](https://github.com/janszotkowski/weighme/issues/new?template=bug_report.yml).
- **Report a wrong measurement**: a size, composition or install footprint that does not match what you measure yourself. [Open a measurement issue](https://github.com/janszotkowski/weighme/issues/new?template=wrong_measurement.yml) with the package, the version and how you measured.
- **Suggest a feature**, a new measurement or a new view: [open a feature request](https://github.com/janszotkowski/weighme/issues/new?template=feature_request.yml). The [roadmap](docs/ROADMAP.md) lists what is already planned.
- **Report a vulnerability in weighme** privately, as described in [SECURITY.md](SECURITY.md). Never in a public issue.

For anything larger than a small fix, please open an issue first so we can agree on the approach before you spend time on it.

## Development setup

You need Node 24.22.2 (`.node-version`), pnpm 12 and Docker. The README's [Getting Started](README.md#-getting-started) has the full steps:

```bash
pnpm install
pnpm dev
```

`pnpm dev` creates the local `.env` files from the examples, starts the worker in Docker and then the API and the frontend with reload. The worker is the only part that downloads packages, and it refuses to run outside Docker.

Before you open a pull request, run what CI runs:

```bash
pnpm verify
```

It runs the dependency and workflow policy, lint, format check, typecheck, tests, the production build and the smoke test, and must pass. CI then runs the browser tests (`pnpm e2e`, after `pnpm --filter @weighme/e2e exec playwright install chromium` once) and builds the three Docker images.

## Project structure

| Path                                  | What lives there                                                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `packages/core`                       | The contract shared by every app: zod/mini schemas and types of analyses, versions and errors, package spec parsing. No I/O.   |
| `apps/backend/src/modules/analyses`   | The SQLite store of measurements and the job queue, the npm and GitHub readers, the public `/v1` and worker `/internal` routes |
| `apps/backend/src/platform`, `config` | HTTP shell (request id, CORS, rate limit, error contract), logging, environment validation                                     |
| `apps/worker/src/modules/analysis`    | One analysis: install without scripts, bundle with rolldown, measure, report; the limits a package runs under                  |
| `apps/worker/src/modules/backend`     | The worker's client of the API: claim a job, hand in a result or a failure                                                     |
| `apps/frontend/src/routes`            | Pages (TanStack Router file routes)                                                                                            |
| `apps/frontend/src/components`        | UI components; `ui/` holds the Base UI primitives, `iso/` the illustrations                                                    |
| `apps/frontend/src/lib`               | Formatting, API queries, trends, the documents for crawlers and agents (`documents/`), security headers                        |
| `apps/frontend/src/server.ts`         | The server entry: documents and share images first, then the pages, every response with its headers                            |
| `apps/e2e`                            | Browser tests (Playwright) of the built apps, with an axe-core audit                                                           |
| `deploy`                              | The scripts that set up and update a server                                                                                    |
| `tools`                               | The policy check, the smoke test, the `.env` initializer and the project's oxlint plugin                                       |

## Code style

Formatting and most rules are enforced by **oxfmt** and **oxlint** (`pnpm format`, `pnpm lint`); the configuration is in the repository root and covers the whole monorepo. [AGENTS.md](AGENTS.md) spells the rules out for people and agents alike. In short:

- **TypeScript only, strict.** No `any`, no casts to silence the compiler. `type`, not `interface`.
- **Functions are constants**: `export const parseSpec = () => …`, never `function parseSpec()`.
- **Imports use path aliases** (`@lib/…`, `@modules/…`, `@components/…`); only a sibling in the same folder may be imported relatively (`./name`). Backend, worker and core imports carry the `.ts` extension.
- **React components** take one `props: ComponentNameProps` parameter, with the type declared by name above the component, and read `props.x`. No destructuring in the parameter list.
- **`packages/core` runs in the browser and in Node**: no Node or browser globals there, and `zod/mini` instead of `zod`.
- **Dependencies** are pinned to exact versions, and a version must be at least 7 days old before pnpm installs it (`pnpm policy` checks). Add a dependency only when the platform or an existing one cannot do the job.
- **Comments explain why**, not what. Exported symbols carry a JSDoc sentence. Match the density and tone of the code around them.
- **Everything user-facing and all documentation is in English.**

## Accessibility

The site targets WCAG 2.2 AA, checked with axe-core in the browser tests on a desktop and a phone-sized screen. Keep it there:

- **Every control has a name and works from the keyboard.** Use real buttons, links and inputs; a custom widget follows its ARIA pattern (the search is a combobox with a listbox; `Ctrl`/`⌘ K` focuses it).
- **Never color alone.** A chart has a legend, a tooltip and a table of its numbers; a status is always written next to its color.
- **Every page has one `h1`, a `<main id="main" tabIndex={-1}>` and a title that says what it is.** After a navigation `RouteAnnouncer` reads the title out and moves focus to `main`.
- **Tables** have a caption, `scope` on headers, and a wrapper that is a named, focusable region when it scrolls sideways.
- **Live changes are announced politely:** a package being measured, an error, loading that takes unusually long.
- **Motion respects `prefers-reduced-motion`,** and states stay visible in forced-colors mode.

## Tests

Tests use Vitest and live next to each package in `tests/`; browser tests live in `apps/e2e`.

- Backend logic is tested against an in-memory SQLite database, and the API through `app.request`, with the registry and GitHub stood in for: nothing reaches the network.
- The worker's tests never install a package; what parses npm's and the bundler's output must cope with missing and malformed fields.
- `apps/backend/tests/architecture.test.ts` enforces the module boundaries (modules never import each other; `platform` and `config` never import a module).
- A bug fix comes with a test that fails without it.

## Common changes

### Add a measurement

The result of an analysis is defined once, in [`packages/core/src/contract/analysis.ts`](packages/core/src/contract/analysis.ts). Add the field there, produce it in the worker ([`apps/worker/src/modules/analysis`](apps/worker/src/modules/analysis)), store it through the [store](apps/backend/src/modules/analyses/infrastructure/store.ts) and show it on the package page. A new field bumps the analyzer version, so that old measurements are redone.

### Add a page

Add a file route under [`apps/frontend/src/routes`](apps/frontend/src/routes) with a `head` (title, description, canonical, JSON-LD), list it in `STATIC_PAGES` ([`lib/documents/sitemap.ts`](apps/frontend/src/lib/documents/sitemap.ts)) and in `llms.txt`, and add it to the pages the browser tests audit.

### Add an API route

Routes live in [`apps/backend/src/modules/analyses/http/routes.ts`](apps/backend/src/modules/analyses/http/routes.ts). Validate the input with the schemas of `packages/core`, throw `AppError` with a code from the error contract, set a `Cache-Control` and add a test in `apps/backend/tests/http.test.ts`. A route that makes the worker download something counts against the queue limit.

## Pull requests

- Keep a pull request to one change, and describe what it does and why. Screenshots help for anything visible.
- Write commit messages in the imperative ("Add install size"), with details in the body when they help.
- Make sure `pnpm verify` passes. CI runs the same checks, then the browser tests and the Docker images.
- A maintainer reviews every pull request. Expect questions; they are about the code, never about you.

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
