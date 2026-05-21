//! Banned user detection for order validation.
//!
//! Checks if addresses are banned using a hardcoded list and optionally the
//! Chainalysis Oracle on-chain registry. On-chain results are cached (1-hour
//! expiry, LRU eviction) with background refresh every 60 seconds.

use {
    alloy_primitives::Address,
    contracts::ChainalysisOracle,
    futures::future::join_all,
    moka::sync::Cache,
    std::{
        collections::HashSet,
        sync::Arc,
        time::{Duration, Instant},
    },
};

/// Sanctions-oracle observability (F6, 2026-05-21 whole-repo audit /
/// Codex Cyber HIGH).
///
/// The fail-open behavior on `Onchain::fetch` errors is INTENTIONAL: the
/// alternative (fail-closed, rejecting all orders during a Chainalysis
/// outage) is operationally worse than letting through a few requests
/// while the oracle recovers. The pre-F6 posture promoted these errors
/// from `warn` to `error` so they'd surface in log aggregators, but
/// there was no Prometheus signal — operators had to grep the live
/// stream to detect a sustained outage.
///
/// F6 closes that observability gap. This counter increments on every
/// Chainalysis fetch failure. Operators alert when its 5-minute rate
/// is non-zero (per-stack alert in observability/alerts.yml). The
/// behavior remains fail-open by design; this metric is the visibility
/// layer that lets the operator decide when to manually shift to
/// fail-closed via the kill-switch (a separate roadmap item).
#[derive(prometheus_metric_storage::MetricStorage, Clone, Debug)]
#[metric(subsystem = "sanctions")]
struct Metrics {
    /// Sanctions oracle (Chainalysis) fetch failures. Compliance-relevant
    /// fail-open: the address was NOT added to the ban set this cycle.
    ///
    /// `stage` distinguishes the two error paths:
    ///   - "background_refresh": cache-expiry refresh task
    ///   - "on_demand":          per-request fetch on cache miss
    #[metric(labels("stage"))]
    oracle_fetch_failed: prometheus::IntCounterVec,
}

impl Metrics {
    fn get() -> &'static Self {
        Metrics::instance(observe::metrics::get_storage_registry())
            .expect("Metrics instance")
    }
}

/// A list of banned users and an optional registry that can be checked onchain.
pub struct Users {
    list: HashSet<Address>,
    onchain: Option<Arc<Onchain>>,
}

#[derive(Clone)]
struct UserMetadata {
    is_banned: bool,
    last_updated: Instant,
}

/// Onchain banned user checker using Chainalysis Oracle with caching and
/// background refresh. Maintains a size-bounded LRU cache with periodic
/// maintenance to refresh expired entries.
struct Onchain {
    contract: ChainalysisOracle::Instance,
    cache: Cache<Address, UserMetadata>,
}

impl Onchain {
    pub fn new(contract: ChainalysisOracle::Instance, cache_max_size: u64) -> Arc<Self> {
        let onchain = Arc::new(Self {
            contract,
            cache: Cache::builder().max_capacity(cache_max_size).build(),
        });

        onchain.clone().spawn_maintenance_task();

        onchain
    }

    /// Spawns a background task that periodically checks the cache for expired
    /// entries and re-run checks for them.
    fn spawn_maintenance_task(self: Arc<Self>) {
        let cache_expiry = Duration::from_secs(60 * 60);
        let maintenance_timeout = Duration::from_secs(60);
        let detector = Arc::clone(&self);

        tokio::task::spawn(async move {
            loop {
                let start = Instant::now();

                let expired_data: Vec<_> = detector
                    .cache
                    .iter()
                    .filter_map(|(address, metadata)| {
                        let expired = start
                            .checked_duration_since(metadata.last_updated)
                            .unwrap_or_default()
                            >= cache_expiry - maintenance_timeout;

                        expired.then_some((address, metadata))
                    })
                    .collect();

                let results = join_all(expired_data.into_iter().map(|(address, metadata)| {
                    let detector = detector.clone();
                    async move {
                        match detector.fetch(*address).await {
                            Ok(result) => Some((
                                *address,
                                UserMetadata {
                                    is_banned: result,
                                    ..metadata
                                },
                            )),
                            Err(err) => {
                                // Compliance-relevant: a sanctions-oracle outage
                                // would silently let sanctioned addresses
                                // through if we treated this as a soft-warn.
                                // Promote to error so monitoring catches
                                // it. Behavior is still fail-open (address
                                // not added to ban set, cache not updated)
                                // — operators must decide on the compliance
                                // posture (fail-closed) per chain.
                                tracing::error!(
                                    address = ?*address,
                                    ?err,
                                    "sanctions-oracle background fetch failed \
                                     — address NOT added to ban set this cycle"
                                );
                                Metrics::get()
                                    .oracle_fetch_failed
                                    .with_label_values(&["background_refresh"])
                                    .inc();
                                None
                            }
                        }
                    }
                }))
                .await
                .into_iter()
                .flatten();

                detector.insert_many_into_cache(results);

                let remaining_sleep = maintenance_timeout
                    .checked_sub(start.elapsed())
                    .unwrap_or_default();
                tokio::time::sleep(remaining_sleep).await;
            }
        });
    }

