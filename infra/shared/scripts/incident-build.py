from pathlib import Path
p = Path("build-base/apps/backend/Dockerfile")
s = p.read_text()
start = s.index("RUN --mount=type=cache,target=/usr/local/cargo/registry")
end = s.index("# Create an intermediate image", start)
s = s[:start] + """ENV CARGO_BUILD_JOBS=2 CARGO_PROFILE_RELEASE_DEBUG=0
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/src/target \\
    cargo test --release --locked --lib -p driver robinhood_balance_floor_preserves_settlement_headroom && \\
    cargo build --release --locked -p driver && cp target/release/driver /

""" + s[end:]
p.write_text(s)
