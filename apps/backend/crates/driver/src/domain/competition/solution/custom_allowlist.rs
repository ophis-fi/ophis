//! Driver-level allowlist for `Custom` interactions returned by solvers.
//!
//! This is the C2 layer-2 hardening from the 2026-05-18 Phase 2 backend
//! audit (synthesis: `docs/audits/2026-05-18-phase2-backend.md`). Solver-
//! level allowlists (KyberSwap, Velora, OKX) already exist per-DEX. This
//! driver-level allowlist is a defense-in-depth backstop that applies to
//! ALL solvers — including future integrations that forget to add their
//! own allowlist.
//!
//! It enforces three invariants on every `Custom` interaction the driver
//! receives from a solver:
//!
//!   1. `Custom.target` must be on the per-chain allowlist.
//!   2. Each `allowance.spender` must be on the per-chain allowlist.
//!   3. Each `allowance.amount` must be ≤ `MAX_CUSTOM_ALLOWANCE`. This
//!      rejects `U256::MAX` (the structural "unlimited approval" anti-
//!      pattern flagged by the audit) plus any value in the top
//!      ~50-orders-of-magnitude band — none of which any real order
//!      needs.
//!
//! The per-chain lists below mirror the union of all currently-deployed
//! solver allowlists at the time of audit closure (2026-05-22). When a
//! new solver integration ships, its router/spender addresses MUST be
//! added here in the same PR — verified independently against upstream
//! docs, NOT taken from an API response (that's the attack vector this
//! gate prevents).

use {
    crate::domain::competition::solution::interaction,
    alloy::primitives::{Address, U256, address},
};

/// Cap on the value of any allowance a solver can request via a `Custom`
/// interaction. = `2^200` ≈ `1.6e60`.
///
/// Why this value:
/// - Rejects `U256::MAX` and any "infinite approval" sentinel value.
/// - Plenty of headroom for legitimate orders: even an 18-decimal token
///   at `2^200` wei is `1.6e42` tokens — ~24 orders of magnitude beyond
///   any token's total supply.
/// - Power-of-two so the const can be expressed as `from_limbs` without
///   a runtime helper. Bit 200 lives in the 4th `u64` limb at offset
///   `200 - 192 = 8`.
pub const MAX_CUSTOM_ALLOWANCE: U256 = U256::from_limbs([0, 0, 0, 1u64 << 8]);

/// Per-chain allowlist of contract addresses approved as `Custom.target`
/// or as `allowance.spender`.
///
/// Adding a new chain: extend `ALLOWLIST` with `(chain_id, &CHAIN_NAME)`
/// and define `CHAIN_NAME: &[Address]` with verified addresses.
/// Adding a new contract on an existing chain: extend the relevant
/// per-chain slice. In both cases, verify against the upstream's
/// canonical docs — never take the address from a `/swap` or `/routes`
/// response.
const ALLOWLIST: &[(u64, &[Address])] = &[
    (10, OPTIMISM_MAINNET),
    (999, HYPEREVM_MAINNET),
];

/// Optimism mainnet (chain 10). Verified against upstream docs.
/// Each address kept in its EIP-55 mixed-case canonical form so that
/// reviewers can sanity-check the value by eye against upstream pages.
const OPTIMISM_MAINNET: &[Address] = &[
    // KyberSwap MetaAggregationRouterV2 — CREATE2-deterministic across
    // all KyberSwap-supported chains. Single address serves as both
    // router (`tx.to`) and ERC-20 spender. Verified live 2026-05-16 via
    // upstream docs:
    // https://docs.kyberswap.com/Aggregator/aggregator-protocol-deployment/contracts-and-addresses
    address!("6131B5fae19EA4f9D964eAc0408E4408b66337b5"),
    // Velora Augustus V6.2 — single address across all 10 Velora-
    // supported chains (Optimism is in the list). Router == spender.
    // Verified live 2026-05-16 via `cast code` (49127 bytes) and
    // upstream docs:
    // https://developers.velora.xyz/augustus-swapper/augustus-v6.2-smart-contracts
    address!("6a000F20005980200259B80c5102003040001068"),
    // OKX V6 router on Optimism mainnet. Verified 2026-05-18 via
    // authenticated probe + `cast code`. Used as `tx.to` returned by
    // OKX `/swap`. Distinct from the spender address below — OKX
    // separates router and approval target on V6.
    address!("Dd5E9B947c99AA60baB00CA4631DCe63b49983E7"),
    // OKX V6 spender on Optimism mainnet. Returned by OKX
    // `/approve-transaction` as `dexContractAddress` — the ERC-20
    // approval grantee. Verified 2026-05-18 alongside the router.
    address!("68D6B739D2020067D1e2F713b999dA97E4d54812"),
];

