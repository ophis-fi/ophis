use {
    crate::{AppDataHash, Hooks, app_data_hash::hash_full_app_data},
    alloy_primitives::{Address, U256},
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

/// CIP-75 hard cap on `surplusBps` and `priceImprovementBps` partner-fee fields.
/// Values above this are a protocol-level violation and rejected at validation
/// time. This is the single source of truth: `autopilot/src/domain/fee/mod.rs`
/// imports this constant to re-clamp bps as defense-in-depth.
pub const MAX_PARTNER_FEE_BPS: u64 = 2500;

/// CIP-75 hard cap on `maxVolumeBps` for `Surplus` and `PriceImprovement`
/// partner-fee policies. The operator-set global `max_partner_fee` provides an
/// additional ceiling enforced downstream at fee computation time.
pub const MAX_PARTNER_VOLUME_BPS: u64 = 50;

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
        let (bps, max_volume_bps, kind) = match fee.policy {
            FeePolicy::Surplus {
                bps,
                max_volume_bps,
            } => (bps, max_volume_bps, "surplusBps"),
            FeePolicy::PriceImprovement {
                bps,
                max_volume_bps,
            } => (bps, max_volume_bps, "priceImprovementBps"),
            FeePolicy::Volume { .. } => continue,
        };
        if bps > MAX_PARTNER_FEE_BPS {
            return Err(anyhow!(
                "partner fee {kind} {bps} exceeds CIP-75 cap of {MAX_PARTNER_FEE_BPS} bps"
            ));
        }
        if max_volume_bps > MAX_PARTNER_VOLUME_BPS {
            return Err(anyhow!(
                "partner fee maxVolumeBps {max_volume_bps} exceeds CIP-75 cap of \
                 {MAX_PARTNER_VOLUME_BPS} bps"
            ));
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
                            },
                            {
                                "surplusBps": 100,
                                "maxVolumeBps": 50,
                                "recipient": "0x858f0F5eE954846D47155F5203c04aF1819eCeF8"
                            },
                            {
                                "priceImprovementBps": 100,
                                "maxVolumeBps": 50,
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
                    // this one is using the new format
                    PartnerFee {
                        policy: FeePolicy::Volume { bps: 1000 },
                        recipient: PARTNER_FEE_RECIPIENT_ALLOWLIST[0],
                    },
                    PartnerFee {
                        policy: FeePolicy::Surplus {
                            bps: 100,
                            max_volume_bps: 50
                        },
                        recipient: PARTNER_FEE_RECIPIENT_ALLOWLIST[0],
                    },
                    PartnerFee {
                        policy: FeePolicy::PriceImprovement {
                            bps: 100,
                            max_volume_bps: 50
                        },
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
    fn cip75_caps_accept_boundary_values() {
        let validator = Validator::default();
        let cases = [
            r#"{ "surplusBps": 2500, "maxVolumeBps": 50, "recipient": "0x858f0F5eE954846D47155F5203c04aF1819eCeF8" }"#,
            r#"{ "priceImprovementBps": 2500, "maxVolumeBps": 50, "recipient": "0x858f0F5eE954846D47155F5203c04aF1819eCeF8" }"#,
            // Volume policies are not capped by CIP-75 surplus/price-improvement caps.
            r#"{ "volumeBps": 9999, "recipient": "0x858f0F5eE954846D47155F5203c04aF1819eCeF8" }"#,
            // Lower-bound is also accepted.
            r#"{ "surplusBps": 0, "maxVolumeBps": 0, "recipient": "0x858f0F5eE954846D47155F5203c04aF1819eCeF8" }"#,
        ];
        for policy in cases {
            let doc = partner_fee_json(policy);
            validator.validate(doc.as_bytes()).unwrap_or_else(|err| {
                panic!("CIP-75-compliant policy was rejected: {policy} ({err:?})");
            });
        }
    }

    #[test]
    fn cip75_caps_reject_surplus_bps_above_cap() {
        let validator = Validator::default();
        let doc = partner_fee_json(
            r#"{ "surplusBps": 2501, "maxVolumeBps": 50, "recipient": "0x858f0F5eE954846D47155F5203c04aF1819eCeF8" }"#,
        );
        let err = validator.validate(doc.as_bytes()).unwrap_err();
        assert!(
            err.to_string().contains("surplusBps 2501 exceeds CIP-75 cap of 2500"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn cip75_caps_reject_price_improvement_bps_above_cap() {
        let validator = Validator::default();
        let doc = partner_fee_json(
            r#"{ "priceImprovementBps": 9999, "maxVolumeBps": 50, "recipient": "0x858f0F5eE954846D47155F5203c04aF1819eCeF8" }"#,
        );
        let err = validator.validate(doc.as_bytes()).unwrap_err();
        assert!(
            err.to_string()
                .contains("priceImprovementBps 9999 exceeds CIP-75 cap of 2500"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn cip75_caps_reject_max_volume_bps_above_cap() {
        let validator = Validator::default();
        let surplus_doc = partner_fee_json(
            r#"{ "surplusBps": 2500, "maxVolumeBps": 51, "recipient": "0x858f0F5eE954846D47155F5203c04aF1819eCeF8" }"#,
        );
        let err = validator.validate(surplus_doc.as_bytes()).unwrap_err();
        assert!(
            err.to_string()
                .contains("maxVolumeBps 51 exceeds CIP-75 cap of 50"),
            "unexpected error: {err}"
        );

        let pi_doc = partner_fee_json(
            r#"{ "priceImprovementBps": 2500, "maxVolumeBps": 100, "recipient": "0x858f0F5eE954846D47155F5203c04aF1819eCeF8" }"#,
        );
        let err = validator.validate(pi_doc.as_bytes()).unwrap_err();
        assert!(
            err.to_string()
                .contains("maxVolumeBps 100 exceeds CIP-75 cap of 50"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn cip75_caps_reject_any_violating_entry_in_array() {
        let validator = Validator::default();
        let doc = partner_fee_json(
            r#"[
                { "volumeBps": 100, "recipient": "0x858f0F5eE954846D47155F5203c04aF1819eCeF8" },
                { "surplusBps": 100, "maxVolumeBps": 50, "recipient": "0x858f0F5eE954846D47155F5203c04aF1819eCeF8" },
                { "priceImprovementBps": 5000, "maxVolumeBps": 50, "recipient": "0x858f0F5eE954846D47155F5203c04aF1819eCeF8" }
            ]"#,
        );
        let err = validator.validate(doc.as_bytes()).unwrap_err();
        assert!(
            err.to_string()
                .contains("priceImprovementBps 5000 exceeds CIP-75 cap of 2500"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn recipient_allowlist_accepts_registered_safe() {
        // The CIP-75 partner-fee Safe is the only registered recipient today;
        // every cap-conformant policy variant with that recipient must pass.
        let validator = Validator::default();
        for policy in [
            r#"{ "volumeBps": 100, "recipient": "0x858f0F5eE954846D47155F5203c04aF1819eCeF8" }"#,
            r#"{ "surplusBps": 2500, "maxVolumeBps": 50, "recipient": "0x858f0F5eE954846D47155F5203c04aF1819eCeF8" }"#,
            r#"{ "priceImprovementBps": 2500, "maxVolumeBps": 50, "recipient": "0x858f0F5eE954846D47155F5203c04aF1819eCeF8" }"#,
        ] {
            let doc = partner_fee_json(policy);
            validator.validate(doc.as_bytes()).unwrap_or_else(|err| {
                panic!("allowlisted recipient was rejected: {policy} ({err:?})");
            });
        }
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
