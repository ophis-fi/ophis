use {crate::tests, std::net::SocketAddr};

mod api_calls;
mod market_order;
mod not_found;
mod out_of_price;

/// Creates a temporary file containing the config of the given solver.
pub fn config(solver_addr: &SocketAddr) -> tests::Config {
    tests::Config::String(format!(
        r"
node-url = 'http://localhost:8545'
strict-market-output-simulation = 'off'
max-output-reference-factor = '1000000000000'
[dex]
chain-id = '1'
sell-orders-endpoint = 'http://{solver_addr}/'
api-project-id = '1'
api-key = '1234'
api-secret-key = '1234567890123456'
api-passphrase = 'pass'
",
    ))
}

/// Identical to [`config`] except that `buy-orders-endpoint` is ALSO set.
pub fn config_with_buy_orders(solver_addr: &SocketAddr) -> tests::Config {
    tests::Config::String(format!(
        r"
node-url = 'http://localhost:8545'
strict-market-output-simulation = 'off'
max-output-reference-factor = '1000000000000'
[dex]
chain-id = '1'
sell-orders-endpoint = 'http://{solver_addr}/'
buy-orders-endpoint = 'http://{solver_addr}/'
api-project-id = '1'
api-key = '1234'
api-secret-key = '1234567890123456'
api-passphrase = 'pass'
",
    ))
}
