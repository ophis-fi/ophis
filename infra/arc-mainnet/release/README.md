# Arc release package

The operator authorized the Arc mainnet launch on September 24. All seven
contracts are deployed and the 2-of-3 Safe has authorized the dedicated solver.
Both free RPCs passed `verify.cjs`; the solver holds 0.45005359 native USDC.
The backend and public API at `https://arc-mainnet.ophis.fi` are running, with a
simulation-verified USDC/EURC quote. Frontend publication and funded swap/bridge
validation remain pending. No remote merge or push was performed.
`plan`, `rehearse`, `render`, and `check` are preparation
commands, not deployment commands; do not regenerate this deployed release.

## Existing identities

### Prepared Mac mini launch — September 24

The selected runtime host is the existing Mac mini. Its isolated
`ophis-driver` account (UID 502) holds the canonical key; Colima runs as
the operator (UID 501). The actual ignored `config.json` and
`generated/plan.json` now use Arc's dedicated solver
`0x839029e110F4954e05aFad4Fa222CfE93ce6d86f`, the Safe and Ledger below,
and observed deployer nonce zero. Plan hash:
`0xf847a22abd920e48c88906ead95e39be4f5673433e378f0903cfe2289e01fcc0`.
The seven deployment transactions are confirmed, costing 0.162722960008136148
native USDC in total. Solver activation succeeded at block 22516917, transaction
`0xbad31b4a400b97db748807face9ede4ab4401a1a2c3081bfe08ef93f46135ca1`.
Do not resubmit the activation batch. Generated frontend/backend configuration
is active after successful runtime preparation and startup.

The operator confirmed successful import into `ophis-driver` on September 24.
The importer checks the planned address and owner-only runtime file permissions.
The assistant could not independently repeat that check: its noninteractive sudo
session still requires authentication. No private key was read or displayed.
For reference, the completed operator command was:

```sh
node /Users/scep/ophis-arc/infra/arc-mainnet/release/import-staged.cjs --import
```

Authenticate sudo locally. The command verifies the reviewed plan and address,
imports to `/Users/ophis-driver/.config/ophis-arc/submitter.key` with owner 502 and
mode 0600, and refuses to replace an existing key. It sends no transaction and
starts no service. No password or private key belongs in chat or shell arguments.
The operator explicitly selected an encrypted backup on this Mac mini. That
backup was created and restored successfully, including a signing/address check,
on September 24. Its password is stored separately in macOS Keychain. This is a
verified local backup, not off-site recovery; encrypted staging is retained.
See the [backup inventory](../../../docs/operations/submitter-pk-backup-runbook.md).

The prepared key supersedes the fresh-key example below: **do not generate a
second solver or overwrite this deployed plan**.
The original disk blocker is resolved: removing only this checkout's rebuildable
Rust intermediates recovered about 10 GiB, preserving all four native binaries.
The production backend and migrations images are now built as
`ophis-arc-backend:7f2f8b10f2e1` and `ophis-arc-migrations:7f2f8b10f2e1`.
The build used two Cargo jobs and a 3 GiB disk stop; it began with 14.3 GiB free.
All five backend binary help commands passed inside the image as UID 501 with
networking disabled; Flyway's offline version check also passed. Image IDs and
architecture are recorded in ignored `generated/production-images.json`.

Colima's operator-owned socket and virtiofs cannot directly use UID 502's private
key. As with OP, the Mac runtime therefore needs an owner-only RAM-backed copy:

```sh
node infra/arc-mainnet/release/mac-key.cjs --prepare
```

Run this as the Colima operator from the checkout root, authenticate sudo locally,
and set `ARC_SOLVER_KEY_FILE` to
`/Users/scep/.local/state/ophis/arc-ram-pk/submitter.key`. The helper binds the key to
the reviewed plan and verifies the exact mounted device against hdiutil's
`ram://` image record before writing. It excludes Spotlight indexing and checks
Colima can read the public mount markers before accessing the canonical key.
It retains the canonical UID 502 file.
Arc uses its own mount, separate from OP; it must be prepared again after reboot.
The operator account and Docker administrators can read the runtime copy. This
does not provide isolation from them. Startup rejects a missing RAM mount or a
regular disk substitute. Release files and backend containers stay owned by
the Colima operator (UID 501, GID 20). The operator prepared the actual RAM key;
startup independently matched its address to the authorized solver and started
the prebuilt stack. All 110 database migrations passed.
Rapid reuse of a detached RAM device exposed stale Colima mount caching during
testing. The production empty RAM mount initially failed the public marker probe.
A one-time `colima ssh -- sudo sh -c 'echo 2 > /proc/sys/vm/drop_caches'` cleared
reclaimable guest filesystem metadata; the same probe then passed. OP services
were not restarted. This was a diagnostic repair, not routine cache tuning.
Preparation/startup still stop if the Docker probe fails.
The opt-in reproduction is `node infra/arc-mainnet/release/test_mac_key_mount.cjs
--scratch`; it uses only a public dummy key and cleans up its own RAM volume.

### Reproducible preparation for a new installation

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

After the operator's update, both free Arc RPCs verified the Safe at
**2026-09-24 09:58 UTC**: all three configured owners (including the Ledger),
threshold **two**, no modules, and official SafeL2 1.5.0 runtime. Governance
preflight now passes. At **10:08 UTC**, both free RPCs confirmed the deployer was
funded with **0.3 native USDC**, pending nonce zero, and the Safe still passed.
The final launch must recheck these values.