/// HyperEVM mainnet (chain 999). Only KyberSwap currently supports this
/// chain; Velora and OKX do NOT deploy here as of 2026-05-22. When OKX
/// or Velora add HyperEVM support, append their router/spender after
/// upstream verification.
const HYPEREVM_MAINNET: &[Address] = &[
    // KyberSwap MetaAggregationRouterV2 (same CREATE2 address as OP).
    address!("6131B5fae19EA4f9D964eAc0408E4408b66337b5"),
];

/// Validation error from [`validate`] / [`validate_target`] /
/// [`validate_value`].
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum Error {
    #[error(
        "interaction target {target:?} not on driver allowlist for chain {chain_id} — refusing \
         interaction. If this is a legitimate new router, add it to ALLOWLIST in \
         driver/src/domain/competition/solution/custom_allowlist.rs after independent \
         verification."
    )]
    TargetNotAllowed { target: Address, chain_id: u64 },

    #[error(
        "Custom allowance spender {spender:?} not on driver allowlist for chain {chain_id} — \
         refusing approval. Add to ALLOWLIST after upstream-verified."
    )]
    SpenderNotAllowed { spender: Address, chain_id: u64 },

    #[error(
        "Custom allowance amount {amount} exceeds MAX_CUSTOM_ALLOWANCE (2^200). Solvers must \
         not request unlimited approvals (U256::MAX) — issue per-trade amounts scoped to the \
         actual order size."
    )]
    AmountTooLarge { amount: U256 },

    #[error(
        "interaction native-ETH value {value} exceeds MAX_INTERACTION_VALUE (2^200). Solvers \
         must not request unbounded native-token transfers — value must be scoped to settlement \
         ETH balance."
    )]
    ValueTooLarge { value: U256 },

    #[error(
        "Driver allowlist not configured for chain {chain_id}. Custom interactions on \
         unconfigured chains are rejected fail-secure. Add a per-chain entry to ALLOWLIST in \
         custom_allowlist.rs."
    )]
    ChainNotConfigured { chain_id: u64 },
}

impl Error {
    /// Stable, low-cardinality label for the `custom_interaction_rejected`
    /// Prometheus metric.
    pub fn metric_reason(&self) -> &'static str {
        match self {
            Error::TargetNotAllowed { .. } => "target_not_allowed",
            Error::SpenderNotAllowed { .. } => "spender_not_allowed",
            Error::AmountTooLarge { .. } => "amount_too_large",
            Error::ValueTooLarge { .. } => "value_too_large",
            Error::ChainNotConfigured { .. } => "chain_not_configured",
        }
    }
}

