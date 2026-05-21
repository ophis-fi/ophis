use {
    crate::{
        domain::{
            self,
            Mempools,
            competition::{
                order::app_data::AppDataRetriever,
                risk_detector::{self, bad_orders},
                sorting,
            },
        },
        infra::{
            self,
            Ethereum,
            config::file::OrderPriorityStrategy,
            liquidity,
            notify,
            solver::Solver,
            tokens,
        },
    },
    error::Error,
    futures::Future,
    observe::tracing::distributed::axum::{make_span, record_trace_id},
    simulator::Simulator,
    std::{net::SocketAddr, sync::Arc},
    tokio::sync::oneshot,
};

mod auth;
mod error;
mod extract;
pub mod routes;

pub struct Api {
    pub solvers: Vec<Solver>,
    pub liquidity: liquidity::Fetcher,
    pub liquidity_sources_notifier: notify::liquidity_sources::Notifier,
    pub simulator: Simulator,
    pub eth: Ethereum,
    pub mempools: Mempools,
    pub addr: SocketAddr,
    /// Audit MED-1 toggle: see `cli::Args::healthz_verbose`.
    pub healthz_verbose: bool,
    pub bad_token_detector: risk_detector::bad_tokens::Detector,
    /// F7 (2026-05-21 whole-repo audit, HIGH H2): optional inter-service
    /// auth token. When `Some`, all per-solver routes (/solve /reveal
    /// /settle /quote and the per-solver info root) require
    /// `Authorization: Bearer <token>`. When `None`, no auth is applied
    /// and a warning logs at startup. Caller (run.rs) reads
    /// `OPHIS_INTER_SERVICE_AUTH_TOKEN` from env.
    pub inter_service_auth_token: Option<Arc<String>>,
    /// If this channel is specified, the bound address will be sent to it. This
    /// allows the driver to bind to 0.0.0.0:0 during testing.
    pub addr_sender: Option<oneshot::Sender<SocketAddr>>,
}

