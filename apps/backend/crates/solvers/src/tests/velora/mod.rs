use {crate::tests, std::net::SocketAddr};

mod api_calls;
mod try_new;

/// Build an inline TOML config pointing the Velora solver at the given
/// mock-server address. Chain ID 10 (Optimism) is chosen because Velora
/// actually supports it; the `endpoint` override means no real network
/// call is made.
pub fn config(solver_addr: &SocketAddr) -> tests::Config {
    tests::Config::String(format!(
        r"
node-url = 'http://localhost:8545'
[dex]
chain-id = '10'
endpoint = 'http://{solver_addr}/'
partner = 'ophis-test'
",
    ))
}
