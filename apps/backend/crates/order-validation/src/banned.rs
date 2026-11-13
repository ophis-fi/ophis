//! Manual bans plus a periodically reloaded, freshness-checked OFAC snapshot.

use {
    alloy_primitives::Address,
    anyhow::{Context, Result, ensure},
    serde::Deserialize,
    std::{
        collections::HashSet,
        fs::File,
        io::Read,
        path::{Path, PathBuf},
        sync::{Arc, RwLock, RwLockReadGuard},
        time::{Duration, SystemTime, UNIX_EPOCH},
    },
};

#[derive(prometheus_metric_storage::MetricStorage, Clone, Debug)]
#[metric(subsystem = "sanctions")]
struct Metrics {
    /// UNIX timestamp of the last successfully downloaded and validated snapshot.
    snapshot_fetched_at: prometheus::IntGauge,
    /// Maximum age after which screening stops accepting orders.
    snapshot_max_age_seconds: prometheus::IntGauge,
    /// Failed reloads; the last validated snapshot remains subject to expiry.
    snapshot_reload_failed: prometheus::IntCounter,
}

impl Metrics {
    fn get() -> &'static Self {
        Self::instance(observe::metrics::get_storage_registry()).expect("sanctions metrics")
    }
}

#[derive(Deserialize)]
struct Snapshot {
    fetched_at: u64,
    source_sha256: String,
    addresses: HashSet<Address>,
}

impl Snapshot {
    fn ensure_fresh(&self, max_age: Duration) -> Result<()> {
        let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
        ensure!(
            now.checked_sub(self.fetched_at)
                .is_some_and(|age| age <= max_age.as_secs()),
            "OFAC snapshot is stale or future-dated"
        );
        Ok(())
    }

    fn read(path: &Path, max_age: Duration) -> Result<Self> {
        // Read past the bound to detect an oversized atomically replaced file.
        let mut bytes = Vec::new();
        File::open(path)?.take(1_048_577).read_to_end(&mut bytes)?;
        ensure!(bytes.len() <= 1_048_576, "OFAC snapshot exceeds 1 MiB");
        let snapshot: Self = serde_json::from_slice(&bytes).context("invalid OFAC snapshot")?;
        ensure!(!snapshot.addresses.is_empty(), "empty OFAC address list");
        ensure!(
            snapshot.source_sha256.len() == 64
                && snapshot
                    .source_sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit()),
            "invalid OFAC source digest"
        );
        snapshot.ensure_fresh(max_age)?;
        Ok(snapshot)
    }
}

struct FileList {
    path: PathBuf,
    max_age: Duration,
    snapshot: RwLock<Snapshot>,
}

impl FileList {
    fn current(&self) -> Result<RwLockReadGuard<'_, Snapshot>> {
        let snapshot = self
            .snapshot
            .read()
            .map_err(|_| anyhow::anyhow!("OFAC snapshot lock poisoned"))?;
        snapshot.ensure_fresh(self.max_age)?;
        Ok(snapshot)
    }

    fn reload(&self) -> Result<()> {
        let next = Snapshot::read(&self.path, self.max_age)?;
        let mut snapshot = self
            .snapshot
            .write()
            .map_err(|_| anyhow::anyhow!("OFAC snapshot lock poisoned"))?;
        ensure!(
            next.fetched_at >= snapshot.fetched_at,
            "OFAC snapshot download timestamp moved backwards"
        );
        Metrics::get()
            .snapshot_fetched_at
            .set(next.fetched_at.try_into()?);
        *snapshot = next;
        Ok(())
    }

    fn spawn(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(60)).await;
                let Some(list) = weak.upgrade() else { break };
                if let Err(err) = list.reload() {
                    // Retain validated data; current() still enforces its expiry.
                    Metrics::get().snapshot_reload_failed.inc();
                    tracing::error!(?err, path = ?list.path, "OFAC snapshot reload failed");
                }
            }
        });
    }
}

pub struct Users {
    list: HashSet<Address>,
    file: Option<Arc<FileList>>,
}

impl Users {
    pub fn new(
        banned_users: Vec<Address>,
        path: Option<PathBuf>,
        max_age: Duration,
    ) -> Result<Self> {
        ensure!(!max_age.is_zero(), "OFAC snapshot max age must be positive");
        let file = path
            .map(|path| {
                let snapshot = Snapshot::read(&path, max_age)?;
                Metrics::get()
                    .snapshot_fetched_at
                    .set(snapshot.fetched_at.try_into()?);
                Metrics::get()
                    .snapshot_max_age_seconds
                    .set(max_age.as_secs().try_into()?);
                let list = Arc::new(FileList {
                    path,
                    max_age,
                    snapshot: RwLock::new(snapshot),
                });
                list.spawn();
                Ok::<_, anyhow::Error>(list)
            })
            .transpose()?;
        Ok(Self {
            list: banned_users.into_iter().collect(),
            file,
        })
    }

