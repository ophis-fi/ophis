FROM node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1

# Pin the Bookworm APT security fix; disable the vulnerable retry path while upgrading.
RUN apt-get -o Acquire::Retries=0 update \
    && apt-get -o Acquire::Retries=0 install --yes --only-upgrade --no-install-recommends \
        apt=2.6.2 libapt-pkg6.0=2.6.2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/ophis/apps/broadcaster
COPY apps/broadcaster/package.json apps/broadcaster/pnpm-lock.yaml apps/broadcaster/.npmrc ./
COPY patches/zod@3.25.76.patch patches/picomatch@2.3.2.patch patches/picomatch@4.0.7.patch /opt/ophis/patches/
COPY apps/railgun/patches/ /opt/ophis/apps/railgun/patches/
RUN corepack pnpm install --prod --frozen-lockfile --ignore-scripts --store-dir /tmp/pnpm-store \
    && rm -rf /tmp/pnpm-store /root/.cache \
        /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v1.22.22 \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
        /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY apps/broadcaster/dist/main.mjs ./dist/main.mjs
ARG OPHIS_BUNDLE_SHA256
RUN test -n "$OPHIS_BUNDLE_SHA256" && printf '%s  dist/main.mjs\n' "$OPHIS_BUNDLE_SHA256" | sha256sum -c - \
    && chmod 0444 dist/main.mjs package.json pnpm-lock.yaml
LABEL org.ophis.broadcaster.bundle-sha256=$OPHIS_BUNDLE_SHA256

USER node
ENTRYPOINT ["node", "--max-old-space-size=2048"]
CMD ["dist/main.mjs", "run"]
