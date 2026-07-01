use {
    super::competition::solution::{GasFeeOverride, settlement},
    crate::{
        domain::{blockchain::TxStatus, competition::solution::Settlement},
        infra::{self, Ethereum, blockchain, observe},
    },
    alloy::{consensus::Transaction, eips::eip1559::Eip1559Estimation, sol_types::SolCall},
    anyhow::Context,
    contracts::CowSettlementForwarder::CowSettlementForwarder,
    eth_domain_types::{self as eth, BlockNo, TxId},
    ethrpc::block_stream::into_stream,
    futures::{FutureExt, StreamExt, future::select_ok},
    num::Saturating,
    thiserror::Error,
    tracing::Instrument,
};

/// Factor by how much a transaction fee needs to be increased to override a
/// pending transaction at the same nonce. The correct factor is actually
/// 12.5% but to avoid rounding issues on chains with very low gas prices
/// we increase slightly more.
const GAS_PRICE_BUMP_PCT: u64 = 13;

/// The gas amount required to cancel a transaction.
const CANCELLATION_GAS_AMOUNT: u64 = 21000;

/// How the settlement transaction should be submitted on-chain.
#[derive(Debug, Clone)]
pub enum SubmissionMode {
    /// Solver EOA signs and submits directly to the settlement contract.
    Direct(eth::Address),
    /// A dedicated submission EOA signs and pays for the tx while routing it
    /// through the solver's EIP-7702 delegated forwarder contract.
    Delegated {
        /// The address that signs the transaction and whose nonce is used.
        submitter_eoa: eth::Address,
        /// The solver EOA address. In EIP-7702 mode tx.to is set to this
        /// address (which delegates to a forwarder contract), instead of the
        /// settlement contract.
        solver_eoa: eth::Address,
    },
}

/// The mempools used to execute settlements.
#[derive(Debug, Clone)]
pub struct Mempools {
    mempools: Vec<infra::Mempool>,
    ethereum: Ethereum,
}

impl Mempools {
    pub fn try_new(mempools: Vec<infra::Mempool>, ethereum: Ethereum) -> Result<Self, NoMempools> {
        if mempools.is_empty() {
            Err(NoMempools)
        } else {
            Ok(Self { mempools, ethereum })
        }
    }

    pub async fn execute(
        &self,
        settlement: &Settlement,
        submission_deadline: BlockNo,
        mode: &SubmissionMode,
    ) -> Result<eth::TxId, Error> {
        let (submission, _remaining_futures) = select_ok(self.mempools.iter().map(|mempool| {
            async move {
                let result = self
                    .submit(mempool, settlement, submission_deadline, mode)
                    .instrument(tracing::info_span!("mempool", kind = mempool.to_string()))
                    .await;
                observe::mempool_executed(mempool, settlement, &result);
                result
            }
            .boxed()
        }))
        .await?;

        Ok(submission.tx_hash)
    }

    /// Defines if the mempools are configured in a way that guarantees that
    /// settled solution will not revert.
    pub fn revert_protection(&self) -> RevertProtection {
        match self
            .mempools
            .iter()
            .all(|mempool| mempool.reverts_can_get_mined())
        {
            true => RevertProtection::Disabled,
            false => RevertProtection::Enabled,
        }
    }

