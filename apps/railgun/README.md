# Ophis private swaps

Private swaps run inside the existing Ophis swap page. The Public/Private control opens a fresh `/private-swap/` document, which embeds this separately built execution runtime at `/private/`. The standalone private-wallet subdomain remains withdrawn. The main-app entry is enabled only when `REACT_APP_PRIVATE_SWAP_ENABLED=true` is included in its build.

The local engine supports the following networks. Balances and transactions stay on their selected chain; this does not bridge assets.

| Network     | Chain ID | Private assets                     | Native deposit |
| ----------- | -------- | ---------------------------------- | -------------- |
| Ethereum    | 1        | WETH, USDC, USDT                   | ETH            |
| Arbitrum    | 42161    | WETH, USDC, USDT                   | ETH            |
| Polygon PoS | 137      | WPOL, native USDC, bridged USDT    | POL            |
| BNB Chain   | 56       | WBNB, Binance-pegged USDC and USDT | BNB            |

Railgun supplies privacy rather than DEX liquidity. This implementation quotes **Uniswap v3 only**: four fee tiers and direct or one-intermediate paths, up to 20 candidates per selected pair. Missing pools are skipped, not advertised as available liquidity. The best positive output wins, with gas as a tie-breaker. Other DEX adapters are not implemented. Public orderbook orders remain public; f(x) development remains paused.

Route discovery encodes all 20 candidates into one canonical Multicall3 `eth_call` at one block, reducing quote calls from 20 to 1. The aggregate shares a 30m gas ceiling; expensive paths can reduce coverage, so this selects the best successful quote within that budget. An aggregate RPC or decoding failure stops quoting rather than retrying 20 individual calls. Deployment readiness checks run networks sequentially to avoid simultaneous bursts against the shared vendor account.

The private Ophis fee is **10 bp (0.1%) of output**; the public SDK base stays at 1 bp. Railgun, pool, broadcaster and public deposit gas fees are separate. Existing installed Railgun SDK versions already support these four networks; this expansion requires no SDK release or new mainnet contract.

## Run locally

Use Node 22.18+ and pnpm. Fork scripts use Node's built-in TypeScript stripping. This package intentionally has its own lockfile and is excluded from the root workspace: its Railgun stack needs ethers 6 while the existing frontend still uses ethers 5. Installation scripts are disabled.

```sh
cd apps/railgun
pnpm install --ignore-workspace --frozen-lockfile --ignore-scripts
```

Start an Ethereum fork with Foundry's Anvil in another terminal. The RPC below is only an example read-only archive source; no real signed transaction is sent upstream by Anvil.

```sh
anvil --fork-url https://rpc.flashbots.net --fork-block-number 26239582 \
  --host 127.0.0.1 --port 8549 --chain-id 1
```

Prepare the fork once after starting or resetting Anvil:

```sh
node tests/prepare-fork.mjs
```

This guarded loopback-only script installs a test marker derived from Anvil's instance ID. Browser wallets can verify the marker with standard `eth_getCode`; MetaMask blocks `anvil_metadata`. Missing or different markers reject public-wallet funding. The application and production gateway never install the marker or expose `anvil_setCode`.

Create an untracked `.env.local`:

```dotenv
RAILGUN_RPC_URL=http://127.0.0.1:8549
VITE_RAILGUN_ENVIRONMENT=fork
VITE_RAILGUN_CHAIN_ID=1
```

```sh
pnpm dev
```

Open http://127.0.0.1:4319 with a **new dedicated test recovery phrase**. Connect only a test browser wallet pointing to this marked Anvil fork. The default fork build rejects mainnet broadcaster submissions and public wallets without the matching marker. Automatic development reloads are disabled so edits cannot interrupt proving; restart Vite after changing its configuration.

