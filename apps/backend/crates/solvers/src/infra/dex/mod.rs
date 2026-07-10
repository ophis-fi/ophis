use {
    crate::domain::{auction, dex},
    ethrpc::block_stream::CurrentBlockWatcher,
    reqwest::RequestBuilder,
};

pub mod bitget;
pub mod dodo;
pub mod enso;
pub mod kyberswap;
pub mod lifi;
pub mod odos;
pub mod okx;
pub mod openocean;
pub mod simulator;
pub mod velora;

pub use self::simulator::Simulator;

/// A supported external DEX/DEX aggregator API.
pub enum Dex {
    Bitget(bitget::Bitget),
    Okx(Box<okx::Okx>),
    KyberSwap(Box<kyberswap::KyberSwap>),
    Velora(Box<velora::Velora>),
    Odos(Box<odos::Odos>),
    OpenOcean(Box<openocean::OpenOcean>),
    Dodo(Box<dodo::Dodo>),
    Lifi(Box<lifi::Lifi>),
    Enso(Box<enso::Enso>),
}

impl Dex {
    /// Computes a swap (including calldata, estimated input and output amounts
    /// and the required allowance) for the specified order.
    ///
    /// These computed swaps can be used to generate single order solutions.
    pub async fn swap(
        &self,
        order: &dex::Order,
        slippage: &dex::Slippage,
        tokens: &auction::Tokens,
        // Quote path: report the optimistic output. Only the flooring lanes
        // (okx/kyberswap/velora/odos/dodo) consume this; the others already
        // report their optimistic/pinned amount and are unchanged.
        is_quote: bool,
    ) -> Result<dex::Swap, Error> {
        let swap = match self {
            Dex::Bitget(bitget) => bitget.swap(order, slippage, tokens).await?,
            Dex::Okx(okx) => okx.swap(order, slippage, is_quote).await?,
            Dex::KyberSwap(kyberswap) => kyberswap.swap(order, slippage, is_quote).await?,
            Dex::Velora(velora) => velora.swap(order, slippage, tokens, is_quote).await?,
            Dex::Odos(odos) => odos.swap(order, slippage, is_quote).await?,
            Dex::OpenOcean(openocean) => openocean.swap(order, slippage, tokens).await?,
            Dex::Dodo(dodo) => dodo.swap(order, slippage, is_quote).await?,
            Dex::Lifi(lifi) => lifi.swap(order, slippage).await?,
            Dex::Enso(enso) => enso.swap(order, slippage).await?,
        };
        Ok(swap)
    }
}

/// A categorized error that occurred building a swap with an external DEX/DEX
/// aggregator.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("order type is not supported")]
    OrderNotSupported,
    #[error("no valid swap interaction could be found")]
    NotFound,
    #[error("invalid request")]
    BadRequest,
    #[error("rate limited")]
    RateLimited,
    #[error("unavailable for legal reasons, banned tokens or similar")]
    UnavailableForLegalReasons,
    #[error(transparent)]
    Other(Box<dyn std::error::Error + Send + Sync>),
}

/// A wrapper around [`reqwest::Client`] to pre-set commonly used headers
/// and other properties on each request.
pub(crate) struct Client {
    /// Client to send requests.
    client: reqwest::Client,

    /// Block stream to read the current block.
    block_stream: Option<CurrentBlockWatcher>,
}

impl Client {
    pub fn new(client: reqwest::Client, block_stream: Option<CurrentBlockWatcher>) -> Self {
        Self {
            client,
            block_stream,
        }
    }

    /// Prepares a request builder which already has additional headers set.
    pub fn request(&self, method: reqwest::Method, url: reqwest::Url) -> RequestBuilder {
        let request = self.client.request(method, url);
        if let Some(stream) = &self.block_stream {
            // Set this header to easily support caching in an egress proxy.
            request.header("X-CURRENT-BLOCK-HASH", stream.borrow().hash.to_string())
        } else {
            request
        }
    }
}

