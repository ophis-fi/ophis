use {
    num::ToPrimitive,
    shared::arguments::DB_MAX_CONNECTIONS_DEFAULT,
    sqlx::{Executor, PgConnection, PgPool, postgres::PgPoolOptions},
    std::{
        num::{NonZeroU32, NonZeroUsize},
        time::Duration,
    },
    tracing::Instrument,
};

/// Default per-statement Postgres timeout. A slow query stalls the
/// run-loop indefinitely otherwise (sharp-edges follow-up: an outage
/// in the DB writes-path masquerades as a solver timeout from ops'
/// perspective). 30s matches the orderbook crate's default.
const STATEMENT_TIMEOUT_DEFAULT: Duration = Duration::from_secs(30);

mod auction;
pub mod auction_prices;
pub mod competition;
pub mod ethflow_events;
pub mod events;
pub mod fee_policies;
pub mod onchain_order_events;
pub mod order_events;
mod quotes;

pub const INSERT_BATCH_SIZE_DEFAULT: NonZeroUsize = NonZeroUsize::new(500).unwrap();

#[derive(Debug, Clone)]
pub struct Config {
    pub insert_batch_size: NonZeroUsize,
    pub max_pool_size: NonZeroU32,
    /// Maps directly to Postgres' `statement_timeout` GUC, applied as
    /// `SET statement_timeout = <ms>` on every connection acquired from
    /// the pool. Sharp-edges follow-up: pre-this-timeout an unbounded
    /// query (DB lock contention, network partition, replica lag)
    /// blocked the run-loop until the autopilot eventually surfaced
    /// `SettleError::Timeout`, masking the actual DB outage in ops
    /// alerts. With a 30s server-side timeout, slow queries fail
    /// loudly with `57014 query_canceled` and the existing
    /// `runloop_db_metric_error` counter fires immediately.
    pub statement_timeout: Duration,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            insert_batch_size: INSERT_BATCH_SIZE_DEFAULT,
            max_pool_size: DB_MAX_CONNECTIONS_DEFAULT,
            statement_timeout: STATEMENT_TIMEOUT_DEFAULT,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Postgres {
    pub pool: PgPool,
    pub config: Config,
}

impl Postgres {
    pub async fn new(url: &str, config: Config) -> sqlx::Result<Self> {
        // Pre-merge review hardening:
        //
        //   HIGH-2: `Duration::ZERO` would emit `SET statement_timeout = 0`,
        //           which Postgres interprets as "no limit" — silently
        //           reverting to pre-PR unbounded behavior. Floor to 1ms
        //           with a warn log so the misconfig is visible.
        //
        //   MED-4 (pgBouncer-safe): `SET statement_timeout = ...` is a
        //           session-level GUC. pgBouncer in transaction pooling
        //           mode rejects session SET. Swallow the error with a
        //           warn rather than crash the pool — autopilot in front
        //           of pgBouncer is a realistic deployment.
        let mut statement_timeout_ms =
            u64::try_from(config.statement_timeout.as_millis()).unwrap_or(u64::MAX);
        if statement_timeout_ms == 0 {
            tracing::warn!(
                "Config.statement_timeout was Duration::ZERO — Postgres would interpret \
                 SET statement_timeout = 0 as unlimited. Flooring to 1ms; fix your config."
            );
            statement_timeout_ms = 1;
        }
        let pool = PgPoolOptions::new()
            .max_connections(config.max_pool_size.get())
            .after_connect(move |conn, _meta| {
                Box::pin(async move {
                    let stmt = format!("SET statement_timeout = {statement_timeout_ms}");
                    if let Err(e) = conn.execute(stmt.as_str()).await {
                        tracing::warn!(
                            error = %e,
                            "could not apply SET statement_timeout — connection will run \
                             unbounded. Possible causes: pgBouncer in transaction pooling \
                             mode, or a Postgres role without SET permission."
                        );
                    }
                    Ok(())
                })
            })
            .connect(url)
            .await?;

        Self::start_db_metrics_job(pool.clone());

        Ok(Self { pool, config })
    }

    /// Acquire a connection without the global `statement_timeout` —
    /// for maintenance paths that legitimately exceed 30s (ANALYZE on
    /// multi-GB tables, batch DELETE on long-tail event tables).
    /// Issues `SET LOCAL statement_timeout = 0` inside a transaction
    /// the caller MUST commit/rollback; the LOCAL scope confines the
    /// override to that one transaction, so other handlers acquiring
    /// the same connection later (via pool recycling) keep the
    /// session-level guard.
    pub async fn begin_maintenance_tx(
        &self,
    ) -> sqlx::Result<sqlx::Transaction<'_, sqlx::Postgres>> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("SET LOCAL statement_timeout = 0")
            .execute(&mut *tx)
            .await?;
        Ok(tx)
    }

    fn start_db_metrics_job(pool: PgPool) {
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_secs(5));
            loop {
                ticker.tick().await;

                let Some(idle) = pool.num_idle().to_i64() else {
                    tracing::error!("Failed to get number of idle connections from the pool");
                    continue;
                };
                let active = i64::from(pool.size()) - idle;

                Metrics::get().active_connections.set(active);
                Metrics::get().idle_connections.set(idle);
            }
        });
    }

    pub async fn with_defaults() -> sqlx::Result<Self> {
        Self::new("postgresql://", Default::default()).await
    }

    pub async fn update_database_metrics(&self) -> sqlx::Result<()> {
        let metrics = Metrics::get();

        let mut ex = self.pool.acquire().await?;

        // update table row metrics
        for &table in database::TABLES {
            let count = count_rows_in_table(&mut ex, table).await?;
            metrics.table_rows.with_label_values(&[table]).set(count);
        }

        // update table row metrics
        for &table in database::LARGE_TABLES {
            let count = estimate_rows_in_table(&mut ex, table).await?;
            metrics.table_rows.with_label_values(&[table]).set(count);
        }

        Ok(())
    }

    pub async fn update_large_tables_stats(&self) -> sqlx::Result<()> {
        // ANALYZE on multi-GB tables routinely exceeds the 30s
        // session-level statement_timeout. Use the maintenance-tx
        // helper to scope a `SET LOCAL statement_timeout = 0` to
        // this work — other concurrent queries on the pool keep
        // the guard.
        let mut tx = self.begin_maintenance_tx().await?;
        for &table in database::LARGE_TABLES {
            let query = format!("ANALYZE {table};");
            sqlx::query(&query).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        Ok(())
    }
}