/// Validate a `Custom` interaction against the driver-level allowlist.
///
/// Returns `Ok(())` if every check passes. Returns `Err(...)` on the first
/// violation — callers should log + emit `custom_interaction_rejected`
/// metric + propagate to the solver as a parse error.
pub fn validate(custom: &interaction::Custom, chain_id: u64) -> Result<(), Error> {
    let allowlist = chain_allowlist(chain_id)?;

    // (1) target — `ContractAddress(Address)` is opaque from outside its
    // defining crate; the public path is `Address::from(...)`.
    let target: Address = Address::from(custom.target);
    if !allowlist.contains(&target) {
        return Err(Error::TargetNotAllowed { target, chain_id });
    }

    // (2) — native ETH value cap (closes a residual sharp edge flagged by
    // the 2026-05-22 sharp-edges PR-E audit: solver can request arbitrary
    // ETH transfer with the call, and allowlisted aggregators accept
    // ETH-in swaps — bounding `value` prevents settlement-balance drain
    // via a single Custom interaction).
    let value: U256 = custom.value.0;
    if value > MAX_INTERACTION_VALUE {
        return Err(Error::ValueTooLarge { value });
    }

    // (3) + (4) — each allowance
    for required in &custom.allowances {
        let allowance = required.0;
        if !allowlist.contains(&allowance.spender) {
            return Err(Error::SpenderNotAllowed {
                spender: allowance.spender,
                chain_id,
            });
        }
        if allowance.amount > MAX_CUSTOM_ALLOWANCE {
            return Err(Error::AmountTooLarge {
                amount: allowance.amount,
            });
        }
    }

    Ok(())
}

/// Cap on the native-ETH `value` field of any solver-supplied interaction
/// (Custom + raw pre/post). Identical numeric to [`MAX_CUSTOM_ALLOWANCE`]
/// (`2^200`); kept as a distinct alias so future tuning of one doesn't
/// silently affect the other.
pub const MAX_INTERACTION_VALUE: U256 = MAX_CUSTOM_ALLOWANCE;

/// Validate a bare interaction target against the per-chain allowlist.
///
/// Used for solver-supplied `pre_interactions` and `post_interactions`
/// (`Call` DTOs at `solver/dto/solution.rs:150,259`) which bypass the
/// `Custom` wrapper entirely but ultimately land in the settlement
/// calldata via `encoding.rs:217`. Without this check, a malicious solver
/// could route arbitrary calls through pre/post slots and avoid the
/// `Custom` allowlist completely. Closes the HIGH from the 2026-05-22
/// Codex Cyber PR-E audit.
pub fn validate_target(target: Address, chain_id: u64) -> Result<(), Error> {
    let allowlist = chain_allowlist(chain_id)?;
    if !allowlist.contains(&target) {
        return Err(Error::TargetNotAllowed { target, chain_id });
    }
    Ok(())
}

/// Validate a bare interaction native-ETH value against
/// [`MAX_INTERACTION_VALUE`]. Used alongside [`validate_target`] for
/// pre/post interactions.
pub fn validate_value(value: U256) -> Result<(), Error> {
    if value > MAX_INTERACTION_VALUE {
        return Err(Error::ValueTooLarge { value });
    }
    Ok(())
}

fn chain_allowlist(chain_id: u64) -> Result<&'static [Address], Error> {
    ALLOWLIST
        .iter()
        .find(|(c, _)| *c == chain_id)
        .map(|(_, list)| *list)
        .ok_or(Error::ChainNotConfigured { chain_id })
}

#[cfg(test)]
mod tests {
    use {
        super::*,
        crate::domain::competition::solution::interaction::Custom,
        alloy::primitives::{Bytes, U256, address},
        eth_domain_types as eth,
    };

    // KyberSwap router (verified on both OP and HL).
    const KYBER: Address = address!("6131B5fae19EA4f9D964eAc0408E4408b66337b5");
    // Velora Augustus V6.2 (OP only).
    const VELORA: Address = address!("6a000F20005980200259B80c5102003040001068");
    // OKX V6 router on OP (used in the OKX coverage test below).
    const OKX_OP_ROUTER: Address = address!("Dd5E9B947c99AA60baB00CA4631DCe63b49983E7");
    // OKX V6 spender on OP (separate from router — verifies router/spender
    // distinct-address handling).
    const OKX_OP_SPENDER: Address = address!("68D6B739D2020067D1e2F713b999dA97E4d54812");
    // Random off-allowlist address (audit-style attacker control).
    const ATTACKER: Address = address!("4242424242424242424242424242424242424242");

