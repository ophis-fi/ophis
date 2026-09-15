#[cfg(unix)]
use tokio::signal::unix::{self, SignalKind};
use {
    crate::{
        domain::solver,
        infra::{cli, config, dex},
    },
    clap::Parser,
    shared::arguments::tracing_config,
    std::net::SocketAddr,
    tokio::sync::oneshot,
};

pub async fn start(args: impl IntoIterator<Item = String>) {
    observe::panic_hook::install();
    let args = cli::Args::parse_from(args);
    run_with(args, None).await;
}

pub async fn run(
    args: impl IntoIterator<Item = String>,
    bind: Option<oneshot::Sender<SocketAddr>>,
) {
    let args = cli::Args::parse_from(args);
    run_with(args, bind).await;
}

async fn run_with(args: cli::Args, bind: Option<oneshot::Sender<SocketAddr>>) {
    let obs_config = observe::Config::new(
        &args.log,
        tracing::Level::ERROR.into(),
        args.use_json_logs,
        tracing_config(&args.tracing, "solvers".into()),
    );
    observe::tracing::init::initialize_reentrant(&obs_config);
    #[cfg(unix)]
    observe::heap_dump_handler::spawn_heap_dump_handler();

    let commit_hash = option_env!("VERGEN_GIT_SHA").unwrap_or("COMMIT_INFO_NOT_FOUND");

    tracing::info!(%commit_hash, "running solver engine with {args:#?}");

    let solver = match args.command {
        cli::Command::Baseline { config: path } => {
            let config = config::baseline::load(&path).await;
            solver::Solver::Baseline(solver::Baseline::new(config).await)
        }
        cli::Command::Okx { config: path } => {
            let config = config::dex::okx::file::load(&path).await;
            solver::Solver::Dex(Box::new(solver::Dex::new(
                dex::Dex::Okx(Box::new(
                    dex::okx::Okx::try_new(config.okx).expect("invalid OKX configuration"),
                )),
                config.base,
            )))
        }
        cli::Command::Bitget { config: path } => {
            let config = config::dex::bitget::file::load(&path).await;
            solver::Solver::Dex(Box::new(solver::Dex::new(
                dex::Dex::Bitget(
                    dex::bitget::Bitget::try_new(config.bitget)
                        .expect("invalid Bitget configuration"),
                ),
                config.base,
            )))
        }
        cli::Command::KyberSwap { config: path } => {
            let config = config::dex::kyberswap::file::load(&path).await;
            solver::Solver::Dex(Box::new(solver::Dex::new(
                dex::Dex::KyberSwap(Box::new(
                    dex::kyberswap::KyberSwap::try_new(config.kyberswap)
                        .expect("invalid KyberSwap configuration"),
                )),
                config.base,
            )))
        }
        cli::Command::Velora { config: path } => {
            let config = config::dex::velora::file::load(&path).await;
            solver::Solver::Dex(Box::new(solver::Dex::new(
                dex::Dex::Velora(Box::new(
                    dex::velora::Velora::try_new(config.velora)
                        .expect("invalid Velora configuration"),
                )),
                config.base,
            )))
        }
        cli::Command::OpenOcean { config: path } => {
            let config = config::dex::openocean::file::load(&path).await;
            solver::Solver::Dex(Box::new(solver::Dex::new(
                dex::Dex::OpenOcean(Box::new(
                    dex::openocean::OpenOcean::try_new(config.openocean)
                        .expect("invalid OpenOcean configuration"),
                )),
                config.base,
            )))
        }
        cli::Command::Dodo { config: path } => {
            let config = config::dex::dodo::file::load(&path).await;
            solver::Solver::Dex(Box::new(solver::Dex::new(
                dex::Dex::Dodo(Box::new(
                    dex::dodo::Dodo::try_new(config.dodo).expect("invalid DODO configuration"),
                )),
                config.base,
            )))
        }
        cli::Command::Lifi { config: path } => {
            let config = config::dex::lifi::file::load(&path).await;
            solver::Solver::Dex(Box::new(solver::Dex::new(
                dex::Dex::Lifi(Box::new(
                    dex::lifi::Lifi::try_new(config.lifi).expect("invalid LI.FI configuration"),
                )),
                config.base,
            )))
        }
        cli::Command::Pons { config: path } => {
            let config = config::dex::pons::file::load(&path).await;
            solver::Solver::Dex(Box::new(solver::Dex::new(
                dex::Dex::Pons(Box::new(
                    dex::pons::Pons::try_new(config.pons).expect("invalid pons configuration"),
                )),
                config.base,
            )))
        }
        cli::Command::Curve { config: path } => {
            let config = config::dex::curve::file::load(&path).await;
            let curve =
                dex::curve::Curve::try_new(config.curve).expect("invalid Curve configuration");
            curve
                .validate_onchain()
                .await
                .expect("Curve pool configuration does not match live contracts");
            solver::Solver::Dex(Box::new(solver::Dex::new(
                dex::Dex::Curve(Box::new(curve)),
                config.base,
            )))
        }
        cli::Command::Woofi { config: path } => {
            let config = config::dex::woofi::file::load(&path).await;
            solver::Solver::Dex(Box::new(solver::Dex::new(
                dex::Dex::Woofi(Box::new(
                    dex::woofi::Woofi::try_new(config.woofi).expect("invalid WOOFi configuration"),
                )),
                config.base,
            )))
        }
        cli::Command::Fx { config: path } => {
            let config = config::dex::fx::file::load(&path).await;
            solver::Solver::Dex(Box::new(solver::Dex::new(
                dex::Dex::Fx(Box::new(
                    dex::fx::Fx::try_new(config.fx).expect("invalid f(x) configuration"),
                )),
                config.base,
            )))
        }
        cli::Command::Enso { config: path } => {
            let config = config::dex::enso::file::load(&path).await;
            solver::Solver::Dex(Box::new(solver::Dex::new(
                dex::Dex::Enso(Box::new(
                    dex::enso::Enso::try_new(config.enso).expect("invalid Enso configuration"),
                )),
                config.base,
            )))
        }
        cli::Command::UniswapV4 { config: path } => {
            let config = config::dex::uniswap_v4::file::load(&path).await;
            solver::Solver::Dex(Box::new(solver::Dex::new(
                dex::Dex::UniswapV4(Box::new(
                    dex::uniswap_v4::UniswapV4::try_new(config.uniswap_v4)
                        .expect("invalid Uniswap V4 configuration"),
                )),
                config.base,
            )))
        }
        cli::Command::Ekubo { config: path } => {
            let config = config::dex::ekubo::file::load(&path).await;
            solver::Solver::Dex(Box::new(solver::Dex::new(
                dex::Dex::Ekubo(Box::new(
                    dex::ekubo::Ekubo::try_new(config.ekubo).expect("invalid Ekubo configuration"),
                )),
                config.base,
            )))
        }
        cli::Command::DirectV3 { config: path } => {
            let config = config::dex::direct_v3::file::load(&path).await;
            solver::Solver::Dex(Box::new(solver::Dex::new(
                dex::Dex::DirectV3(Box::new(
                    dex::direct_v3::DirectV3::try_new(config.direct_v3)
                        .expect("invalid direct V3 configuration"),
                )),
                config.base,
            )))
        }
        cli::Command::Up33 { config: path } | cli::Command::Velodrome { config: path } => {
            let config = config::dex::up33::file::load(&path).await;
            solver::Solver::Dex(Box::new(solver::Dex::new(
                dex::Dex::Up33(Box::new(
                    dex::up33::Up33::try_new(config.up33).expect("invalid UP33 configuration"),
                )),
                config.base,
            )))
        }
    };

    crate::api::Api {
        addr: args.addr,
        solver,
    }
    .serve(bind, shutdown_signal())
    .await
    .unwrap();
}