impl Api {
    pub async fn serve(
        self,
        shutdown: impl Future<Output = ()> + Send + 'static,
        order_priority_strategies: Vec<OrderPriorityStrategy>,
        app_data_retriever: Option<AppDataRetriever>,
    ) -> Result<(), std::io::Error> {
        // Add middleware.
        let mut app = axum::Router::new();

        let balance_fetcher = account_balances::cached(
            self.eth.web3(),
            self.eth.balance_simulator().clone(),
            self.eth.current_block().clone(),
        );

        let tokens = tokens::Fetcher::new(&self.eth);
        let fetcher = Arc::new(domain::competition::DataAggregator::new(
            self.eth.clone(),
            app_data_retriever.clone(),
            self.liquidity.clone(),
            tokens.clone(),
            balance_fetcher,
        ));

        let order_sorting_strategies =
            Self::build_order_sorting_strategies(&order_priority_strategies);

        // Add the metrics, healthz, and gasprice endpoints. Healthz takes a
        // HealthcheckState (Ethereum + solver list — needed for audit H4.2
        // per-solver EOA balance check); gasprice keeps the plain Ethereum
        // state. Two separate state-bound merges since the state types differ.
        app = routes::metrics(app);

        let healthz_router = axum::Router::new();
        let healthz_router = routes::healthz(healthz_router);
        let healthz_state = routes::HealthcheckState {
            eth: self.eth.clone(),
            solvers: Arc::new(self.solvers.clone()),
            verbose: self.healthz_verbose,
        };
        app = app.merge(healthz_router.with_state(healthz_state));

        let gasprice_router = axum::Router::new();
        let gasprice_router = routes::gasprice(gasprice_router);
        app = app.merge(gasprice_router.with_state(self.eth.clone()));

        // F7: log whether inter-service auth is enforced. We log here
        // (not at struct construction) so the message appears in the
        // server's startup log next to "serving driver" — operators
        // grepping for the running mode see both lines together.
        let auth_token = self.inter_service_auth_token.clone();
        match &auth_token {
            Some(_) => tracing::info!(
                "F7 inter-service auth ENFORCED on per-solver routes \
                 (/solve /reveal /settle /quote / )"
            ),
            None => tracing::warn!(
                "F7 inter-service auth DISABLED — OPHIS_INTER_SERVICE_AUTH_TOKEN \
                 not set. Per-solver routes are reachable by anything on the \
                 docker network. Acceptable in single-tenant deployments; \
                 set the env var before Spec 8 or any multi-tenant expansion."
            ),
        }

        // Multiplex each solver as part of the API. Multiple solvers are multiplexed
        // on the same driver so only one liquidity collector collects the liquidity
        // for all of them. This is important because liquidity collection is
        // computationally expensive for the Ethereum node.
        for solver in self.solvers {
            let name = solver.name().clone();
            let router = axum::Router::new();
            let router = routes::info(router);
            let router = routes::quote(router);
            let router = routes::solve(router);
            let router = routes::reveal(router);
            let router = routes::settle(router);

            let bad_order_config = solver.bad_order_detection();
            let mut bad_tokens =
                risk_detector::Detector::new(bad_order_config.tokens_supported.clone());
            if bad_order_config.enable_simulation_strategy {
                bad_tokens.with_simulation_detector(self.bad_token_detector.clone());
            }

            if bad_order_config.enable_metrics_strategy {
                bad_tokens.with_metrics_detector(bad_orders::metrics::Detector::new(
                    bad_order_config.metrics_strategy_failure_ratio,
                    bad_order_config.metrics_strategy_required_measurements,
                    bad_order_config.metrics_strategy_log_only,
                    bad_order_config.metrics_strategy_order_freeze_time,
                    bad_order_config.metrics_strategy_cache_gc_interval,
                    bad_order_config.metrics_strategy_cache_max_age,
                    name.clone(),
                ));
            }

            let router = router.with_state(State(Arc::new(Inner {
                eth: self.eth.clone(),
                solver: solver.clone(),
                competition: domain::Competition::new(
                    solver,
                    self.eth.clone(),
                    self.liquidity.clone(),
                    self.liquidity_sources_notifier.clone(),
                    self.simulator.clone(),
                    self.mempools.clone(),
                    Arc::new(bad_tokens),
                    fetcher.clone(),
                    order_sorting_strategies.clone(),
                ),
                liquidity: self.liquidity.clone(),
                tokens: tokens.clone(),
            })));
            // F7: wrap the per-solver router with the auth middleware IF
            // the token was provided. Done before `nest()` so the middleware
            // applies to every route in the per-solver namespace (info,
            // quote, solve, reveal, settle). Global routes (/metrics,
            // /healthz, /gasprice) stay unauthenticated — Docker
            // healthchecks + Prometheus scrape don't carry the header.
            let router = if let Some(token) = &auth_token {
                router.layer(axum::middleware::from_fn_with_state(
                    token.clone(),
                    auth::require_inter_service_auth,
                ))
            } else {
                router
            };

            let path = format!("/{name}");
            infra::observe::mounting_solver(&name, &path);
            app = app.nest(&path, router);
        }

        app = app
            // axum's default body limit is 2MB too low for solvers, 20MB is still too low
            // so instead of constantly guessing and updating, we disable the limit altogether
            .layer(axum::extract::DefaultBodyLimit::disable())
            .layer(tower_http::decompression::RequestDecompressionLayer::new())
            .layer(
                tower::ServiceBuilder::new()
                    .layer(tower_http::trace::TraceLayer::new_for_http().make_span_with(make_span))
                    .map_request(record_trace_id),
            );

        // Start the server.
        let listener = tokio::net::TcpListener::bind(self.addr).await?;
        let local_addr = listener.local_addr()?;
        tracing::info!(port = local_addr.port(), "serving driver");
        if let Some(addr_sender) = self.addr_sender {
            addr_sender.send(local_addr).unwrap();
        }
        axum::serve(listener, app)
            .with_graceful_shutdown(shutdown)
            .await
    }

    fn build_order_sorting_strategies(
        order_priority_strategies: &[OrderPriorityStrategy],
    ) -> Vec<Arc<dyn sorting::SortingStrategy>> {
        let mut order_sorting_strategies = vec![];
        for strategy in order_priority_strategies {
            let comparator: Arc<dyn sorting::SortingStrategy> = match strategy {
                OrderPriorityStrategy::ExternalPrice => Arc::new(sorting::ExternalPrice),
                OrderPriorityStrategy::CreationTimestamp { max_order_age } => {
                    Arc::new(sorting::CreationTimestamp {
                        max_order_age: max_order_age
                            .map(|t| chrono::Duration::from_std(t).unwrap()),
                    })
                }
                OrderPriorityStrategy::OwnQuotes { max_order_age } => {
                    Arc::new(sorting::OwnQuotes {
                        max_order_age: max_order_age
                            .map(|t| chrono::Duration::from_std(t).unwrap()),
                    })
                }
            };
            order_sorting_strategies.push(comparator);
        }

        order_sorting_strategies
    }
}

#[derive(Clone)]
struct State(Arc<Inner>);

impl State {
    fn eth(&self) -> &Ethereum {
        &self.0.eth
    }

    fn solver(&self) -> &Solver {
        &self.0.solver
    }

    fn competition(&self) -> &Arc<domain::Competition> {
        &self.0.competition
    }

    fn liquidity(&self) -> &liquidity::Fetcher {
        &self.0.liquidity
    }

    fn tokens(&self) -> &tokens::Fetcher {
        &self.0.tokens
    }
}

struct Inner {
    eth: Ethereum,
    solver: Solver,
    competition: Arc<domain::Competition>,
    liquidity: liquidity::Fetcher,
    tokens: tokens::Fetcher,
}
