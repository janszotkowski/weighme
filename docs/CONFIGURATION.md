# Configuration and self-hosting

Every setting of the backend, the worker and the frontend, and what it takes to run weighme on your own. For a step-by-step setup on a Hetzner server behind a Cloudflare Tunnel, follow [DEPLOY.md](../DEPLOY.md); to run it on your own computer, see [Development](DEVELOPMENT.md).

Contents: [Backend](#backend) · [Worker](#worker) · [Frontend](#frontend) · [Deployment](#deployment)

## Backend

The backend reads its settings from the environment once at start-up and refuses to start with a readable message when one is invalid. The full list, with defaults, is in [`apps/backend/src/config/env.ts`](../apps/backend/src/config/env.ts); [`apps/backend/.env.example`](../apps/backend/.env.example) is a starting point.

| Variable                                                            | Default                          | Meaning                                                                                                                                 |
| ------------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`, `HOST`                                                      | `4100`, `127.0.0.1`              | Where the API listens (on Linux, the worker in Docker needs more than `127.0.0.1`)                                                      |
| `DATABASE_PATH`                                                     | `./data/weighme.db`              | The SQLite file (created when missing); `:memory:` for tests                                                                            |
| `CORS_ORIGINS`                                                      | any localhost port (development) | Comma-separated origins of the frontend; required in production                                                                         |
| `WORKER_TOKEN`                                                      | none (required)                  | What the worker proves itself with (32+ characters); the example value is refused in production                                         |
| `INTERNAL_API_TOKEN`                                                | none                             | Shared with the frontend's server, so its rendering is limited per visitor (32+ characters); the example value is refused in production |
| `RATE_LIMIT_PER_MINUTE`                                             | `300`                            | Requests per caller per minute to `/v1/*` (health excepted)                                                                             |
| `RATE_LIMIT_RENDER_PER_MINUTE`                                      | `600`                            | Requests the frontend's rendering may make per minute for one visitor it names                                                          |
| `RATE_LIMIT_QUEUE_PER_MINUTE`                                       | `10`                             | Packages one caller may add to the queue per minute, and times it may queue a package's versions (`POST /v1/history`)                   |
| `MCP_ENABLED`                                                       | `true`                           | Offer the MCP server at `/v1/mcp`                                                                                                       |
| `RATE_LIMIT_MCP_PER_MINUTE`                                         | `60`                             | Requests to `/v1/mcp` per caller per minute, on top of the general limit                                                                |
| `RATE_LIMIT_MCP_TOTAL_PER_MINUTE`                                   | `1200`                           | Requests to `/v1/mcp` per minute for all callers together                                                                               |
| `CLIENT_IP_HEADER`                                                  | connection address               | Single-value header the proxy overwrites with the visitor's address (`cf-connecting-ip`, `x-real-ip`); `x-forwarded-for` is refused     |
| `QUEUE_MAX_WAITING`                                                 | `200`                            | Packages waiting at most; beyond it the API answers `503`                                                                               |
| `JOB_LEASE_SECONDS`, `JOB_MAX_ATTEMPTS`, `JOB_FAILED_RETRY_MINUTES` | `180`, `2`, `60`                 | How long a worker may be silent about a job, how often a package is retried, and when a failed one is measured again                    |
| `GITHUB_TOKEN`                                                      | none                             | Optional, for the stars in the trends table (60 questions an hour without it; no permissions needed)                                    |
| `LOG_LEVEL`                                                         | `info`                           | pino log level                                                                                                                          |

## Worker

The worker runs in Docker with the settings of [`docker-compose.yml`](../docker-compose.yml); the full list is in [`apps/worker/src/config/env.ts`](../apps/worker/src/config/env.ts): `BACKEND_URL`, `WORKER_TOKEN`, `WORKER_CONCURRENCY`, `JOB_TIMEOUT_MS`, `JOB_MEMORY_MB`, `MAX_INSTALL_BYTES`, `STORE_MAX_BYTES` and the like. `WORKER_IN_CONTAINER=true` must be set by the image; the worker refuses to run otherwise.

## Frontend

The frontend's settings are build-time (`VITE_*`, baked into the bundle) plus a few runtime variables for its server; [`apps/frontend/.env.example`](../apps/frontend/.env.example) is a starting point.

| Variable              | Meaning                                                                        |
| --------------------- | ------------------------------------------------------------------------------ |
| `VITE_API_URL`        | The API the browser calls (required for a build)                               |
| `VITE_SITE_URL`       | The public origin of the site (canonical links)                                |
| `VITE_ALLOW_INDEXING` | `true` only for the production build; everything else answers `noindex`        |
| `API_INTERNAL_URL`    | Runtime, server only: an internal address of the API for server-side rendering |
| `INTERNAL_API_TOKEN`  | Runtime, server only: the same token as the backend's                          |
| `CLIENT_IP_HEADER`    | Runtime, server only: the header with the visitor's address behind a proxy     |

## Deployment

The whole product is the API, the frontend, the worker and its network gateway as containers, with the measurements in one SQLite file on a volume. weighme has not been deployed yet, so none of this has been tried on a real server.

```bash
SITE_URL=https://pkg.example.org \
API_URL=https://api.pkg.example.org \
ALLOW_INDEXING=true \
WORKER_TOKEN=a-random-string-of-32-characters-or-more \
INTERNAL_API_TOKEN=another-random-string-of-32-characters-or-more \
BACKEND_URL=http://api:4100 \
docker compose --profile app up -d --build
```

[`docker-compose.yml`](../docker-compose.yml) builds the images from the [`Dockerfile`](../Dockerfile). The API refuses the example tokens in production. Compose caps the worker at 3 GB of memory and 2 processors, the API at 1 GB and the frontend at 512 MB. It publishes the API and the frontend on `127.0.0.1` only, so put a reverse proxy or a tunnel in front for TLS, and set `CLIENT_IP_HEADER` to the header it overwrites with the visitor's address (both services read it). `pnpm stack` runs the same locally in the foreground, and `pnpm stack:down` stops it.

Serverless platforms without Docker and a persistent disk do not fit: the database, the queue and the worker need long-lived processes.
