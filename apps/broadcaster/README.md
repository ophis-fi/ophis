# Ophis private broadcaster

**Multichain development, 5 November 2026:** this branch extends transaction validation, fee pricing, guard attestation, journals, recovery and monitoring to Arbitrum, BNB Chain and Polygon. Their live signing remains disabled in source pending qualified private delivery, deployment and acceptance. These changes do not modify the running Ethereum installation. Base is excluded until the owner gives a separate go-ahead.

| Chain | ID | Native gas / wrapped fee token | Live release gate |
| --- | --- | --- | --- |
| Ethereum | 1 | ETH / WETH | Preserve the existing operator, guard, journals and approved limits. |
| Arbitrum | 42161 | ETH / WETH | A reviewed private route with revert filtering; the ordinary sequencer alone does not establish that policy. |
| BNB Chain | 56 | BNB / WBNB | Private route qualification and live type-4 acceptance, followed by funded operator/guard checks. |
| Polygon | 137 | POL / WPOL | Provisioned private-provider access, followed by funded operator/guard checks. |

Every new chain also requires its own approved financial limits and native gas reserve, deployed operator-bound guard, exact fee-receipt verification, the requested security reviews and independent Codex approval before merge/deployment. A local fork or simulation does not satisfy live private-delivery acceptance.

One process serves one immutable `OPHIS_BROADCASTER_CHAIN_ID`. Use separate Compose projects (`ophis-broadcaster`, `ophis-broadcaster-42161`, `ophis-broadcaster-56`, `ophis-broadcaster-137`), installation/state directories, encrypted operator files and nwaku relays. Set `COMPOSE_PROJECT_NAME` in each private `compose.env` and a distinct loopback `OPHIS_WAKU_REST_PORT`; never share a Waku REST cache. Changing a populated journal's chain or operator is rejected. Only verified legacy Ethereum journals can acquire a missing binding.

The owner unlock client defaults to the existing Ethereum installation. For another prepared installation, set `OPHIS_BROADCASTER_CHAIN_ID` when running it. This selects only the four fixed installation/container names; it cannot select Base or an arbitrary remote path. Unlocking never enables signing.

BNB common withdrawals use legacy pricing and a positive network gas-price floor even when the base fee is absent or zero. Arbitrum estimates already include their L1 component; it is not charged twice. Non-Ethereum nonce release and receipt settlement require the node's finalized boundary; the single-sender service remains unavailable while that boundary catches up. Canonical block hashes are checked before receipt accounting on all chains. Non-Ethereum cancellations estimate and pad gas instead of assuming 21,000.

Non-Ethereum oracle addresses, descriptions, precision and published heartbeats are pinned; Arbitrum additionally checks its sequencer and recovery grace. BNB stablecoin precision is 18 decimals. Underlying-asset USD feeds do not establish redemption value for bridged assets. All fees round upward and must cover the full signed gas ceiling plus the configured positive margin. Revert filtering is a provider policy, not a guarantee that Ophis can never lose gas.

Waku cache capacity is bounded to 16 messages so maximum-sized batches fit the 16 MiB response limit. Every valid message in a bounded returned batch is processed; a sticky saturation warning reaches health/metrics. GET still clears the relay cache before admission, so unadmitted messages can require client retry. Monitoring and accounting include chain/operator identity; Prometheus samples carry `chain_id`.

The dated pilot notes below record the earlier Ethereum rollout. The multichain gates above govern this branch.

**Current checkpoint, 4 November 2026:** the restricted Ethereum swap and USDC withdrawal succeeded on 3 November, with exact private fee receipts verified. The guard is deployed and the approved pilot margin is 15%. General production admission and public frontend activation remain pending. The integration branch includes current Ophis security changes and repairs the broadcaster's independent dependency tree; this does not upgrade the running pilot automatically. See [dependency scope](DEPENDENCIES.md) and [validation](VALIDATION.md).

Stage 3 adds repeated-user admission, locally verified with two real-proof swaps and four withdrawals across WETH, USDC and USDT. `OPHIS_BROADCASTER_ADMISSION` defaults to `pilot`. Explicit `public` admission is available for isolated fork validation; enabled public mainnet startup is held in source until final release acceptance. Public settings cannot contain either pilot restriction. The existing live pilot is unchanged.

