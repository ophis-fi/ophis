use {
    crate::infra::{Ethereum, blockchain},
    eth_domain_types as eth,
    futures::FutureExt,
    itertools::Itertools,
    model::order::BUY_ETH_ADDRESS,
    request_sharing::BoxRequestSharing,
    std::{
        collections::HashMap,
        sync::{
            Arc, RwLock, RwLockReadGuard, RwLockWriteGuard,
            atomic::{AtomicBool, Ordering},
        },
    },
};

/// Logged-once gate for the token-metadata cache poison-recovery path.
static CACHE_POISON_LOGGED: AtomicBool = AtomicBool::new(false);

fn note_cache_poison() {
    if !CACHE_POISON_LOGGED.swap(true, Ordering::Relaxed) {
        tracing::error!(
            "tokens::Fetcher::cache RwLock was poisoned — a prior task panicked while \
             holding the lock. Recovering with potentially-inconsistent cache. \
             Investigate the originating panic in journald. \
             (this message logs once per process; clearing poison)"
        );
    }
}

/// Read cached token metadata, recovering from a poisoned lock.
fn read_token_cache(
    rw: &RwLock<HashMap<eth::TokenAddress, TokenInfo>>,
) -> RwLockReadGuard<'_, HashMap<eth::TokenAddress, TokenInfo>> {
    rw.read().unwrap_or_else(|e| {
        note_cache_poison();
        rw.clear_poison();
        e.into_inner()
    })
}

/// Discard potentially partial metadata after a poisoned write.
fn write_token_cache(
    rw: &RwLock<HashMap<eth::TokenAddress, TokenInfo>>,
) -> RwLockWriteGuard<'_, HashMap<eth::TokenAddress, TokenInfo>> {
    rw.write().unwrap_or_else(|e| {
        note_cache_poison();
        rw.clear_poison();
        let mut guard = e.into_inner();
        guard.clear();
        guard
    })
}

#[derive(Clone, Debug)]
pub struct Metadata {
    pub decimals: Option<u8>,
    pub symbol: Option<String>,
    /// Current balance of the smart contract.
    pub balance: eth::TokenAmount,
}

#[derive(Clone)]
pub struct Fetcher(Arc<Inner>);

impl Fetcher {
    pub fn new(eth: &Ethereum) -> Self {
        let eth = eth.with_metric_label("tokenInfos".into());
        let inner = Arc::new(Inner {
            eth,
            cache: RwLock::new(HashMap::new()),
            requests: BoxRequestSharing::labelled("token_info".into()),
            balances: BoxRequestSharing::labelled("token_balance".into()),
        });
        Self(inner)
    }

    /// Returns metadata and fresh balances, or the balance-read failure.
    /// Missing optional metadata must never imply a zero settlement balance.
    pub async fn get(
        &self,
        addresses: &[eth::TokenAddress],
    ) -> Result<HashMap<eth::TokenAddress, Metadata>, Arc<blockchain::Error>> {
        self.0.get(addresses).await
    }
}

#[cfg(test)]
mod poison_recovery_tests {
    use {super::*, std::panic::AssertUnwindSafe};

    #[test]
    fn read_write_cache_recover_after_poison() {
        let rw: RwLock<HashMap<eth::TokenAddress, TokenInfo>> = RwLock::new(HashMap::new());

        // Poison via panicking write.
        let _ = std::panic::catch_unwind(AssertUnwindSafe(|| {
            let _g = rw.write().unwrap();
            panic!("simulated panic with write lock held");
        }));
        assert!(rw.is_poisoned());

        // read_token_cache recovers.
        let r = read_token_cache(&rw);
        assert!(r.is_empty());
        drop(r);
        assert!(!rw.is_poisoned(), "read_token_cache must clear poison");

        // Re-poison via panicking read (rare but possible).
        let _ = std::panic::catch_unwind(AssertUnwindSafe(|| {
            let _g = rw.read().unwrap();
            panic!("simulated panic with read lock held");
        }));
        // Note: a read-side panic does NOT poison RwLock (read guards are
        // shared, no exclusive invariant). So is_poisoned should be false.
        assert!(
            !rw.is_poisoned(),
            "read-side panic should not poison RwLock"
        );

        // write_token_cache after a poisoning write also recovers AND
        // clears the cache (HIGH-2 guard: pre-clear, the map could
        // contain half-mutated entries from an interrupted write).
        let addr: eth::TokenAddress = eth::Address::repeat_byte(0x42).into();
        let stale = TokenInfo {
            decimals: Some(18),
            symbol: Some("STALE".into()),
        };
        rw.write().unwrap().insert(addr, stale);
        assert_eq!(rw.read().unwrap().len(), 1);

        let _ = std::panic::catch_unwind(AssertUnwindSafe(|| {
            let _g = rw.write().unwrap();
            panic!("simulated panic with write lock held (round 2)");
        }));
        assert!(rw.is_poisoned());
        let w = write_token_cache(&rw);
        assert!(
            w.is_empty(),
            "write_token_cache must CLEAR the cache on poison recovery — \
             otherwise partial metadata flows to the quoter"
        );
        drop(w);
        assert!(!rw.is_poisoned(), "write_token_cache must clear poison");
    }
}

