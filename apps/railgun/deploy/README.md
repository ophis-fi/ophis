# Baal RPC transport

This separate stack connects the wallet gateway to Baal without publishing an Ethereum RPC host port. Cloudflare Tunnel terminates at Caddy, which accepts only `POST /rpc` with a server-held bearer token. The Worker applies the RPC method and resource limits before forwarding. Caddy removes credentials before calling Baal's Tailscale-only RPC and rejects bodies above 256 KiB. Access logging is disabled; do not enable request-body or credential logging.

The stack is running at `/home/clement/ophis-railgun` on Baal. Its images are pinned by digest. The scoped tunnel credentials and `.env` are mode 0600 and excluded from Git. The generated RPC token is also stored in the repository's protected `Production` environment as `RAILGUN_RPC_TOKEN`; it belongs only in the deployed Worker's secret binding, never a Vite variable or browser bundle.

The deployment workflow is manual and main-only. It installs pinned dependencies with scripts disabled, runs the fork-scoped unit suite, builds the Ethereum wallet, deploys the Worker, sets the RPC secret and checks Ethereum reads plus administrative-method rejection. A first deployment remains unavailable until the secret is installed. Required release acceptance must pass before dispatching it. Enable the existing Ophis footer only after deployment checks by setting `REACT_APP_PRIVATE_WALLET_URL=https://private.ophis.fi` and rebuilding the frontend.

## Verification

The live origin checks passed missing/wrong credentials, wrong method/path, valid Ethereum reads and oversized valid JSON rejection. Read-only service checks passed canonical EIP-7702 calls and tracing, PPOI node health and signed broadcaster discovery through the authenticated HTTPS origin. The actual local Workerd gateway passed those Ethereum calls through the same origin and rejected `admin_nodeInfo`.

Use an explicit application User-Agent for machine probes: the existing Cloudflare browser-integrity policy rejects Python's default User-Agent with error 1010 before it reaches Caddy. The Worker sets `Ophis-Private-Wallet/1.0`; do not mistake an edge rejection for a successful Caddy authentication test.

These checks do not establish funded wallet execution, PPOI eligibility or broadcaster transaction acceptance.

## Operations and rollback

Validate and start from the stack directory with `docker compose run --rm --no-deps rpc caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile` and `docker compose up -d --no-build --pull never`. Do not print `docker compose config` or container environments: they contain the RPC token. Rotate the token in both Baal's `.env` and the Worker secret, then recreate only this stack's `rpc` service.

Stop only this transport with `docker compose down` from `/home/clement/ophis-railgun`. This does not stop Ethereum, consensus or the validator. Remove its dedicated DNS record and tunnel if retiring it. Disable the wallet RPC and footer entry before withdrawing the transport.

Baal tracing was enabled separately with `EL_EXTRAS=--http.api eth,net,web3,debug --rpc.max-tracing-requests 1`. The original `.env` backup is `/home/clement/eth-mainnet/.env.railgun-tracing-20261021T145547Z.bak`. The execution container alone was recreated with its existing image, volumes and private port bindings; consensus and validator start times and restart counts were unchanged. Reverting that setting also requires recreating execution, briefly interrupting its engine connection.