The restricted withdrawal pilot supports one USDC withdrawal to the explicitly configured `OPHIS_BROADCASTER_PILOT_WITHDRAWAL_RECIPIENT`. It remains disabled when that setting is absent. The fee and withdrawal must share one normal RAILGUN proof, and the private USDC fee must cover the validated maximum signed gas cost plus the configured margin. The one-time authorization is journaled atomically before disclosure and survives restart. Normal withdrawals use the canonical privacy contract and the existing protected transport; the execution guard applies to type-4 swaps. Exact per-request limits, reserve checks and the rolling daily budget remain enforced. Availability can advertise the remaining daily capacity; signing still checks the full cost of each request.

For common withdrawals, `minGasPrice` is a floor. The operator uses at least the request/proof minimum and the current base fee plus a positive tip, checks the gas-price cap, and validates the existing private fee against the resulting full signed gas budget before signing. This preserves the original proof and payment; insufficient coverage is rejected without spending gas.

**PPOI policy, 2 November 2026:** at the owner’s instruction, Ophis no longer requires PPOI list verification or its standby period. The wallet and broadcaster use the same SDK policy. Confirmed unspent notes become available after history synchronization; fee advertisements require no PPOI lists. Ordinary zero-knowledge transaction proofs, fee recipient/amount/commitment checks, exact EVM simulation, the operator-bound guard, gas limits and private-only submission remain mandatory. Fee delivery is verified against the exact received note and transaction after confirmation. Other wallets may enforce PPOI and treat the same funds differently. The public release hold and single-account pilot scope remain in force. Historical PPOI validation below describes the earlier configuration.

Local implementation of the Railgun 8.x broadcaster wire protocol for Ethereum V2, including canonical nonce-aware EIP-7702 swaps and direct privacy-contract withdrawals. It accepts encrypted Waku requests, verifies fee ownership and commitment binding, simulates the exact private batch, signs with a dedicated gas wallet, and submits exclusively through the existing Flashbots transport. It never needs a user's wallet keys.

**Custody installation, 2 November 2026:** encrypted local signing and manual off-server unlock were installed on Baal before pilot funding. The owner's Ambire + Ledger treasury/refill address is `0x58707c6C1E111c21cba4C9C8caE144175F84EceE`. The separate gas account is `0x65C3f921DB6f0e431C28EcbECFA7687fbD68f2a8`; preserve this now-funded pilot identity and its journals. The old gas account is retired. Live keys are encrypted at rest using the existing backup certificate; the recovery private key remains off-server. The running fee wallet is view-only and its receiving identity is preserved. See [operations](OPERATIONS.md#custody-migration) and the [validation record](VALIDATION.md).

The selected payment flow follows RAILGUN: the operator fronts native gas and receives a quoted private token fee inside the transaction. No separate user gas account or prepayment step is selected. Successful execution must pay at least the maximum signed gas cost plus an explicitly positive markup, rounded up to a fee-token base unit. The restricted pilot uses the approved 15% minimum markup and has confirmed private inclusion and exact fee receipt. General release still needs its remaining acceptance checks; an included outer revert can still leave the operator paying gas without receiving its fee. Guard, financial limits and pilot-account checks remain required after custody migration.

The user's release priorities, in order, are:

1. Security of user funds, authorizations and privacy.
2. Avoid wasting Ophis money on user attempts.
3. User payment covers consumed gas whether the swap succeeds or fails.

**No additional paid services.** The owner explicitly rejects paid signing, RPC and hosting services. Use the existing Baal server/read node and Ambire + Ledger treasury; AWS/KMS is withdrawn from the plan and is not a launch dependency. The installed software gas wallet requires manual unlock after restart and manual treasury refills. Its unlocked key remains exposed to a compromised host; application gas limits cannot protect that balance against host compromise. Ethereum transaction gas still has to be funded and, under the selected payment model, is covered by user fees when execution delivers the fee.

The user directed Ophis to follow RAILGUN's broadcaster payment model after stating these priorities. Preserve its packaged private fee, validate fee ownership, coverage and commitment binding before signing, and retain Ophis's guard, private-only transport, budgets and durable recovery. A checked fee is not an independently settled payment. Do not claim that following RAILGUN makes every included failed transaction user-paid, silently add prepaid custody, or treat this UX direction as authorization to fund production. The user must approve fee limits; paid retries and replacements remain bounded.

The [payment-model comparison](../../docs/development/specs/2026-10-31-broadcaster-gas-funding.md) records the verified upstream flow, its failure limits and the remaining release checks. It supersedes the proposed separate gas allowance without enabling mainnet.

