# How it's built

weighme is one TypeScript repository: a backend that stores what each npm package costs, a worker that measures packages, a server-rendered frontend, and a small package they share.

```
 browser ──▶ frontend (TanStack Start, SSR) ──/v1/*──▶ backend (Hono + SQLite)
                                                          ▲
                                     /internal/* + token  │  take a job, hand in the result
                                                          │
                                  worker ─── one process per package ───▶ npm registry
```

```
apps/backend     HTTP API, the store of results and the queue (one SQLite table)
apps/worker      Installs one package at a time, bundles it and reports its sizes
apps/frontend    Web app: search, the package page, trends and how it works
apps/cli         Command line: asks the API what a package costs and prints it
packages/core    Shared contract: zod schemas, package name validation, the analyzer version, reading the API's answers
docker           The configuration of the worker's network gateway
docs             This page, the API reference, the MCP guide and the changelog, all of which the site also shows
```

## One analysis

1. The page asks `GET /v1/analyses?package=react`. The backend resolves the name to an exact version and answers from the store, or queues the package.
2. The worker takes the job with `POST /internal/jobs/claim` and starts a process just for it.
3. That process installs the package, bundles it with Rolldown, compresses the bundle and answers with the numbers.
4. The worker hands in the result, and the page, which keeps asking, shows it.
5. The same process then bundles each entry point and each named export alone, and the page adds them when they arrive. Its folder is then removed.

The worker only handles what someone asked for. Nothing is fetched in the background: older versions of a package are measured only when someone looks at them, on a package's History tab or in the size view of the trends page, behind anything someone is waiting for. Suggestions while typing come from the registry's search through `GET /v1/search`: names and descriptions only, nothing is installed. The package health panel reads the registry's document of the version through `GET /v1/metadata`, so nothing is installed for it either, and it is not stored with the result, because a version can be deprecated after it was measured.

## Opening a package

Going to a package inside the app never waits: the page opens at once and asks for the size, and history and package health follow without holding anything up. Only the server waits for the first answer, so that a page loaded from its address and read by a crawler arrives complete. What a name or tag resolved to is kept for a minute, because every package page starts with that question to the registry.

## Handling packages safely

A package is untrusted code. It is read, never run:

- **Only in Docker**: the worker refuses to start outside its container. Everything it downloads stays on the `worker-data` volume, and `pnpm worker:clean` removes it.
- **A hardened container**: a read-only filesystem, no capabilities, an unprivileged user, and limits on memory and processes.
- **One way out**: the worker's only network is `internal`, with no route out of Docker. On it, `registry.npmjs.org` resolves to a small gateway (`docker/registry-gateway.conf`) that forwards raw TCP to that one host, whatever the client asks for, and to the API when it runs on the machine. TLS passes through it, so pnpm still checks the registry's own certificate. `pnpm policy` fails if the worker leaves that network.
- **No scripts**: `pnpm install --ignore-scripts`, and dependencies may come from the registry only (`blockExoticSubdeps`).
- **No code execution**: the bundler parses the code. Nothing imports or runs it.
- **No secrets**: the analysis process does not receive `WORKER_TOKEN`, the user-level npm and pnpm configuration is replaced by empty files, and the worker has no database.
- **Limits**: one process group per package, killed after `JOB_TIMEOUT_MS`, and a cap on installed bytes (`MAX_INSTALL_BYTES`), checked while the install runs, which is stopped past it. The shared store is weighed every hour, after a failed analysis, and once a tenth of its limit (`STORE_MAX_BYTES`) has been added.
- **Nothing outside the job's folder**: the bundler refuses a file that is not under it, by a path or through a link, and what a tool quotes of a file never leaves the worker. A message of a failure is shown on a public page, and a file a package made the bundler read could be another process's environment.
- **Validated names**: a package name reaches URLs and paths only through `isValidPackageName`.

## Rate limit

Every caller gets a share of the API per minute (`RATE_LIMIT_PER_MINUTE`), counted by address: the connection's, or the one in `CLIENT_IP_HEADER` behind a proxy that overwrites it (a header proxies append to, such as `x-forwarded-for`, is refused). IPv6 callers are counted by their /64. One more request is answered 429 with `Retry-After`, and every answer carries `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`. Queueing, which has the worker download a package, counts against a much smaller share of its own (`RATE_LIMIT_QUEUE_PER_MINUTE`): every request for a package's versions (`POST /v1/history`), and a request for a package's cost when it adds that package to the queue. Asking for what is known or already waiting costs none of it. Versions queued for a history have a line of their own in the queue, so they cannot crowd out what someone is waiting for. The limiter holds ten thousand callers apart in a window; newcomers past that share fifty callers' worth between them, so filling it with addresses does not shut new visitors out.

The frontend's server renders pages for every visitor at once, so it is not one caller: it proves itself with `INTERNAL_API_TOKEN` and names the visitor in `x-visitor-ip`, whom the API then counts against `RATE_LIMIT_RENDER_PER_MINUTE`. The documents it renders for itself (the sitemap, share images) name none and share one count of the same size, so the token alone never means unlimited. Share images, the costliest thing the frontend draws, have a small limit per visitor of their own.

## Threat model

What could go wrong, and what stands in the way. The controls are the ones described above, gathered by the threat they answer.