In explicit mainnet mode (`VITE_RAILGUN_ENVIRONMENT=mainnet`; legacy `ethereum` is also accepted), WalletConnect pairs a phone or desktop wallet using the public `VITE_WALLETCONNECT_PROJECT_ID`. The selected chain's same-origin RPC is used, telemetry is disabled, and pairing sessions are isolated per chain while preserving existing Ethereum storage. Browser wallets must match the selected chain. Public approvals and deposit signatures remain in the user's wallet. Native ETH/POL/BNB deposits wrap and shield through the pinned Railgun Relay Adapt in one transaction; private holdings use the wrapped token. ERC20 deposits and recovery use exact allowances, with USDT's required zero reset when needed. Keep native currency for public gas. Spending requires synchronized Spendable notes; pending deposits cannot pay fees.

Choose a network before unlocking. Switching networks locks and reloads the harness so chain-bound providers, quotes and public signers cannot leak across selections. The encrypted master wallet is shared intentionally, while pending journals and temporary-account namespaces are chain-specific. Legacy Ethereum journal storage remains readable. Select independent sell and receive tokens; changing either clears prepared quotes. Asset precision is chain-specific, including 18 decimals for BNB's pegged stablecoins.

WalletConnect is deliberately unavailable in fork builds: its read RPC is the dApp's RPC, while the remote wallet signs, so checking a local fork marker cannot establish the remote wallet's network. Use an injected test wallet for ordinary fork testing. The mainnet connector uses the same-origin RPC, disables SDK telemetry, and renders a local QR instead of loading the full AppKit modal and analytics. Cancelling rotates its public SDK storage prefix; a late approval is disconnected without touching a new pairing.

`pnpm build` produces `dist/`. `pnpm exec vite preview` serves that build at http://127.0.0.1:4320 with the same RPC proxy and security headers. Raw static files need equivalent hosting headers and a trusted RPC proxy; the manual deployment workflow supplies both.

The RPC-only gateway supports `/rpc` (Ethereum), `/rpc/42161`, `/rpc/137` and `/rpc/56`. Ethereum uses the existing protected Baal node transport. The other networks use server-only `RAILGUN_ARBITRUM_RPC_URL`, `RAILGUN_POLYGON_RPC_URL` and `RAILGUN_BNB_RPC_URL` secrets for pinned Validation Cloud endpoints. Execution calls, estimates, traces and broadcasts use that configured provider once; signed batches are never replayed to another provider automatically. Ordinary-read-only batches use the existing Ophis ZAN account first, with at most one Validation Cloud attempt after a transport/capacity failure. Without a Validation Cloud override, the existing authenticated/ZAN transport remains supported. Missing configuration returns 503; unsupported chains are rejected. Log filters accept only the selected Railgun proxy. No public endpoint is used as fallback. The gateway never serves a standalone wallet.

All three Validation Cloud keys share one persistent Durable Object meter: **40M CU per UTC calendar month combined**, leaving 10M of the account's 50M allowance for other usage and diagnostics; **60 logical requests/second sustained with burst 60 combined**, leaving room under the team's 120 requests/second limit. Each method in a JSON batch reserves its CU allocation before forwarding, including failed attempts. Published examples: `eth_call` 40 CU, `debug_traceCall` 80 CU, `eth_getLogs` 80 CU. Priority-fee queries reserve 80 CU conservatively because some chains omit their pricing; other undocumented methods stay off Validation Cloud. The meter stores only counts and dates, survives restarts/deployments and rejects requests before forwarding when exhausted. It does not read or control account usage by services outside this gateway; the reserve is not a guarantee against arbitrary external consumption. No subscription upgrade or paid overage is enabled. See `.dev.vars.example` and [RELEASE.md](./RELEASE.md).

Mainnet mode requires explicitly setting `VITE_RAILGUN_ENVIRONMENT=mainnet` and a trusted selected-network RPC supporting EIP-7702 `eth_call` and `debug_traceCall` with `callTracer`. Known Anvil/Hardhat endpoints are rejected in mainnet mode. That check cannot identify every possible private fork: the operator must select the correct endpoint. Fork and mainnet wallet databases are separate. A prior user-controlled Ethereum private swap completed through a real broadcaster. No funded private transaction on Arbitrum, Polygon or BNB Chain was performed for this revision, and the new 0.1% fee has only been exercised on local forks.

