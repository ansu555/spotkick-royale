# syntax=docker/dockerfile:1

# Spotkick server image — Node 22, pnpm, non-root.
# Build context is the repository ROOT (Fly uses the app dir; see infra/fly.toml).
# Local dev backing services (Postgres/Redis/Anvil) are in infra/docker-compose.yml.
#
# The server runs TypeScript directly via `tsx`, so the runtime image keeps the
# source tree and devDependencies (tsx is a devDependency). `pnpm db:migrate`
# (used as Fly's release command) also runs `tsx src/db/migrate.ts`, so the image
# must carry server/drizzle/*.sql and server/src/db/migrate.ts.
#
# The server also imports the bit-exact shared reference at
# ../packages/shared/src/royale-math.ts (GET /api/fair/:id verification), so the
# image carries packages/shared/ (source + its node_modules, which provides viem).

# ---------------------------------------------------------------------------
# base — shared toolchain (installed once, inherited by every stage)
# ---------------------------------------------------------------------------
FROM node:22-slim AS base
ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH" \
    NODE_ENV="production" \
    PORT="8787"
# Install pnpm globally (deterministic; avoids corepack's on-first-run download).
RUN npm install --global pnpm@9
WORKDIR /app

# ---------------------------------------------------------------------------
# deps — install dependencies into a cacheable layer (server + shared reference)
# ---------------------------------------------------------------------------
FROM base AS deps
COPY server/package.json ./server/package.json
COPY server/pnpm-lock.yaml ./server/pnpm-lock.yaml
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/shared/pnpm-lock.yaml ./packages/shared/pnpm-lock.yaml
# Prefer the committed lockfiles; fall back to generating on first build.
RUN cd server && (pnpm install --frozen-lockfile || pnpm install)
RUN cd packages/shared && (pnpm install --frozen-lockfile || pnpm install)

# ---------------------------------------------------------------------------
# runtime — source + node_modules, run by an unprivileged user
# ---------------------------------------------------------------------------
FROM base AS runtime
RUN groupadd --system --gid 10001 spotkick \
    && useradd --system --uid 10001 --gid spotkick --home /app spotkick

WORKDIR /app/server
COPY --from=deps --chown=spotkick:spotkick /app/server/node_modules ./node_modules
COPY --chown=spotkick:spotkick server/package.json ./package.json
COPY --chown=spotkick:spotkick server/tsconfig.json ./tsconfig.json
COPY --chown=spotkick:spotkick server/src ./src
# SQL migrations applied by `pnpm db:migrate` (Fly release_command), and read at runtime by
# src/config/external.ts etc. via path.resolve relative to src/.
COPY --chown=spotkick:spotkick server/drizzle ./drizzle

# Shared reference (imported by src/fair/verifier.ts). Keep it at /app/packages/shared so the
# relative import ../packages/shared/src/royale-math(.js) resolves; it needs its own node_modules
# for `viem`. Layer deps first, then overlay the source + save-table.json from the build context.
COPY --from=deps --chown=spotkick:spotkick /app/packages/shared/node_modules /app/packages/shared/node_modules
COPY --chown=spotkick:spotkick packages/shared/package.json /app/packages/shared/package.json
COPY --chown=spotkick:spotkick packages/shared/src /app/packages/shared/src
COPY --chown=spotkick:spotkick packages/shared/save-table.json /app/packages/shared/save-table.json

USER spotkick
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "--import", "tsx", "src/main.ts"]