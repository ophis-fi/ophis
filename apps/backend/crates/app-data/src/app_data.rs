use {
    crate::{AppDataHash, Hooks, app_data_hash::hash_full_app_data},
    alloy_primitives::{Address, U256, address},
    anyhow::{Result, anyhow},
    bytes_hex::BytesHex,
    moka::sync::Cache,
    number::serialization::HexOrDecimalU256,
    serde::{Deserialize, Deserializer, Serialize, Serializer, de},
    serde_with::serde_as,
    std::{
        fmt::{self, Display},
        slice::Iter,
    },
};

/// The minimum valid empty app data JSON string.
pub const EMPTY: &str = "{}";

/// Allowlist of partner-fee recipient addresses that orders are permitted to
/// route fees to. Closes audit Phase 2 finding C3 / adversarial F6: the
/// `recipient` field on `partnerFee` is fully user-controlled in app-data, so
/// without an allowlist anyone can craft app-data naming themselves as
/// recipient and harvest fees on orders that reference that document.
///
/// **Entries:**
/// - `0x858f0F5eE954846D47155F5203c04aF1819eCeF8` — Ophis partner-fee Safe
///   (2-of-3 multisig, threshold verified on-chain; CIP-75 partner-fee
///   receiver for the "CoW Swap" appCode integration).
///
/// **Adding entries:** new partners must be onboarded through this constant
/// after the partner-fee Safe address is independently verified (multisig
/// owners, deployment proof, signed agreement). Do NOT take recipient
/// addresses from app-data documents — that's the attack we're preventing.
pub const PARTNER_FEE_RECIPIENT_ALLOWLIST: &[Address] = &[
    // Ophis partner-fee Safe (verified EIP-55 checksum; cross-referenced
    // against memory/project_ophis.md and used by CIP-75 integrators).
    Address::new([
        0x85, 0x8f, 0x0F, 0x5e, 0xE9, 0x54, 0x84, 0x6D, 0x47, 0x15, 0x5F, 0x52, 0x03, 0xc0, 0x4a,
        0xF1, 0x81, 0x9e, 0xCe, 0xF8,
    ]),
];

/// The canonical Ophis partner-fee recipient (index 0 of the allowlist above),
/// named so the per-recipient fee floor and the autopilot clamp can key on it.
pub const OPHIS_PARTNER_FEE_RECIPIENT: Address =
    address!("0x858f0F5eE954846D47155F5203c04aF1819eCeF8");

/// Standard Ophis volume fee (0.10%) and the reduced same-chain-stablecoin /
/// boosted rate (0.01%). These MUST stay in lockstep with the frontend
/// (modules/volumeFee/state/volumeFeeAtom.ts + ophis/partnerFeeDefault.ts +
/// ophis/boostedTokens.ts) and the SDK (packages/sdk/src/partner-fee.ts). They
/// are the MINIMUM Volume bps the OP self-hosted backend will accept for a fee to
/// an allowlisted recipient — closing the prior bypass where a Volume fee to the
/// Ophis recipient could be set to 0 and still settle on our solver stack.
pub const OPHIS_DEFAULT_VOLUME_FEE_BPS: u64 = 10;
pub const OPHIS_STABLE_VOLUME_FEE_BPS: u64 = 1;

/// Optimism (chain 10) stablecoin set, mirrored from the frontend
/// `OPTIMISM_STABLECOINS` (libs/common-const/src/tokens.ts). A swap where BOTH
/// tokens are in this set is a same-chain stable pair and floors at the reduced
/// rate. Optimism is the ONLY self-hosted chain, so this is the only set the
/// backend needs; CoW-hosted chains are validated by CoW and never reach here.
/// Kept in sync with the frontend by the CI gate scripts/check-floor-invariant.sh
/// (the hard gate, since the backend Rust suite does not run in CI) and, locally,
/// by the `optimism_stablecoins_match_frontend_source_of_truth` unit test, so the
/// floor never rejects a legitimate 1 bp stable order.
const OPTIMISM_STABLECOINS: &[Address] = &[
    address!("0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85"), // USDC (native)
    address!("0x7F5c764cBc14f9669B88837ca1490cCa17c31607"), // USDC.e (bridged)
    address!("0x94b008aA00579c1307B0EF2c499aD98a8ce58e58"), // USDT
    address!("0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1"), // DAI
];

/// Optimism boosted-token set (mirrors the frontend `OPHIS_BOOSTED_TOKENS[10]`).
/// Empty today (ALEPH is Mainnet/Base only); a swap where EITHER side is boosted
/// floors at the reduced rate. Kept explicit so adding an OP boosted token to the
/// frontend also requires updating the backend: the CI gate
/// scripts/check-floor-invariant.sh diffs this set against the frontend
/// `OPHIS_BOOSTED_TOKENS[SupportedChainId.OPTIMISM]` and fails on drift (the OP
/// frontend entry must be a single-line `new Set([...])` per the gate's parser).
const OPTIMISM_BOOSTED_TOKENS: &[Address] = &[];

