//! Canonical block snapshots and read-only EIP-1898 RPC calls.
//!
//! Quote sources must be compared against one chain state. This module keeps
//! the block identity in a small shared type and exposes only read methods, so
//! measurement tools cannot accidentally submit a transaction.

use {
    alloy_primitives::{Address, B256, Bytes, keccak256},
    reqwest::Url,
    serde::{Deserialize, Serialize, de::DeserializeOwned},
    serde_json::json,
    std::{
        str::FromStr,
        time::{Duration, SystemTime, UNIX_EPOCH},
    },
};

const RPC_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// A canonical chain state used by every call in one quote observation.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockContext {
    pub chain_id: u64,
    pub number: u64,
    pub hash: B256,
    pub observed_at_unix_millis: u64,
}

impl BlockContext {
    pub fn ensure_same(self, other: Self) -> Result<(), ContextMismatch> {
        if self.chain_id == other.chain_id && self.number == other.number && self.hash == other.hash
        {
            Ok(())
        } else {
            Err(ContextMismatch {
                expected: self,
                actual: other,
            })
        }
    }

    pub fn is_stale_at(self, now_unix_millis: u64, max_age: Duration) -> bool {
        now_unix_millis.saturating_sub(self.observed_at_unix_millis)
            > u64::try_from(max_age.as_millis()).unwrap_or(u64::MAX)
    }

    fn selector(self) -> Eip1898BlockSelector {
        Eip1898BlockSelector {
            block_hash: self.hash,
            require_canonical: true,
        }
    }
}

#[derive(Debug, thiserror::Error)]
#[error("block context mismatch: expected {expected:?}, got {actual:?}")]
pub struct ContextMismatch {
    pub expected: BlockContext,
    pub actual: BlockContext,
}

/// EIP-1898 hash selector. `requireCanonical` makes reorged contexts fail
/// instead of being silently evaluated against a different chain state.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Eip1898BlockSelector {
    block_hash: B256,
    require_canonical: bool,
}

/// A deliberately read-only JSON-RPC client.
///
/// No generic public RPC method is exposed. The only available operations are
/// block discovery, `eth_call`, and `eth_getCode` at an EIP-1898 block hash.
#[derive(Clone)]
pub struct ReadOnlyRpc {
    client: reqwest::Client,
    node_url: Url,
    expected_chain_id: u64,
}

impl ReadOnlyRpc {
    pub fn try_new(
        node_url: Url,
        expected_chain_id: u64,
        user_agent: &'static str,
    ) -> Result<Self, reqwest::Error> {
        Ok(Self {
            client: reqwest::Client::builder()
                .user_agent(user_agent)
                .timeout(RPC_REQUEST_TIMEOUT)
                .build()?,
            node_url,
            expected_chain_id,
        })
    }

    /// Capture the latest block once. Subsequent calls use its hash, never the
    /// moving `latest` tag.
    pub async fn snapshot(&self) -> Result<BlockContext, Error> {
        let chain_id: String = self.rpc("eth_chainId", json!([])).await?;
        let chain_id = parse_quantity(&chain_id)?;
        if chain_id != self.expected_chain_id {
            return Err(Error::WrongChain {
                expected: self.expected_chain_id,
                actual: chain_id,
            });
        }

        let block: RpcBlock = self
            .rpc("eth_getBlockByNumber", json!(["latest", false]))
            .await?;
        Ok(BlockContext {
            chain_id,
            number: parse_quantity(&block.number)?,
            hash: B256::from_str(&block.hash).map_err(|_| Error::InvalidBlockHash)?,
            observed_at_unix_millis: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| Error::ClockBeforeUnixEpoch)?
                .as_millis()
                .try_into()
                .unwrap_or(u64::MAX),
        })
    }

    pub async fn call_at(
        &self,
        context: BlockContext,
        to: Address,
        calldata: Vec<u8>,
    ) -> Result<Vec<u8>, Error> {
        self.ensure_chain(context)?;
        let result: String = self
            .rpc(
                "eth_call",
                json!([{
                    "to": format!("{to:#x}"),
                    "data": const_hex::encode_prefixed(calldata),
                }, context.selector()]),
            )
            .await?;
        const_hex::decode(result).map_err(Error::InvalidHex)
    }

    pub async fn code_at(&self, context: BlockContext, address: Address) -> Result<Bytes, Error> {
        self.ensure_chain(context)?;
        let result: String = self
            .rpc(
                "eth_getCode",
                json!([format!("{address:#x}"), context.selector()]),
            )
            .await?;
        let code = const_hex::decode(result).map_err(Error::InvalidHex)?;
        if code.is_empty() {
            return Err(Error::NoCode(address));
        }
        Ok(code.into())
    }

    pub async fn code_hash_at(
        &self,
        context: BlockContext,
        address: Address,
    ) -> Result<B256, Error> {
        Ok(keccak256(self.code_at(context, address).await?))
    }

    fn ensure_chain(&self, context: BlockContext) -> Result<(), Error> {
        if context.chain_id != self.expected_chain_id {
            return Err(Error::WrongChain {
                expected: self.expected_chain_id,
                actual: context.chain_id,
            });
        }
        Ok(())
    }

    async fn rpc<T>(&self, method: &'static str, params: serde_json::Value) -> Result<T, Error>
    where
        T: DeserializeOwned,
    {
        let response: RpcResponse<T> = self
            .client
            .post(self.node_url.clone())
            .json(&RpcRequest {
                jsonrpc: "2.0",
                id: 1,
                method,
                params,
            })
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        match (response.result, response.error) {
            (Some(result), None) => Ok(result),
            (_, Some(error)) => Err(Error::Rpc(error)),
            _ => Err(Error::MissingResult(method)),
        }
    }
}