async fn count_rows_in_table(ex: &mut PgConnection, table: &str) -> sqlx::Result<i64> {
    let query = format!("SELECT COUNT(*) FROM {table};");
    sqlx::query_scalar(&query).fetch_one(ex).await
}

async fn estimate_rows_in_table(ex: &mut PgConnection, table: &str) -> sqlx::Result<i64> {
    let query = format!("SELECT reltuples::bigint FROM pg_class WHERE relname='{table}';");
    sqlx::query_scalar(&query).fetch_one(ex).await
}

#[derive(prometheus_metric_storage::MetricStorage)]
struct Metrics {
    /// Number of rows in db tables.
    #[metric(labels("table"))]
    table_rows: prometheus::IntGaugeVec,

    /// Timing of db queries.
    #[metric(
        name = "autopilot_database_queries",
        labels("type"),
        buckets(
            0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 20.0, 30.0, 40.0, 50.0,
            60.0, 70.0, 80.0, 90.0
        )
    )]
    database_queries: prometheus::HistogramVec,

    /// Number of active connections in the database pool.
    #[metric(name = "database_active_connections")]
    active_connections: prometheus::IntGauge,

    /// Number of idle connections in the database pool.
    #[metric(name = "database_idle_connections")]
    idle_connections: prometheus::IntGauge,
}

impl Metrics {
    fn get() -> &'static Self {
        Metrics::instance(observe::metrics::get_storage_registry()).unwrap()
    }
}

pub fn run_database_metrics_work(db: Postgres) {
    let span = tracing::info_span!("database_metrics");
    // Spawn the task for updating large table statistics
    tokio::spawn(update_large_tables_stats(db.clone()).instrument(span.clone()));
    // Spawn the task for database metrics
    tokio::task::spawn(database_metrics(db).instrument(span));
}

async fn database_metrics(db: Postgres) -> ! {
    loop {
        // The DB gets used a lot right after starting the system.
        // Since these queries are quite expensive we delay them
        // to improve the startup time of the system.
        tokio::time::sleep(Duration::from_secs(60)).await;
        if let Err(err) = db.update_database_metrics().await {
            tracing::error!(?err, "failed to update table rows metric");
        }
    }
}

async fn update_large_tables_stats(db: Postgres) -> ! {
    loop {
        if let Err(err) = db.update_large_tables_stats().await {
            tracing::error!(?err, "failed to update large tables stats");
        }
        tokio::time::sleep(Duration::from_secs(60 * 60)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore]
    async fn postgres_count_rows_in_table_() {
        let db = Postgres::with_defaults().await.unwrap();
        let mut ex = db.pool.begin().await.unwrap();
        database::clear_DANGER_(&mut ex).await.unwrap();

        let count = count_rows_in_table(&mut ex, "orders").await.unwrap();
        assert_eq!(count, 0);
        database::orders::insert_order(&mut ex, &Default::default())
            .await
            .unwrap();
        let count = count_rows_in_table(&mut ex, "orders").await.unwrap();
        assert_eq!(count, 1);
    }

    #[tokio::test]
    #[ignore]
    async fn postgres_statement_timeout_zero_is_floored_to_1ms() {
        // Regression for sharp-edges HIGH-2: Duration::ZERO must NOT
        // emit `SET statement_timeout = 0` (Postgres unlimited). The
        // floor + warn log ensures a misconfigured zero still cancels
        // slow queries.
        let config = Config {
            statement_timeout: Duration::ZERO,
            ..Default::default()
        };
        let db = Postgres::new("postgresql://", config).await.unwrap();
        let mut conn = db.pool.acquire().await.unwrap();
        let err = conn
            .execute("SELECT pg_sleep(1)")
            .await
            .expect_err("ZERO floor should still cancel slow queries");
        let db_err = err.as_database_error().expect("should be a database error");
        assert_eq!(db_err.code().as_deref(), Some("57014"));
    }

    #[tokio::test]
    #[ignore]
    async fn postgres_statement_timeout_cancels_slow_query() {
        // Mirror of `orderbook::database::tests::postgres_statement_timeout_cancels_slow_query`.
        // Verifies the per-connection `SET statement_timeout` is applied via
        // `after_connect` and triggers `57014 query_canceled` for queries that
        // exceed the budget.
        let config = Config {
            statement_timeout: Duration::from_millis(100),
            ..Default::default()
        };
        let db = Postgres::new("postgresql://", config).await.unwrap();
        let mut conn = db.pool.acquire().await.unwrap();

        // Fast query — succeeds.
        conn.execute("SELECT 1").await.unwrap();

        // Slow query — should fail with query_canceled.
        let err = conn
            .execute("SELECT pg_sleep(5)")
            .await
            .expect_err("should have timed out");
        let db_err = err.as_database_error().expect("should be a database error");
        assert_eq!(db_err.code().as_deref(), Some("57014")); // query_canceled
    }
}
