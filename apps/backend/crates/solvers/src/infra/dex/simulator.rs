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

/// The wrapped-native `balanceOf` mapping slot is CHAIN-DEPENDENT even though
/// the predeploy ADDRESS is not: OP mainnet's 0x4200..06 is WETH9 (balances at
/// slot 3, verified on-chain 2026-07-06), while Unichain's is the newer
/// OP-stack WETH98-style predeploy (balances at slot 0, verified on-chain
/// 2026-07-18: the settlement's live balance sat at keccak(pad32(holder) ||
/// pad32(0)) and the slot-3 key was empty). Writing the eth-flow override to
/// the wrong slot silently grants nothing -> Swapper's balance guard trips ->
/// every eth-flow order fail-closes. Configure per chain via
/// `wrapped-native-balance-slot`; this default matches WETH9 (OP).
pub const DEFAULT_WRAPPED_NATIVE_BALANCE_SLOT: u8 = 3;

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
///
/// Correct because the ETH->WETH wrap enters the FINAL settlement as an ORDER
/// pre-interaction (autopilot ethflow_events.rs `wrap_all` selector 0x4c84c1c8),
/// which the driver re-includes for every fulfillment (encoding.rs
/// `pre_interactions.extend`). It does NOT flow through `solution.wrappers`, so
/// the DEX solver correctly emits `wrappers: vec![]` and this override models the
/// post-wrap SELL-side balance. The realized OUTPUT is still measured for real
/// (Swapper `realizedOut`), so faking the sell balance cannot blind the
/// anti-siphon guard: an under-delivering DEX is still rejected.
fn eth_flow_balance_override(
    owner: Address,
    swap: &dex::Swap,
    balance_slot: u8,
) -> Option<(B256, B256)> {
    // The zero address is the anonymous-quote sentinel (from = 0x0) and can
    // never hold or transfer ERC20 tokens. Granting it a balance would make the
    // sim run a swap that reverts with "ERC20: transfer to the zero address",
    // turning the graceful "sim unavailable" path (which quotes are exempt from)
    // into a hard error. Skip it -- such quotes fall through to Ok(None).
    if owner.is_zero() || swap.input.token.0 != WRAPPED_NATIVE {
        return None;
    }
    let value = B256::from(swap.input.amount.to_be_bytes::<32>());
    Some((wrapped_native_balance_slot(owner, balance_slot), value))
}

/// Storage slot of `balanceOf[owner]` in the wrapped-native token, i.e. the
/// Solidity mapping slot `keccak256(abi.encode(owner, uint256(SLOT)))`. The
/// mapping's base slot is chain-dependent -- see
/// [`DEFAULT_WRAPPED_NATIVE_BALANCE_SLOT`].
fn wrapped_native_balance_slot(owner: Address, balance_slot: u8) -> B256 {
    let mut key = [0u8; 64];
    key[12..32].copy_from_slice(owner.as_slice());
    key[63] = balance_slot;
    keccak256(key)
}

/// A DEX swap simulator.
#[derive(Debug, Clone)]
pub struct Simulator {
    web3: DynProvider,
    settlement: Address,
    authenticator: Address,
    wrapped_native_balance_slot: u8,
}