    pub fn none() -> Self {
        Self::from_set(HashSet::new())
    }

    pub fn from_set(list: HashSet<Address>) -> Self {
        Self { list, file: None }
    }

    /// A different source digest invalidates auctions screened with the previous list.
    pub fn revision(&self) -> Result<Option<String>> {
        self.file
            .as_ref()
            .map(|file| Ok(file.current()?.source_sha256.clone()))
            .transpose()
    }

    pub async fn banned(
        &self,
        addresses: impl IntoIterator<Item = Address>,
    ) -> Result<HashSet<Address>> {
        let snapshot = self.file.as_ref().map(|file| file.current()).transpose()?;
        Ok(addresses
            .into_iter()
            .filter(|address| {
                self.list.contains(address)
                    || snapshot
                        .as_ref()
                        .is_some_and(|snapshot| snapshot.addresses.contains(address))
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use {super::*, alloy_primitives::address, serde_json::json, tempfile::NamedTempFile};

    const A: Address = address!("1111111111111111111111111111111111111111");
    const B: Address = address!("2222222222222222222222222222222222222222");
    const MANUAL: Address = address!("3333333333333333333333333333333333333333");
    const MAX_AGE: Duration = Duration::from_secs(86400);

    fn write(path: &Path, addresses: &[Address], fetched_at: u64, digest: char) {
        std::fs::write(path, serde_json::to_vec(&json!({
            "addresses": addresses, "fetched_at": fetched_at, "source_sha256": digest.to_string().repeat(64),
        })).unwrap()).unwrap();
    }

    fn now() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
    }

    #[tokio::test]
    async fn merges_manual_bans_and_applies_additions_and_removals() {
        let file = NamedTempFile::new().unwrap();
        write(file.path(), &[A], now(), 'a');
        let users = Users::new(vec![MANUAL], Some(file.path().to_owned()), MAX_AGE).unwrap();
        assert_eq!(
            users.banned([A, B, MANUAL]).await.unwrap(),
            HashSet::from([A, MANUAL])
        );
        let revision = users.revision().unwrap();
        write(file.path(), &[B], now(), 'b');
        users.file.as_ref().unwrap().reload().unwrap();
        assert_ne!(users.revision().unwrap(), revision);
        assert_eq!(
            users.banned([A, B, MANUAL]).await.unwrap(),
            HashSet::from([B, MANUAL])
        );
    }

    #[tokio::test]
    async fn retains_validated_data_until_expiry_then_errors_and_recovers() {
        let file = NamedTempFile::new().unwrap();
        write(file.path(), &[A], now(), 'a');
        let users = Users::new(vec![], Some(file.path().to_owned()), MAX_AGE).unwrap();
        let list = users.file.as_ref().unwrap();
        std::fs::write(file.path(), "not JSON").unwrap();
        assert!(list.reload().is_err());
        assert_eq!(users.banned([A]).await.unwrap(), HashSet::from([A]));
        list.snapshot.write().unwrap().fetched_at = now() - 86401;
        assert!(users.banned([A, B]).await.is_err());
        assert!(users.revision().is_err());
        write(file.path(), &[B], now(), 'b');
        list.reload().unwrap();
        assert_eq!(users.banned([A, B]).await.unwrap(), HashSet::from([B]));
    }

    #[tokio::test]
    async fn missing_stale_future_empty_malformed_and_oversized_snapshots_prevent_startup() {
        let file = NamedTempFile::new().unwrap();
        for (addresses, timestamp) in [
            (vec![A], now() - 86401),
            (vec![A], now() + 60),
            (vec![], now()),
        ] {
            write(file.path(), &addresses, timestamp, 'a');
            assert!(Users::new(vec![], Some(file.path().to_owned()), MAX_AGE).is_err());
        }
        for bytes in [b"bad JSON".to_vec(), vec![b' '; 1_048_577]] {
            std::fs::write(file.path(), bytes).unwrap();
            assert!(Users::new(vec![], Some(file.path().to_owned()), MAX_AGE).is_err());
        }
        assert!(Users::new(vec![], Some(file.path().with_extension("absent")), MAX_AGE).is_err());
        assert!(Users::new(vec![], None, Duration::ZERO).is_err());
    }

    #[tokio::test]
    async fn rejects_timestamp_rollback_without_clearing_manual_or_ofac_bans() {
        let file = NamedTempFile::new().unwrap();
        write(file.path(), &[A], now(), 'a');
        let users = Users::new(vec![MANUAL], Some(file.path().to_owned()), MAX_AGE).unwrap();
        write(file.path(), &[B], now() - 10, 'b');
        assert!(users.file.as_ref().unwrap().reload().is_err());
        assert_eq!(
            users.banned([A, B, MANUAL]).await.unwrap(),
            HashSet::from([A, MANUAL])
        );
    }
}
