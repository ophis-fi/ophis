FROM docker.io/flyway/flyway:13.10.0 AS migrations
ARG OPHIS_GIT_SHA
RUN test "${#OPHIS_GIT_SHA}" -eq 40 && case "$OPHIS_GIT_SHA" in *[!0-9a-f]*) exit 1;; esac
LABEL org.opencontainers.image.revision=$OPHIS_GIT_SHA
COPY database/ /flyway/
CMD ["migrate"]

FROM docker.io/rust:1-slim-bookworm AS cargo-build
WORKDIR /src/

# Accept build arguments for enabling features
ARG CARGO_BUILD_FEATURES=""
ARG RUSTFLAGS=""

# Install dependencies
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked apt-get update && \
    apt-get install -y git libssl-dev pkg-config build-essential
# Install Rust toolchain. PINNED to an exact version (kept in sync with
# rust-toolchain). Using `stable` here caused build breakage: when a new stable
# was released while this layer was cached, the later `cargo build` triggered an
# in-place `stable` channel UPDATE whose cross-overlay rename fails with
# `Invalid cross-device link (os error 18)`. A fixed version is never updated
# mid-build, so the EXDEV churn cannot recur.
RUN rustup install 1.96.1 && rustup default 1.96.1

# Copy and Build Code
COPY . .

# Required for every binary: the context has no Git metadata. Never stamp a
# mutable tag or a caller's arbitrary release name as the source revision.
ARG OPHIS_GIT_SHA
ENV OPHIS_GIT_SHA=${OPHIS_GIT_SHA}

RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/src/target \
    CARGO_PROFILE_RELEASE_DEBUG=1 RUSTFLAGS="${RUSTFLAGS}" cargo build --locked --release \
    -p autopilot -p driver -p orderbook -p refunder -p solvers \
    ${CARGO_BUILD_FEATURES} && \
    cp target/release/autopilot / && \
    cp target/release/driver / && \
    cp target/release/orderbook / && \
    cp target/release/refunder / && \
    cp target/release/solvers /

# Create an intermediate image to extract the binaries
FROM docker.io/debian:bookworm-slim AS intermediate
ARG OPHIS_GIT_SHA
LABEL org.opencontainers.image.revision=$OPHIS_GIT_SHA
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked apt-get update && \
    apt-get install -y ca-certificates tini gettext-base && \
    apt-get clean && \
    groupadd --system --gid 10001 ophis && \
    useradd --system --uid 10001 --gid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin ophis

FROM intermediate AS autopilot
COPY --from=cargo-build /autopilot /usr/local/bin/autopilot
USER 10001:10001
ENTRYPOINT [ "autopilot" ]

FROM intermediate AS driver
COPY --from=cargo-build /driver /usr/local/bin/driver
USER 10001:10001
ENTRYPOINT [ "driver" ]

FROM intermediate AS orderbook
COPY --from=cargo-build /orderbook /usr/local/bin/orderbook
USER 10001:10001
ENTRYPOINT [ "orderbook" ]

FROM intermediate AS refunder
COPY --from=cargo-build /refunder /usr/local/bin/refunder
USER 10001:10001
ENTRYPOINT [ "refunder" ]

FROM intermediate AS solvers
COPY --from=cargo-build /solvers /usr/local/bin/solvers
USER 10001:10001
ENTRYPOINT [ "solvers" ]

# Extract Binary
FROM intermediate

RUN apt-get update && apt-get install -y netcat-openbsd
COPY --from=cargo-build /autopilot /usr/local/bin/autopilot
COPY --from=cargo-build /driver /usr/local/bin/driver
COPY --from=cargo-build /orderbook /usr/local/bin/orderbook
COPY --from=cargo-build /refunder /usr/local/bin/refunder
COPY --from=cargo-build /solvers /usr/local/bin/solvers
USER 10001:10001

ENTRYPOINT ["/usr/bin/tini", "-s", "--"]