Before a mainnet deposit, the runtime requires a fresh compatible broadcaster offer for the asset. A private swap also requires an offer for its receive token before preparation. This avoids knowingly funding an asset with no current broadcaster path; advertisements can still expire. Polygon native USDC had no compatible offer during the final discovery check, so its funding and receive routes remain blocked until one becomes available. No asset address is silently replaced.

## What happens to a swap

1. The browser derives a dedicated Railgun wallet. The SDK encrypts its wallet and the application's pending transaction journals in IndexedDB; a salted PBKDF2 key is derived from the password in memory. The recovery phrase is essential if storage is lost. One tab holds the wallet's Web Lock.
2. Shielding uses the connected public wallet, an exact token allowance, and the existing Railgun proxy. The initial global history scan must finish before spending. Production PPOI checks remain enabled; newly shielded balances can be pending rather than spendable.
   Private quotes and balance refreshes also await the SDK's received-note POI refresh attempt and publish its resulting balance buckets. Some SDK network failures retain cached statuses, so completion does not certify remote freshness. Only Spendable funds can pay a private trade and its fee.
3. The browser quotes Uniswap and reads Railgun's actual shield/unshield fees. It selects a signed broadcaster quote supporting the configured network's canonical 7702 delegate. The displayed minimum private output accounts for Ophis and Railgun fees; the broadcaster fee is additional. Quotes and fee advertisements are checked again before submission.
   If the recommended gas-price ceiling exceeds the available fee budget, the quote caps the price per gas while preserving the entered trade amount and gas allocation. The current base fee plus priority fee must still fit. The displayed capped price is checked again before submission; a price increase can require a fresh quote. This does not guarantee broadcaster acceptance or future inclusion.
   “Max swap after fee” prepares an affordable amount from the spendable balance, reserving the final estimated broadcaster fee. If reducing the amount changes note selection or fees, it rebuilds and rechecks the quote with bounded retries. It fills the amount only after validation; proving and submission remain separate. It is not a search for a global mathematical maximum across changing gas/circuit costs.
   Max budgets 25% above the last fee that caused an insufficient-balance error before rebuilding the quote. This avoids setting a capped price almost exactly at the current base fee. The headroom can increase the committed broadcaster fee; it is not a promise of a refund. The final amount and fee remain within the original budget, including when the balance grows. A larger price increase can still require a new quote. Fixed-amount quotes do not reduce their trade amount to add this headroom.
   The normal quote button also uses this calculation when the entered amount equals the current full spendable balance and cannot cover its fee. It shows an adjustment notice and caps trade plus fee at the original input, even if the balance grows during preparation. Other fixed amounts retain their original meaning.
4. The proof unshields into a derived temporary account. Exact ERC20 and Permit2 allowances enable a single router call containing swap, 10 bp (0.1%) output-token fee to the existing Ophis fee recipient, and token sweeps. No allow-revert command bits are set inside that router call, so a reverted swap pays no Ophis fee. Allowances are revoked and input, output and any intermediate route tokens are reshielded to the original private wallet. This private-swap fee is independent of the SDK's public-swap base fee.
5. Before disclosing the signed batch to the RPC, the browser saves recovery metadata encrypted. Simulation traces that same execution. The outer receipt and the exact committed output note are checked; an outer successful receipt alone does not establish a successful private swap.

The public DEX swap, its amounts and Ophis fee remain visible. The route does not promise sandwich protection. The broadcaster pays public gas and receives the committed private fee. The trusted simulation RPC sees the user's IP and the signed executable batch; it could submit that batch. Do not point it at an arbitrary third-party provider when using real funds.

## Interrupted transactions