    async fn submit(
        &self,
        mempool: &infra::mempool::Mempool,
        settlement: &Settlement,
        submission_deadline: BlockNo,
        mode: &SubmissionMode,
    ) -> Result<SubmissionSuccess, Error> {
        // Don't submit risky transactions if revert protection is
        // enabled and the settlement may revert in this mempool.
        if settlement.may_revert()
            && matches!(self.revert_protection(), RevertProtection::Enabled)
            && mempool.reverts_can_get_mined()
        {
            return Err(Error::Disabled);
        }

        let tx = settlement.transaction(settlement::Internalization::Enable);
        let tx = prepare_submission(tx, mode);
        let signer = tx.from;

        // Instantiate block stream and skip the current block before we submit the
        // settlement. This way we only run iterations in blocks that can potentially
        // include the settlement.
        let mut block_stream = into_stream(self.ethereum.current_block().clone());
        block_stream.next().await;

        let current_block = self.ethereum.current_block().borrow().number;
        // The tx is simulated before submitting the solution to the competition, but a
        // delay between that and the actual execution can cause the simulation to be
        // invalid which doesn't make sense to submit to the mempool anymore.
        if mempool.reverts_can_get_mined() {
            if let Err(err) = self.ethereum.estimate_gas(tx.clone()).await {
                if err.is_revert() {
                    tracing::info!(
                        ?err,
                        "settlement tx simulation reverted before submitting to the mempool"
                    );
                    return Err(Error::SimulationRevert {
                        submitted_at_block: current_block.into(),
                        reverted_at_block: current_block.into(),
                    });
                } else {
                    tracing::warn!(
                        ?err,
                        "couldn't simulate tx before submitting to the mempool"
                    );
                }
            }
        } else {
            tracing::trace!("skipping tx simulation because mempool does not mine reverting txs");
        }

        // Fetch the nonce for the signing account (not the solver in 7702 mode).
        let nonce = mempool.get_nonce(signer).await?;

        // estimate the gas price such that the tx should still be included
        // even if the gas price increases the maximum amount until the submission
        // deadline
        let current_gas_price = self
            .ethereum
            .gas_price()
            .await
            .context("failed to compute current gas price")?;
        let submission_block = self.ethereum.current_block().borrow().number.into();
        let blocks_until_deadline = submission_deadline.saturating_sub(submission_block);

        // if there is still a tx pending we also have to make sure we outbid that one
        // enough to make the node replace it in the mempool
        let replacement_gas_price = self
            .minimum_replacement_gas_price(mempool, signer, nonce)
            .await;
        let final_gas_price = match &replacement_gas_price {
            Some(replacement_gas_price)
                if replacement_gas_price.max_fee_per_gas > current_gas_price.max_fee_per_gas =>
            {
                *replacement_gas_price
            }
            _ => current_gas_price,
        };

        let final_gas_price = apply_gas_fee_override(
            final_gas_price,
            settlement.gas_fee_override(),
            replacement_gas_price.as_ref(),
        );

        // Phase 4 audit F2: re-enforce gas_price_cap AFTER replacement bumping
        // and solver-override application. `gas.rs::estimate()` enforces the
        // cap on the first-submit path, but RBF (`minimum_replacement_gas_price`
        // scales by GAS_PRICE_BUMP_PCT) and solver overrides happen after that
        // check — without this guard, a pathological RPC misreport of
        // `eth_gasPrice` could push the bumped/overridden estimate above the
        // configured cap and drain the submitter EOA on a single broadcast.
        //
        // Submit-path is FAIL-CLOSED: the settle tx is 200-400k gas, so the
        // drain on a bad broadcast is significant. Aborting is correct; the
        // operator pages on the new `OphisOpGasPriceCapExceeded` alert and
        // intervenes. (See sharp-edges audit F3 for why cancel-path differs.)
        let final_gas_price = enforce_gas_price_cap_on_submit(final_gas_price, mempool)?;

        tracing::debug!(
            ?submission_block,
            ?blocks_until_deadline,
            ?replacement_gas_price,
            ?current_gas_price,
            ?final_gas_price,
            ?signer,
            "submitting settlement tx"
        );
        let hash = mempool
            .submit(
                tx.clone(),
                final_gas_price,
                settlement.gas.limit,
                signer,
                nonce,
            )
            .await?;

        // Wait for the transaction to be mined, expired or failing.
        let result = async {
            while let Some(block) = block_stream.next().await {
                tracing::debug!(?hash, current_block = ?block.number, "checking if tx is confirmed");
                let receipt = self
                    .ethereum
                    .transaction_status(&hash)
                    .await
                    .unwrap_or_else(|err| {
                        tracing::warn!(?hash, ?err, "failed to get transaction status",);
                        TxStatus::Pending
                    });
                match receipt {
                    TxStatus::Executed { block_number } => return Ok(SubmissionSuccess {
                        tx_hash: hash,
                        submitted_at_block: submission_block,
                        included_in_block: block_number,
                    }),
                    TxStatus::Reverted { block_number } => {
                        return Err(Error::Revert {
                            tx_id: hash,
                            submitted_at_block: submission_block,
                            reverted_at_block: block_number,
                        })
                    }
                    TxStatus::Pending => {
                        // Check if the current block reached the submission deadline block number
                        if BlockNo(block.number) >= submission_deadline {
                            tracing::debug!(
                                submission_deadline = submission_deadline.0,
                                current_block = block.number,
                                settle_tx_hash = ?hash,
                                "exceeded submission deadline, cancelling across all mempools"
                            );
                            // Phase 4 audit F4 (2026-05-21): broadcast the
                            // cancel to ALL configured mempools, not just
                            // this one. The original settle was broadcast
                            // via select_ok to every mempool in execute();
                            // a single-mempool cancel would leave other
                            // mempools' views of the network with the
                            // original settle pending. See cancel_all
                            // docstring for full rationale.
                            //
                            // But if the settlement landed right at the deadline
                            // (nonce already mined-consumed on-chain), cancelling
                            // is futile and only produces the spurious "nonce may
                            // be stuck" error — skip it. See the sim-revert branch
                            // below for the full rationale.
                            if self.nonce_already_mined(mempool, signer, nonce).await {
                                tracing::debug!(
                                    settle_tx_hash = ?hash,
                                    ?signer,
                                    ?nonce,
                                    "deadline exceeded but signer nonce already advanced on-chain — \
                                     the tx at this nonce already resolved (settlement landed, or a \
                                     prior cancel); skipping futile cancel_all"
                                );
                            } else if let Err(cancel_err) =
                                self.cancel_all(final_gas_price, signer, nonce, "deadline_exceeded").await
                            {
                                tracing::error!(
                                    ?cancel_err,
                                    ?signer,
                                    ?nonce,
                                    settle_tx_hash = ?hash,
                                    "cancel_all after deadline returned Err on every mempool — \
                                     signer nonce may be stuck across the entire stack"
                                );
                                // Sharp-edges H1 (PR #201 review): use the
                                // `cancel_all` sentinel rather than the calling
                                // mempool's label. The failure is a multi-mempool
                                // catastrophic outcome, not attributable to the
                                // mempool whose submit loop happened to surface
                                // it. The per-broadcast counter
                                // `submitter_cancel_broadcast_failed` carries
                                // the per-mempool granular attribution.
                                observe::metrics::get()
                                    .submitter_cancellation_failed
                                    .with_label_values(&["cancel_all", "deadline_exceeded"])
                                    .inc();
                            }
                            return Err(Error::Expired {
                                tx_id: hash,
                                submitted_at_block: submission_block,
                                submission_deadline,
                            });
                        }
                        // Check if transaction still simulates
                        if let Err(err) = self.ethereum.estimate_gas(tx.clone()).await {
                            if err.is_revert() {
                                // A re-sim revert here is AMBIGUOUS. Either the
                                // settlement genuinely can no longer be mined (a
                                // real failure — we must cancel to free the nonce),
                                // OR it ALREADY LANDED under a different hash (an
                                // RBF replacement, or a peer mempool's broadcast
                                // that select_ok has not yet surfaced) and its
                                // calldata now reverts against post-settlement
                                // state. In that latter case the nonce is already
                                // consumed on-chain, so cancel_all is FUTILE: every
                                // mempool's replacement is rejected "nonce too low",
                                // and the resulting "ALL mempools rejected -> nonce
                                // may be stuck" error is a FALSE alarm for a
                                // settlement that actually SUCCEEDED. Only cancel
                                // when the nonce is not yet mined-consumed.
                                if self.nonce_already_mined(mempool, signer, nonce).await {
                                    tracing::debug!(
                                        settle_tx_hash = ?hash,
                                        ?signer,
                                        ?nonce,
                                        "re-sim reverted but signer nonce already advanced on-chain \
                                         — the tx at this nonce already resolved (settlement landed, \
                                         or a prior cancel); skipping futile cancel_all"
                                    );
                                } else {
                                    tracing::info!(
                                        settle_tx_hash = ?hash,
                                        ?err,
                                        "tx started failing in mempool, cancelling across all mempools"
                                    );
                                    // Phase 4 audit F4 (2026-05-21): same
                                    // cross-mempool cancel rationale as the
                                    // deadline branch — see cancel_all docstring.
                                    if let Err(cancel_err) =
                                        self.cancel_all(final_gas_price, signer, nonce, "sim_revert").await
                                    {
                                        tracing::error!(
                                            ?cancel_err,
                                            ?signer,
                                            ?nonce,
                                            settle_tx_hash = ?hash,
                                            "cancel_all after sim-revert returned Err on every mempool — \
                                             signer nonce may be stuck across the entire stack"
                                        );
                                        // Sharp-edges H1: see deadline branch above
                                        // for the `cancel_all` sentinel rationale.
                                        observe::metrics::get()
                                            .submitter_cancellation_failed
                                            .with_label_values(&["cancel_all", "sim_revert"])
                                            .inc();
                                    }
                                }
                                return Err(Error::SimulationRevert {
                                    submitted_at_block: submission_block,
                                    reverted_at_block: block.number.into(),
                                });
                            } else {
                                tracing::warn!(?hash, ?err, "couldn't re-simulate tx");
                                let kind = match &err {
                                    blockchain::Error::Rpc(_) => {
                                        observe::metrics::resim_kind::TRANSPORT
                                    }
                                    blockchain::Error::GasPrice(_) => {
                                        observe::metrics::resim_kind::GAS_PRICE
                                    }
                                    _ => observe::metrics::resim_kind::OTHER,
                                };
                                observe::metrics::get()
                                    .resimulation_transport_error
                                    .with_label_values(&[&mempool.to_string(), kind])
                                    .inc();
                            }
                        }
                    }
                }
            }
            Err(Error::Other(anyhow::anyhow!(
                "Block stream finished unexpectedly"
            )))
        }
        .await;

        if result.is_err() {
            // Do one last attempt to see if the transaction was confirmed (in case of race
            // conditions or misclassified errors like `OrderFilled` simulation failures).
            if let Ok(TxStatus::Executed { block_number }) =
                self.ethereum.transaction_status(&hash).await
            {
                tracing::info!(
                    ?hash,
                    ?block_number,
                    "Found confirmed transaction, ignoring error"
                );
                return Ok(SubmissionSuccess {
                    tx_hash: hash,
                    included_in_block: block_number,
                    submitted_at_block: submission_block,
                });
            }
        }
        result
    }