The Baal deployment uses an encrypted gas key and a view-only private fee wallet, with private persistent state, encrypted backups and resource limits. The original secrets record is preserved in an encrypted retired archive; its plaintext file has been removed. Its old SDK database records remain encrypted under a retired key that is absent from the runtime unlock payload. This does not erase earlier copies or turn a historically hot spending seed into a seed that was never on the server. The restricted pilot deployed the guard and confirmed a swap and withdrawal. The public frontend's protected-operator allowlist remains empty pending the production release. Arbitrum, Polygon and BNB require separate protected submission infrastructure; this Ethereum service does not protect those networks.

## Local commands

Use Node 22.18+ and the integrity-pinned pnpm 10.34.9 declared in `package.json`. This application has its own lockfile; always pass `--ignore-workspace` for dependency installation/auditing. Its standalone `.npmrc` disables lifecycle scripts and applies the same seven-day resolution age as Ophis. Frozen installs do not recheck the age of existing lockfile entries.

```sh
cd apps/broadcaster
pnpm --ignore-workspace install --frozen-lockfile
pnpm build
pnpm test
node dist/main.mjs check
```

`check` uses Baal's read node to verify network freshness and Chainlink ETH/USDC/USDT prices. No CoinGecko or metered third-party RPC is used. Prices are cached for 30 seconds with one in-flight refresh, ENS feed resolution is cached, SDK polling is 15 seconds, and fees are advertised every 30 seconds. Failures back off to 30 seconds.

Copy `.env.example` into a private environment file and load it locally, for example with Node's `--env-file`. `init` is restricted to disposable fork testing: it creates test gas-wallet and fee-wallet secrets in an exclusive 0600 file and prints only the public gas address. Mainnet `init` refuses to create secrets. Create production keys outside the broadcaster; never import the prototype server key into a Ledger or use validator credentials or a user's wallet.

```sh
OPHIS_BROADCASTER_MODE=fork OPHIS_BROADCASTER_RPC=http://127.0.0.1:8559 node --env-file=.env.local dist/main.mjs init
node --env-file=.env.local dist/main.mjs run    # unarmed; local health only
node --env-file=.env.local dist/main.mjs sync   # explicit read-only history sync
```

Mainnet starts locked and exposes no network unlock endpoint. From the owner's Mac run `node apps/broadcaster/dist/unlock-client.mjs unlock`. The client uses the existing private recovery key outside the repository, authenticates decryption before passing only runtime gas/viewing keys over SSH to a private container socket, and prints only an acknowledgment. Never place the recovery key, plaintext payload or unlock credentials on Baal. Unlocking does not change the enabled flag or gas budgets.

Health is available only at `127.0.0.1:4340/health`. `synchronized` means history scans completed; `ready` additionally requires signing enabled, spendable operator gas reserves, an unused confirmed nonce and an available rolling gas budget. The first full history sync takes time; the persistent LevelDB avoids downloading it again on restart. The process requires at least 6 GiB free before starting or accepting work.

## Limits and recovery

Every unresolved signed request or unverified fee now blocks new signing and fee availability, even after its outer nonce is confirmed. The journal repeats this check inside its reservation transaction. An included sponsored revert stays unassured and stops further spending for operator review. A confirmed explicit operator cancellation still resolves its nonce and records its actual cost. No resolution bypass, journal deletion or automatic paid retry is introduced.

Public withdrawals require a positive supported ERC20 amount, zero token sub-ID, a nonzero 160-bit recipient and an authenticated fee in the withdrawn token. The withdrawal and fee retain the existing single-proof requirement. Public mode preserves the historical pilot marker without consuming or resetting it; returning to pilot mode retains its used restriction. The Ethereum client quotes at least the current base fee plus one wei before committing the private withdrawal fee, matching the broadcaster's positive-tip floor. Existing saved proofs are unchanged.

Fork execution requires an explicit gas-price cap, maximum ETH cost per transaction, rolling 24-hour gas budget and minimum remaining ETH reserve. The reserve and daily budget must each cover at least the maximum transaction cost. These limits remain insufficient to enable mainnet sponsorship. Only one gas nonce may be pending, and its consumption must have two confirmations before the next request. Spendability proofs and all nested calls must pass; the trace must include the exact fee-bearing batch through the canonical proxy. User signatures, authorization/execution nonces, quote expiration, current base fee and gas reserves are checked before signing.