| Threat | Control |
|---|---|
| **Untrusted package code** runs on the server | It never runs: the bundler parses it (`--ignore-scripts`, no imports, no `binding.gyp` builds). One process group per package inside a hardened container (read-only filesystem, no capabilities, unprivileged user, memory and process limits), killed after `JOB_TIMEOUT_MS`, with a cap on installed bytes. The process holds no secrets and the worker no database. Its network reaches only the registry, through a gateway with one fixed destination, and the API |
| **The registry or its CDN misbehaves**: an error page, a huge or hostile document, a slow answer | Every answer is read with a timeout that covers the body and a byte cap (8 MiB; 64 MiB for a package's full document), past which it is given up on unread. Fields are read defensively, never trusted to have a shape. Full documents are parsed two at a time at most, with eight more waiting and any further refused at once, and what was read is kept for a while, so one package in a burst costs one request. A failure is answered 503 with `Retry-After` and is not cached, except that of a full document, which is kept for a minute: asking again would read tens of megabytes again |
| **Queue flooding**: a crawler or a script has the worker download the world | Opening a page queues at most the one version it shows, and each package a caller adds to the queue counts against a small share of its own (`RATE_LIMIT_QUEUE_PER_MINUTE`), as does queueing the versions of a history, which happens only on an explicit `POST` and behind what someone is waiting for. The queue has a ceiling (`QUEUE_MAX_WAITING`), counted for the current way of measuring only, past which the API answers 503 rather than piling up; what an older one left is removed at start-up. Documents for crawlers ask with `known=1` and never queue |
| **The worker's token** leaks, or is guessed at from the internet | `/internal/*` answers 404 to any request carrying the header the proxy in front writes (`CLIENT_IP_HEADER`): the worker reaches the API inside the machine, never through the proxy. The token is compared in constant time, and the example value is refused in production |
| **The internal token** reaches further than it should | It only moves a request from the per-caller limit to the per-visitor one; it opens nothing else. A request carrying it without a visitor, or with one that is no address, shares one count, so neither a leaked token nor a misconfigured proxy means unlimited. The example value is refused in production, and the token is compared in constant time |
| **The frontend's server as a single caller** eats the whole limit | Its rendering names the visitor it works for, and each visitor is counted apart; what it renders for itself is counted together. Without the token it is one caller like any other, and the site degrades to a shared limit instead of failing |
| **Log volume** as a way to fill the disk | Each request is one line, and a worker that cannot reach the API says so once and then asks less and less often: the path cut to 200 characters, no headers, the worker's polling at `debug`. Secrets are redacted by path should one ever be logged whole. Logs rotate in Compose |
| **A caller chooses its own address** to escape the limit | The address comes from the connection unless `CLIENT_IP_HEADER` names a header the proxy overwrites; a header proxies append to is refused at start-up, and a value that is not exactly one address falls back to the connection. IPv6 callers are counted by their /64 |

## Search engines and agents

- **One head for every page**: `pageHead` builds the title, description, canonical address, Open Graph and Twitter cards, and one JSON-LD graph.
- **What is indexed**: the home page, the trends page, the how-it-works page and measured packages at their own address. A package still being measured, a page of one version and a chosen comparison are kept out, and so is every page outside production (`VITE_ALLOW_INDEXING`).
- **Documents**: `robots.txt`, `sitemap.xml`, `llms.txt`, `.well-known/security.txt`, `.well-known/api-catalog` and `.well-known/ai-catalog.json`, share images at `/og/`, and each package as Markdown (`.md`, or `Accept: text/markdown`), all from `src/server.ts`.
- **Reading never downloads**: documents, share images and README badges (`/badge/<name>.svg`) ask the API with `known=1`, so a crawler following them cannot cause a package to be measured.
- **For programs and agents**: the [JSON API](API.md) with an OpenAPI description, an [MCP server](MCP.md) at `/v1/mcp` and WebMCP tools an agent in the browser can call. Tool calls count against the same rate limit and shares of their own, per caller and all callers together, and each queues at most one version, as opening a page does.
- **One source for the reference**: the `/api`, `/mcp`, `/architecture` and `/changelog` pages render `docs/API.md`, `docs/MCP.md`, this file and `docs/CHANGELOG.md` at build time, so the site and the repository never disagree.

## Security headers

Every response gets the security headers, and each page a Content-Security-Policy built from the hashes of its own inline scripts, never `'unsafe-inline'`. None of it applies to the dev server, whose hot reload a strict policy would block.

## Accessibility

Keyboard reachable with a skip link and visible focus, labelled controls, tables with real headers, reduced motion respected, and after each navigation the new page's title is announced and focus moves to it.

## Measuring

- **The entry depends on the package**: ES modules are measured through `export *` and their default export, which `export *` leaves out, CommonJS through a namespace import. `export *` over CommonJS measures next to nothing.
- **Nothing to import is an answer**: a package whose entry cannot be resolved, such as a command-line tool, gets its install size and its commands, and no bundle size.
- **A suspicious result is a failure**: a CommonJS bundle with nothing of the package in it fails the analysis instead of reporting a few bytes. An ES module whose root exports nothing has nothing to import, and its subpaths are still measured.
- **A package made for Node.js says so**: Node's own modules and native addons stay out of the bundle and are named on the page, and imports that fail deep in the dependencies, often optional ones, are counted there. The number is then not a browser size, and the page says that too.
- **Peer dependencies are not counted**: the app brings them anyway.
- **Composition is an estimate**: the bundler reports each module's size before minifying, so the page shows each package's share of the bundle and works out its minified size from that.
- **Parts are bundled alone**: an entry point from `exports` or one named export, each in its own bundle, up to `MAX_NAMED` and `PARTS_BUDGET_MS`. The page says what was left out. CommonJS gets no per-export numbers, because bundlers cannot drop parts of it reliably.
- **Download time is arithmetic**: the gzip size at a fixed speed for each connection, without latency, parsing or running. A package made for Node.js does not get one.
- **Results are versioned**: `ANALYZER_VERSION` in `packages/core` is part of a result's key. Bump it when the way of measuring changes.