impl Error {
    /// for instrumentization purposes
    pub fn format_variant(&self) -> &'static str {
        match self {
            Self::OrderNotSupported => "OrderNotSupported",
            Self::NotFound => "NotFound",
            Self::BadRequest => "BadRequest",
            Self::RateLimited => "RateLimited",
            Self::UnavailableForLegalReasons => "UnavailableForLegalReasons",
            Self::Other(_) => "Other",
        }
    }
}

impl From<okx::Error> for Error {
    fn from(err: okx::Error) -> Self {
        match err {
            okx::Error::OrderNotSupported => Self::OrderNotSupported,
            okx::Error::NotFound => Self::NotFound,
            okx::Error::RateLimited => Self::RateLimited,
            _ => Self::Other(Box::new(err)),
        }
    }
}

impl From<bitget::Error> for Error {
    fn from(err: bitget::Error) -> Self {
        match err {
            bitget::Error::OrderNotSupported => Self::OrderNotSupported,
            bitget::Error::NotFound => Self::NotFound,
            bitget::Error::MissingDecimals | bitget::Error::BadRequest => Self::BadRequest,
            bitget::Error::RateLimited => Self::RateLimited,
            _ => Self::Other(Box::new(err)),
        }
    }
}

impl From<kyberswap::Error> for Error {
    fn from(err: kyberswap::Error) -> Self {
        match err {
            kyberswap::Error::OrderNotSupported => Self::OrderNotSupported,
            kyberswap::Error::NotFound | kyberswap::Error::BuildFailed => Self::NotFound,
            kyberswap::Error::RateLimited => Self::RateLimited,
            _ => Self::Other(Box::new(err)),
        }
    }
}

impl From<velora::Error> for Error {
    fn from(err: velora::Error) -> Self {
        match err {
            velora::Error::OrderNotSupported => Self::OrderNotSupported,
            // RateChanged is a transient — the solver caller will retry on the
            // next auction iteration when /prices returns a fresh route.
            velora::Error::NotFound | velora::Error::RateChanged => Self::NotFound,
            velora::Error::RateLimited => Self::RateLimited,
            _ => Self::Other(Box::new(err)),
        }
    }
}

impl From<odos::Error> for Error {
    fn from(err: odos::Error) -> Self {
        match err {
            odos::Error::OrderNotSupported => Self::OrderNotSupported,
            odos::Error::NotFound => Self::NotFound,
            odos::Error::RateLimited => Self::RateLimited,
            _ => Self::Other(Box::new(err)),
        }
    }
}

impl From<openocean::Error> for Error {
    fn from(err: openocean::Error) -> Self {
        match err {
            openocean::Error::OrderNotSupported => Self::OrderNotSupported,
            openocean::Error::NotFound => Self::NotFound,
            // Missing token decimals is a permanent per-order reject (OpenOcean
            // takes amounts in decimal units), not a transient — mirror bitget.
            openocean::Error::MissingDecimals => Self::BadRequest,
            openocean::Error::RateLimited => Self::RateLimited,
            _ => Self::Other(Box::new(err)),
        }
    }
}

impl From<dodo::Error> for Error {
    fn from(err: dodo::Error) -> Self {
        match err {
            dodo::Error::OrderNotSupported => Self::OrderNotSupported,
            dodo::Error::NotFound => Self::NotFound,
            dodo::Error::RateLimited => Self::RateLimited,
            _ => Self::Other(Box::new(err)),
        }
    }
}

impl From<lifi::Error> for Error {
    fn from(err: lifi::Error) -> Self {
        match err {
            lifi::Error::OrderNotSupported => Self::OrderNotSupported,
            lifi::Error::NotFound => Self::NotFound,
            lifi::Error::RateLimited => Self::RateLimited,
            _ => Self::Other(Box::new(err)),
        }
    }
}

impl From<enso::Error> for Error {
    fn from(err: enso::Error) -> Self {
        match err {
            enso::Error::OrderNotSupported => Self::OrderNotSupported,
            enso::Error::NotFound => Self::NotFound,
            enso::Error::RateLimited => Self::RateLimited,
            _ => Self::Other(Box::new(err)),
        }
    }
}