Pending swaps and withdrawals block another private spend until reconciled. The journal survives reloads. Recovery searches wallet history without filtering away older input notes, then checks actual receipts. A withdrawal checks its saved nullifiers, recipient, token and minimum output.

Before quoting a swap, synchronized SDK history and the public account nonce are checked to skip previously used temporary accounts, including accounts beyond the SDK's first 100. This cannot detect executable signatures held offchain after local journals are lost; do not use the same recovery phrase concurrently on multiple devices.

The public-gas withdrawal resume action reuses the **same proof**; those nullifiers cannot withdraw twice. It preserves recovery if a duplicate loses a race to the original submission. The originally committed broadcaster fee still applies, even when the user pays public resubmission gas.

Canceling a pending swap requires explicit acknowledgement of possible public leftovers and native currency in the temporary account for gas. Its derived signer sends a nonce-protected no-op execution; the record is cleared only after the execute nonce has advanced at the two-confirmation block, including when a prior execution already advanced it. This does not require an injected wallet to submit another account's type-4 authorization. Cancellation does not recover tokens. Old temporary accounts remain derivable by index. Scan and reshield leftovers, or explicitly retain their index when dismissing dust. Funding recovery or cancellation from a public wallet creates a public link. Native currency used for gas is not automatically reshielded. A cleanup failure retains the swap journal while any configured token remains, unless the user explicitly accepts leftovers.

## Checks

```sh
pnpm typecheck
pnpm test
RAILGUN_RPC_QUOTE_TEST=1 VITE_RAILGUN_CHAIN_ID=1 RAILGUN_RPC_URL=https://swap.ophis.fi/rpc pnpm exec vitest run src/routes.rpc.test.ts
RAILGUN_FORK_TEST=1 pnpm exec vitest run src/recipe.fork.test.ts src/cancel.fork.test.ts --no-file-parallelism
pnpm build
pnpm exec vite preview
node tests/browser-wallet.mjs
```

`pnpm test:walletconnect` tests real relay pairing, cancellation/retry, exact approval, shielding and account-change invalidation with a generated test signer funded **only on local Anvil**. It requires the Ethereum build served on loopback (default port 4322), the prepared loopback fork and the public project ID in `.env.local`. Its browser-only fixture directs reads to that fork and hides development-node metadata; it does not alter the application or test live PPOI/broadcaster acceptance. No user wallet, recovery phrase or real funds are used.

The router and cancellation fork suites accept any of the four selected chains with `VITE_RAILGUN_CHAIN_ID` and `RAILGUN_FORK_RPC_URL`; the chain ID, loopback address and `anvil_metadata` are checked before mutation. Set the same chain ID when preparing its fork marker. They revert snapshots; do not run concurrently against the same fork. The browser proof harness also accepts the selected network through its guarded fixture.

On 2026-10-28, all four isolated Anvil forks completed native shielding, a real Railgun proof, a private swap, confirmed private output and recovery-journal cleanup. Each recipient transfer matched exactly 10 bp of final output. All four selected gateway endpoints passed delegated-call and trace readiness checks. These tests use generated local wallets, a fork POI adapter and a local sponsor; they do not establish live PPOI delivery or broadcaster acceptance on the three added networks. See [MULTICHAIN-REVIEW.md](./MULTICHAIN-REVIEW.md) for review scope and limits.

See [VALIDATION.md](./VALIDATION.md) for the completed local checks and their limits.

The standalone package pins pnpm10.33.2 and requires Node22.18 or newer. `railgun-ci.yml` runs its frozen scripts-disabled install, unit/dependency regressions, both TypeScript checks and production build without production credentials. Fork and browser roundtrips remain separate local checks.

For the full shield → private proof → swap → reshield → withdrawal → account-recovery test, keep the dev server running and run:

```sh
RAILGUN_TEST_PROFILE=/absolute/path/to/dedicated-test-profile node tests/fork-browser.mjs
```

