use {
    anyhow::{Context, Result},
    reqwest::{Client, ClientBuilder, StatusCode},
    std::time::Duration,
    url::Url,
};

pub struct Ipfs {
    client: Client,
    base: Url,
    query: Option<String>,
}

impl Ipfs {
    pub fn new(client: ClientBuilder, base: Url, query: Option<String>) -> Self {
        assert!(!base.cannot_be_a_base());
        Self {
            client: client.timeout(Duration::from_secs(5)).build().unwrap(),
            base,
            query,
        }
    }

    /// IPFS gateway behavior when a CID cannot be found is inconsistent and can
    /// be confusing:
    ///
    /// - The public ipfs.io gateway responds "504 Gateway Timeout" after 2
    ///   minutes.
    /// - The public cloudflare gateway responds "524" after 20 seconds.
    /// - A private Pinata gateway responds "404 Not Found" after 2 minutes.
    ///
    /// This function treats timeouts and all status codes except "200 OK" as
    /// Ok(None).
    pub async fn fetch(&self, cid: &str) -> Result<Option<Vec<u8>>> {
        let url = self.prepare_url(cid);
        let response = match self.client.get(url).send().await {
            Ok(response) => response,
            Err(err) if err.is_timeout() => return Ok(None),
            result @ Err(_) => return Err(result.context("send").unwrap_err()),
        };
        let status = response.status();
        let body = response.bytes().await.context("body")?;
        match status {
            StatusCode::OK => Ok(Some(body.into())),
            // Phase 2 audit L5 (silent-failure F17, 2026-05-22): the prior
            // implementation logged at `trace!` level, which is suppressed
            // in production. That hid the distinction between "the CID
            // genuinely isn't pinned" (404) and "the gateway is degraded"
            // (5xx, 524, 504), and both cases collapsed to `Ok(None)` with
            // no operational signal. Now: 4xx logged at debug (likely
            // genuinely missing), 5xx + non-4xx logged at warn (gateway
            // health degraded — investigate). Return type unchanged for
            // compatibility with existing callers that already treat IPFS
            // misses as best-effort.
            StatusCode::NOT_FOUND => {
                tracing::debug!(%status, "IPFS not found (likely unpinned CID)");
                Ok(None)
            }
            s if s.is_client_error() => {
                tracing::debug!(%status, "IPFS client error");
                Ok(None)
            }
            _ => {
                let body = String::from_utf8_lossy(&body);
                let body: &str = &body;
                tracing::warn!(
                    %status,
                    %body,
                    "IPFS gateway returned unexpected status — gateway health may be degraded"
                );
                Ok(None)
            }
        }
    }

    fn prepare_url(&self, cid: &str) -> Url {
        let mut url = shared::url::join(&self.base, &format!("ipfs/{cid}"));
        if let Some(query) = &self.query {
            url.set_query(Some(query.as_str()));
        }
        url
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore]
    async fn public_gateway() {
        let ipfs = Ipfs::new(Default::default(), "https://ipfs.io".parse().unwrap(), None);
        let cid = "Qma4Dwke5h8mgJyZMDRvKqM3RF7c6Mxcj3fR4um9UGaNF6";
        let content = ipfs.fetch(cid).await.unwrap().unwrap();
        let content = std::str::from_utf8(&content).unwrap();
        println!("{content}");
    }

    #[tokio::test]
    #[ignore]
    async fn private_gateway() {
        let url = std::env::var("url").unwrap();
        let query = std::env::var("query").unwrap();
        let ipfs = Ipfs::new(Default::default(), url.parse().unwrap(), Some(query));
        let cid = "Qma4Dwke5h8mgJyZMDRvKqM3RF7c6Mxcj3fR4um9UGaNF6";
        let content = ipfs.fetch(cid).await.unwrap().unwrap();
        let content = std::str::from_utf8(&content).unwrap();
        println!("{content}");
    }

    #[tokio::test]
    #[ignore]
    async fn not_found() {
        observe::tracing::init::initialize(
            &observe::Config::default().with_env_filter("orderbook::ipfs=trace"),
        );
        let ipfs = Ipfs::new(Default::default(), "https://ipfs.io".parse().unwrap(), None);
        let cid = "Qma4Dwke5h8mgJyZMDRvKqM3RF7c6Mxcj3fR4um9UGaNF7";
        let result = ipfs.fetch(cid).await.unwrap();
        assert!(result.is_none());
    }
}
