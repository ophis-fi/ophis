# Arc release package — local preparation only

Nothing in this branch has been merged or deployed publicly. `plan`, `rehearse`,
`render`, and `check` do not send public transactions. `broadcast.cjs --broadcast
--ledger` and `start.cjs --start` are separate, explicit operator actions for the
later authorized launch. Do not run them as part of local development.

## Existing identities

`config.example.json` uses the existing protocol Safe
`0xe049a64546fb8564CC4c7D64A0A1BAe00Aa801cF`, Ledger deployer
`0xBeC5B03ffDcac50071693E87bFDb88bAa6710199`, and the three owners recorded in
`infra/shared/cron/safe-drift-check.sh.tmpl`. The default solver is Robinhood's
`0x7A956C269a12f1B897367663b536EB5dd29f3fBb`; OP and Unichain have different recorded
solvers. This is an offline default pending the operator's choice, not a new key.

The example nonce **0 is a placeholder**, not an observed Arc nonce. Before the
ceremony copy it to ignored `config.json`, set the deployer's current pending nonce
using a free Arc RPC, and confirm the intended public API/frontend origins.
Predicted contract addresses are not deployment evidence.

The same Safe address must actually exist on Arc. The preflight verifies its
proxy dispatcher, pinned Safe/SafeL2 singleton bytecode (1.3.0 or 1.4.1), exactly
the expected three owners, threshold two, and no enabled modules. If absent,
deploy the existing Safe configuration through the normal Safe ceremony first.
Reusing its address on another chain does not deploy it on Arc.

Initial Arc governance follows the direct Safe arrangement: proxy owner and
allowlist manager are the Safe from construction. OP's later timelock/guardian
migration is not silently assumed to exist on Arc. No deployer/online solver has
governance privileges; a Safe quorum adds or removes solvers and upgrades auth.

## Offline preparation and checks

Use the existing frontend dependencies, Foundry, solc-select 0.8.30, Python
with PyYAML (and tomli on Python <3.11), and Docker. Check disk before building:

```sh
python3 infra/arc-mainnet/local/build.py --check-only
node infra/arc-mainnet/release/rehearse.cjs
node infra/arc-mainnet/release/plan.cjs infra/arc-mainnet/release/config.example.json
python3 infra/arc-mainnet/release/check.py
python3 infra/arc-mainnet/test_credit_gate.py
python3 infra/arc-mainnet/test_rpc.py --release
```

The rehearsal owns a fresh non-forked Anvil on `127.0.0.1:31559`, deploys the actual
seven production contracts and a real 2-of-3 Safe, tests single-owner denial,
activation, settlement, revocation, runtime/domain/wiring verification, and local
proof rejection for production. It cleans up only its own node. The RPC/API checks
use Docker networks without internet access. None consumes QuickNode/dRPC credits.

The plan compiles current hardened authentication, settlement, balance/signature
helpers and a reverting Balancer vault. It reuses the repository's EIP173 proxy
and HooksTrampoline artifacts. It records compiler/source/artifact hashes, exact
constructor calldata, nonces, gas caps, CREATE addresses and the child relayer.
`generated/solc-input.json` is the standard JSON input for source verification;
constructor arguments and imported artifact provenance are retained in the plan.

`render.py` prepares an **inactive** preview by default: address-only solver,
frontend disabled. It does not create a signing key. `--activate` requires a
matching, nonlocal verification record less than one hour old. Generated secrets,
plans, receipts and rendered configuration stay ignored and mode 0600.

## Later deployment and activation ceremony

These steps are operational work after deployment authorization, not pending
application development. Use the reviewed revision and actual `config.json`:

1. Confirm the Safe on Arc and native USDC gas for the existing Ledger/solver.
   Refresh the deployer nonce and prepare the final unsigned plan. Review all
   seven transactions and the Safe activation batch. No arbitrary Balancer fallback
   or wrapped-USDC deployment is used.
2. Set `ARC_READ_RPC_URL=https://rpc.mainnet.arc.io`; run
   `node infra/arc-mainnet/release/broadcast.cjs --broadcast --ledger`.
   It compares current source to the reviewed plan and verifies the Ledger address,
   nonce, Safe and receipts. Receipt journaling supports resuming completed steps.
   A missing journal entry after an interrupted broadcast requires receipt recovery;
   never blindly increment the nonce or overwrite the plan.
3. Import `generated/safe-activation.json` into the Safe transaction builder and
   execute with two owners. Run `node infra/arc-mainnet/release/verify.cjs`.
   It binds receipts and creation inputs to the plan and checks actual code,
   ownership, empty pending manager, solver authorization and contract wiring.
4. Build the backend/migrations Docker images on a host with sufficient space
   (a fresh Rust build needs at least 12 GiB free). Set `ARC_RELEASE_TAG` to the
   reviewed revision, and export `ARC_RUNTIME_UID=$(id -u)` and
   `ARC_RUNTIME_GID=$(id -g)`; `docker compose -f infra/arc-mainnet/release/docker-compose.yml
   build`. Share the one backend image across services. Never build on the current
   laptop's approximately 6 GiB free space without increasing available storage.
