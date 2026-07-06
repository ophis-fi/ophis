use {
    crate::{
        domain::{dex, eth},
        infra::blockchain,
    },
    alloy::{
        primitives::{Address, B256, U256, address, keccak256},
        providers::DynProvider,
        rpc::types::state::{AccountOverride, StateOverridesBuilder},
    },
    contracts::support::{
        AnyoneAuthenticator,
        Swapper::{
            self,
            Swapper::{Allowance, Asset, Interaction},
        },
    },
};

/// The OP-stack wrapped native token (WETH), the canonical predeploy on every
/// OP-stack chain. Both Ophis sovereign chains (Optimism 10, Unichain 130) are
/// OP-stack and use this address. Eth-flow (native-ETH) orders SELL this token,
/// but the eth-flow contract that owns such an order holds NATIVE ETH -- not
/// WETH -- at simulation time (it wraps to WETH only during real settlement, via
/// a pre-hook). See `eth_flow_balance_override`.
const WRAPPED_NATIVE: Address = address!("4200000000000000000000000000000000000006");

/// WETH9 stores `balanceOf` at storage slot 3 (verified on-chain 2026-07-06:
/// keccak256(pad32(holder) || pad32(3)) held the settlement's WETH balance).
const WRAPPED_NATIVE_BALANCE_SLOT: u8 = 3;

/// When the swap sells the wrapped native, returns the `(slot, value)` storage
/// override that grants `owner` a `sell.amount` WETH balance for the simulation.
///
/// Eth-flow orders are owned by the eth-flow contract, which holds native ETH
/// (not WETH) until real settlement wraps it via a pre-hook. Without this, the
/// Swapper's `balanceOf(sell) < sell.amount` guard trips, the simulation returns
/// "unavailable", and (for a buffer-exposed buy token) the order is fail-closed
/// -- wrongly rejecting every native-ETH -> stablecoin swap. This override models
/// the post-wrap state settlement guarantees, so the swap simulates (and its
/// output is measured) exactly like a normal order whose owner holds the sell
/// token. It only fires when the sell token IS the wrapped native, so it never
/// perturbs a normal order (whose owner already holds a non-native sell token).
fn eth_flow_balance_override(owner: Address, swap: &dex::Swap) -> Option<(B256, B256)> {
    // The zero address is the anonymous-quote sentinel (from = 0x0) and can
    // never hold or transfer ERC20 tokens. Granting it a balance would make the
    // sim run a swap that reverts with "ERC20: transfer to the zero address",
    // turning the graceful "sim unavailable" path (which quotes are exempt from)
    // into a hard error. Skip it -- such quotes fall through to Ok(None).
    if owner.is_zero() || swap.input.token.0 != WRAPPED_NATIVE {
        return None;
    }
    let value = B256::from(swap.input.amount.to_be_bytes::<32>());
    Some((wrapped_native_balance_slot(owner), value))
}

/// Storage slot of `balanceOf[owner]` in the wrapped-native token, i.e. the
/// Solidity mapping slot `keccak256(abi.encode(owner, uint256(SLOT)))`.
fn wrapped_native_balance_slot(owner: Address) -> B256 {
    let mut key = [0u8; 64];
    key[12..32].copy_from_slice(owner.as_slice());
    key[63] = WRAPPED_NATIVE_BALANCE_SLOT;
    keccak256(key)
}

/// A DEX swap simulator.
#[derive(Debug, Clone)]
pub struct Simulator {
    web3: DynProvider,
    settlement: Address,
    authenticator: Address,
}

impl Simulator {
    /// Create a new simulator for computing DEX swap gas usage.
    pub fn new(url: &reqwest::Url, settlement: Address, authenticator: Address) -> Self {
        Self {
            web3: blockchain::rpc(url).provider,
            settlement,
            authenticator,
        }
    }

    /// Simulate the gas needed by a single order DEX swap.
    ///
    /// This will return a `None` if the gas simulation is unavailable.
    pub async fn gas(&self, owner: Address, swap: &dex::Swap) -> Result<eth::Gas, Error> {
        if owner == self.settlement {
            // we can't have both the settlement and swapper contracts at the
            // same address
            return Err(Error::SettlementContractIsOwner);
        }

        let swapper = Swapper::Instance::new(owner, self.web3.clone());
        let mut overrides = StateOverridesBuilder::with_capacity(3)
            // Setup up our trader code that actually executes the settlement
            .append(
                *swapper.address(),
                AccountOverride {
                    code: Some(Swapper::Swapper::DEPLOYED_BYTECODE.clone()),
                    ..Default::default()
                },
            )
            // Override the CoW protocol solver authenticator with one that
            // allows any address to solve
            .append(
                self.authenticator,
                AccountOverride {
                    code: Some(
                        AnyoneAuthenticator::AnyoneAuthenticator::DEPLOYED_BYTECODE.clone(),
                    ),
                    ..Default::default()
                },
            );
        // Grant the owner the wrapped-native sell balance for eth-flow orders,
        // whose owner (the eth-flow contract) holds native ETH, not WETH, until
        // settlement wraps it. See `eth_flow_balance_override`.
        if let Some((slot, value)) = eth_flow_balance_override(owner, swap) {
            overrides = overrides.with_state_diff(WRAPPED_NATIVE, [(slot, value)]);
        }

        let swapper_calls_arg = swap
            .calls
            .iter()
            .map(|call| Interaction {
                target: call.to,
                value: U256::ZERO,
                callData: alloy::primitives::Bytes::copy_from_slice(&call.calldata),
            })
            .collect();
        let sell = Asset {
            token: swap.input.token.0,
            amount: swap.input.amount,
        };
        let buy = Asset {
            token: swap.output.token.0,
            amount: swap.output.amount,
        };
        let allowance = Allowance {
            spender: swap.allowance.spender,
            amount: swap.allowance.amount.get(),
        };
        let gas = swapper
            .swap(self.settlement, sell, buy, allowance, swapper_calls_arg)
            .call()
            .overrides(overrides)
            .await?;

        // `gas == 0` means that the simulation is not possible. See
        // `Swapper.sol` contract for more details. In this case, use the
        // heuristic gas amount from the swap.
        Ok(if gas.is_zero() {
            tracing::info!(
                gas = ?swap.gas,
                "could not simulate dex swap to get gas used; fall back to gas estimate provided \
                 by dex API"
            );
            swap.gas
        } else {
            eth::Gas(gas)
        })
    }