/// Non-stable base floor for an allowlisted recipient. The default Ophis
/// recipient is held to the full rate; authorized partners get a lower agreed
/// tier here, keyed on the RECIPIENT (the only field bound via the allowlist —
/// never appCode/referrer, which are client-controlled). New partner tiers are
/// added after the partner Safe is independently verified and allowlisted.
fn recipient_base_floor_bps(_recipient: Address) -> u64 {
    // Only the Ophis Safe is allowlisted today, held to the full 10 bps. A
    // partner tier (e.g. Lagoon at 5 bps) is added as:
    //   if recipient == LAGOON_PARTNER_FEE_RECIPIENT { 5 } else { 10 }
    OPHIS_DEFAULT_VOLUME_FEE_BPS
}

/// Minimum Volume-policy bps the OP backend accepts for a partner fee to an
/// allowlisted recipient, given the order's token pair. Same-chain stable pairs
/// (both tokens OP stablecoins) or boosted pairs (either side boosted) floor at
/// the reduced rate; everything else floors at the recipient's base tier. Keyed
/// on on-chain token addresses and the allowlisted recipient (both
/// non-spoofable), never on appData strings. Mirrors the frontend rate logic.
pub fn partner_fee_floor_bps(sell_token: Address, buy_token: Address, recipient: Address) -> u64 {
    let either_boosted = OPTIMISM_BOOSTED_TOKENS.contains(&sell_token)
        || OPTIMISM_BOOSTED_TOKENS.contains(&buy_token);
    let both_stable =
        OPTIMISM_STABLECOINS.contains(&sell_token) && OPTIMISM_STABLECOINS.contains(&buy_token);
    if either_boosted || both_stable {
        OPHIS_STABLE_VOLUME_FEE_BPS
    } else {
        recipient_base_floor_bps(recipient)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ValidatedAppData {
    pub hash: AppDataHash,
    pub document: String,
    pub protocol: ProtocolAppData,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq)]
#[cfg_attr(any(test, feature = "test_helpers"), derive(Serialize))]
#[serde(rename_all = "camelCase")]
pub struct ProtocolAppData {
    #[serde(default)]
    pub hooks: Hooks,
    pub signer: Option<Address>,
    pub replaced_order: Option<ReplacedOrder>,
    #[serde(default)]
    pub partner_fee: PartnerFees,
    pub flashloan: Option<Flashloan>,
    #[serde(default)]
    pub wrappers: Vec<WrapperCall>,
}

/// Contains information to hint at how a solver could make
/// use of flashloans to settle the associated order.
/// Since using flashloans introduces a bunch of complexities
/// all these hints are not binding for the solver.
#[serde_as]
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq)]
#[cfg_attr(any(test, feature = "test_helpers"), derive(Serialize))]
#[serde(rename_all = "camelCase")]
pub struct Flashloan {
    /// Which contract to request the flashloan from.
    pub liquidity_provider: Address,
    /// Which helper contract should be used to request
    /// the flashloan with.
    pub protocol_adapter: Address,
    /// Who should receive the borrowed tokens.
    pub receiver: Address,
    /// Which token to flashloan.
    pub token: Address,
    /// How much of the token to flashloan.
    #[serde_as(as = "HexOrDecimalU256")]
    pub amount: U256,
}

/// Contains information about wrapper contracts
#[serde_as]
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[cfg_attr(any(test, feature = "test_helpers"), derive(Serialize))]
#[serde(rename_all = "camelCase")]
pub struct WrapperCall {
    /// The address of the wrapper contract.
    pub address: Address,
    /// Additional calldata to be passed to the wrapper contract.
    #[serde_as(as = "BytesHex")]
    pub data: Vec<u8>,
    /// Declares whether this wrapper (and its data) needs to be included
    /// unmodified in a solution containing this order.
    #[serde(default)]
    pub is_omittable: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq)]
#[cfg_attr(any(test, feature = "test_helpers"), derive(Serialize))]
pub struct ReplacedOrder {
    pub uid: OrderUid,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq)]
#[cfg_attr(any(test, feature = "test_helpers"), derive(Serialize))]
pub struct PartnerFee {
    #[serde(flatten)]
    pub policy: FeePolicy,
    pub recipient: Address,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FeePolicy {
    /// Fees should be captured from the difference between execution price
    /// and the orders' limit price (i.e. improvement over the price signed
    /// by the user).
    Surplus {
        /// How many bps of surplus should be captured as fees.
        bps: u64,
        /// How many bps of the total volume may be captured at most. Under some
        /// conditions there can be a lot of surplus so to not charge egrigious
        /// amounts there is a cap. Note that there is also a cap enforced by
        /// the protocol so effectively the partner can only lower the
        /// limit here.
        max_volume_bps: u64,
    },
    /// Fees should be captured from the difference between execution price
    /// and the price of the order's reference quote (i.e. improvement over the
    /// promised price).
    PriceImprovement {
        /// How many bps of surplus should be captured as fees.
        bps: u64,
        /// How many bps of the total volume may be captured at most. Under some
        /// conditions there can be a lot of surplus so to not charge egrigious
        /// amounts there is a cap. Note that there is also a cap enforced by
        /// the protocol so effectively the partner can only lower the
        /// limit here.
        max_volume_bps: u64,
    },
    /// Fees should be captured from an order's entire volume.
    /// In that case an order's execution must be so much better that
    /// taking a cut from the volume will not end up violating the
    /// order's limit price.
    Volume { bps: u64 },
}

impl Default for FeePolicy {
    fn default() -> Self {
        Self::Volume { bps: 0 }
    }
}

impl<'de> Deserialize<'de> for FeePolicy {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        // The untagged enum does not provide enough information when deserialization
        // fails since it thinks that any unknown or mismatched fields are just
        // an issue with the enum variant which the error will reflect —
        // something among the lines of "did not match any variant of the untagged enum"
        // This is an hacky way of ensuring we get proper behavior when failing to
        // deserialize numbers, for example, when users send bps as floats
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct FeePolicyDeserializer {
            surplus_bps: Option<u64>,
            max_volume_bps: Option<u64>,
            price_improvement_bps: Option<u64>,
            volume_bps: Option<u64>,
            bps: Option<u64>,
        }

