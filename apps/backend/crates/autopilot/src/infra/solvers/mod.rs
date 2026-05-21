use {
    self::dto::{reveal, settle, solve},
    crate::util,
    alloy::signers::{Signer, aws::AwsSigner},
    anyhow::{Context, Result, anyhow},
    configs::autopilot::solver::Account,
    eth_domain_types as eth,
    observe::tracing::{distributed::headers::tracing_headers, lazy::Lazy},
    reqwest::{Client, RequestBuilder, StatusCode},
    std::{borrow::Cow, time::Duration},
    thiserror::Error,
    tracing::instrument,
    url::Url,
};

mod byte_stream;
pub mod dto;

const RESPONSE_SIZE_LIMIT: usize = 10_000_000;
const RESPONSE_TIME_LIMIT: Duration = Duration::from_secs(60);

pub struct Driver {
    pub name: String,
    pub url: Url,
    pub submission_address: eth::Address,
    client: Client,
    /// F7 (2026-05-21 whole-repo audit, HIGH H2): optional inter-service
    /// auth token. When `Some`, injected as `Authorization: Bearer <token>`
    /// on every outgoing request to the driver. Read from
    /// `OPHIS_INTER_SERVICE_AUTH_TOKEN` env at construction time. When
    /// `None`, no header is sent — preserves pre-F7 behavior for
    /// transitional rollout.
    inter_service_auth_token: Option<std::sync::Arc<String>>,
}

#[derive(Error, Debug)]
pub enum Error {
    #[error("unable to load KMS account")]
    UnableToLoadKmsAccount,
    #[error("failed to build client")]
    FailedToBuildClient(#[source] reqwest::Error),
}

impl Driver {
    #[instrument(skip_all)]
    pub async fn try_new(
        url: Url,
        name: String,
        submission_account: Account,
    ) -> Result<Self, Error> {
        let submission_address = match submission_account {
            Account::Kms(key_id) => {
                let config = alloy::signers::aws::aws_config::load_from_env().await;
                let client = alloy::signers::aws::aws_sdk_kms::Client::new(&config);
                let account = AwsSigner::new(client, key_id.0.clone(), None)
                    .await
                    .map_err(|_| {
                        tracing::error!(?name, ?key_id, "Unable to load KMS account");
                        Error::UnableToLoadKmsAccount
                    })?;
                account.address()
            }
            Account::Address(address) => address,
        };
        tracing::info!(?name, ?url, ?submission_address, "Creating solver");

        // F7: pick up the inter-service auth token at construction. We
        // log once per Driver to surface the running mode — if the env
        // var is missing AND the driver enforces auth, every request
        // will 401 with a clear message; the operator will see this
        // log line at startup and the 401 logs side-by-side.
        let inter_service_auth_token = std::env::var("OPHIS_INTER_SERVICE_AUTH_TOKEN")
            .ok()
            .filter(|s| !s.is_empty())
            .map(std::sync::Arc::new);
        if inter_service_auth_token.is_some() {
            tracing::info!(
                ?name,
                "F7 inter-service auth token loaded — autopilot will sign requests to driver"
            );
        } else {
            tracing::warn!(
                ?name,
                "F7 OPHIS_INTER_SERVICE_AUTH_TOKEN unset — autopilot calls to driver \
                 are un-authenticated (acceptable in single-tenant; required before \
                 multi-tenant expansion)"
            );
        }

        Ok(Self {
            name,
            url,
            client: Client::builder()
                .timeout(RESPONSE_TIME_LIMIT)
                .tcp_keepalive(Duration::from_secs(60))
                .build()
                .map_err(Error::FailedToBuildClient)?,
            submission_address,
            inter_service_auth_token,
        })
    }

    /// F7 helper: apply the inter-service auth header to an outgoing
    /// request when the token is configured. No-op when unset.
    fn inject_inter_service_auth(&self, request: RequestBuilder) -> RequestBuilder {
        match &self.inter_service_auth_token {
            Some(token) => request.bearer_auth(token.as_str()),
            None => request,
        }
    }

    pub async fn solve(&self, request: solve::Request) -> Result<solve::Response> {
        self.request_response("solve", request).await
    }

    pub async fn reveal(&self, request: reveal::Request) -> Result<reveal::Response> {
        self.request_response("reveal", request).await
    }

    pub async fn settle(
        &self,
        request: &settle::Request,
        timeout: std::time::Duration,
    ) -> Result<()> {
        let url = util::join(&self.url, "settle");
        tracing::trace!(
            path=&url.path(),
            body=%serde_json::to_string_pretty(request).unwrap(),
            "solver request",
        );

        let response = self
            .inject_inter_service_auth(
                self.client
                    .post(url)
                    .json(request)
                    .timeout(timeout)
                    .header("X-REQUEST-ID", request.auction_id.to_string())
                    .headers(tracing_headers()),
            )
            .send()
            .await
            .context("send")?;
        let status = response.status();

        tracing::trace!(%status, "solver response");

        if status != StatusCode::OK {
            let text = response.text().await.context("read error response body")?;
            return Err(anyhow!("bad status {status}: {text}"));
        }
        Ok(())
    }

    async fn request_response<Response, Request>(
        &self,
        path: &str,
        payload: Request,
    ) -> Result<Response>
    where
        Response: serde::de::DeserializeOwned,
        Request: InjectIntoHttpRequest,
    {
        let url = util::join(&self.url, path);

        tracing::trace!(
            path = &url.path(),
            body = %Lazy(|| payload.body_to_string()),
            "solver request",
        );

        let request = self.client.post(url.clone()).headers(tracing_headers());
        let request = self.inject_inter_service_auth(request);
        let mut request = payload.inject(request);

        if let Some(request_id) = observe::tracing::distributed::request_id::from_current_span() {
            request = request.header("X-REQUEST-ID", request_id);
        }

        let mut response = request.send().await.context("send")?;
        let status = response.status().as_u16();
        let body = response_body_with_size_limit(&mut response, RESPONSE_SIZE_LIMIT)
            .await
            .context("body")?;
        let text = String::from_utf8_lossy(&body);
        tracing::trace!(%status, body=%text, "solver response");
        let context = || format!("url {url}, body {text:?}");
        if status != 200 {
            return Err(anyhow!("bad status {status}, {}", context()));
        }
        serde_json::from_slice(&body).with_context(|| format!("bad json {}", context()))
    }
}

/// Extracts the bytes of the response up to some size limit.
///
/// Returns an error if the byte limit was exceeded.
pub async fn response_body_with_size_limit(
    response: &mut reqwest::Response,
    limit: usize,
) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        let slice: &[u8] = &chunk;
        if bytes.len() + slice.len() > limit {
            return Err(anyhow!("size limit exceeded"));
        }
        bytes.extend_from_slice(slice);
    }
    Ok(bytes)
}

trait InjectIntoHttpRequest {
    fn inject(&self, request: RequestBuilder) -> RequestBuilder;
    fn body_to_string(&self) -> Cow<'_, str>;
}

impl<T> InjectIntoHttpRequest for T
where
    T: serde::ser::Serialize + Sized,
{
    fn inject(&self, request: RequestBuilder) -> RequestBuilder {
        request.json(&self)
    }

    fn body_to_string(&self) -> Cow<'_, str> {
        let serialized = serde_json::to_string(&self).expect("type should be JSON serializable");
        Cow::Owned(serialized)
    }
}