#[cfg(unix)]
async fn shutdown_signal() {
    // Intercept main signals for graceful shutdown.
    // Kubernetes sends sigterm, whereas locally sigint (ctrl-c) is most common.
    let mut interrupt = unix::signal(SignalKind::interrupt()).unwrap();
    let mut terminate = unix::signal(SignalKind::terminate()).unwrap();
    tokio::select! {
        _ = interrupt.recv() => (),
        _ = terminate.recv() => (),
    };
}

#[cfg(windows)]
async fn shutdown_signal() {
    // We don't support signal handling on Windows.
    std::future::pending().await
}

#[cfg(test)]
mod direct_route_smoke {
    use crate::{
        domain::{dex as model, eth, order},
        infra::{config, dex},
    };

    /// Exercises the shipped configuration and the actual Rust quoting path.
    /// Run explicitly with the three RPC environment variables; never broadcasts.
    #[tokio::test]
    #[ignore = "requires OP_MAINNET_RPC, UNICHAIN_RPC and ROBINHOOD_RPC"]
    async fn live_direct_routes() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../..");
        for (chain, id, name, kind, rpc_env, wrapped, buy) in [
            (
                "optimism",
                10,
                "velodrome",
                "v2",
                "OP_MAINNET_RPC",
                "0x4200000000000000000000000000000000000006",
                "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
            ),
            (
                "optimism",
                10,
                "velodrome-slipstream",
                "v3",
                "OP_MAINNET_RPC",
                "0x4200000000000000000000000000000000000006",
                "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
            ),
            (
                "unichain",
                130,
                "velodrome",
                "v2",
                "UNICHAIN_RPC",
                "0x4200000000000000000000000000000000000006",
                "0x7f9AdFbd38b669F03d1d11000Bc76b9AaEA28A81",
            ),
            (
                "unichain",
                130,
                "uniswap-v4",
                "v4",
                "UNICHAIN_RPC",
                "0x4200000000000000000000000000000000000006",
                "0x078D782b760474a361dDA0AF3839290b0EF57AD6",
            ),
            (
                "robinhood",
                4663,
                "pancakeswap",
                "v3",
                "ROBINHOOD_RPC",
                "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
                "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
            ),
            (
                "robinhood",
                4663,
                "ramses",
                "v3",
                "ROBINHOOD_RPC",
                "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
                "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
            ),
            (
                "robinhood",
                4663,
                "up33",
                "v2",
                "ROBINHOOD_RPC",
                "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
                "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
            ),
            (
                "robinhood",
                4663,
                "fables",
                "v4",
                "ROBINHOOD_RPC",
                "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
                "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
            ),
        ] {
            let text = std::fs::read_to_string(
                root.join(format!("infra/{chain}-mainnet/configs/{name}.toml.tmpl")),
            )
            .unwrap();
            let text = text.replace(
                &format!("http://rpc-proxy:4000/main/evm/{id}"),
                &std::env::var(rpc_env).expect(rpc_env),
            );
            let tmp = tempfile::NamedTempFile::new().unwrap();
            std::fs::write(tmp.path(), text).unwrap();
            let venue = match kind {
                "v2" => {
                    let c = config::dex::up33::file::load(tmp.path()).await;
                    dex::Dex::Up33(Box::new(dex::up33::Up33::try_new(c.up33).unwrap()))
                }
                "v3" => {
                    let c = config::dex::direct_v3::file::load(tmp.path()).await;
                    dex::Dex::DirectV3(Box::new(
                        dex::direct_v3::DirectV3::try_new(c.direct_v3).unwrap(),
                    ))
                }
                _ => {
                    let c = config::dex::uniswap_v4::file::load(tmp.path()).await;
                    dex::Dex::UniswapV4(Box::new(
                        dex::uniswap_v4::UniswapV4::try_new(c.uniswap_v4).unwrap(),
                    ))
                }
            };
            let amount = eth::U256::from(100_000_000_000_000u64);
            let order = model::Order {
                sell: wrapped.parse::<eth::Address>().unwrap().into(),
                buy: buy.parse::<eth::Address>().unwrap().into(),
                side: order::Side::Sell,
                amount: model::Amount::new(amount),
                buy_limit: Default::default(),
                owner: eth::Address::ZERO,
                solve_fee: Default::default(),
            };
            let swap = venue
                .swap(
                    &order,
                    &model::Slippage::one_percent(),
                    &crate::domain::auction::Tokens(Default::default()),
                    true,
                )
                .await
                .unwrap_or_else(|e| panic!("{chain}/{name}: {e:?}"));
            assert_eq!(swap.input.amount, amount);
            assert_eq!(swap.allowance.amount.get(), amount);
            assert!(!swap.output.amount.is_zero());
            assert_eq!(swap.calls.len(), 1);
            let minimum_word = match kind {
                "v2" => 1,
                "v3" if name == "pancakeswap" => 5,
                "v3" => 6,
                _ => 2,
            };
            let start = 4 + minimum_word * 32;
            let calldata_floor =
                eth::U256::from_be_slice(&swap.calls[0].calldata[start..start + 32]);
            assert!(
                calldata_floor == swap.output.amount,
                "{chain}/{name} quote output disagrees with driver-validated calldata"
            );
            // Tight signed limits must tighten the router floor on the solve path.
            let tight = model::Order {
                buy_limit: swap.output.amount * eth::U256::from(995) / eth::U256::from(1000),
                ..order
            };
            let bounded = venue
                .swap(
                    &tight,
                    &model::Slippage::one_percent(),
                    &crate::domain::auction::Tokens(Default::default()),
                    false,
                )
                .await
                .unwrap_or_else(|e| panic!("{chain}/{name} tight solve: {e:?}"));
            assert!(
                bounded.output.amount >= tight.buy_limit,
                "{chain}/{name} ignored signed limit"
            );
            eprintln!(
                "{chain}/{name}: {} -> {}",
                swap.input.amount, swap.output.amount
            );
        }
    }
}