        match FeePolicyDeserializer::deserialize(deserializer)? {
            FeePolicyDeserializer {
                surplus_bps: Some(surplus_bps),
                max_volume_bps: Some(max_volume_bps),
                price_improvement_bps: None,
                volume_bps: None,
                bps: None,
            } => Ok(FeePolicy::Surplus {
                bps: surplus_bps,
                max_volume_bps,
            }),
            FeePolicyDeserializer {
                surplus_bps: None,
                max_volume_bps: Some(max_volume_bps),
                price_improvement_bps: Some(price_improvement_bps),
                volume_bps: None,
                bps: None,
            } => Ok(FeePolicy::PriceImprovement {
                bps: price_improvement_bps,
                max_volume_bps,
            }),
            FeePolicyDeserializer {
                surplus_bps: None,
                max_volume_bps: None,
                price_improvement_bps: None,
                volume_bps: Some(volume_bps),
                bps: None,
            } => Ok(FeePolicy::Volume { bps: volume_bps }),
            FeePolicyDeserializer {
                surplus_bps: None,
                max_volume_bps: None,
                price_improvement_bps: None,
                volume_bps: None,
                bps: Some(bps),
            } => Ok(FeePolicy::Volume { bps }),
            _ => Err(serde::de::Error::custom("unknown fee policy format")),
        }
    }
}

#[cfg(any(test, feature = "test_helpers"))]
impl serde::Serialize for FeePolicy {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        enum Helper {
            Surplus {
                surplus_bps: u64,
                max_volume_bps: u64,
            },
            PriceImprovement {
                price_improvement_bps: u64,
                max_volume_bps: u64,
            },
            Volume {
                volume_bps: u64,
            },
        }

        let helper = match self {
            Self::Volume { bps } => Helper::Volume { volume_bps: *bps },
            Self::Surplus {
                bps,
                max_volume_bps,
            } => Helper::Surplus {
                surplus_bps: *bps,
                max_volume_bps: *max_volume_bps,
            },
            Self::PriceImprovement {
                bps,
                max_volume_bps,
            } => Helper::PriceImprovement {
                price_improvement_bps: *bps,
                max_volume_bps: *max_volume_bps,
            },
        };

        helper.serialize(serializer)
    }
}

#[derive(Clone)]
pub struct Validator {
    /// App data size limit (in bytes).
    size_limit: usize,
}

#[cfg(any(test, feature = "test_helpers"))]
impl Default for Validator {
    fn default() -> Self {
        Self { size_limit: 8192 }
    }
}

impl Validator {
    /// Creates a new app data [`Validator`] with the provided app data
    /// `size_limit` (in bytes).
    pub fn new(size_limit: usize) -> Self {
        Self { size_limit }
    }

    /// Returns the app data size limit (in bytes).
    pub fn size_limit(&self) -> usize {
        self.size_limit
    }

    /// Parses and validates the provided app data bytes, returns the validated
    ///
    /// Valid app data is considered to be:
    /// 1. Below or equal to [`Validator::size_limit`] in size.
    /// 2. A valid JSON & app data object.
    /// 3. CIP-75-compliant partner-fee fields (see [`validate_partner_fees`]).
    pub fn validate(&self, full_app_data: &[u8]) -> Result<ValidatedAppData> {
        if full_app_data.len() > self.size_limit {
            return Err(anyhow!(
                "app data has byte size {} which is larger than limit {}",
                full_app_data.len(),
                self.size_limit
            ));
        }

        let document = String::from_utf8(full_app_data.to_vec())?;
        let protocol = parse(full_app_data)?;
        validate_partner_fees(&protocol.partner_fee)?;

        Ok(ValidatedAppData {
            hash: AppDataHash(hash_full_app_data(full_app_data)),
            document,
            protocol,
        })
    }
}

