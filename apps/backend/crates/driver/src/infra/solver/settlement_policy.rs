//! settle()-only signing policy for the submitter EOA (#441).
//!
//! Defence-in-depth: even a fully-compromised driver process can only get the
//! submitter signer to produce a *legitimate settlement* transaction, not an
//! arbitrary one (a token `approve`, a raw ETH transfer, a call to an attacker
//! contract). It is a **use** constraint on the in-process signing channel — NOT
//! a theft constraint (a thief who exfiltrates the raw key signs off-box,
//! bypassing this). Pairs with key-out-of-process custody (`Account::Kms`) for the
//! theft side; this closes the "RCE drives the signer to drain the float" vector.
//!
//! Fail-closed: a transaction is allowed ONLY if it calls an allow-listed
//! `(target, selector)` pair with zero ETH value. The allow-set is supplied
//! explicitly (operator config, validated on a testnet) so it can be tuned to a
//! given deployment without code changes — on Optimism the only legitimate target
//! is `settle()` -> GPv2Settlement; deployments that enable flashloans/wrappers add
//! their `(router, flashLoanAndSettle)` / wrapper pairs.

use alloy::primitives::{Address, U256};

/// A contract the submitter may call, and the 4-byte selectors permitted on it.
#[derive(Debug, Clone)]
pub struct AllowedTarget {
    pub address: Address,
    pub selectors: Vec<[u8; 4]>,
}

/// The settle()-only signing policy. See module docs.
#[derive(Debug, Clone)]
pub struct SettlementPolicy {
    pub allowed: Vec<AllowedTarget>,
    /// Reject any tx carrying non-zero ETH value (settlements never send value —
    /// `solution/encoding.rs` builds them with `value: Ether::zero()`).
    pub require_zero_value: bool,
}

/// Why a transaction was refused. Surfaced in the signer error + logs so a
/// rejected *legitimate* settlement (a misconfigured allow-set) is debuggable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyViolation {
    NonZeroValue(U256),
    ContractCreation,
    DisallowedTarget(Address),
    CalldataTooShort(usize),
    DisallowedSelector { to: Address, selector: [u8; 4] },
}

impl std::fmt::Display for PolicyViolation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NonZeroValue(v) => write!(f, "settlement policy: non-zero value {v}"),
            Self::ContractCreation => write!(f, "settlement policy: contract-creation tx (no `to`)"),
            Self::DisallowedTarget(to) => write!(f, "settlement policy: disallowed target {to}"),
            Self::CalldataTooShort(n) => {
                write!(f, "settlement policy: calldata too short ({n} bytes, need >= 4 for a selector)")
            }
            Self::DisallowedSelector { to, selector } => write!(
                f,
                "settlement policy: disallowed selector 0x{} for target {to}",
                alloy::hex::encode(selector)
            ),
        }
    }
}