The seven contract deployments used **8,136,136 gas** in the local rehearsal.
At the observed **20.1 gwei** this suggests approximately **0.163536 USDC**.
The reviewed per-contract limits preserve at least 20% gas headroom (checked by
the rehearsal), totaling **9,815,000 gas**. With the default **25 gwei** fee cap,
the seven planned deployments are capped at **0.245375 USDC**, within the funded
balance. The broadcaster stops before sending if the suggested gas price exceeds
the reviewed cap. Refresh the quote before the ceremony; solver gas and Safe
activation funding are separate. The runtime solver gas limit stays independent
of these tighter deployment limits.

Previously, at block **22379061**, both free Arc RPCs reported the supplied Safe
with **two owners and threshold one**. Its singleton
matches the [official pinned 1.5.0 artifact](https://github.com/safe-global/safe-deployments/blob/v1.37.50/src/assets/v1.5.0/safe_l2.json).
The original owners were `0x746Ad9C63cCA6d3A8588731d60Fb87deaB4da46A` and
`0x0494F503912C101Bfd76b88e4F5D8A33de284d1A`.
The operator confirmed retaining **2-of-3** on September 24. The unsigned
[safe-governance.json](safe-governance.json) is retained as the reviewed migration
artifact; **do not submit it again**. It contains one zero-value **Safe
self-call**: `addOwnerWithThreshold(0xBeC5B03ffDcac50071693E87bFDb88bAa6710199, 2)`.
This atomically adds the existing Ledger owner and requires two signatures,
preserving the two current owners. It must execute through the Safe, not as a
direct EOA transaction to `addOwnerWithThreshold`.

The original threshold allowed one existing owner to authorize the change;
subsequent transactions require two of the three owners. Re-run the launch
preflight to verify the resulting owner set and threshold. The exact
calldata passed a local real-Safe rehearsal from 1-of-2 to 2-of-3, including
duplicate-owner rejection and denial of single-owner authorization afterward.
No owner or threshold change has been broadcast to Arc by this local work.

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
node infra/arc-mainnet/release/test_plan.cjs
node infra/arc-mainnet/release/test_mac_key.cjs
node infra/arc-mainnet/release/rehearse.cjs
python3 infra/arc-mainnet/release/check.py
python3 infra/arc-mainnet/test_credit_gate.py
python3 infra/arc-mainnet/test_rpc.py --release
```

On a clean checkout, `check.py` generates preview identities without known signing
keys; these are not production identities. It preserves an existing prepared plan.
Use `node infra/arc-mainnet/release/plan.cjs infra/arc-mainnet/release/config.json`
only after completing the actual launch inputs.
Planning refuses an existing or partial release bundle. Preview checks and direct
rendering refuse deployed, verified or activated state; they cannot reset it.
The broadcaster validates the exact planned Safe activation calldata before use.

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

1. Recheck the completed 2-of-3 Safe configuration; do not repeat the owner-add
   transaction. Run the offline
   staged-key import above for this prepared Mac mini launch, and back up Arc's dedicated key.
   Confirm the Safe on Arc and native USDC gas
   for the existing Ledger and new Arc submitter.
   Refresh the deployer nonce and compare it with the prepared unsigned plan. Review all
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
4. Use the prepared backend/migrations Docker images above, or build them on a host with sufficient space
   (a fresh Rust build needs at least 12 GiB free). Set `ARC_RELEASE_TAG` to the
   reviewed revision, and export `ARC_RUNTIME_UID=$(id -u)` and
   `ARC_RUNTIME_GID=$(id -g)`; `docker compose -f infra/arc-mainnet/release/docker-compose.yml
   build`. Share the one backend image across services. A fresh build still needs
   a new disk-space check; cached outputs are not a reservation of space.
5. On the selected Mac mini, prepare the verified RAM copy using `mac-key.cjs`
   above and run Compose/startup as the Colima operator. On Linux, use the isolated
   signing account and its canonical key directly. Supply `ARC_SOLVER_KEY_FILE`
   pointing to the corresponding dedicated Arc file outside the repo, mode 0600.
   Set `ARC_QUICKNODE_RPC_URL` privately and reserve only the
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
Public quote ingress is capped globally at six/minute with a burst of five; the
initial fast/optimal quote pair, amount edit and slippage update can complete
without raising the sustained RPC budget. This
is deliberately a low-volume launch configuration, not a high-traffic SLA.
The driver explicitly uses the existing Web3 gas-price estimator and zero extra
tip. Alloy's default doubled base-fee estimate exceeded the reviewed 25 gwei cap
even at a 20.1 gwei network price. The cap and guarded signer are unchanged.
`eth_getBlockByNumber(latest)` is translated to the common served height before
quorum, avoiding a race between providers on Arc's 0.5-second blocks. The public
pollers still read raw latest every 30 seconds; advancing served heights and
actual conflicting-header rejection were checked. This does not add a hard
freshness guarantee during a poller outage.

The separate Arc Cloudflare tunnel is `f3eb4ae9-0d9c-43be-9a59-568e18824895`.
Its local configuration is `~/.cloudflared/config-ophis-arc-mainnet.yml`; launchd
label is `com.ophis.cloudflared.arc-mainnet`. It exposes only the localhost API
proxy at port 8442. The existing OP tunnel and services were not restarted.

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
