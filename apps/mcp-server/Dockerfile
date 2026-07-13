# syntax=docker/dockerfile:1.7
#
# Standalone stdio build of the Ophis MCP server (for the Glama.ai registry /
# any MCP client that spawns a container). This runs plain Node + tsx, NOT
# workerd — the production Cloudflare Worker is unaffected (it ships from
# src/index.ts via wrangler, not this image). The server speaks MCP over stdio.

FROM node:24-alpine AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/mcp-server/package.json apps/mcp-server/
COPY packages/sdk/package.json packages/sdk/
# Workspace-scoped install: mcp-server + its workspace dep (@ophis/sdk) and their
# external deps only. The lockfile is committed, so install frozen.
RUN pnpm install --frozen-lockfile --filter @ophis/mcp-server...

FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY --from=deps /app /app
COPY apps/mcp-server apps/mcp-server
COPY packages/sdk packages/sdk
# packages/sdk/tsconfig.build.json extends the repo-root tsconfig.base.json.
COPY tsconfig.base.json ./
# Compile @ophis/sdk to dist/ — apps/mcp-server resolves it via the workspace
# package's "main" (./dist/index.js), so it must be built before runtime.
RUN pnpm --filter @ophis/sdk build

FROM node:24-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache tini && corepack enable && corepack prepare pnpm@9.12.0 --activate
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app /app
WORKDIR /app/apps/mcp-server
USER node
# No EXPOSE: the server speaks MCP over stdio, not HTTP. tini reaps the tsx/node
# child cleanly. Run via `docker run -i` so stdin/stdout carry the MCP channel.
ENTRYPOINT ["tini","--"]
CMD ["pnpm","exec","tsx","src/standalone.ts"]
