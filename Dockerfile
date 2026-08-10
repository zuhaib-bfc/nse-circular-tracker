# syntax=docker/dockerfile:1

# ── Build stage ────────────────────────────────────────────────────────────────
# better-sqlite3 is a native addon. Prebuilt binaries usually cover node:22-slim,
# but the toolchain is installed so the build still succeeds if it has to compile
# from source rather than failing at deploy time.
FROM node:22-slim AS builder

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy manifests first so the dependency layer caches across source-only changes.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop devDependencies (typescript, tsx, @types/*) from the tree we ship.
RUN npm prune --omit=dev


# ── Runtime stage ──────────────────────────────────────────────────────────────
# Same base as the builder so the compiled native binding stays ABI-compatible.
FROM node:22-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    # Cloud Run's only writable path is /tmp. STATE_BUCKET syncs this file to
    # Cloud Storage around each run; see src/storage/state.ts.
    DB_PATH=/tmp/data/circulars.db \
    # Affects log timestamps only — email bodies format IST explicitly.
    TZ=Asia/Kolkata

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json

# node:22-slim ships an unprivileged `node` user; never run as root.
USER node

# tini reaps zombies and forwards SIGTERM, so `apidoc`/`run` exit promptly and
# the daemon shuts down cleanly when Cloud Run stops the instance.
ENTRYPOINT ["/usr/bin/tini", "--", "node", "dist/cli.js"]

# Cloud Run Job default. Override per-job with `--args`, e.g. `--args=apidoc,check`.
# For a long-running service deployment instead, override the command to `start`.
CMD ["run"]
