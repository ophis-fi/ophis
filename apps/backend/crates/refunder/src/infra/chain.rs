//! Blockchain access via Alloy.

use {
    crate::traits::{ChainRead, RefundStatus},
    alloy::{primitives::Address, providers::Provider, rpc::types::TransactionRequest},
    anyhow::{Result, anyhow},
    contracts::CoWSwapEthFlow,
    ethrpc::{AlloyProvider, block_stream::timestamp_of_current_block_in_seconds},
    std::collections::HashMap,
};

/// [`ChainRead`] implementation using Alloy.
pub struct AlloyChain {
    provider: AlloyProvider,
    ethflow_contracts: HashMap<Address, CoWSwapEthFlow::Instance>,
}

impl AlloyChain {
    pub fn new(provider: AlloyProvider, ethflow_addresses: Vec<Address>) -> Self {
        let ethflow_contracts = ethflow_addresses
            .into_iter()
            .map(|addr| {
                let instance = CoWSwapEthFlow::Instance::new(addr, provider.clone());
                (addr, instance)
            })
            .collect();
        Self {
            provider,
            ethflow_contracts,
        }
    }
}

impl ChainRead for AlloyChain {
    async fn current_block_timestamp(&self) -> Result<u32> {
        timestamp_of_current_block_in_seconds(&self.provider).await
    }

    async fn can_receive_eth(&self, address: Address) -> bool {
        // An EOA has no receive/fallback code to execute, so a plain ETH
        // transfer is always receivable. Avoid estimating gas for this case:
        // quorum RPCs can legitimately return different gas estimates for the
        // same transfer, and a strict consensus proxy would turn that harmless
        // disagreement into a false "cannot receive ETH" result.
        match self.provider.get_code_at(address).await {
            Ok(code) if code.is_empty() => return true,
            Ok(_) => {}
            Err(err) => {
                tracing::warn!(?address, ?err, "failed to determine refund owner account type");
                return false;
            }
        }

        // Contracts still need a simulation because their receive/fallback
        // logic may reject ETH and would otherwise revert an entire batch.
        let tx = TransactionRequest::default()
            .to(address)
            .value(alloy::primitives::U256::from(1));

        self.provider.estimate_gas(tx).await.is_ok()
    }

    fn ethflow_addresses(&self) -> Vec<Address> {
        self.ethflow_contracts.keys().copied().collect()
    }

    async fn get_order_status(
        &self,
        ethflow_address: Address,
        order_hash: alloy::primitives::B256,
    ) -> Result<RefundStatus> {
        let contract = self
            .ethflow_contracts
            .get(&ethflow_address)
            .ok_or_else(|| anyhow!("Unknown EthFlow contract: {ethflow_address}"))?;

        let order = contract.orders(order_hash).call().await?;
        Ok(order.into())
    }
}
