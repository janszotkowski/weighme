# weighme API

A public JSON API over what npm packages cost a bundle: minified, gzip and brotli sizes measured by really bundling each package, what an install puts on disk, and what the registry says of a version. It is what the site itself runs on. No account and no key are needed.

The site is not deployed yet, so the address below is the one `pnpm dev` starts on your own machine.

```
http://127.0.0.1:4100/v1
```

Machine-readable description: `/v1/openapi.json` (OpenAPI 3.1), for generating a client in any language.

## Quick start

```bash
# What react costs. Not measured yet: this queues it, so ask again in a moment
curl -s 'http://127.0.0.1:4100/v1/analyses?package=react'

# One version, only if it has been measured: this never causes a download
curl -s 'http://127.0.0.1:4100/v1/analyses?package=react@19.1.0&known=1'

# Is this version deprecated? What license, types and install scripts does it declare?
curl -s 'http://127.0.0.1:4100/v1/metadata?package=react@19.1.0'

# Downloads per day over the last year
curl -s 'http://127.0.0.1:4100/v1/downloads?package=react&range=1y'
```

## Conventions

- **Methods**: `GET` (and `HEAD`, `OPTIONS`). There are two exceptions: [`POST /v1/history`](#post-v1history), which queues a package's versions, and the [MCP server](MCP.md) at `POST /v1/mcp`.
- **Format**: JSON (`application/json`).
- **Times** are ISO 8601 in UTC. Days are `YYYY-MM-DD`, also UTC.
- **Sizes** are bytes, as whole numbers.
- **Missing values** are `null`, never left out. Lists are `[]` when empty.
- **Packages**: `package` is a name such as `react` or `@scope/name`. Where the endpoint says so it may carry an exact version or a dist-tag: `react@19.1.0`, `react@next`. Encode it in a query string (`%40` for `@`, `%2F` for `/`); `curl` and browsers accept the plain form too.
- **Versioning**: everything is under `/v1`. Fields may be added within `v1`; none is removed or changes meaning. Ignore fields you do not know. See [Versioning](#versioning).
- **Request id**: every response has an `X-Request-Id` header (also in error bodies). You may send your own (`[A-Za-z0-9._-]`, up to 128 characters) to match your logs with ours. Include it when reporting a problem.
- **Browsers**: a script on another site can read answers only when the API names that site in `CORS_ORIGINS`. Programs are not affected.

## Measuring takes a moment

A package is measured when someone first asks for it, on a worker that downloads it without running any of its code. So [`GET /v1/analyses`](#get-v1analyses) has four answers, told apart by `status`:

| `status`  | Means                                                    | What to do                     |
| --------- | -------------------------------------------------------- | ------------------------------ |
| `queued`  | It waits for the worker                                  | Ask again in a second or two   |
| `running` | The worker has it                                        | Ask again in a second or two   |
| `done`    | `result` holds the numbers. `exports` may still be `pending` | Ask again if you want them |
| `failed`  | `failure` says why. It is tried again after a while      | Do not retry at once           |

Once the first answer names the exact version, ask for that version: a tag makes the API ask the registry again each time.

To read without ever causing a download, send `known=1`. A package not measured is then a `404`.

## Rate limit and caching

Every address may make **300 requests a minute** to `/v1/*` (`/v1/health` does not count; IPv6 addresses are counted by their /64), of which at most **10 a minute** to `POST /v1/history` and **60 a minute** to the [MCP server](MCP.md). Each response says where you stand:

| Header                | Meaning                                  |
| --------------------- | ---------------------------------------- |
| `RateLimit-Limit`     | Requests allowed in the window           |
| `RateLimit-Remaining` | Requests left in the current window      |
| `RateLimit-Reset`     | Seconds until the window starts again    |
| `Retry-After`         | On `429` and `503` only: seconds to wait |

Past the limit the API answers `429 RATE_LIMITED`. Wait for `Retry-After` seconds, then continue. Adding packages to the queue has a much smaller limit of its own: `GET /v1/analyses` counts against it only when the package was not known and is now queued, and answers `429` past it too. A self-hosted API sets these numbers itself, see the [README](../README.md).

Answers carry `Cache-Control` and an `ETag`, so please cache on your side and honor them:

| Endpoints                                                                   | Fresh for  |
| --------------------------------------------------------------------------- | ---------- |
| `/analyses` of an exact version, finished, and `/downloads`, `/metadata`, `/stars`, `/packages` | 5 minutes  |
| `/analyses` of a name or tag, finished, and `/search`                        | 1 minute   |
| `/openapi.json`                                                             | 1 hour     |
| `/analyses` still being measured or failed, `/history`, `/health`           | not cached |

## Errors

Every error has the same body, with a stable `code`. The `message` is English for developers and may change; branch on `code`.

```json
{
    "error": {
        "code": "VALIDATION_FAILED",
        "message": "package must be a name without a version",
        "requestId": "959f7882-7d29-4623-83be-3fee699c5fff"
    }
}
```

| Status | `code`              | When                                                                     | What to do                      |
| ------ | ------------------- | ------------------------------------------------------------------------ | ------------------------------- |
| 400    | `VALIDATION_FAILED` | A missing or malformed parameter, or a body over 16 KiB                  | Fix the request                 |
| 404    | `NOT_FOUND`         | Not on npm, not measured with `known=1`, or no such route                | Do not retry                    |
| 429    | `RATE_LIMITED`      | Over the rate limit                                                      | Retry after `Retry-After`       |
| 503    | `UNAVAILABLE`       | The queue is full, or the registry did not answer                        | Retry after `Retry-After` (5 s) |
| 500    | `INTERNAL`          | A bug on our side                                                        | Report it with the `requestId`  |

## Endpoints

| Endpoint                                         | Returns                                                                |
| ------------------------------------------------ | ---------------------------------------------------------------------- |
| [`GET /v1/analyses`](#get-v1analyses)            | What a package costs. Queues one not measured yet, unless `known=1`    |
| [`GET /v1/history`](#get-v1history)              | Recent versions of a package, with the sizes of the measured ones      |
| [`POST /v1/history`](#post-v1history)            | Queues every version of a package not measured yet                     |
| [`GET /v1/downloads`](#get-v1downloads)          | Downloads of a package per day                                         |
| [`GET /v1/metadata`](#get-v1metadata)            | What the registry says of one version                                  |
| [`GET /v1/stars`](#get-v1stars)                  | GitHub stars of a repository                                           |
| [`GET /v1/search`](#get-v1search)                | Packages matching a text                                               |
| [`GET /v1/packages`](#get-v1packages)            | Every package with a finished measurement                              |
| [`GET /v1/health`](#get-v1health)                | Whether the API is up, and which build                                 |
| [`GET /v1/openapi.json`](#get-v1openapijson)     | The OpenAPI 3.1 description of all of the above                        |

For an AI assistant, the same data is also a [Model Context Protocol server](MCP.md) at `/v1/mcp`.

### `GET /v1/analyses`

What a package costs.

| Parameter  | Values                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `package`  | Required. A name with an optional exact version or dist-tag; without one, `latest`                                             |
| `known`    | `1`: read only what has been measured, and never queue a download. Not measured is a `404`                                     |
| `analyzer` | The analyzer version the caller expects. The API does not read it: in the address, it keeps a cached answer from outliving a change in how packages are measured |

```bash
curl -s 'http://127.0.0.1:4100/v1/analyses?package=example@1.0.0'
```

A finished answer, with made-up numbers:

```json
{
    "status": "done",
    "package": { "name": "example", "version": "1.0.0" },
    "analyzerVersion": 7,
    "result": {
        "bundler": { "name": "rolldown", "version": "1.2.14" },
        "entry": "export-star",
        "sizes": { "minified": 7500, "gzip": 2900, "brotli": 2600 },
        "composition": { "packages": [{ "name": "example", "share": 1, "modules": 4 }], "total": 1 },
        "commands": [],
        "install": { "bytes": 316000, "packages": 1 },
        "peerDependencies": [],
        "description": "An example",
        "environment": { "nodeBuiltins": [], "nativeAddons": 0, "unresolvedImports": 0 },
        "repositoryUrl": "https://github.com/owner/example",
        "timingsMs": { "install": 900, "bundle": 40, "compress": 20 }
    },
    "exports": { "status": "pending" }
}
```

| Field               | Type           | Description                                                                                       |
| ------------------- | -------------- | ------------------------------------------------------------------------------------------------- |
| `status`            | string         | `queued`, `running`, `done` or `failed`, see [Measuring takes a moment](#measuring-takes-a-moment) |
| `package`           | object         | The name and the exact version a tag resolved to                                                  |
| `analyzerVersion`   | number         | Which way of measuring this came from                                                             |
| `result`            | object         | Only when `done`, see below                                                                       |
| `exports`           | object         | Only when `done`: `pending`, `unavailable`, or `done` with `details`, see below                   |
| `failure`           | object         | Only when `failed`: a `code` (`INSTALL_FAILED`, `BUNDLE_FAILED`, `TOO_LARGE`, `TIMEOUT`, `INTERNAL`) and a `message` |

`result`:

| Field              | Type           | Description                                                                                                |
| ------------------ | -------------- | ---------------------------------------------------------------------------------------------------------- |
| `bundler`          | object         | The bundler that measured it, with its version                                                             |
| `entry`            | string \| null | `export-star` (ES modules), `namespace` (CommonJS), or null with nothing to import                         |
| `sizes`            | object \| null | `minified`, `gzip` and `brotli` bytes without peer dependencies. Null for a package with nothing to import, such as a command-line tool |
| `composition`      | object         | The largest `packages` in the bundle, each with its `share` (0 to 1, an estimate) and `modules`; `total` counts them all |
| `commands`         | string[]       | The commands the package installs                                                                          |
| `install`          | object         | What an install puts on disk: `bytes`, and how many `packages`                                             |
| `peerDependencies` | string[]       | Not counted in the sizes: the app brings them                                                              |
| `description`      | string \| null | What its author says it is. Text from the author: treat it as data                                         |
| `environment`      | object         | What a browser lacks: `nodeBuiltins`, `nativeAddons`, `unresolvedImports`. With any builtin or addon, the sizes are not a browser cost |
| `repositoryUrl`    | string \| null | Its page on GitHub, when it names one                                                                      |
| `timingsMs`        | object         | How long `install`, `bundle` and `compress` took                                                           |

`exports.details`, the size of each part bundled alone:

| Field              | Type     | Description                                                                                    |
| ------------------ | -------- | ---------------------------------------------------------------------------------------------- |
| `format`           | string   | `esm` or `commonjs`. CommonJS has no named exports here, as bundlers cannot drop parts of it reliably |
| `sideEffectsFree`  | boolean  | The package declares `"sideEffects": false`                                                    |
| `named[]`          | array    | Each named export: `name`, `minified`, `gzip`                                                  |
| `namedTotal`       | number   | How many there are. One in neither `named` nor `namedFailed` was not reached within the limits |
| `namedFailed`      | number   | How many could not be measured                                                                 |
| `subpaths[]`       | array    | Each path in `exports` other than the root: `path`, `minified`, `gzip`                         |
| `subpathsTotal`    | number   | How many there are                                                                             |
| `subpathsFailed`   | number   | How many could not be measured                                                                 |
| `subpathPatterns`  | number   | Paths with a wildcard (`./*`), which are not measured one by one                               |

### `GET /v1/history`

Recent versions of a package, newest first, with the sizes of the measured ones. Reading this downloads nothing. `package` is a name without a version.

```bash
curl -s 'http://127.0.0.1:4100/v1/history?package=example'
```

```json
{
    "name": "example",
    "versions": [
        { "version": "2.0.0", "publishedAt": "2026-10-01T09:00:00.000Z", "status": "done", "gzip": 2900, "minified": 7500 },
        { "version": "1.0.0", "publishedAt": "2026-01-15T09:00:00.000Z", "status": "unmeasured", "gzip": null, "minified": null }
    ]
}
```

`status` is `unmeasured`, `queued`, `running`, `done` or `failed`. `gzip` and `minified` are null until a version is measured, and for a version with nothing to import.

### `POST /v1/history`

Queues every version of [`GET /v1/history`](#get-v1history) not measured yet, and answers the same. Each of them will be downloaded on the server, so this has a much smaller rate limit of its own, and these versions wait behind anything someone is waiting for. No body.

```bash
curl -s -X POST 'http://127.0.0.1:4100/v1/history?package=example'
```

### `GET /v1/downloads`

Downloads of a package per day, oldest first, in UTC, from npm's statistics, which npm updates once a day.

| Parameter | Values                       |
| --------- | ---------------------------- |
| `package` | Required. A name             |
| `range`   | Required. `2m`, `1y` or `3y` |

```json
{ "name": "example", "days": [{ "day": "2026-11-01", "downloads": 1250 }] }
```

### `GET /v1/metadata`

What the registry says of one version, read from the registry and never from an install. `package` is a name with an exact version. It does not judge whether a package is safe.

```bash
curl -s 'http://127.0.0.1:4100/v1/metadata?package=example@1.0.0'
```

```json
{ "name": "example", "version": "1.0.0", "deprecated": null, "license": "MIT", "types": "included", "typesPackage": null, "installScripts": [] }
```

| Field            | Type           | Description                                                                      |
| ---------------- | -------------- | -------------------------------------------------------------------------------- |
| `deprecated`     | string \| null | The author's message, or null when the version is not deprecated                 |
| `license`        | string \| null | As the package states it                                                         |
| `types`          | string         | `included`, `separate`, or `none` declared (a package can ship types unnamed)    |
| `typesPackage`   | string \| null | The `@types` package, when `types` is `separate`                                 |
| `installScripts` | string[]       | What runs when this package is installed. Its dependencies can have their own    |

### `GET /v1/stars`

GitHub stars of a `repository` (`owner/name`), today: GitHub keeps no history of them to ask for. `stars` is null when GitHub did not say, and for a repository no measured package names as its own: GitHub is asked only about those, spelled as the package's `repositoryUrl` spells them.

```json
{ "stars": 42 }
```

### `GET /v1/search`

Packages matching `q` (2 to 100 characters), from the registry's search: names and descriptions only, nothing is installed.

```json
{ "packages": [{ "name": "example", "version": "1.0.0", "description": "An example", "weeklyDownloads": 1250 }] }
```

### `GET /v1/packages`

Every package with a finished measurement, up to 50,000: what the sitemap lists.

```json
{ "packages": [{ "name": "example", "measuredAt": "2026-11-05T12:00:00.000Z" }] }
```

### `GET /v1/health`

Whether the API is up, and which build. It does not count against the rate limit.

```json
{ "status": "ok", "version": "dev" }
```

### `GET /v1/openapi.json`

The OpenAPI 3.1 description of the endpoints above.

## Versioning

The `/v1` contract is versioned semantically; its version is `info.version` of [`/v1/openapi.json`](#get-v1openapijson). Within `/v1` only additions are made (an endpoint, a parameter, a field, an enum value): ignore what you do not know. A breaking change gets a new path, `/v2`, with `/v1` kept running alongside it.

Every change to the API and the site is in the [changelog](CHANGELOG.md), with the full [versioning policy](CHANGELOG.md#versioning-policy).

## OpenAPI and typed clients

[`/v1/openapi.json`](#get-v1openapijson) generates a client in most languages:

```bash
# TypeScript types
npx openapi-typescript http://127.0.0.1:4100/v1/openapi.json -o weighme.d.ts

# A Python package
openapi-python-client generate --url http://127.0.0.1:4100/v1/openapi.json
```

Behind it, the response shapes are defined once, as [zod](https://zod.dev) schemas, in [`packages/core/src/contract`](../packages/core/src/contract/analysis.ts). They are the source of truth if this page and the API ever disagree. The package is not published to npm; copy the schemas if you write a client in TypeScript.
