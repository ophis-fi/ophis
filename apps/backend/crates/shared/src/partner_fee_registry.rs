//! In-memory snapshot of the self-serve partner-fee recipient registry
//! (partner-fees Phase A).
//!
//! The registry is the ingress source of truth for THIRD-PARTY partner-fee
//! recipients: the orderbook's app-data [`app_data::Validator`] and the
//! autopilot's `ProtocolFees` both consult it (via the [`RecipientPolicy`]
//! trait) so a fee to an unregistered or suspended recipient is rejected at
//! ingress and dropped defensively at fee computation.
//!
//! The snapshot is an [`ArcSwap`] refreshed on a fixed interval. On a refresh
//! failure the last good snapshot is kept (fail-safe: a transient DB blip never
//! bricks order ingestion, it just serves slightly stale registry data). This
//! crate stays free of a direct SQL dependency: the DB read is injected as a
//! loader closure by the orderbook / autopilot wiring, which own the pool.
//!
//! The Ophis partner-fee Safe (`app_data::PARTNER_FEE_RECIPIENT_ALLOWLIST`) is
//! always allowed regardless of registry contents, so an empty registry
//! reproduces the pre-registry behavior exactly (the flag-off posture).

use {
    alloy::primitives::Address,
    app_data::{AllowlistRecipientPolicy, MAX_THIRD_PARTY_VOLUME_BPS, RecipientPolicy},
    arc_swap::ArcSwap,
    observe::metrics,
    std::{collections::HashMap, future::Future, sync::Arc, time::Duration},
};

#[derive(prometheus_metric_storage::MetricStorage)]
struct Metrics {
    /// Current number of active third-party recipients in the snapshot. Ops
    /// alerts on unexpected growth (owner decision 16: registry-size alerts):
    /// a sudden spike is the signal that auto-activation is being abused.
    partner_fee_registry_active_recipients: prometheus::IntGauge,
    /// Increments whenever a scheduled refresh fails and the last snapshot is
    /// kept. A rising value means the registry is serving stale data.
    partner_fee_registry_refresh_failures: prometheus::IntCounter,
}

impl Metrics {
    fn get() -> &'static Self {
        Metrics::instance(metrics::get_storage_registry()).unwrap()
    }
}

/// A refreshable snapshot of the active partner-fee recipients and their
/// per-partner Volume-bps caps.
pub struct PartnerFeeRegistry {
    /// Active third-party recipient -> effective per-partner Volume-bps cap
    /// (already clamped to [`MAX_THIRD_PARTY_VOLUME_BPS`]). Never contains the
    /// Ophis Safe, which is handled by the always-allow base policy.
    snapshot: ArcSwap<HashMap<Address, u64>>,
}

impl PartnerFeeRegistry {
    /// A registry with no registered third parties. Until the first refresh
    /// populates it (and whenever the registry table is empty) only the Ophis
    /// Safe is allowed, matching the pre-registry behavior. This is the
    /// flag-off posture.
    pub fn empty() -> Self {
        Self {
            snapshot: ArcSwap::from_pointee(HashMap::new()),
        }
    }

    /// Builds a registry from an explicit set of active recipients (test /
    /// bootstrap helper). Caps are clamped to the program cap.
    pub fn with_recipients(recipients: impl IntoIterator<Item = (Address, u64)>) -> Self {
        let registry = Self::empty();
        registry.store(recipients.into_iter().collect());
        registry
    }

    /// Replaces the snapshot, clamping every cap to the 90 bps program cap.
    fn store(&self, recipients: Vec<(Address, u64)>) {
        let map: HashMap<Address, u64> = recipients
            .into_iter()
            .map(|(recipient, cap)| (recipient, cap.min(MAX_THIRD_PARTY_VOLUME_BPS)))
            .collect();
        Metrics::get()
            .partner_fee_registry_active_recipients
            .set(i64::try_from(map.len()).unwrap_or(i64::MAX));
        self.snapshot.store(Arc::new(map));
    }

    /// Runs the injected `loader` once and swaps in the result. Returns the
    /// loader's error without mutating the snapshot on failure (keep-last).
    pub async fn refresh<F, Fut>(&self, loader: &F) -> anyhow::Result<()>
    where
        F: Fn() -> Fut,
        Fut: Future<Output = anyhow::Result<Vec<(Address, u64)>>>,
    {
        let recipients = loader().await?;
        self.store(recipients);
        Ok(())
    }