#[derive(Serialize)]
struct RpcRequest {
    jsonrpc: &'static str,
    id: u64,
    method: &'static str,
    params: serde_json::Value,
}

#[derive(Deserialize)]
struct RpcResponse<T> {
    result: Option<T>,
    error: Option<RpcError>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
}

#[derive(Deserialize)]
struct RpcBlock {
    number: String,
    hash: String,
}

fn parse_quantity(value: &str) -> Result<u64, Error> {
    let digits = value.strip_prefix("0x").ok_or(Error::InvalidQuantity)?;
    u64::from_str_radix(digits, 16).map_err(|_| Error::InvalidQuantity)
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("expected chain {expected}, RPC reported chain {actual}")]
    WrongChain { expected: u64, actual: u64 },
    #[error("RPC error {0:?}")]
    Rpc(RpcError),
    #[error("RPC response omitted result for {0}")]
    MissingResult(&'static str),
    #[error("RPC returned an invalid hex quantity")]
    InvalidQuantity,
    #[error("RPC returned an invalid block hash")]
    InvalidBlockHash,
    #[error("system clock is before the Unix epoch")]
    ClockBeforeUnixEpoch,
    #[error("address {0:#x} has no code at the pinned block")]
    NoCode(Address),
    #[error("invalid hex RPC response")]
    InvalidHex(#[source] const_hex::FromHexError),
    #[error("HTTP transport error")]
    Http(
        #[from]
        #[source]
        reqwest::Error,
    ),
}

#[cfg(test)]
mod tests {
    use {super::*, serde_json::json};

    fn context(hash_byte: u8) -> BlockContext {
        BlockContext {
            chain_id: 1,
            number: 42,
            hash: B256::repeat_byte(hash_byte),
            observed_at_unix_millis: 1_000,
        }
    }

    #[test]
    fn eip_1898_selector_requires_canonical_hash() {
        assert_eq!(
            serde_json::to_value(context(0x11).selector()).unwrap(),
            json!({
                "blockHash": format!("{:#x}", B256::repeat_byte(0x11)),
                "requireCanonical": true,
            })
        );
    }

    #[test]
    fn block_context_rejects_number_or_hash_drift() {
        let expected = context(0x11);
        expected.ensure_same(expected).unwrap();

        let mut wrong_hash = expected;
        wrong_hash.hash = B256::repeat_byte(0x22);
        assert!(expected.ensure_same(wrong_hash).is_err());

        let mut wrong_number = expected;
        wrong_number.number += 1;
        assert!(expected.ensure_same(wrong_number).is_err());
    }

    #[test]
    fn staleness_uses_observation_time_without_underflow() {
        let context = context(0x11);
        assert!(!context.is_stale_at(999, Duration::from_millis(0)));
        assert!(!context.is_stale_at(1_500, Duration::from_millis(500)));
        assert!(context.is_stale_at(1_501, Duration::from_millis(500)));
    }

    #[test]
    fn parses_only_hex_rpc_quantities() {
        assert_eq!(parse_quantity("0x2a").unwrap(), 42);
        assert!(parse_quantity("42").is_err());
        assert!(parse_quantity("0xnope").is_err());
    }
}