    /// True if a transaction at `nonce` has already been MINED for `signer`
    /// (the account's latest transaction count exceeds `nonce`), so the nonce
    /// slot is filled on-chain — the settlement landed (possibly under a
    /// different hash via RBF or a peer mempool's broadcast), or a prior cancel
    /// did. When true, broadcasting another cancel at that nonce is futile: it
    /// is rejected "nonce too low", and the resulting cancel_all failure is a
    /// FALSE "nonce may be stuck" alarm for a settlement that actually
    /// succeeded. Read at LATEST (mined) so a `pending` count can't mistake the
    /// account's own un-mined submission for "already mined".
    ///
    /// Fail-safe: on lookup error returns `false` so the caller still cancels —
    /// better a futile cancel than a missed one on a genuinely stuck tx.
    async fn nonce_already_mined(
        &self,
        mempool: &infra::Mempool,
        signer: eth::Address,
        nonce: u64,
    ) -> bool {
        match mempool.get_mined_nonce(signer).await {
            Ok(mined_count) => mined_count > nonce,
            Err(err) => {
                tracing::debug!(
                    ?err,
                    ?signer,
                    ?nonce,
                    "could not read mined nonce to suppress a futile cancel; \
                     proceeding with cancel (fail-safe)"
                );
                false
            }
        }
    }

    /// Broadcast a cancellation transaction concurrently to ALL configured
    /// mempools.
    ///
    /// **Why this exists (Phase 4 audit F4, 2026-05-21):** `execute()` uses
    /// `select_ok` to broadcast the original settlement tx to every mempool
    /// in parallel. When one mempool's `submit()` loop later hits a cancel
    /// trigger (submission deadline exceeded or simulation reverted), the
    /// previous per-mempool `cancel()` only sent the cancellation to ONE
    /// mempool. The OTHER mempools' RPCs still had the original settle in
    /// their view of the pending pool. If a node downstream of those other
    /// RPCs processed the original settle BEFORE the single-mempool cancel
    /// propagated, the settlement could mine despite the operator intent
    /// to cancel — a race where the cancel "wins" only on one network
    /// view while the settle "wins" on another, and chain consensus picks
    /// whichever lands first.
    ///
    /// Broadcasting the cancel to ALL configured mempools concurrently
    /// maximizes the chance that every node's view receives a cancel
    /// before any node mines the original settle. Cancel and settle share
    /// the same nonce, so chain-level only one can land; the more mempool
    /// channels carry the cancel, the more likely it wins the race.
    ///
    /// **Behavior:**
    ///   - Per-mempool cancel calls run via `join_all` so all broadcasts
    ///     happen in parallel.
    ///   - Returns `Ok(tx_id)` with the first successful mempool's tx_id
    ///     as long as at least ONE mempool accepted the cancel.
    ///   - Returns `Err(last_failure)` only if ALL mempools rejected.
    ///   - Per-mempool failures increment `submitter_cancel_broadcast_failed`
    ///     so ops can alert on sustained partial-broadcast degradation.
    ///
    /// **Concurrent invocation:** rare in practice because `execute()`'s
    /// `select_ok` drops losing futures the moment the first one returns
    /// (Ok or Err). Concurrent cancel_all therefore only arises when
    /// multiple submit loops surface `Err(cancel_trigger)` within the same
    /// poll tick of select_ok — possible during a chain-wide stall where
    /// every mempool hits the deadline at the same block, but not the
    /// common case. Even when it happens, the broadcasts are idempotent at
    /// the network level: a duplicate cancel at the same nonce either RBFs
    /// (if the second's fee was bumped above the first's) or is rejected
    /// by the RPC as already-known. Both outcomes are harmless. Sharp-edges
    /// H2 (PR #201 review).
    ///
    /// **Trust model:** `infra::Mempool::submit()` treats a JSON-RPC ack as
    /// "broadcast accepted" — it does NOT independently verify network
    /// propagation. A compromised upstream RPC could ack the cancel without
    /// actually broadcasting it. cancel_all is no worse than the pre-F4
    /// `cancel()` in this respect (both rely on the same primitive), but
    /// the multi-broadcast posture means a SINGLE compromised RPC plus
    /// honest failures on the others could suppress the real cancel while
    /// making the driver log partial success. Mitigation requires a
    /// trusted-RPC quorum or cross-RPC propagation check — tracked as a
    /// separate hardening PR (option (c), defense-in-depth). Codex Cyber
    /// MED-2 (PR #201 review).
    #[tracing::instrument(skip(self), fields(num_mempools = self.mempools.len()))]
    async fn cancel_all(
        &self,
        original_tx_gas_price: Eip1559Estimation,
        signer: eth::Address,
        nonce: u64,
        cancel_reason: &'static str,
    ) -> Result<TxId, Error> {
        use futures::future::join_all;

        let futures = self.mempools.iter().map(|mempool| async move {
            let mempool_label = mempool.to_string();
            let result = self.cancel(mempool, original_tx_gas_price, signer, nonce).await;
            match &result {
                Ok(tx_id) => {
                    // Sharp-edges M2 (PR #201 review): forensic-grade per-
                    // mempool success log so post-incident the operator can
                    // reconstruct WHICH mempool's view accepted the cancel.
                    // The aggregate-level info! at the bottom of cancel_all
                    // only logs the first OK; this one logs every OK.
                    tracing::info!(
                        ?tx_id,
                        mempool = %mempool_label,
                        ?signer,
                        nonce,
                        reason = cancel_reason,
                        "cancel_all: per-mempool broadcast accepted"
                    );
                }
                Err(err) => {
                    tracing::warn!(
                        ?err,
                        mempool = %mempool_label,
                        ?signer,
                        nonce,
                        reason = cancel_reason,
                        "cancel_all: per-mempool broadcast failed; \
                         other mempools may still succeed"
                    );
                    observe::metrics::get()
                        .submitter_cancel_broadcast_failed
                        .with_label_values(&[&mempool_label, cancel_reason])
                        .inc();
                }
            }
            result
        });

        let results: Vec<Result<TxId, Error>> = join_all(futures).await;
        let total = results.len();
        let succeeded = results.iter().filter(|r| r.is_ok()).count();

        let aggregate = aggregate_cancel_broadcast_results(results);
        match &aggregate {
            Ok(tx_id) => tracing::info!(
                ?tx_id,
                succeeded,
                total,
                ?signer,
                nonce,
                reason = cancel_reason,
                "cancel_all: at least one mempool accepted the cancel; \
                 F4 race window minimized"
            ),
            Err(_) => tracing::error!(
                succeeded,
                total,
                ?signer,
                nonce,
                reason = cancel_reason,
                "cancel_all: ALL mempools rejected the cancel — \
                 signer nonce may be stuck across the entire stack"
            ),
        }
        aggregate
    }