/// Rejects partner-fee entries whose `Surplus` or `PriceImprovement` policies
/// exceed CIP-75 bps caps, AND whose `recipient` is not registered in
/// [`PARTNER_FEE_RECIPIENT_ALLOWLIST`]. Volume-policy bps are bounded
/// downstream by the operator-set global `max_partner_fee`; the recipient
/// check applies uniformly to all policy variants.
fn validate_partner_fees(partner_fees: &PartnerFees) -> Result<()> {
    for fee in partner_fees.iter() {
        if !PARTNER_FEE_RECIPIENT_ALLOWLIST.contains(&fee.recipient) {
            return Err(anyhow!(
                "partner fee recipient {recipient:?} is not on the registered \
                 partner-fee recipient allowlist. If this is a legitimate new \
                 partner, add the address to PARTNER_FEE_RECIPIENT_ALLOWLIST in \
                 crates/app-data/src/app_data.rs after independent verification \
                 of the recipient multisig.",
                recipient = fee.recipient,
            ));
        }
        // Ophis charges a CIP-75 VOLUME fee only. A fee to an allowlisted
        // (Ophis-controlled) recipient using the Surplus or PriceImprovement
        // policy is rejected outright: those variants carry no enforced lower
        // bound, so accepting them would reopen the fee-bypass that the Volume
        // floor closes (an attacker would just switch policy variant). The
        // Volume minimum-bps floor is token-pair-aware and enforced in the order
        // validator (which has the sell/buy tokens in scope) and re-applied as an
        // upward clamp in the autopilot; nothing token-blind to check here. A
        // Volume fee has no per-order upper cap at validation: it is bounded above
        // only by the autopilot's operator-set global `max_partner_fee`.
        match fee.policy {
            FeePolicy::Surplus { .. } | FeePolicy::PriceImprovement { .. } => {
                return Err(anyhow!(
                    "partner fee to an Ophis-allowlisted recipient must use the \
                     Volume policy; Surplus/PriceImprovement partner fees are not \
                     accepted (no enforced lower bound)."
                ));
            }
            FeePolicy::Volume { .. } => continue,
        }
    }
    Ok(())
}

pub fn parse(full_app_data: &[u8]) -> Result<ProtocolAppData, serde_json::Error> {
    let root = serde_json::from_slice::<Root>(full_app_data)?;
    let parsed = root
        .metadata
        .or_else(|| root.backend.map(ProtocolAppData::from))
        // If the key doesn't exist, default. Makes life easier for API
        // consumers, who don't care about protocol app data.
        .unwrap_or_default();
    Ok(parsed)
}

/// The root app data JSON object.
///
/// App data JSON is organised in an object of the form
///
/// ```text
/// {
///     "metadata": {}
/// }
/// ```
///
/// Where the protocol-relevant app-data fields appear in the `metadata` object
/// along side other valid metadata fields. For example:
///
/// ```text
/// {
///     "version": "0.9.0",
///     "appCode": "CoW Swap",
///     "environment": "barn",
///     "metadata": {
///         "quote": {
///             "slippageBps": "50"
///         },
///         "hooks": {
///             "pre": [
///                 {
///                     "target": "0x0000000000000000000000000000000000000000",
///                     "callData": "0x",
///                     "gasLimit": "21000"
///                 }
///             ]
///         }
///     }
/// }
/// ```
///
/// For more detailed information on the schema, see:
/// <https://github.com/cowprotocol/app-data>.
#[derive(Deserialize)]
#[cfg_attr(any(test, feature = "test_helpers"), derive(Clone, Serialize))]
pub struct Root {
    metadata: Option<ProtocolAppData>,
    /// DEPRECATED. The `backend` field was originally specified to contain all
    /// protocol-specific app data (such as hooks). However, after releasing
    /// hooks, we decided to move the fields to the existing `metadata` field.
    /// However, in order to not break existing integrations, we allow using the
    /// `backend` field for specifying hooks.
    backend: Option<BackendAppData>,
}

impl Root {
    pub fn new(metadata: Option<ProtocolAppData>) -> Self {
        Self {
            metadata,
            backend: None,
        }
    }

    pub fn wrappers(&self) -> &[WrapperCall] {
        self.metadata
            .as_ref()
            .map(|metadata| metadata.wrappers.as_slice())
            .unwrap_or_default()
    }
}

/// Caches whether a given app data document contains wrappers, keyed by
/// hash. This avoids re-parsing the same JSON across orders and auction
/// cycles. We're using the default TinyLFU eviction policy, but the capacity is
/// large enough that we don't expect eviction to be a problem in practice, but
/// we limit the size to prevent potential memory exhaustion attacks.
pub struct WrapperCache(Cache<AppDataHash, bool>);

impl WrapperCache {
    pub fn new(capacity: u64) -> Self {
        Self(Cache::new(capacity))
    }

    /// Returns `true` if order appData contains non-empty wrappers
    pub fn has_wrappers(&self, hash: &AppDataHash, document: Option<&str>) -> bool {
        if let Some(cached) = self.0.get(hash) {
            return cached;
        }
        let result = document.is_some_and(|doc| {
            serde_json::from_str::<Root>(doc)
                .ok()
                .and_then(|root| root.metadata)
                .is_some_and(|m| !m.wrappers.is_empty())
        });
        self.0.insert(*hash, result);
        result
    }
}

// uid as 56 bytes: 32 for orderDigest, 20 for ownerAddress and 4 for validTo
#[derive(Clone, Copy, Eq, Hash, PartialEq, PartialOrd, Ord)]
pub struct OrderUid(pub [u8; 56]);

impl Display for OrderUid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut bytes = [0u8; 2 + 56 * 2];
        bytes[..2].copy_from_slice(b"0x");
        // Unwrap because the length is always correct.
        const_hex::encode_to_slice(self.0.as_slice(), &mut bytes[2..]).unwrap();
        // Unwrap because the string is always valid utf8.
        let str = std::str::from_utf8(&bytes).unwrap();
        f.write_str(str)
    }
}