5. Supply `ARC_SOLVER_KEY_FILE` pointing to the existing private key file outside
   the repo, mode 0600. Set `ARC_QUICKNODE_RPC_URL` privately and reserve only the
   actually available credits in `ARC_QUICKNODE_CREDIT_ALLOWANCE` (1..10,000,000).
   Use the environment or an ignored release `.env`; never put these in frontend
   variables. `start.cjs` expects these variables exported in its environment.
6. Run `node infra/arc-mainnet/release/start.cjs --start`. It checks signer identity,
   deployment again, gas funding, disk space and a submission window of at least
   60 seconds at the observed block cadence, re-renders active config, and starts
   prebuilt images. Run it as the unprivileged owner of both release files and the
   key. It canonicalizes the key path and aligns backend/eRPC container UID/GID
   with that owner, preserving 0600 files on Linux. Database credentials are read
   by Compose from the private host env file. It neither builds nor pulls images
   implicitly; pull the pinned runtime images separately before the ceremony.
7. Publish the configured API hostname through the existing Cloudflare tunnel to
   `http://127.0.0.1:8442`. Only the API proxy has a host port. Verify
   `/api/v1/version`, an executable USDC/EURC quote, and that excess quote requests
   receive 429. Copy the four public `REACT_APP_ARC_*` values from the active
   `generated/frontend.env` to repository variables; keep `ARC_LOCAL=false`.
   The existing Cloudflare workflow now uses these values for both swap and explorer.
8. Publish frontend/explorer and perform one small live swap and one supported
   inbound Across bridge, checking deposit event, destination fill and final token
   balance. A local relayer fixture is not proof of a live bridge fill. Confirm the
   current direct venue using the bounded probe documented in `../LIQUIDITY.md`.

## Runtime and budget

One existing Ophis backend stack, Postgres, eRPC, a small credit gate and Nginx;
no Arc node, separate indexer service, new paid plan, or dRPC traffic. Direct
Uniswap V3 is the initial venue. Other implemented adapters remain optional;
LI.FI is not required. The protocol routes existing DEX liquidity.

USDC ERC20 orders use six decimals; native USDC gas uses eighteen and shares the
same balance. Native-sentinel orders, WUSDC wrapping and Balancer balance modes
are unavailable. Arc TWAP is hidden because its helper contracts are not deployed.
The supported bridge corridor is inbound USDC through Across's existing direct
SpokePool/CoWShed path, with executable source-chain checks. Arc is not advertised
as a bridge source. Across's legacy suggested-fees API is not actively maintained;
the existing direct deposit path remains documented, and unavailable routes fail
closed. No unvalidated `/swap/approval` calldata is executed. A requested slow fill
remains pending until an actual fill status arrives.

Free official and Blockdaemon RPC responses must agree for protected reads.
Only the official endpoint receives `eth_sendRawTransaction`, one attempt; it
never reaches QuickNode. Each public provider is capped at 120 requests/minute.
Public quote ingress is capped globally at six/minute with a burst of one; this
is deliberately a low-volume launch configuration, not a high-traffic SLA.

QuickNode receives transaction traces plus eRPC's bounded bootstrap/hourly header
probes. SQLite reserves credits **before** an upstream attempt: 1,000/minute,
40,000/day and the fixed total allowance. Timeouts remain charged. No retries or
redirects. Both compose projects share `ophis-arc-quicknode-credits`; retain and
back up this volume. Other consumers of the provider account remain outside this
ledger, so compare against provider totals. Exhaustion stops the paid lane.

The production event indexer starts at the verified settlement deployment block,
then resumes its database cursor. `skip-event-sync=false` is deliberate: enabling
it would skip settlements during a restart. No genesis scan is needed.

## Operations and rollback

Use `docker compose ... ps` and service logs for readiness/errors; API, driver,
autopilot and eRPC must all be healthy before enabling the frontend. Existing
backend `/metrics` endpoints stay private. Monitor failed quotes/settlements,
remaining native USDC, provider usage, SQLite `usage.total`, and disk space; no
RPC polling is needed to inspect credit usage. An API canary can reuse the existing
sovereign canary after its Arc URL is enabled.

Back up Postgres with `docker compose ... exec -T postgres pg_dump -U arc arc`
and retain the credit volume independently. Never use `down -v` to roll back.
Disable `REACT_APP_ARC_ENABLED` and redeploy frontend/explorer to hide Arc; stop
`autopilot driver uniswap-v3` to stop submitting. In a signing incident, the
2-of-3 Safe calls authenticator `removeSolver(solver)` immediately. Preserve the
orderbook/database so existing orders and histories remain inspectable. Contract
deployments cannot be undone; do not replace addresses without a new reviewed plan.
