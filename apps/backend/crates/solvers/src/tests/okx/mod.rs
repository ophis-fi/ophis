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
///
/// Exists so a test can isolate the effect of merely CONFIGURING OKX buy-mode:
/// this differs from [`config`] by exactly one line, so any behavioural
/// difference between a test using this and the same test using [`config`] is
/// attributable to the buy endpoint and nothing else.
///
/// Motivation: `market_order::buy_enabled` is quarantined because its V6 sell
/// leg stops issuing requests once buy-mode is configured. That left an open
/// question — is the SELL path broken by the mere presence of a buy endpoint,
/// or only by the buy-then-sell sequence? The sell path is live on Unichain, so
/// the difference matters. See `market_order::sell_with_buy_orders_configured`.
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