impl Simulator {
    /// Create a new simulator for computing DEX swap gas usage.
    pub fn new(
        url: &reqwest::Url,
        settlement: Address,
        authenticator: Address,
        wrapped_native_balance_slot: u8,
    ) -> Self {
        Self {
            web3: blockchain::rpc(url).provider,
            settlement,
            authenticator,
            wrapped_native_balance_slot,
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
        if let Some((slot, value)) =
            eth_flow_balance_override(owner, swap, self.wrapped_native_balance_slot)
        {
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
        if let Some((slot, value)) =
            eth_flow_balance_override(owner, swap, self.wrapped_native_balance_slot)
        {
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

impl Error {
    /// Whether this error is an EVM execution **revert** of the simulation
    /// call — the settlement the swap interactions would perform cannot
    /// succeed on-chain (the DEX under-delivers, or the router calldata
    /// reverts, which `Swapper` bubbles via `Caller.doMeteredCallNoReturn`) —
    /// as opposed to a **transient** transport/RPC failure (timeout, reset,
    /// 5xx, rate limit, (de)serialization) where the swap's executability is
    /// merely UNKNOWN.
    ///
    /// A reverting simulation for a real (settle-able) solve means the
    /// solution is unexecutable and must never be submitted, so callers fail
    /// CLOSED on it. A transient failure stays LENIENT: dropping a valid solve
    /// (or, in #774, a valid quote) on an RPC blip is the regression this
    /// classifier is built to avoid.
    ///
    /// Deliberately biased toward "transient": a revert is ONLY a JSON-RPC
    /// *error response* (the node executed the eth_call and it failed on-chain)
    /// carrying revert return-data, geth code `3`, an "…revert…" message, or
    /// the `INVALID`/`0xFE` opcode halt (`InvalidFEOpcode`, older Solidity's
    /// missing-selector halt). Local ABI-decode outcomes (`ZeroData` "0x" /
    /// unknown-selector), transport errors, null/local/serde failures,
    /// non-execution server errors (rate limit, internal error), and other EVM
    /// halts that bad input can trigger (`InvalidJump`, `StackUnderflow`, …)
    /// all return `false` and keep the lenient/transient path.
    pub fn is_revert(&self) -> bool {
        use ethrpc::alloy::errors::ContractErrorExt;
        let Self::ContractCall(err) = self else {
            // `SettlementContractIsOwner` is a can-not-simulate precondition,
            // not a revert; it has its own lenient arm at the call sites.
            return false;
        };
        // Only a JSON-RPC *error response* means the node actually executed the
        // eth_call and it failed on-chain. Gate the shared classifier on that
        // variant so we keep its revert-data / geth-code-3 / "revert" /
        // InvalidFEOpcode table but do NOT inherit its local-decode arm
        // (`ZeroData`/`UnknownFunction`/`UnknownSelector`): those are alloy
        // CLIENT-side decode outcomes with no node execution failure. In the
        // strict-output sim a `ZeroData` ("0x") arises when an upstream
        // silently DROPS the Swapper state override, so the eth_call hits a
        // codeless address — an infrastructure blip, not a settlement revert;
        // inheriting that arm would fail-close every real solve on such an RPC
        // hiccup (the #774 regression). A genuine revert can only surface as an
        // `ErrorResp` (alloy reaches its decode stage only on `Ok(bytes)`), so
        // this never lets a real settlement revert through.
        matches!(
            err,
            alloy::contract::Error::TransportError(t) if t.as_error_resp().is_some()
        ) && err.is_contract_revert()
    }
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
            wrapped_native_balance_slot(owner, 3),
            b256!("55576e8f9be9c279e97c3d9148807514bf90c4c718d2ff153be89caecfadc1a1"),
        );
    }

    #[test]
    fn wrapped_native_balance_slot_matches_unichain_onchain() {
        // Unichain's 0x4200..06 predeploy stores balances at mapping slot 0, NOT
        // WETH9's slot 3. Verified on-chain 2026-07-18 (incident: every eth-flow
        // order fail-closed because the override wrote to the dead slot-3 key):
        // - the settlement's LIVE balance sat at keccak(pad32(holder)||pad32(0))
        //   while the slot-3 key read empty;
        // - an eth_call stateDiff at the eth-flow contract's slot-0 key read
        //   back through balanceOf, at the slot-3 key it did not.
        let ethflow = address!("38c03729153bccf6a281daf41d7c6a14c543f1d7");
        assert_eq!(
            wrapped_native_balance_slot(ethflow, 0),
            b256!("bbf2b036c70cfa6194535e13d6a373c99dbf3ce152eb448755c768ae9da2e34a"),
        );
        let settlement = address!("108a678716e5e1776036ef044cab7064226f714e");
        assert_eq!(
            wrapped_native_balance_slot(settlement, 0),
            b256!("dacd2a9610dc8623051117c26da13093742d154c3ea72b5c4e0ff3a502a3e375"),
        );
        // Same holders under WETH9's slot 3 give DIFFERENT keys (the ones that
        // were verified EMPTY on Unichain).
        assert_eq!(
            wrapped_native_balance_slot(ethflow, 3),
            b256!("fe2b01d8e5f403db266a76a5bcb84c1fd3e54c52ff8c907d4cf09ad1cb4f3417"),
        );
        assert_eq!(
            wrapped_native_balance_slot(settlement, 3),
            b256!("7961f33f11549ab7edbb235ad1e0cdc4a5a9f7db7e56b5572200a1b234f1b37c"),
        );
    }

    mod is_revert {
        use super::*;

        // `deser_err` returns `RpcError::ErrorResp` when the text parses as a
        // JSON-RPC error payload — exactly the shape a node returns for a
        // reverted (or otherwise failed) `eth_call`. Builds a real
        // `alloy::contract::Error` without a live provider.
        fn contract_err(payload_json: &str) -> Error {
            let dummy = serde_json::from_str::<u8>("x").unwrap_err();
            let rpc_err = alloy::transports::TransportError::deser_err(dummy, payload_json);
            assert!(rpc_err.is_error_resp(), "test setup: expected an ErrorResp");
            Error::ContractCall(alloy::contract::Error::TransportError(rpc_err))
        }

        #[test]
        fn revert_with_reason_data_is_revert() {
            // geth/reth: {"code":3,"message":"execution reverted","data":"0x08c379a0…"}
            let err =
                contract_err(r#"{"code":3,"message":"execution reverted","data":"0x08c379a0"}"#);
            assert!(err.is_revert());
        }

        #[test]
        fn revert_empty_data_hex_is_revert() {
            let err = contract_err(r#"{"code":3,"message":"execution reverted","data":"0x"}"#);
            assert!(err.is_revert());
        }

        #[test]
        fn revert_message_only_no_data_field_is_revert() {
            // eRPC/normalized nodes may drop `data` on an empty revert; classify
            // by the execution-revert message.
            let err = contract_err(r#"{"code":-32000,"message":"execution reverted"}"#);
            assert!(err.is_revert());
        }

        #[test]
        fn invalid_fe_opcode_halt_is_revert() {
            // anvil/revm surface the INVALID (0xFE) opcode as `EVM error
            // InvalidFEOpcode` with NO "revert" word and NO return-data — older
            // Solidity emits it on a missing selector, a contract-level
            // rejection. The prior string-match let this slip to the lenient
            // path; the shared classifier catches it (Codex P2).
            let err = contract_err(r#"{"code":-32603,"message":"EVM error InvalidFEOpcode"}"#);
            assert!(err.is_revert());
        }

        #[test]
        fn geth_code_3_without_revert_word_is_revert() {
            // geth tags execution reverts with code 3; classify by the code even
            // when the message omits the literal "revert" word.
            let err = contract_err(r#"{"code":3,"message":"transaction execution failed"}"#);
            assert!(err.is_revert());
        }

        #[test]
        fn zero_data_local_decode_is_not_revert() {
            // `ContractError::ZeroData` is what alloy raises when an eth_call
            // returns "0x" — in the strict-output sim this happens when an
            // upstream silently DROPS the Swapper state override and the call
            // hits a codeless address. NOTHING reverted; it is an RPC/infra blip
            // that MUST stay lenient (else every real solve fails closed on an
            // override drop — the #774 regression). `ZeroData`'s second field is
            // an `alloy_dyn_abi::Error` (no ctor without a new dep), so we
            // exercise its IDENTICAL local-decode `is_contract_revert` match arm
            // via `UnknownFunction` — a non-`TransportError` variant the gate
            // excludes.
            let err = Error::ContractCall(alloy::contract::Error::UnknownFunction(
                "swapEnsuringOutput".to_string(),
            ));
            assert!(!err.is_revert());
        }

        #[test]
        fn unknown_selector_local_decode_is_not_revert() {
            // Same client-side decode arm as `ZeroData`: a local ABI-decode
            // outcome, not a node execution failure -> lenient.
            let err = Error::ContractCall(alloy::contract::Error::UnknownSelector(
                alloy::primitives::Selector::from([0xde, 0xad, 0xbe, 0xef]),
            ));
            assert!(!err.is_revert());
        }

        #[test]
        fn other_evm_halt_invalid_jump_is_not_revert() {
            // Halts that BAD INPUT can trigger (InvalidJump/StackUnderflow) are
            // not contract-level rejections — they must keep bubbling up as
            // transient rather than fail a real solve closed.
            let err = contract_err(r#"{"code":-32603,"message":"EVM error InvalidJump"}"#);
            assert!(!err.is_revert());
        }

        #[test]
        fn top_level_out_of_gas_is_not_revert() {
            // Top-level eth_call gas-cap OOG = can-not-measure/transient, NOT a
            // solution revert (a genuine inner OOG bubbles as "execution
            // reverted" via Caller.sol). Must stay lenient (#774 spirit).
            let err = contract_err(r#"{"code":-32000,"message":"out of gas"}"#);
            assert!(!err.is_revert());
        }

        #[test]
        fn rate_limit_error_resp_is_not_revert() {
            let err = contract_err(r#"{"code":-32005,"message":"rate limit exceeded"}"#);
            assert!(!err.is_revert());
        }

        #[test]
        fn internal_error_resp_is_not_revert() {
            let err = contract_err(r#"{"code":-32603,"message":"Internal error"}"#);
            assert!(!err.is_revert());
        }

        #[test]
        fn transport_error_is_not_revert() {
            // Connection-level failure: executability unknown -> transient.
            let rpc_err = alloy::transports::TransportError::local_usage_str("connection reset");
            assert!(!rpc_err.is_error_resp());
            let err = Error::ContractCall(alloy::contract::Error::TransportError(rpc_err));
            assert!(!err.is_revert());
        }

        #[test]
        fn null_response_is_not_revert() {
            let err = Error::ContractCall(alloy::contract::Error::TransportError(
                alloy::transports::TransportError::NullResp,
            ));
            assert!(!err.is_revert());
        }

        #[test]
        fn settlement_contract_is_owner_is_not_revert() {
            assert!(!Error::SettlementContractIsOwner.is_revert());
        }
    }
}
