//! Direct Robinhood Uniswap V4 solver lane.
//!
//! Quotes come from Uniswap's canonical V4Quoter over Ophis' own RPC. The
//! executable interaction calls the immutable, pair-restricted
//! OphisUniswapV4Adapter; no third-party routing or quote API participates.

use {
    crate::domain::{dex, eth, order},
    alloy::{
        primitives::{Address, Bytes, U256},
        sol,
        sol_types::SolCall,
    },
    serde::{Deserialize, Serialize},
};

sol! {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct QuoteExactSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 exactAmount;
        bytes hookData;
    }

    function quoteExactInputSingle(QuoteExactSingleParams params)
        external
        returns (uint256 amountOut, uint256 gasEstimate);

    function swapExactInput(address tokenIn, uint256 amountIn, uint256 minAmountOut)
        external
        returns (uint256 amountOut);
}

const MAX_SLIPPAGE_BPS: u16 = 2_000;
const ADAPTER_OVERHEAD_GAS: u64 = 250_000;

pub struct Config {
    pub node_url: reqwest::Url,
    pub quoter: Address,
    pub adapter: Address,
    pub wrapped_native: Address,
    pub stablecoin: Address,
}

pub struct UniswapV4 {
    client: reqwest::Client,
    config: Config,
}

impl UniswapV4 {
    pub fn try_new(config: Config) -> Result<Self, CreationError> {
        Ok(Self {
            client: reqwest::Client::builder()
                .user_agent("ophis-uniswap-v4-solver/1.0")
                .build()?,
            config,
        })
    }

    pub async fn swap(
        &self,
        order: &dex::Order,
        slippage: &dex::Slippage,
        is_quote: bool,
    ) -> Result<dex::Swap, Error> {
        if order.side == order::Side::Buy {
            return Err(Error::OrderNotSupported);
        }

        let sell = order.sell.0;
        let buy = order.buy.0;
        let zero_for_one = if sell == self.config.wrapped_native && buy == self.config.stablecoin {
            true
        } else if sell == self.config.stablecoin && buy == self.config.wrapped_native {
            false
        } else {
            return Err(Error::OrderNotSupported);
        };
        let exact_amount: u128 = order
            .amount
            .get()
            .try_into()
            .map_err(|_| Error::AmountTooLarge)?;

        let quote_call = quoteExactInputSingleCall {
            params: QuoteExactSingleParams {
                poolKey: PoolKey {
                    currency0: Address::ZERO,
                    currency1: self.config.stablecoin,
                    fee: 500u32.try_into().expect("500 fits uint24"),
                    tickSpacing: 10i32.try_into().expect("10 fits int24"),
                    hooks: Address::ZERO,
                },
                zeroForOne: zero_for_one,
                exactAmount: exact_amount,
                hookData: Bytes::new(),
            },
        };
        let quote_data = self
            .eth_call(self.config.quoter, quote_call.abi_encode())
            .await?;
        let quote = quoteExactInputSingleCall::abi_decode_returns(&quote_data)
            .map_err(Error::QuoteDecode)?;
        if quote.amountOut.is_zero() {
            return Err(Error::NotFound);
        }

        let configured_bps = slippage.as_bps().ok_or(Error::InvalidSlippage)?;
        let clamped_bps = crate::infra::metrics::clamp_slippage_bps(
            crate::infra::metrics::Dex::UniswapV4,
            configured_bps,
            MAX_SLIPPAGE_BPS,
        );
        let sent_bps = if is_quote {
            clamped_bps
        } else {
            order.bounded_solve_slippage_bps(
                quote.amountOut,
                clamped_bps,
                eth::Gas(
                    quote
                        .gasEstimate
                        .saturating_add(U256::from(ADAPTER_OVERHEAD_GAS)),
                ),
                0,
            )
        };
        let min_amount_out = quote
            .amountOut
            .saturating_mul(U256::from(10_000u64 - u64::from(sent_bps)))
            / U256::from(10_000u64);
        if min_amount_out.is_zero() {
            return Err(Error::NotFound);
        }

        let swap_call = swapExactInputCall {
            tokenIn: sell,
            amountIn: order.amount.get(),
            minAmountOut: min_amount_out,
        };
        Ok(dex::Swap {
            calls: vec![dex::Call {
                to: self.config.adapter,
                calldata: swap_call.abi_encode(),
            }],
            input: eth::Asset {
                token: order.sell,
                amount: order.amount.get(),
            },
            output: eth::Asset {
                token: order.buy,
                amount: min_amount_out,
            },
            allowance: dex::Allowance {
                spender: self.config.adapter,
                amount: dex::Amount::new(order.amount.get()),
            },
            gas: eth::Gas(
                quote
                    .gasEstimate
                    .saturating_add(U256::from(ADAPTER_OVERHEAD_GAS)),
            ),
        })
    }

    async fn eth_call(&self, to: Address, calldata: Vec<u8>) -> Result<Vec<u8>, Error> {
        #[derive(Serialize)]
        struct Request<'a> {
            jsonrpc: &'static str,
            id: u64,
            method: &'static str,
            params: [CallParams<'a>; 2],
        }
        #[derive(Serialize)]
        #[serde(untagged)]
        enum CallParams<'a> {
            Call { to: String, data: String },
            Block(&'a str),
        }
        #[derive(Deserialize)]
        struct Response {
            result: Option<String>,
            error: Option<RpcError>,
        }
        #[derive(Debug, Deserialize)]
        struct RpcError {
            code: i64,
            message: String,
        }

        let request = Request {
            jsonrpc: "2.0",
            id: 1,
            method: "eth_call",
            params: [
                CallParams::Call {
                    to: format!("{to:#x}"),
                    data: const_hex::encode_prefixed(calldata),
                },
                CallParams::Block("latest"),
            ],
        };
        let response: Response = self
            .client
            .post(self.config.node_url.clone())
            .json(&request)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        if let Some(error) = response.error {
            return Err(Error::Rpc(error.code, error.message));
        }
        let result = response.result.ok_or(Error::MissingResult)?;
        const_hex::decode(result).map_err(Error::Hex)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("order is not an exact-input WETH/USDG swap")]
    OrderNotSupported,
    #[error("no direct Uniswap V4 route")]
    NotFound,
    #[error("order amount exceeds uint128")]
    AmountTooLarge,
    #[error("invalid slippage")]
    InvalidSlippage,
    #[error("RPC error {0}: {1}")]
    Rpc(i64, String),
    #[error("RPC response omitted result")]
    MissingResult,
    #[error(transparent)]
    Http(#[from] reqwest::Error),
    #[error("invalid hex RPC response")]
    Hex(#[source] const_hex::FromHexError),
    #[error("invalid V4Quoter response")]
    QuoteDecode(#[source] alloy::sol_types::Error),
}

#[derive(Debug, thiserror::Error)]
pub enum CreationError {
    #[error(transparent)]
    Client(#[from] reqwest::Error),
}