    /// Cancel a pending settlement by sending a transaction to self with a
    /// slightly higher gas price than the existing one.
    async fn cancel(
        &self,
        mempool: &infra::mempool::Mempool,
        original_tx_gas_price: Eip1559Estimation,
        signer: eth::Address,
        nonce: u64,
    ) -> Result<TxId, Error> {
        let fallback_gas_price = original_tx_gas_price.scaled_by_pct(GAS_PRICE_BUMP_PCT);
        let replacement_gas_price = self
            .minimum_replacement_gas_price(mempool, signer, nonce)
            .await;

        // the node is the ultimate source of truth to compute the minimum
        // replacement gas price, but if that fails for whatever reason
        // we use our best estimate based on the originally submitted tx
        let final_gas_price = match &replacement_gas_price {
            Some(replacement) => *replacement,
            _ => fallback_gas_price,
        };

        // Phase 4 audit F2 + sharp-edges F3 (2026-05-21): observe-but-don't-abort
        // on the cancel path. The original settle tx is ALREADY broadcast at
        // this point — aborting the cancel here would leave the submitter EOA's
        // nonce blocked by the in-flight settle tx until either it mines or
        // gets evicted from the OP mempool (≥3h on default txpool.lifetime).
        // That nonce-stuck outcome is strictly worse than a cancel broadcast
        // exceeding the cap, because cancellation is 21000 gas (bounded $0.05
        // fee drain even at 1000 gwei) while a stuck nonce blocks all future
        // settlements from that signer. We page the operator via the same
        // alert/counter so the violation is investigated, but broadcast the
        // cancellation regardless.
        observe_cancel_cap_violation(final_gas_price, mempool);

        let cancellation = eth::Tx {
            from: signer,
            to: signer,
            value: 0.into(),
            input: Default::default(),
            access_list: Default::default(),
        };

        tracing::debug!(
            ?replacement_gas_price,
            ?fallback_gas_price,
            ?final_gas_price,
            "submitting cancellation tx"
        );

        mempool
            .submit(
                cancellation,
                final_gas_price,
                CANCELLATION_GAS_AMOUNT.into(),
                signer,
                nonce,
            )
            .await
    }

    /// Computes minimum price to replace the last tx that was submitted
    /// with the given nonce. Returns `None` if no tx was submitted with
    /// that nonce yet.
    #[tracing::instrument(skip_all)]
    async fn minimum_replacement_gas_price(
        &self,
        mempool: &infra::Mempool,
        signer: eth::Address,
        next_nonce: u64,
    ) -> Option<Eip1559Estimation> {
        if let Some(last_submission) = mempool.last_submission(signer) {
            if last_submission.nonce == next_nonce {
                Some(last_submission.gas_price.scaled_by_pct(GAS_PRICE_BUMP_PCT))
            } else {
                None
            }
        } else {
            // If we don't have the last submission in-memory (i.e. first submission
            // attempt after a restart) we try to inspect the nodes transaction mempool.
            // This is only done as a backup since it can incur significant latency and
            // is generally not very widely supported.
            //
            // Silent-failure-hunter F9 (2026-05-21): pre-this-comment the
            // `debug!` swallowed every txpool_content failure mode
            // indistinguishably — provider-rejection ("method not
            // available"), transient timeout, malformed response.
            // Providers like Alchemy / public CF endpoints reject the
            // Geth-only txpool_content_from outright; under those, the
            // function returns Ok(None) every time and the
            // minimum_replacement_gas_price lookup quietly degrades to
            // "no replacement floor known". On a driver restart, this
            // means we lose the chance to detect stuck pending txs
            // until manual operator intervention.
            //
            // Counter (`mempool_txpool_inspect_error`) is increment-
            // when-failing so ops can alert on sustained provider
            // un-support per mempool — the first occurrence indicates a
            // provider that doesn't speak `txpool_content_from`,
            // sustained occurrences flag transient degradation.
            let pending_tx = mempool
                .find_pending_tx_in_mempool(signer, next_nonce)
                .await
                .inspect_err(|err| {
                    observe::metrics::get()
                        .mempool_txpool_inspect_error
                        .with_label_values(&[&mempool.to_string()])
                        .inc();
                    tracing::debug!(?err, "could not inspect tx mempool")
                })
                .ok()??;

            let pending_tx_gas_price = Eip1559Estimation {
                max_fee_per_gas: pending_tx.max_fee_per_gas(),
                max_priority_fee_per_gas: pending_tx.max_priority_fee_per_gas().or_else(|| {
                    tracing::error!(tx = ?pending_tx.inner.tx_hash(), "pending tx is not EIP 1559");
                    None
                })?,
            };

            Some(pending_tx_gas_price.scaled_by_pct(GAS_PRICE_BUMP_PCT))
        }
    }
}

/// Re-enforce the per-mempool `gas_price_cap` AFTER all bumps and overrides
/// have been applied. `gas.rs::estimate()` enforces the cap on the first
/// estimate, but every code path that touches the gas price downstream of
/// that — `minimum_replacement_gas_price` (×1.13 RBF bump), the
/// `apply_gas_fee_override` solver override, the cancellation bump — can
/// push the final estimate above the configured cap. This function is the
/// last line of defense before `mempool.submit()` actually broadcasts.
///
/// **Submit-path semantics:** on cap-exceedance, returns
/// `Error::GasPriceCapExceeded`; the broadcast is aborted. The settlement
/// tx is gas-heavy (~200-400k gas) so the dollar drain on a bad broadcast
/// is significant — failing closed is correct.
fn enforce_gas_price_cap_on_submit(
    estimate: Eip1559Estimation,
    mempool: &infra::Mempool,
) -> Result<Eip1559Estimation, Error> {
    let cap = mempool.config().gas_price_cap;
    if let Some((computed, cap)) = check_cap(estimate, cap) {
        observe::metrics::get()
            .gas_price_cap_exceeded
            .with_label_values(&[&mempool.to_string(), "submit_settlement"])
            .inc();
        return Err(Error::GasPriceCapExceeded {
            computed,
            cap,
            context: "submit_settlement",
        });
    }
    Ok(estimate)
}

