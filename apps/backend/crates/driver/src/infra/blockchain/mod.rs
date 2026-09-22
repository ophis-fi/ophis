use {
    crate::{boundary, domain::blockchain::TxStatus},
    account_balances::{BalanceSimulator, SimulationError},
    alloy::{
        eips::eip1559::Eip1559Estimation,
        network::TransactionBuilder,
        providers::Provider,
        rpc::types::{TransactionReceipt, TransactionRequest},
        transports::TransportErrorKind,
    },
    balance_overrides::{BalanceOverrides, BalanceOverriding},
    chain::Chain,
    eth_domain_types as eth,
    ethrpc::{Web3, alloy::ProviderLabelingExt, block_stream::CurrentBlockWatcher},
    gas_price_estimation::{Eip1559EstimationExt, GasPriceEstimating},
    shared::web3,
    std::{fmt, sync::Arc},
    thiserror::Error,
    tracing::{Level, instrument},
    url::Url,
};

pub mod contracts;
pub mod gas;
pub mod token;
pub use self::{contracts::Contracts, gas::GasPriceEstimator};

/// An Ethereum RPC connection.
#[derive(Clone)]
pub struct Rpc {
    web3: Web3,
    chain: Chain,
    args: RpcArgs,
}

#[derive(Clone)]
pub struct RpcArgs {
    pub url: Url,
    pub max_batch_size: usize,
    pub max_concurrent_requests: usize,
}

impl Rpc {
    /// Instantiate an RPC client to an Ethereum (or Ethereum-compatible) node
    /// at the specifed URL.
    pub async fn try_new(args: RpcArgs) -> Result<Self, RpcError> {
        let web3 = web3::web3(
            &web3::Arguments {
                ethrpc_max_batch_size: args.max_batch_size,
                ethrpc_max_concurrent_requests: args.max_concurrent_requests,
                ethrpc_batch_delay: Default::default(),
            },
            &args.url,
            "base",
        );
        let chain = Chain::try_from(web3.provider.get_chain_id().await?)?;

        Ok(Self { web3, chain, args })
    }

    /// Returns the chain for the RPC connection.
    pub fn chain(&self) -> Chain {
        self.chain
    }

    /// Returns a reference to the underlying web3 client.
    pub fn web3(&self) -> &Web3 {
        &self.web3
    }
}

