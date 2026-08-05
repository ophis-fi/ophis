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
            let curve = dex::curve::Curve::try_new(config.curve)
                .expect("invalid Curve configuration");
            curve
                .validate_onchain()
                .await
                .expect("Curve pool configuration does not match live contracts");
            solver::Solver::Dex(Box::new(solver::Dex::new(
                dex::Dex::Curve(Box::new(curve)),
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
