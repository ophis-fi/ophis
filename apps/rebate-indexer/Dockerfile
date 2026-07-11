# syntax=docker/dockerfile:1.7

FROM node:24-alpine AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/rebate-indexer/package.json apps/rebate-indexer/
COPY packages/sdk/package.json packages/sdk/
# --ignore-scripts: do NOT run dependency lifecycle (postinstall) scripts inside the
# image build — this service runs the monthly WETH rebate batch, so a compromised
# transitive dep must not execute arbitrary code here. The indexer has no native deps
# that need build scripts (tsx/esbuild ship their native binary via platform-specific
# optional-dependency packages, which work at runtime without their postinstall).
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @ophis/rebate-indexer...

FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY --from=deps /app /app
COPY apps/rebate-indexer apps/rebate-indexer
COPY packages/sdk packages/sdk
COPY tsconfig.base.json ./
RUN pnpm --filter @ophis/rebate-indexer typecheck

FROM node:24-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache tini && corepack enable && corepack prepare pnpm@9.12.0 --activate
ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app/apps/rebate-indexer
EXPOSE 8080
ENTRYPOINT ["tini","--"]
CMD ["pnpm","start"]
