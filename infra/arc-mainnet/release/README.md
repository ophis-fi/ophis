# Arc release package — local preparation only

Nothing in this branch has been merged or deployed publicly. `plan`, `rehearse`,
`render`, and `check` do not send public transactions. `broadcast.cjs --broadcast
--ledger` and `start.cjs --start` are separate, explicit operator actions for the
later authorized launch. Do not run them as part of local development.

## Existing identities

`config.example.json` uses the operator-supplied Arc Safe
`0x858f0F5eE954846D47155F5203c04aF1819eCeF8`, existing Ledger deployer
`0xBeC5B03ffDcac50071693E87bFDb88bAa6710199`, and the three owners recorded in
`infra/shared/cron/safe-drift-check.sh.tmpl`. The solver is deliberately unset:
Arc follows the existing **new submitter EOA per chain** pattern, documented in
[Unichain prerequisites](../../unichain-mainnet/README.md) and
[Robinhood deployment inputs](../../robinhood-mainnet/deploy/README.md).
All solver lanes on one chain share that chain's submitter. This is a signing
account, not another node or a separate liquidity provider.

The current tracked runtime configurations record OP's `0x92B9bE5e96795E8630fDC61efb0e705E75b1A1B1`,
Robinhood's `0x95f0beaB29BeA3D18A7c81140AED9227Ff2D7665`, and Unichain's
`0xB6537cFd4f574b339a6b145Db64EcC92af3ebdf2`. These are repository evidence, not
fresh onchain observations. The previously copied `0x7A956C269a12f1B897367663b536EB5dd29f3fBb`
came from stale deployment records. Commit `d3acec5c` documents how leaving that
old address in Unichain's autopilot after rotation caused solver rejection.
Do not reuse it as Arc's default.

The example nonce **0 is a placeholder**, not an observed Arc nonce. The offline
`solver.cjs` command requires an explicit nonce and derives `solver` from Arc's
dedicated key, writing ignored `config.json`. Prepare the Arc key on the runtime
host under the isolated signing account, following the existing
[custody and backup procedure](../../../docs/operations/submitter-pk-backup-runbook.md).
Use a separate Arc key path; never overwrite another chain's `submitter.key`.
Only its public address belongs in the plan. Planning rejects an unset solver;
startup derives the key's address and requires it to match the reviewed plan.
Predicted contract addresses are not deployment evidence.

Run the following on the runtime host as the unprivileged signing account, from
the checkout root. First set `ARC_DEPLOYER_NONCE` to the existing Ledger's observed
pending Arc nonce using the free official RPC. Confirm the public API/frontend
origins in the resulting configuration before planning.

```sh
mkdir -p -m 700 "$HOME/.config/ophis-arc"
export ARC_SOLVER_KEY_FILE="$HOME/.config/ophis-arc/submitter.key"
node infra/arc-mainnet/release/solver.cjs --nonce "${ARC_DEPLOYER_NONCE:?Set the observed pending nonce}" --create-solver
node infra/arc-mainnet/release/plan.cjs infra/arc-mainnet/release/config.json
```

This follows the existing file-backed hot-key custody: directory 0700, key 0600,
outside the checkout, and only the public address printed or stored in the plan.
Back up the key using the existing encrypted off-site procedure before funding.
It never overwrites a key or configuration. For an already provisioned **Arc** key,
omit `--create-solver`; do not point at another chain's key. If preparation stops
after creating the key, it retains that key for recovery rather than rotating it.
An existing `config.json` must be reviewed explicitly, not regenerated blindly.

The configured Safe must actually exist on Arc. The preflight verifies its
proxy dispatcher, pinned Safe/SafeL2 singleton bytecode (1.3.0, 1.4.1 or 1.5.0), exactly
the expected three owners, threshold two, and no enabled modules. If absent,
deploy the intended Safe configuration through the normal Safe ceremony first.

At block **22379061**, both free Arc RPCs reported the supplied Safe as deployed
SafeL2 1.5.0, with no modules, **two owners and threshold one**. Its singleton
matches the [official pinned 1.5.0 artifact](https://github.com/safe-global/safe-deployments/blob/v1.37.50/src/assets/v1.5.0/safe_l2.json).
The current owners are `0x746Ad9C63cCA6d3A8588731d60Fb87deaB4da46A` and
`0x0494F503912C101Bfd76b88e4F5D8A33de284d1A`; the Ledger owner is absent.
This does **not** satisfy the existing launch requirement of all three recorded
owners and threshold two. The address is configured, but launch remains blocked
on resolving that governance mismatch; no owner or threshold change was sent.

Initial Arc governance follows the direct Safe arrangement: proxy owner and
allowlist manager are the Safe from construction. OP's later timelock/guardian
migration is not silently assumed to exist on Arc. No deployer/online solver has
governance privileges; a Safe quorum adds or removes solvers and upgrades auth.

## Offline preparation and checks

Use the existing frontend dependencies, Foundry, solc-select 0.8.30, Python
with PyYAML (and tomli on Python <3.11), and Docker. Check disk before building:

```sh
python3 infra/arc-mainnet/local/build.py --check-only
node infra/arc-mainnet/release/test_solver.cjs
node infra/arc-mainnet/release/rehearse.cjs
python3 infra/arc-mainnet/release/check.py
python3 infra/arc-mainnet/test_credit_gate.py
python3 infra/arc-mainnet/test_rpc.py --release
```

On a clean checkout, `check.py` generates preview identities without known signing
keys; these are not production identities. It preserves an existing prepared plan.
Use `node infra/arc-mainnet/release/plan.cjs infra/arc-mainnet/release/config.json`
only after completing the actual launch inputs.

The rehearsal creates a disposable solver through the production preparation path,
funds it only on local Anvil, and removes its temporary key on completion. It owns
a fresh non-forked Anvil on `127.0.0.1:31559`, deploys the actual
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

1. Run the offline submitter preparation above and back up Arc's dedicated key.
   Confirm the Safe on Arc and native USDC gas
   for the existing Ledger and new Arc submitter.
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
5. Supply `ARC_SOLVER_KEY_FILE` pointing to the dedicated Arc private key file outside
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