    fn make_custom(target: Address, allowances: Vec<(Address, U256)>) -> Custom {
        Custom {
            target: target.into(),
            value: eth::Ether(U256::ZERO),
            call_data: Bytes::new(),
            allowances: allowances
                .into_iter()
                .map(|(spender, amount)| {
                    eth::allowance::Required(eth::allowance::Allowance {
                        token: address!("0000000000000000000000000000000000000001").into(),
                        spender,
                        amount,
                    })
                })
                .collect(),
            inputs: vec![],
            outputs: vec![],
            internalize: false,
        }
    }

    #[test]
    fn target_allowlisted_op() {
        let c = make_custom(KYBER, vec![(KYBER, U256::from(1000u64))]);
        assert_eq!(validate(&c, 10), Ok(()));
    }

    #[test]
    fn target_allowlisted_hl() {
        let c = make_custom(KYBER, vec![(KYBER, U256::from(1000u64))]);
        assert_eq!(validate(&c, 999), Ok(()));
    }

    #[test]
    fn target_not_allowlisted() {
        let c = make_custom(ATTACKER, vec![]);
        match validate(&c, 10) {
            Err(Error::TargetNotAllowed { target, chain_id: 10 }) if target == ATTACKER => {}
            other => panic!("expected TargetNotAllowed, got {other:?}"),
        }
    }

    #[test]
    fn velora_not_supported_on_hl() {
        // Velora router is allowlisted on OP but NOT on HL (Velora doesn't
        // deploy there). Same allowance should pass on OP, fail on HL.
        let c = make_custom(VELORA, vec![(VELORA, U256::from(1000u64))]);
        assert_eq!(validate(&c, 10), Ok(()));
        assert!(matches!(
            validate(&c, 999),
            Err(Error::TargetNotAllowed { .. })
        ));
    }

    #[test]
    fn spender_not_allowlisted() {
        let c = make_custom(KYBER, vec![(ATTACKER, U256::from(1000u64))]);
        match validate(&c, 10) {
            Err(Error::SpenderNotAllowed {
                spender,
                chain_id: 10,
            }) if spender == ATTACKER => {}
            other => panic!("expected SpenderNotAllowed, got {other:?}"),
        }
    }

    #[test]
    fn allowance_amount_u256_max_rejected() {
        let c = make_custom(KYBER, vec![(KYBER, U256::MAX)]);
        assert!(matches!(validate(&c, 10), Err(Error::AmountTooLarge { .. })));
    }

    #[test]
    fn allowance_amount_above_cap_rejected() {
        // 2^201 = MAX_CUSTOM_ALLOWANCE * 2 — over the cap.
        let above_cap = MAX_CUSTOM_ALLOWANCE.saturating_mul(U256::from(2u64));
        let c = make_custom(KYBER, vec![(KYBER, above_cap)]);
        assert!(matches!(validate(&c, 10), Err(Error::AmountTooLarge { .. })));
    }

    #[test]
    fn allowance_amount_at_cap_accepted() {
        let c = make_custom(KYBER, vec![(KYBER, MAX_CUSTOM_ALLOWANCE)]);
        assert_eq!(validate(&c, 10), Ok(()));
    }

    #[test]
    fn allowance_amount_large_but_under_cap_accepted() {
        // 1e30 — far above any real order size, well under 2^200.
        let large = U256::from(10u64).pow(U256::from(30u64));
        let c = make_custom(KYBER, vec![(KYBER, large)]);
        assert_eq!(validate(&c, 10), Ok(()));
    }

    #[test]
    fn unknown_chain_fail_secure() {
        // chain 4326 (MegaETH mainnet) is intentionally not in the allowlist
        // yet — verifies the fail-secure default.
        let c = make_custom(KYBER, vec![]);
        match validate(&c, 4326) {
            Err(Error::ChainNotConfigured { chain_id: 4326 }) => {}
            other => panic!("expected ChainNotConfigured, got {other:?}"),
        }
    }

    #[test]
    fn metric_reason_stable() {
        // Stable low-cardinality label values for Prometheus.
        assert_eq!(
            Error::TargetNotAllowed {
                target: ATTACKER,
                chain_id: 10
            }
            .metric_reason(),
            "target_not_allowed"
        );
        assert_eq!(
            Error::SpenderNotAllowed {
                spender: ATTACKER,
                chain_id: 10
            }
            .metric_reason(),
            "spender_not_allowed"
        );
        assert_eq!(
            Error::AmountTooLarge { amount: U256::MAX }.metric_reason(),
            "amount_too_large"
        );
        assert_eq!(
            Error::ChainNotConfigured { chain_id: 4326 }.metric_reason(),
            "chain_not_configured"
        );
    }

