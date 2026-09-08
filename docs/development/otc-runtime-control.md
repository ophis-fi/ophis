# OTC runtime signing switch

The **OTC runtime control** workflow runs only from protected `main`, using the existing Cloudflare credentials. It manages one expiring object in the private `ophis-otc-control` R2 bucket. The production Pages binding is `OPHIS_OTC_CONTROL`; preview deployments always return disabled. No browser or public HTTP endpoint can write the control.

Initialize with `gh workflow run otc-runtime-control.yml --ref main -f mode=init`, then deploy the current frontend through **Deploy to Cloudflare Pages** so the new binding takes effect. Initialization writes disabled state and preserves other R2 bindings. It does not change wallet/token admission or enable frontend signing.

To stop new signing, run `gh workflow run otc-runtime-control.yml --ref main -f mode=off`. Wait for success: the workflow writes disabled state and verifies the public endpoint with a fresh nonce. R2 reads through a binding are [strongly consistent](https://developers.cloudflare.com/r2/reference/consistency/); the endpoint and browser must not cache authorization. A failed read disables signing. An already-issued wallet prompt or signed transaction cannot be cancelled by this switch.

For an authorized activation window, use `mode=on` with `expires_at=YYYY-MM-DDTHH:MM:SSZ` within the next 24 hours. An unsuccessful enablement check attempts to restore disabled state. The static reviewed policy remains independently mandatory; enabling this switch never admits a wallet or expands a token limit. The frontend integration and a witnessed existing/fresh-tab shutdown drill must pass before admitting live trades.

The existing `REACT_APP_OTC_ENABLED=false` deployment/reload control remains a separate route-level fallback. Do not change the compiled feature flag default to bypass an unavailable runtime control. No mainnet transaction is part of provisioning or a control-only rehearsal.
