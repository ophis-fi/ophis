//! `GET /api/v1/info/contracts` (api-dx, frozen path per owner decision 9).
//!
//! One call gives an integrator everything needed to talk to this
//! deployment's on-chain stack: the settlement, vault-relayer, authenticator
//! and hooks-trampoline contracts, each with its address AND full ABI, plus
//! the EIP-712 signing domain (with its precomputed separator), the
//! canonical Multicall3 address for balance/allowance preflights, and the
//! wrapped native token. Addresses come from the boot-time on-chain wiring
//! in `run.rs` (the same instances every other subsystem uses), never from a
//! parallel hardcoded table, so this endpoint cannot drift from what the
//! orderbook actually settles against.
//!
//! ABIs are embedded at compile time from the workspace contract artifacts
//! (the vault relayer's is generated once via `forge inspect` into
//! `api/abis/`, since the artifacts directory carries no standalone
//! GPv2VaultRelayer entry). Serving the full ABI next to the address spares
//! integrators the "which ABI version does this fork actually run" hunt.

use {
    super::AppState,
    alloy::primitives::Address,
    axum::{Json, extract::State, response::IntoResponse, response::Response},
    model::DomainSeparator,
    serde_json::{Value, json},
    std::sync::{Arc, LazyLock},
};

/// The canonical cross-chain Multicall3 deployment. Must match
/// `MULTICALL3_ADDRESS` in `packages/sdk/src/preflight.ts`: the SDK
/// preflight batches its balance/allowance reads through this contract.
pub const MULTICALL3_ADDRESS: &str = "0xcA11bde05977b3631167028862bE2a173976CA11";

fn artifact_abi(artifact: &'static str, name: &'static str) -> Value {
    let parsed: Value = serde_json::from_str(artifact)
        .unwrap_or_else(|err| panic!("embedded {name} artifact is not valid JSON: {err}"));
    let abi = parsed
        .get("abi")
        .unwrap_or_else(|| panic!("embedded {name} artifact has no `abi` key"));
    assert!(
        abi.as_array().is_some_and(|abi| !abi.is_empty()),
        "embedded {name} ABI is empty",
    );
    abi.clone()
}

fn bare_abi(abi: &'static str, name: &'static str) -> Value {
    let parsed: Value = serde_json::from_str(abi)
        .unwrap_or_else(|err| panic!("embedded {name} ABI is not valid JSON: {err}"));
    assert!(
        parsed.as_array().is_some_and(|abi| !abi.is_empty()),
        "embedded {name} ABI is empty",
    );
    parsed
}

static SETTLEMENT_ABI: LazyLock<Value> = LazyLock::new(|| {
    artifact_abi(
        include_str!("../../../../contracts/artifacts/GPv2Settlement.json"),
        "GPv2Settlement",
    )
});

/// Generated once via `forge inspect src/contracts/GPv2VaultRelayer.sol:GPv2VaultRelayer abi`
/// from the `contracts/` Foundry workspace (the Rust contract artifacts have
/// no standalone vault-relayer entry).
static VAULT_RELAYER_ABI: LazyLock<Value> = LazyLock::new(|| {
    bare_abi(
        include_str!("abis/GPv2VaultRelayer.abi.json"),
        "GPv2VaultRelayer",
    )
});

static AUTHENTICATOR_ABI: LazyLock<Value> = LazyLock::new(|| {
    artifact_abi(
        include_str!("../../../../contracts/artifacts/GPv2AllowListAuthentication.json"),
        "GPv2AllowListAuthentication",
    )
});

static HOOKS_TRAMPOLINE_ABI: LazyLock<Value> = LazyLock::new(|| {
    artifact_abi(
        include_str!("../../../../contracts/artifacts/HooksTrampoline.json"),
        "HooksTrampoline",
    )
});

/// Boot-time contract facts for this deployment, wired in `run.rs` from the
/// same on-chain reads the rest of the orderbook uses.
#[derive(Clone, Debug)]
pub struct ContractsInfo {
    pub chain_id: u64,
    pub settlement: Address,
    pub vault_relayer: Address,
    pub authenticator: Address,
    pub hooks_trampoline: Address,
    pub wrapped_native_token: Address,
    pub domain_separator: DomainSeparator,
}