/// Same policy check as the submit path BUT on the cancel path we deliberately
/// **do NOT** abort the broadcast. Rationale (sharp-edges audit F3, 2026-05-21):
///
/// The cancel path is invoked when the original settle tx is already in-flight
/// and we've hit the submission deadline. Aborting the cancel here would:
///   1. Leave the original settle tx broadcast and pending in the OP mempool.
///   2. Block the submitter EOA's nonce until the original mines or the
///      mempool evicts it (≥ `txpool.lifetime`, typically 3h on OP).
///   3. Provide no recovery path — the operator must manually unstick from a
///      different EOA.
///
/// That nonce-stuck outcome is strictly worse than broadcasting a cancel that
/// exceeds the cap: a cancellation is 21000 gas, so even at 1000 gwei the
/// absolute drain is bounded (21000 × ~1000 gwei × ETH/gwei ≈ $0.05). The
/// fee-drain dollar amount is far smaller than the operational cost of a
/// stuck submitter EOA.
///
/// So on the cancel path: emit the same Prometheus counter + page the
/// operator (the alert fires), but PROCEED with the broadcast. The operator
/// sees the alert and investigates — either way the original tx is no
/// longer blocking the nonce.
fn observe_cancel_cap_violation(estimate: Eip1559Estimation, mempool: &infra::Mempool) {
    let cap = mempool.config().gas_price_cap;
    if let Some((computed, _)) = check_cap(estimate, cap) {
        observe::metrics::get()
            .gas_price_cap_exceeded
            .with_label_values(&[&mempool.to_string(), "cancel_settlement"])
            .inc();
        tracing::warn!(
            ?computed,
            ?cap,
            "cancel-path gas price exceeds configured cap; broadcasting anyway to avoid \
             nonce-stuck (audit F3) — operator alert fired"
        );
    }
}

/// Pure helper isolating the cancel-broadcast aggregation logic so it
/// can be unit-tested without constructing real `infra::Mempool`
/// instances. Returns `Ok(first_tx_id)` if at least one mempool's cancel
/// broadcast succeeded, `Err(last_failure)` if ALL mempools rejected.
///
/// **Semantics rationale (F4, 2026-05-21):** `cancel_all` succeeds as
/// long as the cancel reaches AT LEAST ONE mempool's RPC — because settle
/// and cancel share the same nonce, chain consensus will only mine one.
/// Maximizing the channels carrying the cancel maximizes the chance it
/// wins the race. Per-mempool failures are observable via
/// `submitter_cancel_broadcast_failed` for sustained-degradation
/// alerting; a single per-mempool failure does NOT make cancel_all fail.
///
/// **What `Ok(tx_id)` proves and what it does NOT prove (Codex MED-1,
/// PR #201 review):** an `Ok` means at least one mempool's RPC accepted
/// the cancel. It does NOT prove (a) the cancel propagated to the network
/// view of the mempool that builds the next block, or (b) the signer
/// nonce is globally unstuck. If another mempool's RPC still holds the
/// original settle pending and that mempool's view is the one a block
/// builder reads from, the settle can still mine. The race window is
/// SHRUNK by cancel_all, not eliminated.
///
/// **What `Err(..)` represents:** all mempools rejected the cancel. The bubbled
/// error is chosen by SEMANTIC PRIORITY (#219), not iteration position, so the
/// operator's log/alert line reflects the most representative cause (highest first):
/// - `Err("already known" / "already imported")` — the cancel tx is ALREADY PRESENT
///   in that mempool, i.e. the cancel propagated; healthiest signal, surfaced first
///   so a confirmed-present cancel isn't misreported as stuck (Codex #473).
/// - `Err("RPC degraded": timeout / connection / rate-limit / 5xx)` — the nonce may
///   be stuck across the stack (operator must intervene).
/// - unclassified rejection.
/// - `Err("nonce too low")` — the original settle ALREADY MINED (cancel is moot,
///   system healthy); least urgent.
///
/// Ties (same category) keep the last-in-order error, preserving the prior
/// representative-failure behavior. `submitter_cancel_broadcast_failed{reason}`
/// still increments per-mempool independently for correlation.
fn aggregate_cancel_broadcast_results(
    results: Vec<Result<TxId, Error>>,
) -> Result<TxId, Error> {
    if let Some(tx_id) = results.iter().find_map(|r| r.as_ref().ok().copied()) {
        return Ok(tx_id);
    }
    results
        .into_iter()
        .filter_map(Result::err)
        // max_by_key returns the LAST element among equal-priority ties, so a
        // same-category set bubbles the last error (prior positional behavior).
        .max_by_key(cancel_error_priority)
        .map_or_else(
            || {
                Err(Error::Other(anyhow::anyhow!(
                    "cancel_all: no mempools configured (Mempools::try_new should have rejected)"
                )))
            },
            Err,
        )
}

/// Semantic priority of a per-mempool cancel-broadcast failure (#219). Higher =
/// more actionable; the aggregator surfaces the highest. Classification is by
/// message substring because every cancel error arrives as `Error::Other(anyhow)`
/// (the infra mempool layer wraps them), so there is no typed variant to match.
///
/// **Definitive node verdicts are checked BEFORE the transient heuristic (Codex
/// #473 P2).** "already known" and "nonce too low" are unambiguous phrases the
/// node emits verbatim; they never appear incidentally in a transport error. A
/// bare HTTP status digit, by contrast, CAN appear incidentally — geth renders a
/// benign nonce rejection as "nonce too low: next nonce 430, tx nonce 429", whose
/// nonce VALUE (429) would trip a naive `contains("429")` transient match. By
/// classifying the node verdict first, a healthy "settle already mined" can never
/// be mis-promoted to an operator-actionable RPC degradation.
fn cancel_error_priority(err: &Error) -> u8 {
    let s = err.to_string().to_lowercase();
    // Accepted (HEALTHIEST): "already known" / "already imported" means the cancel
    // tx is ALREADY PRESENT in this mempool — the cancel propagated, so the settle
    // can't double-mine regardless of other mempools' transient errors. Surface it
    // preferentially so a confirmed-present cancel is NOT misreported as a stuck /
    // actionable failure (Codex #473): e.g. [already known, replacement underpriced]
    // bubbles the reassuring "already known", not the noisy unclassified error.
    if s.contains("already known") || s.contains("already imported") {
        return 3;
    }
    // NonceResolved (benign): the original settle already mined → cancel is moot.
    // Checked before the transient heuristic so an HTTP-status digit incidentally
    // present in the nonce/state values cannot promote it to actionable (Codex #473).
    if s.contains("nonce too low") || s.contains("nonce is too low") {
        return 0;
    }
    // Transient (RPC degraded): nonce may be stuck stack-wide → operator-actionable.
    if is_transient_rpc_error(&s) {
        return 2;
    }
    1 // Unknown — unclassified rejection
}