    /// Spawns a background task that refreshes the snapshot every `interval`,
    /// keeping the last good snapshot on failure. The first refresh happens
    /// after `interval`; callers that need a warm snapshot before serving should
    /// `refresh` once up front.
    pub fn spawn<F, Fut>(self: Arc<Self>, interval: Duration, loader: F)
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = anyhow::Result<Vec<(Address, u64)>>> + Send,
    {
        tokio::task::spawn(async move {
            loop {
                tokio::time::sleep(interval).await;
                if let Err(err) = self.refresh(&loader).await {
                    Metrics::get().partner_fee_registry_refresh_failures.inc();
                    tracing::warn!(
                        ?err,
                        "partner-fee registry refresh failed; keeping last snapshot"
                    );
                }
            }
        });
    }

    /// Number of active third-party recipients currently in the snapshot.
    pub fn len(&self) -> usize {
        self.snapshot.load().len()
    }

    /// Whether the snapshot holds no registered third parties.
    pub fn is_empty(&self) -> bool {
        self.snapshot.load().is_empty()
    }
}

impl RecipientPolicy for PartnerFeeRegistry {
    fn allowed_volume_bps(&self, recipient: &Address) -> Option<u64> {
        // The Ophis Safe is always allowed at the uncapped validate ceiling,
        // regardless of registry contents.
        if let Some(cap) = AllowlistRecipientPolicy.allowed_volume_bps(recipient) {
            return Some(cap);
        }
        // Otherwise the recipient must be an active registered third party. Its
        // cap is already clamped to the program cap at store time.
        self.snapshot.load().get(recipient).copied()
    }
}

#[cfg(test)]
mod tests {
    use {super::*, app_data::OPHIS_PARTNER_FEE_RECIPIENT, std::sync::Mutex};

    const THIRD_PARTY: Address = Address::new([0xab; 20]);
    const OTHER: Address = Address::new([0xcd; 20]);

    #[test]
    fn empty_registry_allows_only_the_ophis_safe() {
        let registry = PartnerFeeRegistry::empty();
        // Ophis Safe always allowed.
        assert!(
            registry
                .allowed_volume_bps(&OPHIS_PARTNER_FEE_RECIPIENT)
                .is_some()
        );
        // No third party allowed (flag-off posture reproduces pre-registry
        // behavior).
        assert_eq!(registry.allowed_volume_bps(&THIRD_PARTY), None);
        assert!(registry.is_empty());
    }

    #[test]
    fn registered_third_party_is_allowed_at_its_capped_bps() {
        let registry = PartnerFeeRegistry::with_recipients([(THIRD_PARTY, 50)]);
        assert_eq!(registry.allowed_volume_bps(&THIRD_PARTY), Some(50));
        assert_eq!(registry.allowed_volume_bps(&OTHER), None);
        assert_eq!(registry.len(), 1);
    }

    #[test]
    fn caps_are_clamped_to_the_program_cap() {
        // Even if a manual DB edit set a cap above the 90 bps program cap, the
        // snapshot clamps it down.
        let registry = PartnerFeeRegistry::with_recipients([(THIRD_PARTY, 5_000)]);
        assert_eq!(
            registry.allowed_volume_bps(&THIRD_PARTY),
            Some(MAX_THIRD_PARTY_VOLUME_BPS)
        );
    }

    #[tokio::test]
    async fn refresh_swaps_the_snapshot_and_keeps_last_on_failure() {
        let registry = PartnerFeeRegistry::empty();
        // Toggle the loader between a successful load and a failure.
        let fail = Mutex::new(false);
        let loader = || {
            let should_fail = *fail.lock().unwrap();
            async move {
                if should_fail {
                    anyhow::bail!("boom")
                } else {
                    Ok(vec![(THIRD_PARTY, 50u64)])
                }
            }
        };

        registry.refresh(&loader).await.unwrap();
        assert_eq!(registry.allowed_volume_bps(&THIRD_PARTY), Some(50));

        // A subsequent failed refresh keeps the last good snapshot.
        *fail.lock().unwrap() = true;
        assert!(registry.refresh(&loader).await.is_err());
        assert_eq!(registry.allowed_volume_bps(&THIRD_PARTY), Some(50));
    }
}
