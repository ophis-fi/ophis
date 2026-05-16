pub const MAINNET: u64 = 1;
pub const GNOSIS: u64 = 100;
pub const SEPOLIA: u64 = 11155111;
pub const ARBITRUM_ONE: u64 = 42161;
pub const BASE: u64 = 8453;
pub const POLYGON: u64 = 137;
pub const AVALANCHE: u64 = 43114;
pub const BNB: u64 = 56;
pub const OPTIMISM: u64 = 10;
pub const LINEA: u64 = 59144;
pub const PLASMA: u64 = 9745;
pub const INK: u64 = 57073;
// Ophis: Hyperliquid HyperEVM mainnet — chain 999. Not in upstream
// cowprotocol/services. Registered here so HyperSwap V3 (the
// canonical UniV3-fork DEX on HL) gets a QuoterV2 deployment address
// the baseline solver can resolve via `UniswapV3QuoterV2::Instance::deployed`.
// Without this, `solvers/src/boundary/baseline.rs:233-236` silently
// drops every `Liquidity::Concentrated(pool)` because the quoter
// fails to instantiate.
pub const HYPEREVM: u64 = 999;