/// Detects a transient RPC/transport failure in an already-lowercased cancel-error
/// string. Direct transport cues (timeout, connection, rate limit) and unambiguous
/// HTTP reason phrases match on their own; bare numeric status codes match ONLY
/// alongside an explicit `http`/`status` cue AND as a standalone number, so an
/// incidental digit run — a nonce value, gas amount, or tx-hash fragment — is never
/// misread as a 4xx/5xx status (Codex #473 P2). alloy renders HTTP transport
/// failures as "HTTP error {code} with body: …", so the cue is present for real ones.
/// (`code` is deliberately NOT a cue: every JSON-RPC rejection contains "error code N".)
fn is_transient_rpc_error(s: &str) -> bool {
    // Direct transport cues + unambiguous HTTP reason phrases: "too many requests"
    // (429), "bad gateway" (502), "service unavailable" (503), "gateway time(-)out"
    // (504). These match on their own — no bare digit needed.
    if s.contains("timeout")
        || s.contains("timed out")
        || s.contains("connection")
        || s.contains("rate limit")
        || s.contains("too many requests")
        || s.contains("gateway")
        || s.contains("service unavailable")
    {
        return true;
    }
    let http_context = s.contains("http") || s.contains("status");
    http_context
        && ["429", "502", "503", "504"]
            .iter()
            .any(|code| contains_standalone_number(s, code))
}

/// True if the all-ASCII-digit `needle` occurs in `haystack` not flanked by other
/// ASCII digits — i.e. as a standalone number. "503" matches in "error 503 with"
/// but not inside "15030" or "5031", so a status code embedded in a longer value
/// (a port, gas amount, or hash digit run) is not falsely matched.
fn contains_standalone_number(haystack: &str, needle: &str) -> bool {
    haystack.match_indices(needle).any(|(i, _)| {
        let prev_is_digit = haystack[..i]
            .chars()
            .next_back()
            .is_some_and(|c| c.is_ascii_digit());
        let next_is_digit = haystack[i + needle.len()..]
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_digit());
        !prev_is_digit && !next_is_digit
    })
}

/// Pure helper isolating the cap-comparison logic so it can be unit-tested
/// without constructing a full `infra::Mempool` (which requires a real
/// Web3 transport). Returns `Some((computed, cap))` if the estimate is
/// above-policy, `None` otherwise.
///
/// **Compares `max(max_fee_per_gas, max_priority_fee_per_gas)` against the
/// cap.** Mirrors the invariant enforced in `gas.rs::estimate()` at line
/// 121-122 (`suggested_max_fee_per_gas = max(suggested, max_priority)`).
/// Without this, a solver-override that sets `max_priority_fee_per_gas`
/// arbitrarily high while keeping `max_fee_per_gas ≤ cap` would pass the
/// check, then be rejected by the node for violating `max_priority ≤
/// max_fee` (EIP-1559) — leaving the submitter EOA nonce-stuck silently
/// (no counter increments, no alert). Sharp-edges audit F1 (2026-05-21).
fn check_cap(estimate: Eip1559Estimation, cap: eth::U256) -> Option<(eth::U256, eth::U256)> {
    let max_fee = eth::U256::from(estimate.max_fee_per_gas);
    let max_priority = eth::U256::from(estimate.max_priority_fee_per_gas);
    let effective = std::cmp::max(max_fee, max_priority);
    (effective > cap).then_some((effective, cap))
}

#[cfg(test)]
mod tests {
    use {super::*, alloy::eips::eip1559::Eip1559Estimation};

    fn estimate(max_fee_per_gas: u128) -> Eip1559Estimation {
        Eip1559Estimation {
            max_fee_per_gas,
            max_priority_fee_per_gas: 0,
        }
    }

    #[test]
    fn check_cap_allows_below_cap() {
        let cap = eth::U256::from(5_000_000_000u128); // 5 gwei
        assert_eq!(check_cap(estimate(4_999_999_999), cap), None);
    }

    #[test]
    fn check_cap_allows_exactly_at_cap() {
        let cap = eth::U256::from(5_000_000_000u128);
        // At-cap submission is allowed — the cap is inclusive on the
        // upper bound (the legacy gas.rs check uses `>`, not `>=`).
        assert_eq!(check_cap(estimate(5_000_000_000), cap), None);
    }

    #[test]
    fn check_cap_rejects_above_cap() {
        let cap = eth::U256::from(5_000_000_000u128);
        let result = check_cap(estimate(5_000_000_001), cap);
        assert_eq!(
            result,
            Some((eth::U256::from(5_000_000_001u128), cap)),
        );
    }

    #[test]
    fn check_cap_rejects_far_above_cap() {
        // Simulates a hostile RPC reporting eth_gasPrice = 1000 gwei
        // and a subsequent RBF bump that pushes the final estimate to
        // ~1130 gwei, well above the 5 gwei policy cap.
        let cap = eth::U256::from(5_000_000_000u128);
        let computed = 1_130_000_000_000u128; // ~1130 gwei
        let result = check_cap(estimate(computed), cap);
        assert_eq!(result, Some((eth::U256::from(computed), cap)));
    }

    /// Sharp-edges audit F1 (2026-05-21): without checking
    /// `max_priority_fee_per_gas` against the cap, a solver-override that
    /// sets `max_priority` arbitrarily high while keeping `max_fee` under
    /// cap would pass the check, then be rejected by the node for violating
    /// EIP-1559 (`max_priority ≤ max_fee`) — silent nonce-stuck.
    #[test]
    fn check_cap_rejects_when_priority_fee_exceeds_cap() {
        let cap = eth::U256::from(5_000_000_000u128);
        let priority_above_cap = Eip1559Estimation {
            max_fee_per_gas: 1_000_000_000,    // 1 gwei — under cap
            max_priority_fee_per_gas: 6_000_000_000, // 6 gwei — over cap
        };
        let result = check_cap(priority_above_cap, cap);
        assert_eq!(
            result,
            Some((eth::U256::from(6_000_000_000u128), cap)),
            "max_priority_fee > cap must be rejected even when max_fee ≤ cap"
        );
    }

    #[test]
    fn check_cap_uses_max_of_fee_and_priority() {
        // When both fields are under cap, allow it.
        let cap = eth::U256::from(5_000_000_000u128);
        let both_under = Eip1559Estimation {
            max_fee_per_gas: 4_000_000_000,
            max_priority_fee_per_gas: 4_500_000_000,
        };
        assert_eq!(check_cap(both_under, cap), None);
    }

    // ── F4 cross-mempool cancel aggregator tests (2026-05-21) ──────────────

    fn tx(byte: u8) -> TxId {
        TxId(alloy::primitives::B256::repeat_byte(byte))
    }

    fn rpc_err(msg: &'static str) -> Error {
        Error::Other(anyhow::anyhow!(msg))
    }

