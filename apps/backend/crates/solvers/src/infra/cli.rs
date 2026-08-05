//! CLI arguments for the `solvers` binary.

use {
    clap::{Parser, Subcommand},
    shared::arguments::TracingArguments,
    std::{net::SocketAddr, path::PathBuf},
};

/// Run a solver engine
#[derive(Parser, Debug)]
#[command(version)]
pub struct Args {
    /// The log filter.
    #[arg(
        long,
        env,
        default_value = "warn,solvers=debug,shared=debug,model=debug,solver=debug"
    )]
    pub log: String,

    /// Whether to use JSON format for the logs.
    #[clap(long, env, default_value = "false")]
    pub use_json_logs: bool,

    #[clap(flatten)]
    pub tracing: TracingArguments,

    /// The socket address to bind to.
    #[arg(long, env, default_value = "127.0.0.1:7872")]
    pub addr: SocketAddr,

    #[command(subcommand)]
    pub command: Command,
}

/// The solver engine to run. The config field is a path to the solver
/// configuration file. This file should be in TOML format.
#[derive(Subcommand, Debug)]
#[clap(rename_all = "lowercase")]
pub enum Command {
    /// solve individual orders exclusively via provided onchain liquidity
    Baseline {
        #[clap(long, env)]
        config: PathBuf,
    },
    /// solve individual orders via the OKX DEX aggregator API
    Okx {
        #[clap(long, env)]
        config: PathBuf,
    },
    /// solve individual orders using Bitget API
    Bitget {
        #[clap(long, env)]
        config: PathBuf,
    },
    /// solve individual orders via the KyberSwap aggregator API
    KyberSwap {
        #[clap(long, env)]
        config: PathBuf,
    },
    /// solve individual orders via the Velora (ParaSwap) aggregator API
    Velora {
        #[clap(long, env)]
        config: PathBuf,
    },
    /// solve individual orders via the OpenOcean aggregator API
    OpenOcean {
        #[clap(long, env)]
        config: PathBuf,
    },
    /// solve individual orders via the DODO aggregator API
    Dodo {
        #[clap(long, env)]
        config: PathBuf,
    },
    /// solve individual orders via the LI.FI aggregator API
    Lifi {
        #[clap(long, env)]
        config: PathBuf,
    },
    /// solve pons launch-token/WETH and token/WETH/token orders through pinned V3 contracts
    Pons {
        #[clap(long, env)]
        config: PathBuf,
    },
    /// redeem fxUSD through the native f(x) Protocol contracts on Ethereum
    Fx {
        #[clap(long, env)]
        config: PathBuf,
    },
    /// solve individual orders via the Enso aggregator API
    Enso {
        #[clap(long, env)]
        config: PathBuf,
    },
    /// solve Robinhood WETH/USDG orders directly through Uniswap V4
    UniswapV4 {
        #[clap(long, env)]
        config: PathBuf,
    },
}
