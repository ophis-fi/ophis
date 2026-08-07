//! Ekubo V3 solver for Robinhood Chain.
//!
//! Quotes are block-pinned by Ekubo's production quoter, but its response is
//! treated as hostile. This first lane accepts only connected extensionless
//! Core hops or routes forwarded to the pinned Robinhood Ve33 deployment,
//! encodes them locally, and calls the pinned Yul Router.

use {
    crate::domain::{dex, eth, order},
    alloy::primitives::{Address, U256},
    serde::Deserialize,
};

const MAX_SLIPPAGE_BPS: u16 = 2_000;
const MAX_HOPS: usize = 4;
const MAX_SPLITS: usize = 8;
const ROUTER_OVERHEAD_GAS: u64 = 150_000;
const ROBINHOOD_VE33: Address =
    alloy::primitives::address!("D18685a514E59b06d59824e16Db07e73345d9953");

pub struct Config {
    pub api: reqwest::Url,
    pub chain_id: u64,
    pub settlement: Address,
    pub router: Address,
    pub wrapped_native: Address,
}

pub struct Ekubo {
    client: reqwest::Client,
    config: Config,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Quote {
    #[allow(dead_code)]
    block_number: u64,
    #[allow(dead_code)]
    block_hash: String,
    total_calculated: String,
    estimated_gas_cost: u64,
    price_impact: Option<f64>,
    splits: Vec<Split>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Split {
    amount_specified: String,
    #[allow(dead_code)]
    amount_calculated: String,
    route: Vec<Node>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Node {
    swap: Swap,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Swap {
    r#type: String,
    pool_key: PoolKey,
    sqrt_ratio_limit: String,
    skip_ahead: u8,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PoolKey {
    token0: Address,
    token1: Address,
    config: String,
}

impl Ekubo {
    pub fn try_new(config: Config) -> Result<Self, CreationError> {
        if config.chain_id != 4663
            || config.settlement.is_zero()
            || config.router.is_zero()
            || config.wrapped_native.is_zero()
        {
            return Err(CreationError::InvalidConfig);
        }
        if config.api.as_str() != "https://prod-api-quoter.ekubo.org/" {
            return Err(CreationError::InvalidApi);
        }
        Ok(Self {
            client: reqwest::Client::builder()
                .user_agent("ophis-ekubo-solver/1.0")
                .build()?,
            config,
        })
    }

    pub async fn swap(
        &self,
        order: &dex::Order,
        slippage: &dex::Slippage,
        _is_quote: bool,
    ) -> Result<dex::Swap, Error> {
        if order.sell == order.buy
            || order.sell.0.is_zero()
            || order.buy.0.is_zero()
            || order.sell.0 == self.config.wrapped_native
            || order.buy.0 == self.config.wrapped_native
        {
            return Err(Error::OrderNotSupported);
        }
        if order.side != order::Side::Sell {
            return Err(Error::OrderNotSupported);
        }
        let exact_out = false;
        let specified_token = if exact_out { order.buy.0 } else { order.sell.0 };
        let calculated_token = if exact_out { order.sell.0 } else { order.buy.0 };
        let amount = if exact_out {
            format!("-{}", order.amount.get())
        } else {
            order.amount.get().to_string()
        };
        let url = self
            .config
            .api
            .join(&format!(
                "{}/{}/{:#x}/{:#x}",
                self.config.chain_id, amount, specified_token, calculated_token
            ))
            .map_err(Error::Url)?;
        let response = self.client.get(url).send().await?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Err(Error::NotFound);
        }
        if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Err(Error::RateLimited);
        }
        let quote: Quote = response.error_for_status()?.json().await?;
        // Ekubo documents a null reverse-quote price impact as a risk warning.
        // Fail closed instead of bidding from a route the quoter could not
        // sanity-check in the opposite direction.
        if quote.price_impact.is_none() {
            return Err(Error::InvalidQuote);
        }
        let calculated = parse_signed(&quote.total_calculated)?;
        if calculated == 0 || calculated.is_negative() != exact_out {
            return Err(Error::InvalidQuote);
        }
        let bps = crate::infra::metrics::clamp_slippage_bps(
            crate::infra::metrics::Dex::Ekubo,
            slippage.as_bps().ok_or(Error::InvalidSlippage)?,
            MAX_SLIPPAGE_BPS,
        );
        let calculated_abs = U256::from(calculated.unsigned_abs());
        let threshold_abs = if exact_out {
            add_slippage(calculated_abs, bps)?
        } else {
            subtract_slippage(calculated_abs, bps)?
        };
        let threshold: i128 = threshold_abs
            .try_into()
            .map_err(|_| Error::AmountTooLarge)?;
        let threshold = if exact_out { -threshold } else { threshold };
        let calldata = encode_routes(
            specified_token,
            calculated_token,
            threshold,
            self.config.settlement,
            &quote.splits,
        )?;
        let (input, output) = if exact_out {
            (threshold_abs, order.amount.get())
        } else {
            (order.amount.get(), threshold_abs)
        };
        if input.is_zero() || output.is_zero() {
            return Err(Error::NotFound);
        }
        Ok(dex::Swap {
            calls: vec![dex::Call {
                to: self.config.router,
                calldata,
            }],
            input: eth::Asset {
                token: order.sell,
                amount: input,
            },
            output: eth::Asset {
                token: order.buy,
                amount: output,
            },
            allowance: dex::Allowance {
                spender: self.config.router,
                amount: dex::Amount::new(input),
            },
            gas: eth::Gas(U256::from(
                quote.estimated_gas_cost.saturating_add(ROUTER_OVERHEAD_GAS),
            )),
        })
    }
}

fn encode_routes(
    specified: Address,
    calculated: Address,
    threshold: i128,
    recipient: Address,
    splits: &[Split],
) -> Result<Vec<u8>, Error> {
    if splits.is_empty() || splits.len() > MAX_SPLITS {
        return Err(Error::InvalidQuote);
    }
    let mut out = vec![1, u8::try_from(splits.len() - 1).unwrap()];
    out.extend_from_slice(specified.as_slice());
    out.extend_from_slice(calculated.as_slice());
    out.extend_from_slice(&threshold.to_be_bytes());
    out.extend_from_slice(recipient.as_slice());
    for split in splits {
        if split.route.is_empty() || split.route.len() > MAX_HOPS {
            return Err(Error::InvalidQuote);
        }
        let amount = parse_signed(&split.amount_specified)?;
        if amount == 0 || amount.is_negative() != threshold.is_negative() {
            return Err(Error::InvalidQuote);
        }
        out.extend_from_slice(&amount.to_be_bytes());
        out.push(u8::try_from(split.route.len() - 1).unwrap());
        let mut current = specified;
        for node in &split.route {
            let hop = &node.swap;
            if hop.pool_key.token0 >= hop.pool_key.token1 {
                return Err(Error::InvalidQuote);
            }
            let config = decode_fixed::<32>(&hop.pool_key.config)?;
            let extension = Address::from_slice(&config[..20]);
            let kind = match hop.r#type.as_str() {
                "core" if extension.is_zero() => 0,
                "forwarded" if extension == ROBINHOOD_VE33 => 1,
                _ => return Err(Error::InvalidQuote),
            };
            let next = if current == hop.pool_key.token0 {
                hop.pool_key.token1
            } else if current == hop.pool_key.token1 {
                hop.pool_key.token0
            } else {
                return Err(Error::InvalidQuote);
            };
            let sqrt = decode_fixed::<12>(&hop.sqrt_ratio_limit)?;
            out.push(kind);
            if kind == 1 {
                out.extend_from_slice(extension.as_slice());
            }
            out.extend_from_slice(hop.pool_key.token0.as_slice());
            out.extend_from_slice(hop.pool_key.token1.as_slice());
            out.extend_from_slice(&config);
            out.extend_from_slice(&sqrt);
            out.extend_from_slice(&(u32::from(hop.skip_ahead)).to_be_bytes());
            current = next;
        }
        if current != calculated {
            return Err(Error::InvalidQuote);
        }
    }
    Ok(out)
}

fn decode_fixed<const N: usize>(value: &str) -> Result<[u8; N], Error> {
    let bytes = const_hex::decode(value).map_err(Error::Hex)?;
    bytes.try_into().map_err(|_| Error::InvalidQuote)
}
fn parse_signed(value: &str) -> Result<i128, Error> {
    value.parse().map_err(|_| Error::AmountTooLarge)
}
fn subtract_slippage(amount: U256, bps: u16) -> Result<U256, Error> {
    Ok(amount.saturating_mul(U256::from(10_000u16 - bps)) / U256::from(10_000u16))
}
fn add_slippage(amount: U256, bps: u16) -> Result<U256, Error> {
    amount
        .checked_mul(U256::from(10_000u32 + u32::from(bps)))
        .and_then(|x| x.checked_add(U256::from(9_999u16)))
        .map(|x| x / U256::from(10_000u16))
        .ok_or(Error::AmountTooLarge)
}

#[derive(Debug, thiserror::Error)]
pub enum CreationError {
    #[error("invalid Ekubo chain/address configuration")]
    InvalidConfig,
    #[error("untrusted Ekubo API URL")]
    InvalidApi,
    #[error(transparent)]
    Http(#[from] reqwest::Error),
}
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("order unsupported by the ERC-20-only Ekubo lane")]
    OrderNotSupported,
    #[error("Ekubo route unavailable")]
    NotFound,
    #[error("Ekubo rate limited")]
    RateLimited,
    #[error("invalid slippage")]
    InvalidSlippage,
    #[error("untrusted or malformed Ekubo quote")]
    InvalidQuote,
    #[error("amount exceeds Ekubo int128 bounds")]
    AmountTooLarge,
    #[error(transparent)]
    Http(#[from] reqwest::Error),
    #[error(transparent)]
    Url(#[from] url::ParseError),
    #[error("invalid quote hex")]
    Hex(#[source] const_hex::FromHexError),
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_extension_bearing_core_hop() {
        let split = Split {
            amount_specified: "1".into(),
            amount_calculated: "1".into(),
            route: vec![Node {
                swap: Swap {
                    r#type: "core".into(),
                    pool_key: PoolKey {
                        token0: Address::ZERO,
                        token1: Address::with_last_byte(1),
                        config: format!("0x01{}", "00".repeat(31)),
                    },
                    sqrt_ratio_limit: format!("0x{}", "00".repeat(12)),
                    skip_ahead: 0,
                },
            }],
        };
        assert!(matches!(
            encode_routes(
                Address::ZERO,
                Address::with_last_byte(1),
                1,
                Address::with_last_byte(2),
                &[split]
            ),
            Err(Error::InvalidQuote)
        ));
    }

    #[test]
    fn accepts_only_the_pinned_robinhood_ve33_forwardee() {
        let token0 = Address::with_last_byte(1);
        let token1 = Address::with_last_byte(2);
        let mut config = [0u8; 32];
        config[..20].copy_from_slice(ROBINHOOD_VE33.as_slice());
        let split = Split {
            amount_specified: "7".into(),
            amount_calculated: "5".into(),
            route: vec![Node {
                swap: Swap {
                    r#type: "forwarded".into(),
                    pool_key: PoolKey {
                        token0,
                        token1,
                        config: const_hex::encode_prefixed(config),
                    },
                    sqrt_ratio_limit: format!("0x{}", "00".repeat(12)),
                    skip_ahead: 0,
                },
            }],
        };
        let encoded =
            encode_routes(token0, token1, 5, Address::with_last_byte(3), &[split]).unwrap();
        assert_eq!(encoded.len(), 78 + 17 + 109);
        assert_eq!(encoded[78 + 17], 1);
        assert_eq!(&encoded[78 + 18..78 + 38], ROBINHOOD_VE33.as_slice());
    }
}