    /// Single-mempool config (N=1): aggregator behavior must be identical to
    /// the pre-F4 single-mempool cancel — Ok in → Ok out, Err in → Err out.
    #[test]
    fn aggregate_n1_passes_through_ok() {
        let result = aggregate_cancel_broadcast_results(vec![Ok(tx(0x42))]);
        assert!(matches!(&result, Ok(t) if t.0 == tx(0x42).0));
    }

    #[test]
    fn aggregate_n1_passes_through_err() {
        let result = aggregate_cancel_broadcast_results(vec![Err(rpc_err("nonce too low"))]);
        assert!(matches!(result, Err(Error::Other(_))));
    }

    /// Multi-mempool happy path: every cancel broadcast succeeded.
    /// Aggregator returns the first OK tx_id.
    #[test]
    fn aggregate_all_ok_returns_first_tx_id() {
        let results = vec![Ok(tx(0xAA)), Ok(tx(0xBB)), Ok(tx(0xCC))];
        let aggregate = aggregate_cancel_broadcast_results(results);
        assert!(matches!(&aggregate, Ok(t) if t.0 == tx(0xAA).0));
    }

    /// Mixed outcomes: at least one mempool accepted the cancel. F4 race
    /// is closed — aggregator returns the first OK, ignoring earlier Errs.
    #[test]
    fn aggregate_mixed_returns_first_ok_skipping_errs() {
        let results = vec![
            Err(rpc_err("mempool A rejected")),
            Ok(tx(0xBB)),
            Err(rpc_err("mempool C rejected")),
        ];
        let aggregate = aggregate_cancel_broadcast_results(results);
        assert!(
            matches!(&aggregate, Ok(t) if t.0 == tx(0xBB).0),
            "aggregator must return the first successful broadcast even when \
             earlier mempools rejected (F4 race-closing semantics)"
        );
    }

    /// All-fail, same category (all Unknown): aggregator surfaces the LAST error
    /// — equal-priority ties keep the last-in-order failure, preserving the prior
    /// representative-failure behavior (#219 tie semantics).
    #[test]
    fn aggregate_all_err_returns_last_err() {
        let results = vec![
            Err(rpc_err("first failure")),
            Err(rpc_err("second failure")),
            Err(rpc_err("last failure")),
        ];
        let aggregate = aggregate_cancel_broadcast_results(results);
        assert!(matches!(&aggregate, Err(Error::Other(e)) if e.to_string() == "last failure"));
    }

    /// #219: all-fail bubbles by SEMANTIC PRIORITY, not position. A transient
    /// (RPC-degraded) failure outranks a benign nonce-too-low even when the
    /// nonce error is last in order — the operator-actionable cause wins.
    #[test]
    fn aggregate_all_err_prioritizes_transient_over_nonce_resolved() {
        let results = vec![
            Err(rpc_err("connection timed out")), // Transient (priority 2)
            Err(rpc_err("nonce too low")),        // NonceResolved (priority 0), last
        ];
        let aggregate = aggregate_cancel_broadcast_results(results);
        assert!(
            matches!(&aggregate, Err(Error::Other(e)) if e.to_string().contains("timed out")),
            "transient RPC failure must outrank a benign nonce-too-low regardless of order"
        );
    }

    /// Codex #473: "already known"/"already imported" (cancel ALREADY PRESENT in a
    /// mempool — the cancel propagated) is the healthiest signal, surfaced over BOTH
    /// a benign nonce-too-low AND an actionable transient, so a confirmed-present
    /// cancel is never misreported as a stuck/actionable failure.
    #[test]
    fn aggregate_all_err_accepted_outranks_everything() {
        // accepted vs nonce-resolved
        let a = aggregate_cancel_broadcast_results(vec![
            Err(rpc_err("nonce too low")),
            Err(rpc_err("already known")),
        ]);
        assert!(matches!(&a, Err(Error::Other(e)) if e.to_string().contains("already known")));
        // accepted vs transient + a noisy unclassified — accepted still wins
        let b = aggregate_cancel_broadcast_results(vec![
            Err(rpc_err("connection timed out")),
            Err(rpc_err("already imported")),
            Err(rpc_err("replacement transaction underpriced")),
        ]);
        assert!(
            matches!(&b, Err(Error::Other(e)) if e.to_string().contains("already imported")),
            "a confirmed-present cancel must be surfaced over transient/unclassified errors"
        );
    }

    /// Codex #473 P2: a benign `nonce too low` rejection whose numeric nonce
    /// value happens to contain an HTTP status code (geth emits "nonce too low:
    /// next nonce 430, tx nonce 429", and alloy wraps it as "server returned an
    /// error response: error code -32000: …") must classify as NonceResolved,
    /// NOT as a transient RPC degradation. The definitive node verdict is checked
    /// before the heuristic status-code match, so an incidental digit can never
    /// promote a healthy "settle already mined" into an operator-actionable cause.
    #[test]
    fn nonce_too_low_with_status_code_digit_is_not_transient() {
        let err = rpc_err(
            "server returned an error response: error code -32000: nonce too low: \
             next nonce 430, tx nonce 429",
        );
        assert_eq!(
            cancel_error_priority(&err),
            0,
            "a benign nonce-too-low whose value contains 429 must NOT be transient"
        );
    }

    /// Codex #473 P2 (general case): an unclassified node rejection whose message
    /// embeds a status-code digit inside a value (here a gas amount) but carries
    /// NO HTTP context must classify as Unknown — not be inflated to a transient
    /// RPC degradation by a bare-substring `contains("502")` match.
    #[test]
    fn unknown_rejection_with_incidental_status_digit_is_not_transient() {
        let err = rpc_err(
            "server returned an error response: error code -32000: \
             intrinsic gas too low: have 502 want 21000",
        );
        assert_eq!(
            cancel_error_priority(&err),
            1,
            "an incidental 502 in a value (no HTTP context) is not an HTTP 502"
        );
    }

    /// Real HTTP transport failures must STILL classify as transient. alloy formats
    /// them as "HTTP error {code} with body: …", so the status code always arrives
    /// with an explicit HTTP cue — the context gate keeps these actionable.
    #[test]
    fn http_status_errors_are_transient() {
        for msg in [
            "HTTP error 502 with body: <html>bad gateway</html>",
            "HTTP error 503 with empty body",
            "HTTP error 504 with body: gateway time-out",
            "HTTP error 429 with body: too many requests",
        ] {
            assert_eq!(
                cancel_error_priority(&rpc_err(msg)),
                2,
                "HTTP transport failure must remain transient: {msg}"
            );
        }
    }