#[derive(Debug, Error)]
pub enum RpcError {
    #[error("alloy transport error: {0:?}")]
    Alloy(#[from] alloy::transports::TransportError),
    #[error("unsupported chain")]
    UnsupportedChain(#[from] chain::ChainIdNotSupported),
}

/// The Ethereum blockchain.
#[derive(Clone)]
pub struct Ethereum {
    web3: Web3,
    inner: Arc<Inner>,
}

struct Inner {
    chain: Chain,
    contracts: Contracts,
    gas: Arc<GasPriceEstimator>,
    current_block: CurrentBlockWatcher,
    balance_simulator: BalanceSimulator,
    balance_overrider: Arc<dyn BalanceOverriding>,
}

impl Ethereum {
    /// Access the Ethereum blockchain through an RPC API.
    ///
    /// # Panics
    ///
    /// Since this type is essential for the program this method will panic on
    /// any initialization error.
    pub async fn new(
        rpc: Rpc,
        addresses: contracts::Addresses,
        gas: Arc<GasPriceEstimator>,
        current_block_args: &shared::current_block::Arguments,
    ) -> Self {
        let Rpc { web3, chain, args } = rpc;
        let current_block_stream = current_block_args
            .stream(args.url.clone(), web3.provider.clone())
            .await
            .expect("couldn't initialize current block stream");

        // Bootstrap RPC call: retry with backoff so transient eRPC consensus
        // failures (ErrConsensusLowParticipants / ErrConsensusDispute) during
        // HL stack restart bursts don't crash-loop the container. Mirrors
        // the pattern used in autopilot, orderbook, and solvers; sustained
        // failures still surface as panic after the backoff exhausts.
        let contracts = retry_helper::with_backoff(
            "Contracts::new",
            retry_helper::BackoffConfig::default(),
            || async { Contracts::new(&web3, chain, addresses.clone()).await },
        )
        .await
        .expect("could not initialize important smart contracts after retries");
        let balance_overrider = Arc::new(BalanceOverrides::new(web3.clone()));
        let balance_simulator = BalanceSimulator::new(
            contracts.settlement().clone(),
            contracts.balance_helper().clone(),
            *contracts.vault_relayer(),
            Some(*contracts.vault().address()),
            balance_overrider.clone(),
        );

        Self {
            inner: Arc::new(Inner {
                current_block: current_block_stream,
                chain,
                contracts,
                gas,
                balance_simulator,
                balance_overrider,
            }),
            web3,
        }
    }

    pub fn chain(&self) -> Chain {
        self.inner.chain
    }

    pub fn balance_simulator(&self) -> &BalanceSimulator {
        &self.inner.balance_simulator
    }

    pub fn balance_overrider(&self) -> Arc<dyn BalanceOverriding> {
        Arc::clone(&self.inner.balance_overrider)
    }

    /// Clones self and returns an instance that captures metrics extended with
    /// the provided label.
    pub fn with_metric_label(&self, label: String) -> Self {
        Self {
            web3: self.web3.labeled(label),
            ..self.clone()
        }
    }

    /// Onchain smart contract bindings.
    pub fn contracts(&self) -> &Contracts {
        &self.inner.contracts
    }

    /// Check if a smart contract is deployed to the given address.
    pub async fn is_contract(&self, address: eth::Address) -> Result<bool, Error> {
        let code = self.web3.provider.get_code_at(address).await?;
        Ok(!code.is_empty())
    }

    /// Returns a type that monitors the block chain to inform about the current
    /// block.
    pub fn current_block(&self) -> &CurrentBlockWatcher {
        &self.inner.current_block
    }

    /// The gas price is determined based on the deadline by which the
    /// transaction must be included on-chain. A shorter deadline requires a
    /// higher gas price to increase the likelihood of timely inclusion.
    pub async fn gas_price(&self) -> Result<Eip1559Estimation, Error> {
        self.inner.gas.estimate().await
    }

    pub fn gas_estimator(&self) -> Arc<dyn GasPriceEstimating> {
        Arc::clone(&self.inner.gas) as _
    }

    pub fn block_gas_limit(&self) -> eth::Gas {
        self.inner.current_block.borrow().gas_limit.into()
    }

    /// Returns the current [`eth::Ether`] balance of the specified account.
    pub async fn balance(&self, address: eth::Address) -> Result<eth::Ether, Error> {
        self.web3
            .provider
            .get_balance(address)
            .await
            .map(Into::into)
            .map_err(Into::into)
    }

    /// Returns a [`token::Erc20`] for the specified address.
    pub fn erc20(&self, address: eth::TokenAddress) -> token::Erc20 {
        token::Erc20::new(self, address)
    }

    /// Estimate gas used by a transaction.
    pub async fn estimate_gas(&self, tx: eth::Tx) -> Result<eth::Gas, Error> {
        let tx = TransactionRequest::default()
            .from(tx.from)
            .to(tx.to)
            .value(tx.value.0)
            .input(tx.input.into())
            .access_list(tx.access_list.into());

        let tx = match self.simulation_gas_price().await {
            Some(gas_price) => tx.with_gas_price(gas_price),
            _ => tx,
        };

        let estimated_gas = self
            .web3
            .provider
            .estimate_gas(tx)
            .pending()
            .await
            .map_err(Error::Rpc)?
            .into();

        Ok(estimated_gas)
    }

    /// Returns the transaction's on-chain inclusion status.
    pub async fn transaction_status(&self, tx_hash: &eth::TxId) -> Result<TxStatus, Error> {
        self.web3
            .provider
            .get_transaction_receipt(tx_hash.0)
            .await
            .map(|result| {
                let Some(
                    receipt @ TransactionReceipt {
                        block_number: Some(block_number),
                        ..
                    },
                ) = result
                else {
                    return TxStatus::Pending;
                };

                if receipt.status() {
                    TxStatus::Executed {
                        block_number: eth::BlockNo(block_number),
                    }
                } else {
                    TxStatus::Reverted {
                        block_number: eth::BlockNo(block_number),
                    }
                }
            })
            .map_err(Into::into)
    }

    #[instrument(skip(self), ret(level = Level::DEBUG))]
    pub(super) async fn simulation_gas_price(&self) -> Option<u128> {
        let base_fee = self.current_block().borrow().base_fee;
        // Some nodes don't pick a reasonable default value when you don't specify a gas
        // price and default to 0. Additionally some sneaky tokens have special code
        // paths that detect that case to try to behave differently during simulations
        // than they normally would. To not rely on the node picking a reasonable
        // default value we estimate the current gas price upfront. But because it's
        // extremely rare that tokens behave that way we are fine with falling back to
        // the node specific fallback value instead of failing the whole call.
        Some(replay_safe_simulation_gas_price(
            self.inner.gas.estimate().await.ok()?.effective(base_fee),
        ))
    }

    pub fn web3(&self) -> &Web3 {
        &self.web3
    }
}

/// Robinhood can advance several blocks during a quorum RPC round trip.
///
/// EIP-1559 permits the base fee to grow 12.5% per full block, so a one-block
/// margin is insufficient on fast chains: by the time a protected simulation
/// reaches both upstreams, its gas price can already be below the served block's
/// base fee. Compound six maximum-growth blocks, rounding each increase up. This
/// affects only `eth_call`/`eth_estimateGas`; transaction submission obtains a
/// fresh EIP-1559 estimate.
fn replay_safe_simulation_gas_price(current: u128) -> u128 {
    (0..6).fold(current, |fee, _| {
        let increase = fee / 8 + u128::from(fee % 8 != 0);
        fee.saturating_add(increase)
    })
}

impl fmt::Debug for Ethereum {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.debug_struct("Ethereum")
            .field("web3", &self.web3)
            .field("chain", &self.inner.chain)
            .field("contracts", &self.inner.contracts)
            .field("gas", &"Arc<NativeGasEstimator>")
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::replay_safe_simulation_gas_price;

    #[test]
    fn simulation_gas_price_covers_multiple_fast_blocks() {
        assert_eq!(replay_safe_simulation_gas_price(8), 20);
        assert_eq!(replay_safe_simulation_gas_price(9), 23);
        assert_eq!(replay_safe_simulation_gas_price(22_252_001), 45_111_186);
    }

    #[test]
    fn simulation_gas_price_saturates() {
        assert_eq!(replay_safe_simulation_gas_price(u128::MAX), u128::MAX);
    }
}

#[derive(Debug, Error)]
pub enum Error {
    #[error("method error: {0:?}")]
    ContractRpc(#[from] alloy::contract::Error),
    #[error("alloy rpc error: {0:?}")]
    Rpc(#[from] alloy::transports::RpcError<TransportErrorKind>),
    #[error("gas price estimation error: {0}")]
    GasPrice(boundary::Error),
    #[error("access list estimation error: {0:?}")]
    AccessList(String),
}

impl Error {
    /// Returns whether the error indicates that the original transaction
    /// reverted.
    pub fn is_revert(&self) -> bool {
        // This behavior is node dependent
        match self {
            Error::GasPrice(_) => false,
            Error::AccessList(_) => true,
            Error::ContractRpc(_) => true,
            Error::Rpc(err) => {
                let is_revert = err.is_error_resp();
                tracing::trace!(is_revert, ?err, "classified error");
                is_revert
            }
        }
    }
}

impl From<SimulationError> for Error {
    fn from(err: SimulationError) -> Self {
        match err {
            SimulationError::Method(err) => Self::ContractRpc(err),
        }
    }
}

#[cfg(test)]
mod token_demand_tests {
    use {
        super::*, alloy::providers::mock::Asserter, alloy::sol_types::SolValue,
        ethrpc::block_stream::BlockInfo, tokio::sync::watch,
    };

    #[tokio::test]
    async fn token_balances_are_fresh_on_demand_and_never_polled_while_idle() {
        let rpc = Asserter::new();
        let web3 = Web3::with_asserter(rpc.clone());
        for _ in 0..3 {
            rpc.push_success(&alloy::primitives::Bytes::from(vec![0; 32]));
        }
        let contracts = Contracts::new(&web3, Chain::Mainnet, Default::default())
            .await
            .unwrap();
        let balance_overrider = Arc::new(BalanceOverrides::new(web3.clone()));
        let balance_simulator = BalanceSimulator::new(
            contracts.settlement().clone(),
            contracts.balance_helper().clone(),
            *contracts.vault_relayer(),
            Some(*contracts.vault().address()),
            balance_overrider.clone(),
        );
        let gas = Arc::new(
            GasPriceEstimator::new(
                &web3,
                &Default::default(),
                &[crate::infra::mempool::Config::test_config(
                    "http://localhost".parse().unwrap(),
                )],
            )
            .await
            .unwrap(),
        );
        let (blocks, current_block) = watch::channel(BlockInfo::default());
        let eth = Ethereum {
            web3,
            inner: Arc::new(Inner {
                chain: Chain::Mainnet,
                contracts,
                gas,
                current_block,
                balance_simulator,
                balance_overrider,
            }),
        };
        let fetcher = crate::infra::tokens::Fetcher::new(&eth);
        let token: eth::TokenAddress = eth::Address::repeat_byte(0x42).into();
        let word = |n: u64| alloy::primitives::Bytes::from(eth::U256::from(n).abi_encode());
        rpc.push_success(&word(6));
        rpc.push_success(&alloy::primitives::Bytes::from("TEST".abi_encode()));
        rpc.push_success(&word(42));
        let first = fetcher.get(&[token, token]).await.unwrap();
        assert_eq!(first[&token].balance, eth::U256::from(42).into());
        assert_eq!(first[&token].decimals, Some(6));
        assert_eq!(first[&token].symbol.as_deref(), Some("TEST"));
        assert!(rpc.read_q().is_empty());

        // A new block must not consume this queued response without demand.
        rpc.push_success(&word(43));
        blocks.send_modify(|block| {
            block.number += 1;
        });
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        assert_eq!(rpc.read_q().len(), 1, "idle block triggered an RPC read");
        let second = fetcher.get(&[token]).await.unwrap();
        assert_eq!(second[&token].balance, eth::U256::from(43).into());
        assert!(
            rpc.read_q().is_empty(),
            "cached metadata should need only one balance call"
        );

        rpc.push_failure_msg("quota exhausted");
        let error = fetcher
            .get(&[token])
            .await
            .expect_err("failed balance must not reuse 43 or invent zero");
        assert!(error.to_string().contains("quota exhausted"));
        // The real auction converter must fail before constructing zero balances.
        let request: crate::infra::api::routes::solve::dto::SolveRequest = serde_json::from_value(
            serde_json::json!({"id": "1", "tokens": [{"address": token.0, "trusted": false}],
                "orders": [], "deadline": chrono::Utc::now()}),
        )
        .unwrap();
        rpc.push_failure_msg("quota exhausted");
        let error = request
            .into_domain(&eth, &fetcher, Default::default())
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            crate::infra::api::routes::solve::AuctionError::TokenBalance(_)
        ));
        rpc.push_success(&word(0));
        assert_eq!(
            fetcher.get(&[token]).await.unwrap()[&token].balance,
            eth::U256::ZERO.into()
        );

        // Missing metadata is optional; it must not suppress a balance read.
        let other: eth::TokenAddress = eth::Address::repeat_byte(0x43).into();
        rpc.push_failure_msg("metadata unavailable");
        rpc.push_success(&word(99));
        let result = fetcher.get(&[other]).await.unwrap();
        assert_eq!(result[&other].balance, eth::U256::from(99).into());
        assert!(result[&other].decimals.is_none() && result[&other].symbol.is_none());
    }
}