impl fmt::Debug for OrderUid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self}")
    }
}

impl Default for OrderUid {
    fn default() -> Self {
        Self([0u8; 56])
    }
}

impl Serialize for OrderUid {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.to_string().as_str())
    }
}

impl<'de> Deserialize<'de> for OrderUid {
    fn deserialize<D>(deserializer: D) -> Result<OrderUid, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct Visitor {}
        impl de::Visitor<'_> for Visitor {
            type Value = OrderUid;

            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                write!(formatter, "an uid with orderDigest_owner_validTo")
            }

            fn visit_str<E>(self, s: &str) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                let s = s.strip_prefix("0x").ok_or_else(|| {
                    de::Error::custom(format!(
                        "{s:?} can't be decoded as hex uid because it does not start with '0x'"
                    ))
                })?;
                let mut value = [0u8; 56];
                const_hex::decode_to_slice(s, value.as_mut()).map_err(|err| {
                    de::Error::custom(format!("failed to decode {s:?} as hex uid: {err}"))
                })?;
                Ok(OrderUid(value))
            }
        }

        deserializer.deserialize_str(Visitor {})
    }
}

/// A list containing all the partner fees
#[derive(Clone, Debug, Default, Eq, PartialEq)]
#[cfg_attr(
    any(test, feature = "test_helpers"),
    derive(Serialize),
    serde(transparent)
)]
pub struct PartnerFees(Vec<PartnerFee>);

impl PartnerFees {
    pub fn iter(&self) -> Iter<'_, PartnerFee> {
        self.0.iter()
    }
}

impl<'de> Deserialize<'de> for PartnerFees {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct PartnerFeesVisitor;

        impl<'de> de::Visitor<'de> for PartnerFeesVisitor {
            type Value = PartnerFees;

            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("a single partner fee object or an array of partner fees")
            }

            fn visit_map<A>(self, map: A) -> Result<Self::Value, A::Error>
            where
                A: de::MapAccess<'de>,
            {
                let fee = PartnerFee::deserialize(de::value::MapAccessDeserializer::new(map))?;
                Ok(PartnerFees(vec![fee]))
            }

            fn visit_seq<A>(self, seq: A) -> Result<Self::Value, A::Error>
            where
                A: de::SeqAccess<'de>,
            {
                let fees =
                    Vec::<PartnerFee>::deserialize(de::value::SeqAccessDeserializer::new(seq))?;
                Ok(PartnerFees(fees))
            }
        }

        deserializer.deserialize_any(PartnerFeesVisitor)
    }
}

/// The legacy `backend` app data object.
#[derive(Debug, Default, Deserialize)]
#[cfg_attr(any(test, feature = "test_helpers"), derive(Clone, Serialize))]
struct BackendAppData {
    #[serde(default)]
    pub hooks: Hooks,
}