    #[test]
    fn multiple_allowances_first_violation_wins() {
        // If multiple allowances are invalid, the first violation in
        // iteration order is returned. Documents the behavior so a
        // future refactor doesn't silently change error semantics.
        let c = make_custom(
            KYBER,
            vec![
                (ATTACKER, U256::from(1000u64)),
                (ATTACKER, U256::MAX),
            ],
        );
        assert!(matches!(
            validate(&c, 10),
            Err(Error::SpenderNotAllowed { .. })
        ));
    }

    #[test]
    fn empty_allowances_ok_if_target_ok() {
        // No allowances at all = no value flow. Target check still applies.
        let c = make_custom(KYBER, vec![]);
        assert_eq!(validate(&c, 10), Ok(()));
    }

    #[test]
    fn validate_target_helper_accepts_kyber_on_op() {
        assert_eq!(validate_target(KYBER, 10), Ok(()));
    }

    #[test]
    fn validate_target_helper_rejects_attacker() {
        match validate_target(ATTACKER, 10) {
            Err(Error::TargetNotAllowed {
                target,
                chain_id: 10,
            }) if target == ATTACKER => {}
            other => panic!("expected TargetNotAllowed, got {other:?}"),
        }
    }

    #[test]
    fn validate_target_helper_unknown_chain_fail_secure() {
        assert!(matches!(
            validate_target(KYBER, 4326),
            Err(Error::ChainNotConfigured { chain_id: 4326 })
        ));
    }

    #[test]
    fn validate_value_under_cap_ok() {
        // Realistic order ETH value: 10 ETH = 1e19 wei.
        assert_eq!(validate_value(U256::from(10u64).pow(U256::from(19u64))), Ok(()));
    }

    #[test]
    fn validate_value_at_cap_ok() {
        assert_eq!(validate_value(MAX_INTERACTION_VALUE), Ok(()));
    }

    #[test]
    fn validate_value_u256_max_rejected() {
        assert!(matches!(
            validate_value(U256::MAX),
            Err(Error::ValueTooLarge { .. })
        ));
    }

    #[test]
    fn validate_value_above_cap_rejected() {
        let above_cap = MAX_INTERACTION_VALUE.saturating_mul(U256::from(2u64));
        assert!(matches!(
            validate_value(above_cap),
            Err(Error::ValueTooLarge { .. })
        ));
    }

    #[test]
    fn validate_custom_value_rejected_when_above_cap() {
        // Custom validation now also caps `value`. A KyberSwap-target
        // Custom with attacker-controlled native ETH transfer of
        // U256::MAX must be rejected even though target + spender are
        // allowlisted.
        let mut c = make_custom(KYBER, vec![(KYBER, U256::from(1000u64))]);
        c.value = eth::Ether(U256::MAX);
        assert!(matches!(validate(&c, 10), Err(Error::ValueTooLarge { .. })));
    }

    #[test]
    fn okx_router_and_distinct_spender_both_allowlisted() {
        // OKX V6 uses distinct addresses for the router (`tx.to`) and the
        // ERC-20 spender (`dexContractAddress`). Both must be on the
        // allowlist for an OKX-routed Custom interaction to validate.
        let c = make_custom(
            OKX_OP_ROUTER,
            vec![(OKX_OP_SPENDER, U256::from(1_000_000_000u64))],
        );
        assert_eq!(validate(&c, 10), Ok(()));
    }

    #[test]
    fn max_custom_allowance_is_2_pow_200() {
        assert_eq!(
            MAX_CUSTOM_ALLOWANCE,
            U256::from(1u64) << 200,
            "MAX_CUSTOM_ALLOWANCE should equal 2^200; check const limb layout"
        );
    }
}