The application journals encrypted requests, signed raw transactions, maximum gas exposure and fee-assurance context before submission. The protected transport maintains a second durable nonce journal before private disclosure. An error or timeout preserves both records. Identical client retries return the stored encrypted response, without another signature. Fee assurance confirms the exact owned note and transaction hash under the selected PPOI-free policy.

Stop the service before these commands and keep `OPHIS_BROADCASTER_ENABLED=0`; the native exclusive lock prevents simultaneous service/recovery signers:

```sh
node --env-file=.env.local dist/main.mjs status
node --env-file=.env.local dist/main.mjs retry
node --env-file=.env.local dist/main.mjs cancel MAX_FEE_PER_GAS_WEI PRIORITY_FEE_WEI
```

Mainnet `retry` permits only an already journaled cancellation; original sponsored payloads cannot be resubmitted while general release remains held. `cancel` requires explicit higher fees within the configured limits, journals a zero-value 21,000-gas self-transfer with the same outer nonce, and submits it privately. This explicit operator recovery can cost gas; it is not a newly sponsored user attempt. Cancellation **does not revoke** the user's private authorization/proof or clear browser recovery state. If the original is mined instead, reconcile its actual receipt. Never delete an unresolved journal, raise limits automatically, or reuse the gas wallet elsewhere.

The read RPC is Baal. The sole write endpoint is `https://rpc.flashbots.net?hint=hash`, with no fast mode, calldata/log hints, redirects or public write fallback. A relay acknowledgment is not confirmation. Private submission reduces mempool exposure; builders still see transactions, and a hostile user can change a 7702 authority after simulation and cause a sponsored transaction to waste gas. Spending caps bound that operator risk; this backend cannot promise reimbursement or eliminate all MEV through off-chain validation alone.

## Fees and compatibility

Ophis private swaps retain their existing 10 bp (0.1%) frontend fee. The broadcaster quote is separate, payable privately in WETH, USDC or USDT. Added broadcaster rate markup defaults to zero. The client commits its conservative fee inside the private execution; this is not a separately received, secured gas credit. When execution pays the fee, differences between that quote and actual gas remain in the broadcaster fee wallet, following the existing SDK flow. No prepaid-credit ledger, automatic refund or public token liquidation is implemented.

Only the first private transaction's first owned, commitment-authenticated fee note counts toward reimbursement; this matches the SDK's available assurance context. Later batch transactions cannot make up an underpaid first fee note. Standard compatible clients can use the Waku service, within the same validation and spending limits. No new public HTTP transaction API or subdomain is required.

## Guarded execution prototype

The local candidate keeps the user's existing private swap and broadcaster fee in one type-4 transaction. `contracts/RailgunExecutionGuard.sol` adds a non-custodial outer call bound to the operator. It checks the account's exact EIP-7702 designation and the canonical delegate's code hash during execution, permits only nonce-aware `execute`, and requires exactly one execution-nonce increment. The verified canonical delegate calls the original private batch before its external swap calls. Clearing or replacing delegation therefore cannot turn the guarded transaction into a successful unpaid no-op.

The existing backend still authenticates the counted fee, authenticates the fee commitment, verifies user signatures and the exact private trace, and applies monetary limits. Only its final outer transaction is wrapped; the user's signed private batch, authorization and proof are retained. With `OPHIS_BROADCASTER_EXECUTION_GUARD` configured, the transport accepts type-4 publication only through that guard and checks its entire runtime bytecode, including operator/delegate bindings, against the reproducible artifact. Unpublished legacy originals can still be staged for cancellation but cannot be republished through a guard-configured sender.

This introduces no gas-credit screen, separate prepayment or external broadcaster dependency. It is not prepaid collateral: Ophis still pays the chain in ETH and collects its private fee during successful execution. **A reverted transaction still costs gas if a builder includes it.** Excluding those reverts relies on the private endpoint's inclusion policy; signed-byte disclosure, deep reorgs, live fee spendability and replenishment remain separate risks. General mainnet admission remains restricted. A passing local guard test does not change the approved pilot's financial limits or enable a public release.

The pinned compiler is Solidity 0.8.30 with Foundry's Prague EVM target. Compile and verify without adding an npm dependency:

```sh
pnpm build:guard   # regenerate the server-only artifact after contract changes
pnpm test:guard    # verify exact artifact reproduction, then unit/fuzz tests
```