impl ContractsInfo {
    /// The `GET /api/v1/info/contracts` response body. Field shapes follow
    /// the archived Odos contract-info conventions where they made sense
    /// (flat chainId, `{address, abi}` per contract) with camelCase naming
    /// consistent with the rest of this API.
    pub fn response_body(&self) -> Value {
        json!({
            "chainId": self.chain_id,
            "settlement": {
                "address": self.settlement.to_string(),
                "abi": &*SETTLEMENT_ABI,
            },
            "vaultRelayer": {
                "address": self.vault_relayer.to_string(),
                "abi": &*VAULT_RELAYER_ABI,
            },
            "authenticator": {
                "address": self.authenticator.to_string(),
                "abi": &*AUTHENTICATOR_ABI,
            },
            "hooksTrampoline": {
                "address": self.hooks_trampoline.to_string(),
                "abi": &*HOOKS_TRAMPOLINE_ABI,
            },
            "multicall3": {
                "address": MULTICALL3_ADDRESS,
            },
            "wrappedNativeToken": {
                "address": self.wrapped_native_token.to_string(),
            },
            "eip712Domain": {
                "name": "Gnosis Protocol",
                "version": "v2",
                "chainId": self.chain_id,
                "verifyingContract": self.settlement.to_string(),
            },
            "domainSeparator": format!("0x{:?}", self.domain_separator),
        })
    }
}

pub async fn get_contract_info_handler(State(state): State<Arc<AppState>>) -> Response {
    Json(state.contracts.response_body()).into_response()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn test_contracts_info() -> ContractsInfo {
        // The live Optimism (chain 10) deployment values; the tests only rely
        // on internal consistency, not on these being reachable.
        ContractsInfo {
            chain_id: 10,
            settlement: "0x310784c7FCE12d578dA6f53460777bAc9718B859"
                .parse()
                .unwrap(),
            vault_relayer: "0x83847EaB41ad9ea43809ce71569eB2e9daF51830"
                .parse()
                .unwrap(),
            authenticator: "0x0101010101010101010101010101010101010101"
                .parse()
                .unwrap(),
            hooks_trampoline: "0x2fbb1e41ff4f9b707e4428eec7f5afaac5d60810"
                .parse()
                .unwrap(),
            wrapped_native_token: "0x4200000000000000000000000000000000000006"
                .parse()
                .unwrap(),
            domain_separator: DomainSeparator::new(
                10,
                "0x310784c7FCE12d578dA6f53460777bAc9718B859".parse().unwrap(),
            ),
        }
    }

    fn abi_entry_names(abi: &Value) -> Vec<&str> {
        abi.as_array()
            .unwrap()
            .iter()
            .filter_map(|entry| entry.get("name").and_then(Value::as_str))
            .collect()
    }

    #[test]
    fn serves_every_contract_with_address_and_full_abi() {
        let body = test_contracts_info().response_body();

        for (key, expected_fn) in [
            ("settlement", "settle"),
            ("vaultRelayer", "batchSwapWithFee"),
            ("authenticator", "isSolver"),
            ("hooksTrampoline", "execute"),
        ] {
            let contract = &body[key];
            let address = contract["address"].as_str().unwrap();
            assert!(address.starts_with("0x") && address.len() == 42, "{key}");
            assert!(
                abi_entry_names(&contract["abi"]).contains(&expected_fn),
                "{key} ABI must contain {expected_fn}",
            );
        }

        // The vault relayer ABI is complete, not a fragment.
        assert!(abi_entry_names(&body["vaultRelayer"]["abi"]).contains(&"transferFromAccounts"));
    }

    #[test]
    fn serves_multicall3_and_wrapped_native_token() {
        let body = test_contracts_info().response_body();
        // Parity with packages/sdk/src/preflight.ts MULTICALL3_ADDRESS.
        assert_eq!(
            body["multicall3"]["address"],
            "0xcA11bde05977b3631167028862bE2a173976CA11",
        );
        assert_eq!(
            body["wrappedNativeToken"]["address"],
            "0x4200000000000000000000000000000000000006",
        );
    }

    #[test]
    fn eip712_domain_matches_the_boot_domain_separator() {
        let info = test_contracts_info();
        let body = info.response_body();

        let domain = &body["eip712Domain"];
        assert_eq!(domain["name"], "Gnosis Protocol");
        assert_eq!(domain["version"], "v2");
        assert_eq!(domain["chainId"], 10);
        assert_eq!(
            domain["verifyingContract"],
            "0x310784c7FCE12d578dA6f53460777bAc9718B859",
        );

        // Parity: hashing the served domain fields with
        // model::DomainSeparator::new yields exactly the served separator, so
        // a client signing against `eip712Domain` produces signatures this
        // orderbook accepts.
        let recomputed = DomainSeparator::new(
            domain["chainId"].as_u64().unwrap(),
            domain["verifyingContract"]
                .as_str()
                .unwrap()
                .parse()
                .unwrap(),
        );
        assert_eq!(
            body["domainSeparator"].as_str().unwrap(),
            format!("0x{recomputed:?}"),
        );
    }
}
