use {
    crate::ethereum::contracts::Contracts,
    alloy_primitives::U256,
    alloy_provider::{Provider, network::TransactionBuilder},
    alloy_rpc_types::TransactionRequest,
    alloy_transport::RpcError,
    anyhow::{Result, anyhow},
    chain::Chain,
    eth_domain_types::AccessList,
    ethrpc::{Web3, alloy::ProviderLabelingExt, block_stream::CurrentBlockWatcher},
    gas_price_estimation::{Eip1559EstimationExt, GasPriceEstimating},
    std::sync::Arc,
    thiserror::Error,
    tracing::{Level, instrument},
};

pub mod contracts;

#[derive(Clone)]
pub struct Ethereum {
    web3: Web3,
    inner: Arc<Inner>,
}

struct Inner {
    chain: Chain,
    contracts: Contracts,
    gas: Arc<dyn GasPriceEstimating>,
    current_block: CurrentBlockWatcher,
    tx_gas_limit: U256,
}

impl Ethereum {
    pub fn new(
        web3: Web3,
        chain: Chain,
        addresses: configs::simulator::Addresses,
        gas: Arc<dyn GasPriceEstimating>,
        current_block: CurrentBlockWatcher,
        tx_gas_limit: U256,
    ) -> Self {
        Self {
            web3: web3.clone(),
            inner: Arc::new(Inner {
                chain,
                contracts: Contracts::new(web3.clone(), chain, addresses),
                gas,
                current_block,
                tx_gas_limit,
            }),
        }
    }

    #[instrument(skip(self), ret(level = Level::DEBUG))]
    pub(super) async fn simulation_gas_price(&self) -> Option<u128> {
        let base_fee = self.inner.current_block.borrow().base_fee;
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

    pub fn chain(&self) -> Chain {
        self.inner.chain
    }

    pub fn current_block(&self) -> &CurrentBlockWatcher {
        &self.inner.current_block
    }

    pub fn web3(&self) -> &Web3 {
        &self.web3
    }

    /// Clones self and returns an instance that captures metrics extended with
    /// the provided label.
    pub fn with_metric_label(&self, label: String) -> Self {
        Self {
            web3: self.web3.labeled(label),
            ..self.clone()
        }
    }

    pub async fn create_access_list<T>(&self, tx: T) -> Result<AccessList, Error>
    where
        T: Into<TransactionRequest>,
    {
        let gas_limit = self.inner.tx_gas_limit.try_into().map_err(|err| {
            Error::GasPrice(anyhow!("failed to convert gas_limit to u64: {err:?}"))
        })?;
        let tx = tx.into().with_gas_limit(gas_limit);
        let tx = match self.simulation_gas_price().await {
            Some(gas_price) => tx.with_gas_price(gas_price),
            _ => tx,
        };
        let access_list = self
            .web3
            .provider
            .create_access_list(&tx)
            .pending()
            .await
            .map_err(Error::Rpc)?;
        Ok(access_list
            .ensure_ok()
            .map_err(Error::AccessList)?
            .access_list
            .into())
    }

    pub async fn estimate_gas<T>(&self, tx: T) -> Result<eth_domain_types::Gas, Error>
    where
        T: Into<TransactionRequest>,
    {
        let tx = tx.into();
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
}

/// Fast chains can advance several blocks while a quorum RPC request is in
/// flight. Doubling the simulation-only gas price covers six consecutive
/// maximum EIP-1559 base-fee increases. Transaction submission performs a
/// separate, fresh estimate.
fn replay_safe_simulation_gas_price(current: u128) -> u128 {
    current.saturating_mul(2)
}

impl std::fmt::Debug for Ethereum {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
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
        assert_eq!(replay_safe_simulation_gas_price(8), 16);
        assert_eq!(replay_safe_simulation_gas_price(22_252_001), 44_504_002);
    }

    #[test]
    fn simulation_gas_price_saturates() {
        assert_eq!(replay_safe_simulation_gas_price(u128::MAX), u128::MAX);
    }
}

#[derive(Debug, Error)]
pub enum Error {
    #[error("method error: {0:?}")]
    ContractRpc(#[from] alloy_contract::Error),
    #[error("alloy rpc error: {0:?}")]
    Rpc(#[from] alloy_transport::RpcError<alloy_transport::TransportErrorKind>),
    #[error("gas price estimation error: {0}")]
    GasPrice(anyhow::Error),
    #[error("access list estimation error: {0:?}")]
    AccessList(String),
    #[error("other error: {0:?}")]
    Other(anyhow::Error),
}

impl Error {
    /// Returns whether the failure proves that EVM execution reverted.
    ///
    /// RPC gateways also encode quorum failures, rate limits, and upstream
    /// timeouts as JSON-RPC error responses. Treating every response as an EVM
    /// revert incorrectly voids otherwise valid winning solutions.
    pub(super) fn is_revert(&self) -> bool {
        match self {
            Self::ContractRpc(_) | Self::AccessList(_) => true,
            Self::GasPrice(_) | Self::Other(_) => false,
            Self::Rpc(RpcError::ErrorResp(err)) => {
                let message = err.message.to_lowercase();
                err.as_revert_data().is_some()
                    || err.code == 3
                    || message.contains("execution reverted")
            }
            Self::Rpc(_) => false,
        }
    }
}