    /// Simulate a single order DEX swap and, on top of the gas estimate,
    /// measure the buy amount the swap interactions actually deliver into the
    /// settlement. This is the output-side ground truth used to reject swaps
    /// whose reported output the interactions do not truly deliver (a shortfall
    /// that the settlement buffer would otherwise silently cover, draining it).
    ///
    /// The DEX calls are simulated NON-internalized, so a legitimate later
    /// internalization can never hide an under-delivery.
    pub async fn gas_with_output(
        &self,
        owner: Address,
        swap: &dex::Swap,
    ) -> Result<OutputSimulation, Error> {
        if owner == self.settlement {
            // we can't have both the settlement and swapper contracts at the
            // same address
            return Err(Error::SettlementContractIsOwner);
        }

        let swapper = Swapper::Instance::new(owner, self.web3.clone());
        let mut overrides = StateOverridesBuilder::with_capacity(3)
            // Setup up our trader code that actually executes the settlement
            .append(
                *swapper.address(),
                AccountOverride {
                    code: Some(Swapper::Swapper::DEPLOYED_BYTECODE.clone()),
                    ..Default::default()
                },
            )
            // Override the CoW protocol solver authenticator with one that
            // allows any address to solve
            .append(
                self.authenticator,
                AccountOverride {
                    code: Some(
                        AnyoneAuthenticator::AnyoneAuthenticator::DEPLOYED_BYTECODE.clone(),
                    ),
                    ..Default::default()
                },
            );
        // Grant the owner the wrapped-native sell balance for eth-flow orders,
        // whose owner (the eth-flow contract) holds native ETH, not WETH, until
        // settlement wraps it. See `eth_flow_balance_override`.
        if let Some((slot, value)) = eth_flow_balance_override(owner, swap) {
            overrides = overrides.with_state_diff(WRAPPED_NATIVE, [(slot, value)]);
        }

        let swapper_calls_arg = swap
            .calls
            .iter()
            .map(|call| Interaction {
                target: call.to,
                value: U256::ZERO,
                callData: alloy::primitives::Bytes::copy_from_slice(&call.calldata),
            })
            .collect();
        let sell = Asset {
            token: swap.input.token.0,
            amount: swap.input.amount,
        };
        let buy = Asset {
            token: swap.output.token.0,
            amount: swap.output.amount,
        };
        let allowance = Allowance {
            spender: swap.allowance.spender,
            amount: swap.allowance.amount.get(),
        };
        let ret = swapper
            .swapEnsuringOutput(self.settlement, sell, buy, allowance, swapper_calls_arg)
            .call()
            .overrides(overrides)
            .await?;

        // `gasUsed == 0` means that the simulation was not possible (see
        // `Swapper.sol`). In that case fall back to the heuristic gas and
        // report the realized output as unknown, so delivery stays unproven.
        Ok(if ret.gasUsed.is_zero() {
            tracing::info!(
                gas = ?swap.gas,
                "could not simulate dex swap output; fall back to heuristic gas estimate"
            );
            OutputSimulation {
                gas: swap.gas,
                realized_output: None,
            }
        } else {
            OutputSimulation {
                gas: eth::Gas(ret.gasUsed),
                realized_output: Some(ret.realizedOut),
            }
        })
    }
}

/// The result of a strict output-delivery simulation.
#[derive(Clone, Copy, Debug)]
pub struct OutputSimulation {
    /// Gas used by the simulated settlement, or the swap's heuristic gas when
    /// the simulation was not possible.
    pub gas: eth::Gas,
    /// The buy amount the swap interactions actually delivered into the
    /// settlement, measured from the settlement's buy-token balance delta.
    /// `None` when the simulation could not be run, in which case the swap's
    /// output delivery could not be proven.
    pub realized_output: Option<U256>,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("contract call error: {0:?}")]
    ContractCall(#[from] alloy::contract::Error),

    #[error("can't simulate gas for an order for which the settlement contract is the owner")]
    SettlementContractIsOwner,
}

#[cfg(test)]
mod tests {
    use {super::*, alloy::primitives::b256};

    #[test]
    fn wrapped_native_balance_slot_matches_onchain() {
        // Verified on-chain 2026-07-06 against OP WETH (0x4200..06): a stateDiff
        // written at THIS slot made `balanceOf(0x764f..6504)` return the override
        // value, proving slot 3 + the keccak256(abi.encode(owner, slot)) layout.
        let owner = address!("764fe4aa1ff493cf39931c7923c8ff5837596504");
        assert_eq!(
            wrapped_native_balance_slot(owner),
            b256!("55576e8f9be9c279e97c3d9148807514bf90c4c718d2ff153be89caecfadc1a1"),
        );
    }
}