    fn insert_many_into_cache(&self, addresses: impl Iterator<Item = (Address, UserMetadata)>) {
        let now = Instant::now();
        for (address, metadata) in addresses {
            self.cache.insert(
                address,
                UserMetadata {
                    last_updated: now,
                    ..metadata
                },
            );
        }
    }
}

impl Users {
    /// Creates a new `Users` instance that checks the hardcoded list and uses
    /// the given `web3` instance to determine whether an onchain registry of
    /// banned addresses is available.
    pub fn new(
        contract: Option<ChainalysisOracle::Instance>,
        banned_users: Vec<Address>,
        cache_max_size: u64,
    ) -> Self {
        Self {
            list: HashSet::from_iter(banned_users),
            onchain: contract.map(|instance| Onchain::new(instance, cache_max_size)),
        }
    }

    /// Creates a new `Users` instance that passes all addresses.
    pub fn none() -> Self {
        Self {
            list: HashSet::new(),
            onchain: None,
        }
    }

    /// Creates a new `Users` instance that passes all addresses except for the
    /// ones in `list`.
    pub fn from_set(list: HashSet<Address>) -> Self {
        Self {
            list,
            onchain: None,
        }
    }

    /// Returns a subset of addresses from the input iterator which are banned.
    ///
    /// On cache-misses, it will use the Chainalysis oracle to fetch the users.
    pub async fn banned(&self, addresses: impl IntoIterator<Item = Address>) -> HashSet<Address> {
        let mut banned = HashSet::new();

        let need_lookup = addresses
            .into_iter()
            .filter(|address| {
                if self.list.contains(address) {
                    banned.insert(*address);
                    false
                } else {
                    true
                }
            })
            // Need to collect here to make sure filter gets executed and we insert addresses
            .collect::<HashSet<_>>();

        let Some(onchain) = &self.onchain else {
            return banned;
        };
        let need_lookup: Vec<_> = {
            let mut filtered = Vec::new();
            for address in need_lookup {
                match onchain.cache.get(&address) {
                    Some(metadata) => {
                        metadata.is_banned.then(|| banned.insert(address));
                    }
                    None => {
                        filtered.push(address);
                    }
                }
            }
            filtered
        };

        let to_cache = join_all(
            need_lookup
                .into_iter()
                .map(|address| async move { (address, onchain.fetch(address).await) }),
        )
        .await;

        let now = Instant::now();
        for (address, result) in to_cache {
            match result {
                Ok(is_banned) => {
                    onchain.cache.insert(
                        address,
                        UserMetadata {
                            is_banned,
                            last_updated: now,
                        },
                    );
                    is_banned.then(|| banned.insert(address));
                }
                Err(err) => {
                    // Same compliance-relevant fail-open as the background
                    // task path — promote to error so operators detect
                    // sustained sanctions-oracle outages. See `update_cache`
                    // for the matching error path.
                    tracing::error!(
                        ?err,
                        ?address,
                        "sanctions-oracle fetch failed — address NOT added \
                         to ban set; investigate Chainalysis oracle health"
                    );
                    Metrics::get()
                        .oracle_fetch_failed
                        .with_label_values(&["on_demand"])
                        .inc();
                }
            }
        }
        banned
    }
}

impl Onchain {
    async fn fetch(&self, address: Address) -> Result<bool, alloy_contract::Error> {
        self.contract.isSanctioned(address).call().await
    }
}