Use a fresh generated test profile with no private WETH, never a normal browser profile. The capped-budget case requires an exact starting balance. Initial history download can take several minutes and needs an archive-capable upstream. The fixture bounds the public indexer at the fork block, disables live PPOI **inside the guarded fork fixture only** because fork-only shields do not exist in the live service, and injects a local Anvil gas sponsor instead of a real broadcaster. It still generates actual Railgun proofs and executes the selected network's existing contracts. These fixtures are not imported by the application or included in `dist/`. A passing fork roundtrip does not verify live broadcaster acceptance or live PPOI timing.

With the local Wrangler gateway running, set `RAILGUN_TEST_RPC_GATEWAY=http://127.0.0.1:4321/rpc` on that same command to exercise SDK reads and signed execution simulations through the production gateway. Only Anvil's unlocked test-wallet and gas-sponsor calls bypass it. The complete gateway-backed roundtrip passed locally; the production method allowlist still rejects mining and admin calls.

## Debugging gas without adding live funds

The guarded fork harness uses Anvil test balances, real proofs and real contract execution. It checks both swap directions, committed private outputs, withdrawal and recovery. The browser roundtrip also shields 0.01 test ETH and swaps exactly 0.001 WETH into private USDC with a modeled 1e18 broadcaster fee rate. This case uses a funded test wallet; live affordability must be quoted separately. Test logs distinguish the SDK estimate, padded transaction gas limit and receipt gas consumed. `forkSwap` can model a nontrivial private fee rate, and `forkShieldETH` exercises the native deposit path on the fork. Balance assertions wait for asynchronous scans.

The capped-budget case first recreates exactly 0.001216490555332357 private WETH across two notes, then swaps 0.0005 WETH with modeled quote prices. It verifies private USDC output and the exact WETH remainder after the committed broadcaster fee. It retains the 3m gas floor, the largest SDK estimate and the SDK's 20% gas-limit margin; capped estimates round upward to 10,000 gas units to absorb calldata variation.

The fork uses its explicit POI adapter and local gas sponsor; it does not establish real broadcaster acceptance or live PPOI proofs. A lower configured floor must still pass the SDK's gas-escalation probes and the exact signed execution trace. Gas consumed from one successful transaction does not establish a universally safe limit.

## Dependencies and review

Pinned SDKs: wallet 11.2.0, engine 9.9.1, shared-models 8.2.1, Waku web client 10.0.1, ethers 6.14.3. The Waku client's published wallet peer range is `~11.1.0`; the explicit 11.2.0 compatibility exception must be assessed with runtime tests. Its npm archive contains no postinstall patch files; disabling `patch-package` does not omit a shipped patch.

The browser dependency graph contains legacy packages. Local patches backport the GraphQL mergeDeep prototype-key fix, peer-record signer binding, and Node legacy-WebSocket TLS validation; elliptic reuses Ophis's existing RFC6979 patch. Regression tests cover the GraphQL and peer-record fixes. A version-based `pnpm audit` still reports advisories on patched versions and unused Node-only paths. **The version-based dependency audit still has findings.** See `DEPENDENCIES.md` for scope; release assessment is limited to the inspected browser graph and documented backports.

Jev checks narrowly scoped source claims; its probability is not a security proof. Ponytail, ethskills, independent Codex review and a read-only Claude review informed the implementation. No new Solidity was written, so this change does not claim a Pashov/Verity smart-contract audit. Review notes and actual command results are kept locally outside the repository.

Primary references: [Railgun developer guide](https://docs.railgun.org/developer-guide), [cross-contract calls](https://docs.railgun.org/developer-guide/wallet/transactions/cross-contract-calls), [broadcasting](https://docs.railgun.org/developer-guide/wallet/broadcasters), [Railgun wallet SDK](https://github.com/Railgun-Community/wallet), [Universal Router commands](https://docs.uniswap.org/contracts/universal-router/technical-reference).