    /// Codex #473 P2 at the aggregate: a benign nonce-too-low whose value contains
    /// "429" must not be mis-promoted to transient priority and thereby mask a
    /// co-occurring genuinely-unknown rejection. Post-fix the nonce error is benign
    /// (priority 0) and the unclassified rejection (priority 1) is surfaced instead.
    #[test]
    fn aggregate_benign_nonce_with_digit_does_not_mask_unknown() {
        let results = vec![
            Err(rpc_err(
                "server returned an error response: error code -32000: nonce too low: tx nonce 429",
            )),
            Err(rpc_err(
                "server returned an error response: error code -32010: replacement transaction \
                 underpriced",
            )),
        ];
        let aggregate = aggregate_cancel_broadcast_results(results);
        assert!(
            matches!(&aggregate, Err(Error::Other(e)) if e.to_string().contains("underpriced")),
            "a benign nonce-429 must not be mis-promoted to transient and mask the \
             unclassified rejection"
        );
    }

    /// Empty results (N=0): defensive — `Mempools::try_new` rejects empty
    /// configs, so this path should be unreachable. Aggregator must NOT
    /// panic; returns a sentinel Other error so the caller can log it.
    #[test]
    fn aggregate_empty_returns_sentinel_err() {
        let results: Vec<Result<TxId, Error>> = vec![];
        let aggregate = aggregate_cancel_broadcast_results(results);
        assert!(matches!(&aggregate, Err(Error::Other(e)) if e.to_string().contains("no mempools configured")));
    }

    /// F4 race-window proof: aggregator returns Ok even when the FIRST
    /// mempool failed. The pre-F4 code structurally couldn't have returned
    /// Ok in this scenario because it only sent the cancel to one mempool.
    #[test]
    fn aggregate_f4_first_mempool_fails_others_succeed() {
        let results = vec![
            Err(rpc_err("primary mempool A: nonce already consumed by settle race")),
            Ok(tx(0x42)), // peer mempool B's cancel landed first
        ];
        let aggregate = aggregate_cancel_broadcast_results(results);
        assert!(
            matches!(&aggregate, Ok(t) if t.0 == tx(0x42).0),
            "F4 fix: when primary mempool's cancel races and loses, the cross-\
             broadcast to peers must still be reported as a successful cancel"
        );
    }

    /// Positional-ordering lock-in (sharp-edges L4, PR #201 review):
    /// success appears AFTER multiple errors in iteration order. find_map
    /// must short-circuit on the first Ok and ignore both earlier Errs
    /// and any later positions.
    #[test]
    fn aggregate_finds_ok_buried_deep_in_results() {
        let results = vec![
            Err(rpc_err("err 1")),
            Err(rpc_err("err 2")),
            Err(rpc_err("err 3")),
            Ok(tx(0x99)),
            Err(rpc_err("err 4 — should not surface")),
        ];
        let aggregate = aggregate_cancel_broadcast_results(results);
        assert!(
            matches!(&aggregate, Ok(t) if t.0 == tx(0x99).0),
            "find_map must short-circuit on the first Ok regardless of \
             surrounding errors — positional semantics locked in"
        );
    }
}

/// Applies the solver's gas fee override if present. When a replacement
/// transaction is pending, the solver's values are raised to at least the
/// replacement minimum (a node requirement).
fn apply_gas_fee_override(
    driver_estimate: Eip1559Estimation,
    solver_override: Option<GasFeeOverride>,
    replacement_price: Option<&Eip1559Estimation>,
) -> Eip1559Estimation {
    let Some(gas_override) = solver_override else {
        return driver_estimate;
    };
    let solver_price = Eip1559Estimation {
        max_fee_per_gas: gas_override.max_fee_per_gas,
        max_priority_fee_per_gas: gas_override.max_priority_fee_per_gas,
    };
    match replacement_price {
        Some(replacement) => Eip1559Estimation {
            max_fee_per_gas: std::cmp::max(
                solver_price.max_fee_per_gas,
                replacement.max_fee_per_gas,
            ),
            max_priority_fee_per_gas: std::cmp::max(
                solver_price.max_priority_fee_per_gas,
                replacement.max_priority_fee_per_gas,
            ),
        },
        None => solver_price,
    }
}

/// In EIP-7702 mode, reroute the tx through the solver EOA's delegated
/// forwarder contract. The original target and calldata are wrapped in a
/// `forward()` call. `from` is set to the submission EOA so that simulations
/// see the correct `msg.sender` for the forwarder's caller whitelist.
fn prepare_submission(tx: &eth::Tx, mode: &SubmissionMode) -> eth::Tx {
    let mut tx = tx.clone();
    match mode {
        SubmissionMode::Direct(solver_eoa) => {
            tx.from = *solver_eoa;
            tx
        }
        SubmissionMode::Delegated {
            submitter_eoa,
            solver_eoa,
        } => {
            let original_target = tx.to;
            tx.from = *submitter_eoa;
            tx.to = *solver_eoa;
            tx.input = CowSettlementForwarder::forwardCall {
                target: original_target,
                data: tx.input.clone(),
            }
            .abi_encode()
            .into();
            tx
        }
    }
}

pub struct SubmissionSuccess {
    pub tx_hash: eth::TxId,
    /// At which block we started to submit the transaction.
    pub included_in_block: eth::BlockNo,
    /// In which block the transaction actually appeared onchain.
    pub submitted_at_block: eth::BlockNo,
}

#[derive(Debug, Error)]
#[error("no mempools configured, cannot execute settlements")]
pub struct NoMempools;

/// Defines if the mempools are configured in a way that guarantees that
/// /settle'd solution will not revert.
#[derive(Debug, Clone, Copy)]
pub enum RevertProtection {
    Enabled,
    Disabled,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(
        "Mined reverted transaction: {tx_id:?}, block number: {reverted_at_block}, submitted at \
         block: {submitted_at_block}"
    )]
    Revert {
        tx_id: eth::TxId,
        submitted_at_block: BlockNo,
        reverted_at_block: BlockNo,
    },
    #[error(
        "Simulation started reverting during submission, block number: {reverted_at_block}, \
         submitted at block: {submitted_at_block}"
    )]
    SimulationRevert {
        submitted_at_block: BlockNo,
        reverted_at_block: BlockNo,
    },
    #[error(
        "Settlement did not get included in time: submitted at block: {submitted_at_block}, \
         submission deadline: {submission_deadline}, tx: {tx_id:?}"
    )]
    Expired {
        tx_id: eth::TxId,
        submitted_at_block: BlockNo,
        submission_deadline: BlockNo,
    },
    #[error("Strategy disabled for this tx")]
    Disabled,
    /// The post-bump/post-override gas price exceeds the configured cap.
    /// Aborting the broadcast prevents fee-drain when an upstream RPC
    /// misreports `eth_gasPrice` or when an over-aggressive solver override
    /// pushes the replacement bump above policy. Phase 4 audit F2.
    #[error(
        "gas price {computed:?} wei/gas exceeds configured cap {cap:?} wei/gas ({context}); \
         aborting broadcast to prevent fee drain"
    )]
    GasPriceCapExceeded {
        computed: eth::U256,
        cap: eth::U256,
        context: &'static str,
    },
    #[error("Failed to submit: {0:?}")]
    Other(#[from] anyhow::Error),
}