/// Symbol and decimals can be cached without polling balances while idle.
#[derive(Clone, Debug, Default)]
struct TokenInfo {
    decimals: Option<u8>,
    symbol: Option<String>,
}

/// Provides metadata of tokens.
struct Inner {
    eth: Ethereum,
    cache: RwLock<HashMap<eth::TokenAddress, TokenInfo>>,
    requests: BoxRequestSharing<eth::TokenAddress, Option<(eth::TokenAddress, TokenInfo)>>,
    balances:
        BoxRequestSharing<eth::TokenAddress, Result<eth::TokenAmount, Arc<blockchain::Error>>>,
}

impl Inner {
    /// Fetches `Metadata` of the requested tokens from a node.
    async fn fetch_token_infos(
        &self,
        tokens: &[eth::TokenAddress],
    ) -> Vec<Option<(eth::TokenAddress, TokenInfo)>> {
        let futures = tokens.iter().map(|token| {
            let build_request = |token: &eth::TokenAddress| {
                let token = self.eth.erc20(*token);
                async move {
                    // Use `try_join` because these calls get batched under the hood
                    // so if one of them fails the others will as well.
                    // Also this way we won't get incomplete data for a token.
                    let (decimals, symbol) =
                        futures::future::try_join(token.decimals(), token.symbol())
                            .await
                            .ok()?;

                    Some((token.address(), TokenInfo { decimals, symbol }))
                }
                .boxed()
            };

            self.requests.shared_or_else(*token, build_request)
        });
        futures::future::join_all(futures).await
    }

    /// Ensures that all the missing tokens are in the cache afterwards while
    /// taking into account that the function might be called multiple times
    /// for the same tokens.
    async fn cache_missing_tokens(&self, tokens: &[eth::TokenAddress]) {
        if tokens.is_empty() {
            return;
        }

        let fetched = self.fetch_token_infos(tokens).await;
        {
            let cache = read_token_cache(&self.cache);
            if tokens.iter().all(|token| cache.contains_key(token)) {
                // Often multiple callers are racing to fetch the same Metadata.
                // If somebody else already cached the data we don't want to take an
                // exclusive lock for nothing.
                return;
            }
        }
        write_token_cache(&self.cache).extend(fetched.into_iter().flatten());
    }

    async fn get(
        &self,
        addresses: &[eth::TokenAddress],
    ) -> Result<HashMap<eth::TokenAddress, Metadata>, Arc<blockchain::Error>> {
        let to_fetch: Vec<_> = {
            let cache = read_token_cache(&self.cache);

            // Compute set of requested addresses that are not in cache.
            addresses
                .iter()
                // BUY_ETH_ADDRESS is just a marker and not a real address. We'll never be able to
                // fetch data for it so ignore it to avoid taking exclusive locks all the time.
                .filter(|address| !cache.contains_key(*address) && address.0.0 != BUY_ETH_ADDRESS)
                .cloned()
                .unique()
                .collect()
        };

        self.cache_missing_tokens(&to_fetch).await;

        let infos: Vec<_> = {
            let cache = read_token_cache(&self.cache);
            addresses
                .iter()
                .unique()
                .filter(|address| address.0.0 != BUY_ETH_ADDRESS)
                .map(|address| (*address, cache.get(address).cloned().unwrap_or_default()))
                .collect()
        };
        let settlement = *self.eth.contracts().settlement().address();
        // Optional metadata can be absent; balances must still be read. Propagate
        // failures so callers cannot mistake a missing entry for zero.
        let futures = infos.into_iter().map(|(address, info)| {
            let balance = self.balances.shared_or_else(address, |address| {
                let token = self.eth.erc20(*address);
                async move { token.balance(settlement).await.map_err(Arc::new) }.boxed()
            });
            async move {
                Ok((
                    address,
                    Metadata {
                        decimals: info.decimals,
                        symbol: info.symbol,
                        balance: balance.await?,
                    },
                ))
            }
        });
        futures::future::join_all(futures)
            .await
            .into_iter()
            .collect()
    }
}