impl SettlementPolicy {
    /// Fail-closed check of a transaction against the policy. `to` is the tx
    /// recipient (`None` = contract creation), `input` the calldata (the 4-byte
    /// selector is `input[0..4]`; settlement calldata legitimately has extra bytes
    /// appended after the ABI args, e.g. the auction id, which does not affect the
    /// selector), `value` the ETH value.
    pub fn check(&self, to: Option<Address>, input: &[u8], value: U256) -> Result<(), PolicyViolation> {
        if self.require_zero_value && !value.is_zero() {
            return Err(PolicyViolation::NonZeroValue(value));
        }
        let to = to.ok_or(PolicyViolation::ContractCreation)?;
        let target = self
            .allowed
            .iter()
            .find(|t| t.address == to)
            .ok_or(PolicyViolation::DisallowedTarget(to))?;
        if input.len() < 4 {
            return Err(PolicyViolation::CalldataTooShort(input.len()));
        }
        let selector: [u8; 4] = [input[0], input[1], input[2], input[3]];
        if !target.selectors.contains(&selector) {
            return Err(PolicyViolation::DisallowedSelector { to, selector });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use {
        super::*,
        alloy::primitives::{address, U256},
    };

    // GPv2Settlement on Optimism mainnet.
    const SETTLEMENT: Address = address!("310784c7FCE12d578dA6f53460777bAc9718B859");
    // settle((address[],uint256[],...)) selector.
    const SETTLE: [u8; 4] = [0x13, 0xd7, 0x9a, 0x0b];
    // ERC20 approve(address,uint256) — the canonical "drain" selector to refuse.
    const APPROVE: [u8; 4] = [0x09, 0x5e, 0xa7, 0xb3];

    fn settle_only() -> SettlementPolicy {
        SettlementPolicy {
            allowed: vec![AllowedTarget { address: SETTLEMENT, selectors: vec![SETTLE] }],
            require_zero_value: true,
        }
    }

    // A real settle() calldata shape: selector + ABI args + the appended auction id.
    fn settle_calldata() -> Vec<u8> {
        let mut v = SETTLE.to_vec();
        v.extend_from_slice(&[0u8; 320]); // stand-in ABI args
        v.extend_from_slice(&7u64.to_be_bytes()); // appended auction id (encoding.rs)
        v
    }

    #[test]
    fn allows_settle_to_settlement_with_appended_auction_id() {
        assert_eq!(settle_only().check(Some(SETTLEMENT), &settle_calldata(), U256::ZERO), Ok(()));
    }

    #[test]
    fn rejects_approve_to_settlement() {
        let mut input = APPROVE.to_vec();
        input.extend_from_slice(&[0u8; 64]);
        assert!(matches!(
            settle_only().check(Some(SETTLEMENT), &input, U256::ZERO),
            Err(PolicyViolation::DisallowedSelector { .. })
        ));
    }

    #[test]
    fn rejects_settle_to_a_different_target() {
        let other = address!("00000000000000000000000000000000000ABCDE");
        assert_eq!(
            settle_only().check(Some(other), &settle_calldata(), U256::ZERO),
            Err(PolicyViolation::DisallowedTarget(other))
        );
    }

    #[test]
    fn rejects_non_zero_value_even_for_a_legit_settle() {
        assert_eq!(
            settle_only().check(Some(SETTLEMENT), &settle_calldata(), U256::from(1)),
            Err(PolicyViolation::NonZeroValue(U256::from(1)))
        );
    }

    #[test]
    fn rejects_contract_creation() {
        assert_eq!(
            settle_only().check(None, &settle_calldata(), U256::ZERO),
            Err(PolicyViolation::ContractCreation)
        );
    }

    #[test]
    fn rejects_calldata_shorter_than_a_selector() {
        assert_eq!(
            settle_only().check(Some(SETTLEMENT), &[0x13, 0xd7], U256::ZERO),
            Err(PolicyViolation::CalldataTooShort(2))
        );
    }

    #[test]
    fn allows_a_configured_flashloan_router_pair() {
        // Deployments that enable flashloans add (router, flashLoanAndSettle).
        let router = address!("00000000000000000000000000000000000000AA");
        let flash_loan_and_settle = [0xe7, 0xc4, 0x38, 0xc9]; // FlashLoanRouter selector const
        let policy = SettlementPolicy {
            allowed: vec![
                AllowedTarget { address: SETTLEMENT, selectors: vec![SETTLE] },
                AllowedTarget { address: router, selectors: vec![flash_loan_and_settle] },
            ],
            require_zero_value: true,
        };
        let mut input = flash_loan_and_settle.to_vec();
        input.extend_from_slice(&[0u8; 64]);
        assert_eq!(policy.check(Some(router), &input, U256::ZERO), Ok(()));
        // ...but the flashloan selector to the SETTLEMENT target is still refused.
        assert!(matches!(
            policy.check(Some(SETTLEMENT), &input, U256::ZERO),
            Err(PolicyViolation::DisallowedSelector { .. })
        ));
    }
}
