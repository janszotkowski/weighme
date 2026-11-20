# Features

Everything weighme offers, in one list. How it is built is in [Architecture](ARCHITECTURE.md); what comes next is in the [Roadmap](ROADMAP.md).

Contents: [The package page](#the-package-page) · [Compare and share](#compare-and-share) · [For programs and agents](#for-programs-and-agents) · [Security and fair use](#security-and-fair-use)

## The package page

- **Measured, not guessed**: every package goes through a real bundler (Rolldown), and the page says which one and which version. Minified, gzip and brotli sizes, and the time they take to download on slow 3G and 4G.
- **What it puts on disk**: the install size and the number of packages it brings along, with peer dependencies named.
- **Composition**: which packages make up the bundle, and what share each has.
- **Exports**: the size of each named export and entry point on its own, for packages that offer more than one.
- **Package health**: deprecation, license, TypeScript types, ESM or CommonJS, last release and install scripts, in what the registry says and with no judgement passed.
- **Version history**: how the size changed from release to release, with any version measured on request.
- **Accessible**: WCAG 2.2 AA, checked with axe-core; full keyboard use (`Ctrl`/`⌘ K` for the search), screen reader announcements, light and dark themes, reduced motion, and a table view of every chart's numbers.

## Compare and share

- **Trends**: up to 4 packages side by side, by size across releases or downloads over time, with GitHub stars.
- **Shareable state**: the tab, the compared packages and the chart's settings live in the URL. Copy it, bookmark it, send it.
- **Badges**: `/badge/<name>.svg` shows a package's gzip size in a README. Showing one never causes a download: a package not measured yet says so. Every package page has a button that copies the Markdown for a README.

## For programs and agents

- **A public JSON API**: read-only but for queueing a package's versions, with no key; see the [API reference](API.md).
- **An MCP server for AI assistants**: connect Claude, Cursor or any other client to `/v1/mcp` and let it check what a dependency costs before adding it, with no key; see [MCP server](MCP.md). An agent in the browser finds the same on the site's pages, as WebMCP tools.
- **A command line**: `weighme react` prints what a package costs in the terminal, or the whole answer with `--json`. It asks the API, and waits while a package is being measured; `--api <url>` or `WEIGHME_API_URL` name the API to ask. The exit code is 0 with a result, 1 without one and 2 for a command line that makes no sense.
- **Made to be found and cited**: every measured package has its own server-rendered page with structured data and a share image; a sitemap, `llms.txt`, and a Markdown version of every measured package for AI agents (`/package/<name>.md` or `Accept: text/markdown`).

## Security and fair use

- **Its code never runs**: the worker runs only in Docker, with a read-only root filesystem, no Linux capabilities, no privilege gain and caps on memory, CPU and processes; it refuses to start anywhere else. Its only network has no route out of Docker but a gateway to `registry.npmjs.org`. Packages are installed with `--ignore-scripts` and never executed; the bundler only reads them. What is downloaded stays on a Docker volume, never on the machine.
- **Fair use**: every caller gets 300 requests a minute to `/v1/*`; queueing downloads (`POST /v1/history`) has a far smaller share, so a crawler cannot fill the queue by opening pages. The frontend's rendering proves itself with a token and is limited per visitor instead. `RateLimit-*` headers say where you stand; a `429` carries `Retry-After`.
- **Answers are reused**: a finished measurement stays in the store; pages and answers carry `s-maxage` and an `ETag` for a CDN. Documents for crawlers read with `known=1`, so following them never causes a download.
- **Hardened pages**: a strict Content-Security-Policy that allows inline scripts only by hash and nonce, `frame-ancestors 'none'`, HSTS, `nosniff`, a strict referrer policy.
- **Supply chain**: exact dependency versions, each at least 7 days old before pnpm installs it; transitive dependencies from the registry only; install scripts allowed one by one; Docker base images pinned by digest; GitHub Actions pinned to a commit; pnpm installed through Corepack and verified by its hash. `pnpm policy` fails when any of it slips.
- **No account, no analytics**: weighme needs no paid API and no account, and has no analytics.
