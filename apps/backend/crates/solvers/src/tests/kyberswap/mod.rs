use {crate::tests, std::net::SocketAddr};

mod api_calls;
mod market_order;
mod not_found;
mod out_of_price;

/// Build an inline TOML config pointing the KyberSwap solver at the given
/// mock-server address. The chain ID maps to whatever `chain_slug` returns,
/// but since the `endpoint` override is set explicitly, the slug is unused.
pub fn config(solver_addr: &SocketAddr) -> tests::Config {
    tests::Config::String(format!(
        r"
node-url = 'http://localhost:8545'
strict-market-output-simulation = 'off'
max-output-reference-factor = '1000000000000'
[dex]
chain-id = '10'
endpoint = 'http://{solver_addr}/'
client-id = 'test-client'
",
    ))
}
