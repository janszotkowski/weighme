# Changelog

What changed on weighme and in its [API](API.md), newest first. New measurements of packages are not listed here; this is about what the site and the API can do.

API releases carry the version of the `/v1` contract; how it is versioned is at the [end of this page](#versioning-policy).

## 2026-11-14

### API 1.0.1

- `GET /v1/analyses` and the MCP tool `get_package_cost` count against the small limit of queueing when they add a package to the queue, and answer `429` past it. Asking for a package that is known or already waiting is unchanged.
- `GET /v1/stars` answers `null` for a repository no measured package names: GitHub is asked only about those.
- `GET /v1/history` answers `503` at once when too many packages are being looked up in the registry, and repeats a failed look-up for a minute instead of asking again.

### Measuring

- A package that imports a file outside itself and its dependencies fails to bundle, and the message of a failure no longer quotes code.
- An install is stopped as soon as it passes the size limit, not after it has finished.

## 2026-11-05

### Measuring

- ES modules are measured with their default export, which `export *` leaves out. A package with only a default, such as `vue@2` or `zustand@3`, failed before; one with both was quietly measured too small. Every package is measured again the next time someone asks for it.
- A package whose root exports nothing and which is used through its subpaths, such as `@tanstack/devtools-event-bus@0.3.2`, now has nothing to import instead of failing, and its subpaths are measured.

### API 1.0.0

- `GET /v1/openapi.json`: an OpenAPI 3.1 description of the whole API, generated from the schemas the answers are checked against. Generate a client in any language from it.
- `POST /v1/mcp`: a [Model Context Protocol server](MCP.md), so an AI assistant can check what a dependency costs before adding it. No key, within the rate limit of the rest of the API and with limits of its own.
- Every caller has a rate limit, with `RateLimit-*` headers and `Retry-After`. Queueing a package's versions has a much smaller share of its own, and those versions wait behind anything someone is waiting for.
- Answers carry `ETag` and cache headers a CDN can use, and what the registry answers is read with a timeout and a byte cap.

### Site

- [API documentation](API.md), an [MCP guide](MCP.md) and [how it's built](ARCHITECTURE.md), each a page of the site, and an API catalog at `/.well-known/api-catalog`.
- WebMCP tools: an AI agent in the browser can search packages, read what they cost, and open a package or a comparison, through the page itself.
- A README badge with a package's gzip size at `/badge/<name>.svg`, with a button on each package page that copies it. Showing one never causes a download.
- A how-it-works page, and navigation in the header and the footer, with one menu on a phone.
- The package health panel: deprecation, license, TypeScript types, module format, last release and install scripts.
- This changelog, and an invitation to star the project on GitHub.
- On a phone, the link with the logo has a name for screen readers.
- Links in the documents are underlined, not only coloured.

### Command line and self-hosting

- [DEPLOY.md](../DEPLOY.md) and two scripts set the site up on a small server behind a Cloudflare Tunnel, and update it.
- A worker that cannot reach the API says so once, and asks less and less often.
- A command line: `weighme react` prints what a package costs and waits while it is measured, or prints the whole answer with `--json`. It is not on npm yet.
- The worker's network reaches only the npm registry: it has no route out of Docker but a gateway with one fixed destination.
- `pnpm stack` runs the API, the frontend and the worker as containers, from three Docker images.

## 2026-11-04: first version

### Measuring

- Every package goes through a real bundler (Rolldown), for its minified, gzip and brotli size, what it puts on disk and which packages make up its bundle.
- The size of each entry point and named export, bundled alone.
- Its code never runs: a worker that runs only in Docker installs it without scripts and only reads it.

### API

- `/v1/analyses` for what a package costs, with `known=1` to read only what has been measured and never cause a download.
- `/v1/history`, `/v1/downloads`, `/v1/stars`, `/v1/metadata`, `/v1/search` and `/v1/packages`.

### Site

- Search, a page for each package with its composition, exports and version history, and a page that compares packages by size across releases or downloads over time.
- Server-rendered pages with structured data and a share image, a sitemap, `llms.txt`, and each measured package as Markdown (`/package/<name>.md`).
- A strict Content-Security-Policy, light and dark themes, and WCAG 2.2 AA accessibility.

## Versioning policy

The `/v1` contract is versioned semantically; its version is `info.version` of [`/v1/openapi.json`](API.md#get-v1openapijson).

- **Within `/v1` only additions are made**: a new endpoint, parameter, field or enum value. Nothing is removed, renamed or changes meaning or type. Ignore fields you do not know, and treat an enum value you do not know (a new `status`, a new failure `code`) as "other".
- **A breaking change gets a new path** (`/v2`), announced here, with `/v1` kept running alongside it.
- **Error `message`s** are for people and may be reworded at any time; `code`s are part of the contract.
