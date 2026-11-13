# One Dockerfile, three images: `docker build --target worker .` (what `pnpm dev` runs), `--target backend` and
# `--target frontend` (the `app` profile of docker-compose.yml, `pnpm stack`).
#
# The worker installs npm packages to measure them, so it runs only here, where they stay on the container's own volume
# and never reach the machine it runs on.
#
# The Node and pnpm versions are the ones in .node-version and package.json: change them together (`pnpm policy` fails when they differ).
# The base image is pinned by digest: a re-pushed tag cannot change what is built.

FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS base
ENV PNPM_HOME=/pnpm CI=true COREPACK_HOME=/corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /repo
# pnpm through Corepack, which checks the download against the sha512 in package.json's `packageManager`: a changed
# tarball fails the build. The first run fetches pnpm's native binary (verified by pnpm itself) into this layer.
COPY package.json ./
RUN corepack enable pnpm && corepack install && pnpm --version

# The manifests only: copying them first keeps the install layers when only source changes. The lockfile covers every
# app, so every manifest is here. The pnpm store is a BuildKit cache shared by every build (`id=pnpm-store`), so a
# changed lockfile downloads only what is new.
FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/backend/package.json apps/backend/
COPY apps/cli/package.json apps/cli/
COPY apps/e2e/package.json apps/e2e/
COPY apps/frontend/package.json apps/frontend/
COPY apps/worker/package.json apps/worker/
COPY packages/core/package.json packages/core/

# ---- worker ----
FROM manifests AS worker-build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile --store-dir /pnpm/store --filter @weighme/worker...
COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY apps/worker apps/worker
# Only the production dependencies, with the built files, in one folder.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm --filter @weighme/worker build \
    && pnpm --filter @weighme/worker deploy --prod --prefer-offline --store-dir /pnpm/store /out/worker

FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS worker
# The worker installs packages with pnpm when it runs: the one Corepack verified in the base stage, as its native binary
# and not through Corepack's shim, which would obey the `packageManager` field of whatever package is being measured.
COPY --from=base /corepack/v1/pnpm /opt/pnpm
RUN ln -s /opt/pnpm/*/pnpm-native /usr/local/bin/pnpm && pnpm --version
ENV NODE_ENV=production WORKER_IN_CONTAINER=true WORKER_DIR=/work HOME=/work/home
WORKDIR /app
COPY --from=worker-build --chown=node:node /out/worker/package.json ./
COPY --from=worker-build --chown=node:node /out/worker/node_modules node_modules
COPY --from=worker-build --chown=node:node /out/worker/dist dist
# Everything it downloads, and pnpm's own state, lives on this volume. `pnpm worker:clean` removes it.
RUN mkdir /work && chown node:node /work
VOLUME /work
USER node
CMD ["node", "dist/main.worker.mjs"]

# ---- backend ----
FROM manifests AS backend-build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile --store-dir /pnpm/store --filter @weighme/backend...
COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY apps/backend apps/backend
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm --filter @weighme/backend build \
    && pnpm --filter @weighme/backend deploy --prod --prefer-offline --store-dir /pnpm/store /out/backend

FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS backend
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4100 DATABASE_PATH=/data/weighme.db
WORKDIR /app
COPY --from=backend-build --chown=node:node /out/backend/package.json ./
COPY --from=backend-build --chown=node:node /out/backend/node_modules node_modules
COPY --from=backend-build --chown=node:node /out/backend/dist dist
# What `/v1/health` reports: declared last, so a new value rebuilds nothing above.
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
# The database lives on a volume: a new image keeps every measurement.
RUN mkdir /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 4100
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/v1/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/main.api.mjs"]

# ---- frontend ----
FROM manifests AS frontend-build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile --store-dir /pnpm/store --filter @weighme/frontend...
# The browser calls the API at this address, and it is baked into the bundle: a build argument, not a runtime setting.
ARG VITE_API_URL=http://localhost:4100
ARG VITE_SITE_URL=http://localhost:3100
ARG VITE_ALLOW_INDEXING=false
ENV VITE_API_URL=$VITE_API_URL VITE_SITE_URL=$VITE_SITE_URL VITE_ALLOW_INDEXING=$VITE_ALLOW_INDEXING
COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY apps/frontend apps/frontend
# The /api, /mcp, /architecture and /changelog pages render the files of docs/ at build time.
COPY docs docs
RUN pnpm --filter @weighme/frontend build

FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS frontend
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3100
WORKDIR /app
# Nitro's output carries its own dependencies.
COPY --from=frontend-build --chown=node:node /repo/apps/frontend/.output .output
USER node
EXPOSE 3100
HEALTHCHECK --interval=15s --timeout=3s --start-period=15s --retries=5 CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/about').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", ".output/server/index.mjs"]