The fork operator fixture deploys a fresh guard on its verified loopback fork. `pnpm test:fork` exercises the unchanged encrypted browser request, a real private proof, the guarded backend and the actual protected-sender implementation. Its fixed private write URL is intercepted only in this test and sent to the verified fork; the read shim rejects signed writes. The receipt must contain the authenticated fee commitment. The race probe models an authorized delegation clear after validation, observes the unguarded successful no-op spending test ETH without a fee, checks the guard's specific revert, restores the disposable fork and executes the honest guarded swap. It never publishes the failing guarded transaction or claims to test a real relay's exclusion policy. The live restricted pilot has verified fee delivery and protected inclusion; fee collection and general production acceptance still apply.

## Local verification and deployment files

Unit tests cover integer budgets, permissions, SDK encryption, real fee-note decryption, canonical 7702 signatures, exact private-call traces, concurrent duplicate requests, restart journals and bounded cancellation. To exercise a real local nwaku relay, set `OPHIS_TEST_WAKU` to its loopback REST URL when running tests; the integration test uses isolated cluster 0 only.

`pnpm test:fork` requires an Ethereum Anvil fork on `127.0.0.1:8559` and the existing Railgun Vite fork UI on `127.0.0.1:4357`; `OPHIS_TEST_FORK_RPC` and `OPHIS_TEST_BROWSER_ORIGIN` select other loopback ports. It creates two fresh wallets, shields test ETH, swaps into USDC/USDT and withdraws both those tokens and WETH. The actual protected sender and both journals are exercised, including a request-journal reopen, duplicate replies, consumed-spend re-encryption, underpayment and the delegation-change comparator. The final ledger checks decoded fees against the full signed gas budget plus 15%, and native expenditure against confirmed receipts.

A fresh test wallet uses its creation block; the public commitment tree still synchronizes in full. The harness bounds memory/cache/disk usage. `OPHIS_TEST_PROFILE` must match the exact Anvil instance; only its public indexer cache is reused, with new wallet subprofiles each run. The fixture freezes an initially verified oracle snapshot and models a low fork base fee and zero-tip read suggestion. Fee assurance checks authenticated confirmed commitments, with `fullWalletHistoryAssurance=false`: it does not substitute for a full operator history scan or live builder acceptance. The shared PPOI-free policy retains ordinary proofs and fee authentication. Real Waku delivery, hosted UX, fee collection and final production acceptance remain separate checks.

`waku.compose.yml` pins nwaku 0.38.1 by digest, subscribes to the installed client's Railgun cluster 5/shard 1, and binds REST to localhost. The deployed `compose.yml` runs the broadcaster without root or capabilities, with a read-only image, private state mount, native health check, 1.5 CPU limit and 3 GiB memory ceiling. Waku brings the total below 2 CPUs and 4 GiB. State lives on Baal's root SSD, separate from Ethereum's data disk; no validator mounts or keys are exposed. `ophis-broadcaster.service` remains an alternative, undeployed systemd unit.

Fresh installations start with `OPHIS_BROADCASTER_ENABLED=0`. The restricted pilot already has an approved funded signer, deployed guard and verified fee receipts; preserve their identity, financial limits and journals. Retired funding/deployment packets remain withdrawn. Following the reference does not make included reverts user-paid. Complete the remaining production acceptance checks before publishing the fee-wallet identity into the protected allowlist with a review expiry. Replenishment and fee collection remain explicit operator actions.

## Dependency scope

`broadcaster-ci.yml` runs the standalone frozen install, the actual Node dependency regressions, guard artifact/unit/fuzz checks, application tests, build, Docker-context canary test and production-image smoke test without production credentials. The security workflow scans both standalone lockfiles, with dated exceptions constrained to each project's exact patched versions. Dependabot watches the standalone broadcaster lockfile and Docker base image. Details and remaining advisory dispositions are in [DEPENDENCIES.md](DEPENDENCIES.md).

The pinned SDK versions match Ophis's existing private client. Existing TLS-validation, prototype-pollution and elliptic patches are reused. The unused `circomlibjs > web3` dependency is removed: its published runtime imports only `web3-utils`; Web3 is used solely by upstream contract tests. This removes the old Swarm/request/tar dependency tree instead of changing cryptographic code. Underscore receives a compatible security update. Remaining version-based audit findings and their runtime reachability are recorded with release review evidence; an audit command is not a proof of safety.
