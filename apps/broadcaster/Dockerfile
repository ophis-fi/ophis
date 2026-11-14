FROM node:26.13.0-bookworm-slim@sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9

WORKDIR /opt/ophis/apps/broadcaster
COPY apps/broadcaster/package.json apps/broadcaster/pnpm-lock.yaml apps/broadcaster/.npmrc ./
COPY patches/elliptic@6.6.1.patch patches/zod@3.25.76.patch /opt/ophis/patches/
COPY apps/railgun/patches/ /opt/ophis/apps/railgun/patches/
RUN corepack pnpm install --prod --frozen-lockfile --ignore-scripts --store-dir /tmp/pnpm-store \
    && rm -rf /tmp/pnpm-store /root/.cache
COPY apps/broadcaster/dist/main.mjs ./dist/main.mjs
ARG OPHIS_BUNDLE_SHA256
RUN test -n "$OPHIS_BUNDLE_SHA256" && printf '%s  dist/main.mjs\n' "$OPHIS_BUNDLE_SHA256" | sha256sum -c - \
    && chmod 0444 dist/main.mjs package.json pnpm-lock.yaml
LABEL org.ophis.broadcaster.bundle-sha256=$OPHIS_BUNDLE_SHA256

USER node
ENTRYPOINT ["node", "--max-old-space-size=2048"]
CMD ["dist/main.mjs", "run"]