impl From<BackendAppData> for ProtocolAppData {
    fn from(value: BackendAppData) -> Self {
        Self {
            hooks: value.hooks,
            wrappers: Vec::new(),
            signer: None,
            replaced_order: None,
            partner_fee: PartnerFees::default(),
            flashloan: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use {super::*, crate::Hook};

    macro_rules! assert_app_data {
        ($s:expr_2021, $e:expr_2021 $(,)?) => {{
            let s = $s;
            let a = Validator::default().validate(s.as_ref()).unwrap();
            assert_eq!(a.protocol, $e);
        }};
    }

    #[test]
    fn empty_is_valid() {
        assert_app_data!(EMPTY, ProtocolAppData::default());
    }

    #[test]
    fn examples() {
        assert_app_data!(
            r#"
                {
                    "appCode": "CoW Swap",
                    "environment": "production",
                    "version": "0.9.0"
                }
            "#,
            ProtocolAppData::default(),
        );

        assert_app_data!(
            r#"
                {
                    "appCode": "CoW Swap",
                    "environment": "production",
                    "metadata": {
                        "quote": {
                            "slippageBips": "50"
                        },
                        "orderClass": {
                            "orderClass": "market"
                        }
                    },
                    "version": "0.9.0"
                }
            "#,
            ProtocolAppData::default(),
        );

        assert_app_data!(
            r#"
                {
                    "appCode": "CoW Swap",
                    "environment": "production",
                    "metadata": {
                        "quote": {
                            "slippageBips": "50"
                        },
                        "orderClass": {
                            "orderClass": "market"
                        },
                        "hooks": {
                            "pre": [
                                {
                                    "target": "0x0000000000000000000000000000000000000000",
                                    "callData": "0x",
                                    "gasLimit": "0"
                                }
                            ],
                            "post": [
                                {
                                    "target": "0x0101010101010101010101010101010101010101",
                                    "callData": "0x01",
                                    "gasLimit": "1"
                                },
                                {
                                    "target": "0x0202020202020202020202020202020202020202",
                                    "callData": "0x0202",
                                    "gasLimit": "2"
                                }
                            ]
                        }
                    },
                    "version": "0.9.0"
                }
            "#,
            ProtocolAppData {
                hooks: Hooks {
                    pre: vec![Hook {
                        target: Address::from_slice(&[0; 20]),
                        call_data: vec![],
                        gas_limit: 0,
                    }],
                    post: vec![
                        Hook {
                            target: Address::from_slice(&[1; 20]),
                            call_data: vec![1],
                            gas_limit: 1
                        },
                        Hook {
                            target: Address::from_slice(&[2; 20]),
                            call_data: vec![2, 2],
                            gas_limit: 2,
                        },
                    ],
                },
                ..Default::default()
            },
        );

        assert_app_data!(
            r#"
                {
                    "appCode": "CoW Swap",
                    "environment": "production",
                    "metadata": {
                        "signer": "0x4242424242424242424242424242424242424242"
                    },
                    "version": "0.9.0"
                }
            "#,
            ProtocolAppData {
                signer: Some(Address::from_slice(&[0x42; 20])),
                ..Default::default()
            },
        );

        assert_app_data!(
            r#"
                {
                    "appCode": "CoW Swap",
                    "environment": "production",
                    "metadata": {
                        "quote": {
                            "slippageBips": "50"
                        },
                        "orderClass": {
                            "orderClass": "market"
                        },
                        "partnerFee": {
                            "bps": 100,
                            "recipient": "0x858f0F5eE954846D47155F5203c04aF1819eCeF8"
                        }
                    },
                    "version": "0.9.0"
                }
            "#,
            ProtocolAppData {
                partner_fee: PartnerFees(vec![PartnerFee {
                    policy: FeePolicy::Volume { bps: 100 },
                    recipient: PARTNER_FEE_RECIPIENT_ALLOWLIST[0],
                }]),
                ..Default::default()
            },
        );

        assert_app_data!(
            r#"
                {
                    "appCode": "CoW Swap",
                    "environment": "production",
                    "metadata": {
                        "quote": {
                            "slippageBips": "50"
                        },
                        "orderClass": {
                            "orderClass": "market"
                        },
                        "partnerFee": [
                            {
                                "bps": 100,
                                "recipient": "0x858f0F5eE954846D47155F5203c04aF1819eCeF8"
                            },
                            {
                                "volumeBps": 1000,
                                "recipient": "0x858f0F5eE954846D47155F5203c04aF1819eCeF8"
                            }
                        ]
                    },
                    "version": "0.9.0"
                }
            "#,
            ProtocolAppData {
                partner_fee: PartnerFees(vec![
                    // this one was parsed from the old format for volume fees
                    PartnerFee {
                        policy: FeePolicy::Volume { bps: 100 },
                        recipient: PARTNER_FEE_RECIPIENT_ALLOWLIST[0],
                    },
                    // this one is using the new format. Surplus/PriceImprovement
                    // entries were removed: they are now rejected for an
                    // allowlisted recipient (see
                    // surplus_and_price_improvement_rejected_for_allowlisted_recipient).
                    PartnerFee {
                        policy: FeePolicy::Volume { bps: 1000 },
                        recipient: PARTNER_FEE_RECIPIENT_ALLOWLIST[0],
                    },
                ]),
                ..Default::default()
            },
        );
    }

    #[test]
    fn legacy() {
        assert_app_data!(
            r#"
                {
                    "backend": {
                        "hooks": {
                            "pre": [
                                {
                                    "target": "0x0000000000000000000000000000000000000000",
                                    "callData": "0x",
                                    "gasLimit": "0"
                                }
                            ],
                            "post": [
                                {
                                    "target": "0x0101010101010101010101010101010101010101",
                                    "callData": "0x01",
                                    "gasLimit": "1"
                                },
                                {
                                    "target": "0x0202020202020202020202020202020202020202",
                                    "callData": "0x0202",
                                    "gasLimit": "2"
                                }
                            ]
                        }
                    }
                }
            "#,
            ProtocolAppData {
                hooks: Hooks {
                    pre: vec![Hook {
                        target: Address::from_slice(&[0; 20]),
                        call_data: vec![],
                        gas_limit: 0,
                    }],
                    post: vec![
                        Hook {
                            target: Address::from_slice(&[1; 20]),
                            call_data: vec![1],
                            gas_limit: 1
                        },
                        Hook {
                            target: Address::from_slice(&[2; 20]),
                            call_data: vec![2, 2],
                            gas_limit: 2,
                        },
                    ],
                },
                ..Default::default()
            },
        );

        // Note that if `metadata` is specified, then the `backend` field is
        // ignored.
        assert_app_data!(
            r#"
                {
                    "metadata": {},
                    "backend": {
                        "hooks": {
                            "pre": [
                                {
                                    "target": "0x0000000000000000000000000000000000000000",
                                    "callData": "0x",
                                    "gasLimit": "0"
                                }
                            ]
                        }
                    }
                }
            "#,
            ProtocolAppData::default(),
        );
    }

    #[test]
    fn wrapper_cache_detects_wrappers() {
        let cache = WrapperCache::new(100);
        let h = |b: u8| AppDataHash([b; 32]);

        assert!(!cache.has_wrappers(&h(1), None));
        assert!(!cache.has_wrappers(&h(2), Some("{}")));
        assert!(!cache.has_wrappers(&h(3), Some(r#"{"metadata": {}}"#)));
        assert!(!cache.has_wrappers(&h(4), Some(r#"{"metadata": {"wrappers": []}}"#)));
        assert!(cache.has_wrappers(
            &h(5),
            Some(r#"{"metadata": {"wrappers": [{"address": "0x0000000000000000000000000000000000000001", "data": "0x"}]}}"#),
        ));

        // Second call hits the cache
        assert!(cache.has_wrappers(&h(5), None));
    }

    #[test]
    fn misc() {
        let mut validator = Validator::default();

        let not_json = "hello world".as_bytes();
        let err = validator.validate(not_json).unwrap_err();
        dbg!(err);

        let not_object = "[]".as_bytes();
        let err = validator.validate(not_object).unwrap_err();
        dbg!(err);

        let object = "{}".as_bytes();
        let validated = validator.validate(object).unwrap();
        dbg!(validated.hash);

        let ok_no_metadata = r#"{"hello":"world"}"#.as_bytes();
        validator.validate(ok_no_metadata).unwrap();

        let bad_metadata = r#"{"hello":"world","metadata":[1]}"#.as_bytes();
        let err = validator.validate(bad_metadata).unwrap_err();
        dbg!(err);

        let ok_metadata = r#"{"hello":"world","metadata":{}}"#.as_bytes();
        validator.validate(ok_metadata).unwrap();

        validator.size_limit = 1;
        let size_limit = r#"{"hello":"world"}"#.as_bytes();
        let err = validator.validate(size_limit).unwrap_err();
        dbg!(err);
    }

    fn partner_fee_json(policy: &str) -> String {
        format!(
            r#"{{
                "metadata": {{
                    "partnerFee": {policy}
                }}
            }}"#
        )
    }

    #[test]
    fn volume_policy_accepted_token_blind_at_validate() {
        // validate() is token-blind: it accepts any Volume policy to the allowlisted
        // recipient (the 9999 upper bound is bounded downstream by max_partner_fee).
        // The token-pair-aware MINIMUM (10/1 bps) is enforced in the order validator,
        // which has the sell/buy tokens; this layer must not reject Volume on bps.
        let validator = Validator::default();
        for policy in [
            r#"{ "volumeBps": 9999, "recipient": "0x858f0F5eE954846D47155F5203c04aF1819eCeF8" }"#,
            r#"{ "volumeBps": 10, "recipient": "0x858f0F5eE954846D47155F5203c04aF1819eCeF8" }"#,
            // 0 bps is accepted HERE (token-blind); the order validator floors it.
            r#"{ "volumeBps": 0, "recipient": "0x858f0F5eE954846D47155F5203c04aF1819eCeF8" }"#,
        ] {
            let doc = partner_fee_json(policy);
            validator.validate(doc.as_bytes()).unwrap_or_else(|err| {
                panic!("Volume policy was rejected at validate(): {policy} ({err:?})");
            });
        }
    }

    #[test]
    fn surplus_and_price_improvement_rejected_for_allowlisted_recipient() {
        // Ophis charges a Volume fee only. Surplus/PriceImprovement partner fees to
        // an allowlisted recipient are rejected outright (they have no enforced lower
        // bound, so accepting them would reopen the fee-bypass via policy-switching).
        let validator = Validator::default();
        for policy in [
            r#"{ "surplusBps": 2500, "maxVolumeBps": 50, "recipient": "0x858f0F5eE954846D47155F5203c04aF1819eCeF8" }"#,
            r#"{ "surplusBps": 0, "maxVolumeBps": 0, "recipient": "0x858f0F5eE954846D47155F5203c04aF1819eCeF8" }"#,
            r#"{ "priceImprovementBps": 100, "maxVolumeBps": 50, "recipient": "0x858f0F5eE954846D47155F5203c04aF1819eCeF8" }"#,
        ] {
            let doc = partner_fee_json(policy);
            let err = validator.validate(doc.as_bytes()).unwrap_err();
            assert!(
                err.to_string().contains("must use the Volume policy"),
                "expected Volume-only rejection for {policy}, got: {err}"
            );
        }
    }

    #[test]
    fn surplus_rejected_even_within_an_array_of_otherwise_valid_fees() {
        let validator = Validator::default();
        let doc = partner_fee_json(
            r#"[
                { "volumeBps": 100, "recipient": "0x858f0F5eE954846D47155F5203c04aF1819eCeF8" },
                { "surplusBps": 100, "maxVolumeBps": 50, "recipient": "0x858f0F5eE954846D47155F5203c04aF1819eCeF8" }
            ]"#,
        );
        let err = validator.validate(doc.as_bytes()).unwrap_err();
        assert!(
            err.to_string().contains("must use the Volume policy"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn recipient_allowlist_accepts_registered_safe_volume() {
        // The Ophis partner-fee Safe is the only registered recipient today; a Volume
        // policy with that recipient passes validate() (the bps floor is downstream).
        let validator = Validator::default();
        let doc = partner_fee_json(
            r#"{ "volumeBps": 100, "recipient": "0x858f0F5eE954846D47155F5203c04aF1819eCeF8" }"#,
        );
        validator.validate(doc.as_bytes()).unwrap_or_else(|err| {
            panic!("allowlisted recipient with Volume policy was rejected: ({err:?})");
        });
    }

    #[test]
    fn partner_fee_floor_is_token_pair_aware() {
        // Mirrors the frontend: same-chain stable pairs (both OP stablecoins) and
        // boosted pairs floor at 1 bp; everything else floors at the recipient base
        // rate (10 bps for the Ophis recipient). Keyed on on-chain token addresses
        // (non-spoofable), closing the prior 0-fee bypass.
        let usdc = address!("0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85");
        let usdt = address!("0x94b008aA00579c1307B0EF2c499aD98a8ce58e58");
        let dai = address!("0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1");
        let weth = address!("0x4200000000000000000000000000000000000006"); // volatile
        let r = OPHIS_PARTNER_FEE_RECIPIENT;

        // stable <-> stable => reduced floor
        assert_eq!(partner_fee_floor_bps(usdc, usdt, r), OPHIS_STABLE_VOLUME_FEE_BPS);
        assert_eq!(partner_fee_floor_bps(dai, usdc, r), OPHIS_STABLE_VOLUME_FEE_BPS);
        // any volatile leg => full default floor (this is the bypass the floor closes)
        assert_eq!(partner_fee_floor_bps(weth, usdc, r), OPHIS_DEFAULT_VOLUME_FEE_BPS);
        assert_eq!(partner_fee_floor_bps(usdc, weth, r), OPHIS_DEFAULT_VOLUME_FEE_BPS);
        assert_eq!(partner_fee_floor_bps(weth, weth, r), OPHIS_DEFAULT_VOLUME_FEE_BPS);
        // floor is never zero
        assert!(partner_fee_floor_bps(weth, usdc, r) >= OPHIS_STABLE_VOLUME_FEE_BPS);
    }

    #[test]
    fn optimism_stablecoins_match_frontend_source_of_truth() {
        // The OP partner-fee floor charges 1 bp for stable-stable pairs using
        // OPTIMISM_STABLECOINS. The frontend charges the matching 1 bp rate using
        // its own OPTIMISM_STABLECOINS list (libs/common-const/src/tokens.ts). If
        // the frontend adds a stablecoin and this Rust set is not updated, the
        // ingress floor would reject legitimate 1 bp stable orders (floor stays at
        // the 10 bp default). This drift guard reads the frontend source of truth
        // and asserts the two sets are byte-for-byte identical.
        let ts_path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../frontend/libs/common-const/src/tokens.ts"
        );
        let source = std::fs::read_to_string(ts_path).unwrap_or_else(|e| {
            panic!(
                "could not read frontend tokens.ts at {ts_path} ({e}); the OP \
                 stablecoin floor set must stay in sync with the frontend. If the \
                 frontend moved, update this path."
            )
        });

        // Isolate the `const OPTIMISM_STABLECOINS = [ ... ]` array literal.
        let marker = "const OPTIMISM_STABLECOINS = [";
        let start = source
            .find(marker)
            .expect("OPTIMISM_STABLECOINS array not found in frontend tokens.ts");
        let rest = &source[start + marker.len()..];
        let end = rest
            .find(']')
            .expect("unterminated OPTIMISM_STABLECOINS array in frontend tokens.ts");

        // Extract single-quoted 0x-addresses (42 chars incl. prefix), lowercased.
        let frontend: std::collections::BTreeSet<String> = rest[..end]
            .split('\'')
            .filter(|tok| tok.starts_with("0x") && tok.len() == 42)
            .map(str::to_lowercase)
            .collect();
        let backend: std::collections::BTreeSet<String> = OPTIMISM_STABLECOINS
            .iter()
            .map(|a| format!("{a:#x}"))
            .collect();

        assert_eq!(
            frontend, backend,
            "Optimism stablecoin floor set drifted from the frontend source of \
             truth. frontend={frontend:?} backend={backend:?}"
        );
    }

    #[test]
    fn recipient_allowlist_rejects_arbitrary_address() {
        // The exact recipient an attacker would inject in app-data.
        let validator = Validator::default();
        let doc = partner_fee_json(
            r#"{ "volumeBps": 100, "recipient": "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" }"#,
        );
        let err = validator.validate(doc.as_bytes()).unwrap_err();
        assert!(
            err.to_string()
                .contains("is not on the registered partner-fee recipient allowlist"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn recipient_allowlist_rejects_zero_address() {
        // 0x0 is not a fee-burn convention; reject it explicitly so misconfigured
        // partner integrations fail loud.
        let validator = Validator::default();
        let doc = partner_fee_json(
            r#"{ "volumeBps": 100, "recipient": "0x0000000000000000000000000000000000000000" }"#,
        );
        let err = validator.validate(doc.as_bytes()).unwrap_err();
        assert!(
            err.to_string()
                .contains("is not on the registered partner-fee recipient allowlist"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn recipient_allowlist_rejects_any_violating_entry_in_array() {
        // Mixed array: one entry has an arbitrary recipient. Validator must
        // reject the whole document on the first violation, regardless of
        // other entries being well-formed.
        let validator = Validator::default();
        let doc = partner_fee_json(
            r#"[
                { "volumeBps": 100, "recipient": "0x858f0F5eE954846D47155F5203c04aF1819eCeF8" },
                { "volumeBps": 100, "recipient": "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" }
            ]"#,
        );
        let err = validator.validate(doc.as_bytes()).unwrap_err();
        assert!(
            err.to_string()
                .contains("is not on the registered partner-fee recipient allowlist"),
            "unexpected error: {err}"
        );
    }
}
