# Ophis private wallet

This is a separate browser origin for Railgun keys, balances, shielding, direct Ethereum USDC/WETH swaps, withdrawals, and temporary-account recovery. The Ophis development footer links to it. A production link appears only when `REACT_APP_PRIVATE_WALLET_URL` explicitly contains an HTTPS URL. No new mainnet contract or Ophis SDK version is required. The last merged liquidity/deployment changes did not change `@ophis/sdk`'s API; its existing 0.4.5 release remains appropriate. Release preparation is tracked in draft PR #1594; public enablement follows the checks in [RELEASE.md](./RELEASE.md).

This does not make CoW orderbook orders private. The first private route uses the existing Uniswap Universal Router's v3 0.05% USDC/WETH pool. f(x) development remains paused.

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
```

```sh
pnpm dev
```

Open http://127.0.0.1:4319 with a **new dedicated test recovery phrase**. Connect only a test browser wallet pointing to this marked Anvil fork. The default fork build rejects mainnet broadcaster submissions and public wallets without the matching marker. Automatic development reloads are disabled so edits cannot interrupt proving; restart Vite after changing its configuration.

In Ethereum mode, **Connect with WalletConnect** pairs a phone or desktop wallet by QR code or connection link. Set the public `VITE_WALLETCONNECT_PROJECT_ID` to Ophis's existing Reown project ID before building. The deployment workflow uses the repository's existing `REACT_APP_WC_PROJECT_ID` variable. Keep public approval and shield transactions in your own wallet; never enter its recovery phrase here. Connection does not require an amount. After connecting, choose a deposit asset and amount, then use **Check shield amount**. ETH is the default and uses the existing Railgun Relay Adapt contract to wrap and shield in one wallet transaction, without token approval or a separate wrapping step. The SDK transaction must target the pinned Relay Adapt contract with exactly the requested ETH value. Private holdings from ETH deposits are WETH; swap and withdrawal token/amount inputs are separate. The private selector names the token to sell, with the opposite receive token displayed. It defaults to WETH and follows a confirmed deposit; changing tokens clears the amount and prepared quote so USDC units cannot be reused as WETH units. Keep public ETH for gas. USDC and WETH deposits retain their token balance and allowance checks; approval and shield recheck balances before sending. Editing the amount keeps the wallet connected and requires a fresh check. Connection errors appear next to the wallet controls. Private swap and withdrawal quotes start broadcaster discovery automatically and wait for a fresh compatible signed fee; the separate connection button is optional. Discovery progress and private errors remain next to the quote controls. Initialization and fee discovery each have a 45-second timeout; fee discovery keeps the existing 60-second safety margin and canonical 7702 delegate requirement. Account/network changes invalidate the public signer and approval controls. The same selected connection supports public-gas withdrawal resumption. WalletConnect forwards transaction requests through its SDK without a separate session-ping prerequisite, allowing the request to reach the wallet before it responds. Transaction requests themselves are not given an application timeout or retried automatically. Deposit preparation, wallet confirmation, submitted hash and receipt status stay beside the deposit controls, separately from balance scan updates. A confirmed shield releases the controls while private balances refresh in the background; an uncertain receipt retains its hash and warning and requires an explicit amount recheck.

WalletConnect is deliberately unavailable in fork builds: its read RPC is the dApp's RPC, while the remote wallet signs, so checking a local fork marker cannot establish the remote wallet's network. Use an injected test wallet for ordinary fork testing. The Ethereum connector uses the same-origin RPC, disables SDK telemetry, and renders a local QR instead of loading the full AppKit modal and analytics. Cancelling rotates its public SDK storage prefix; a late approval is disconnected without touching a new pairing.

`pnpm build` produces `dist/`. `pnpm exec vite preview` serves that build at http://127.0.0.1:4320 with the same RPC proxy and security headers. Raw static files need equivalent hosting headers and a trusted RPC proxy; the manual deployment workflow supplies both.

The prepared Cloudflare Worker serves those assets and a restricted `/rpc` endpoint. It defaults to disabled and was checked locally with Wrangler. See [RELEASE.md](./RELEASE.md) before enabling it.

Mainnet mode requires explicitly setting `VITE_RAILGUN_ENVIRONMENT=ethereum` and a trusted Ethereum RPC supporting EIP-7702 `eth_call` and `debug_traceCall` with `callTracer`. Known Anvil/Hardhat endpoints are rejected in mainnet mode. That check cannot identify every possible private fork: the operator must select the correct endpoint. Fork and mainnet wallet databases are separate. A user-controlled funded private swap has completed through a real broadcaster; final release and deployment checks remain separate.

## What happens to a swap

1. The browser derives a dedicated Railgun wallet. The SDK encrypts its wallet and the application's pending transaction journals in IndexedDB; a salted PBKDF2 key is derived from the password in memory. The recovery phrase is essential if storage is lost. One tab holds the wallet's Web Lock.
2. Shielding uses the connected public wallet, an exact token allowance, and the existing Railgun proxy. The initial global history scan must finish before spending. Production PPOI checks remain enabled; newly shielded balances can be pending rather than spendable.
   Private quotes and balance refreshes also await the SDK's received-note POI refresh attempt and publish its resulting balance buckets. Some SDK network failures retain cached statuses, so completion does not certify remote freshness. Only Spendable funds can pay a private trade and its fee.
3. The browser quotes Uniswap and reads Railgun's actual shield/unshield fees. It selects a signed broadcaster quote supporting the configured Ethereum 7702 delegate. The displayed minimum private output accounts for Ophis and Railgun fees; the broadcaster fee is additional. Quotes and fee advertisements are checked again before submission.
   If the recommended gas-price ceiling exceeds the available fee budget, the quote caps the price per gas while preserving the entered trade amount and gas allocation. The current base fee plus priority fee must still fit. The displayed capped price is checked again before submission; a price increase can require a fresh quote. This does not guarantee broadcaster acceptance or future inclusion.
   “Max swap after fee” prepares an affordable amount from the spendable balance, reserving the final estimated broadcaster fee. If reducing the amount changes note selection or fees, it rebuilds and rechecks the quote with bounded retries. It fills the amount only after validation; proving and submission remain separate. It is not a search for a global mathematical maximum across changing gas/circuit costs.
   Max budgets 25% above the last fee that caused an insufficient-balance error before rebuilding the quote. This avoids setting a capped price almost exactly at the current base fee. The headroom can increase the committed broadcaster fee; it is not a promise of a refund. The final amount and fee remain within the original budget, including when the balance grows. A larger price increase can still require a new quote. Fixed-amount quotes do not reduce their trade amount to add this headroom.
   The normal quote button also uses this calculation when the entered amount equals the current full spendable balance and cannot cover its fee. It shows an adjustment notice and caps trade plus fee at the original input, even if the balance grows during preparation. Other fixed amounts retain their original meaning.
4. The proof unshields into a derived temporary account. Exact ERC20 and Permit2 allowances enable a single router call containing swap, 1 bp output-token fee to the existing Ophis fee recipient, and token sweeps. No allow-revert command bits are set inside that router call, so a reverted swap pays no Ophis fee. Allowances are revoked and both supported tokens are reshielded to the original private wallet.
5. Before disclosing the signed batch to the RPC, the browser saves recovery metadata encrypted. Simulation traces that same execution. The outer receipt and the exact committed output note are checked; an outer successful receipt alone does not establish a successful private swap.

The public DEX swap, its amounts and Ophis fee remain visible. The route does not promise sandwich protection. The broadcaster pays public gas and receives the committed private fee. The trusted simulation RPC sees the user's IP and the signed executable batch; it could submit that batch. Do not point it at an arbitrary third-party provider when using real funds.

## Interrupted transactions

Pending swaps and withdrawals block another private spend until reconciled. The journal survives reloads. Recovery searches wallet history without filtering away older input notes, then checks actual receipts. A withdrawal checks its saved nullifiers, recipient, token and minimum output.

Before quoting a swap, synchronized SDK history and the public account nonce are checked to skip previously used temporary accounts, including accounts beyond the SDK's first 100. This cannot detect executable signatures held offchain after local journals are lost; do not use the same recovery phrase concurrently on multiple devices.

The public-gas withdrawal resume action reuses the **same proof**; those nullifiers cannot withdraw twice. It preserves recovery if a duplicate loses a race to the original submission. The originally committed broadcaster fee still applies, even when the user pays public resubmission gas.

Canceling a pending swap requires explicit acknowledgement of possible public leftovers and ETH in the temporary account for gas. Its derived signer sends a nonce-protected no-op execution; the record is cleared only after the execute nonce has advanced at the two-confirmation block, including when a prior execution already advanced it. This does not require an injected wallet to submit another account's type-4 authorization. Cancellation does not recover tokens. Old temporary accounts remain derivable by index. Scan and reshield leftovers, or explicitly retain their index when dismissing dust. Funding recovery or cancellation from a public wallet creates a public link. Native ETH used for gas is not automatically reshielded.

## Checks

```sh
pnpm typecheck
pnpm test
RAILGUN_FORK_TEST=1 pnpm exec vitest run src/recipe.fork.test.ts src/cancel.fork.test.ts --no-file-parallelism
pnpm build
pnpm exec vite preview
node tests/browser-wallet.mjs
```

`pnpm test:walletconnect` tests real relay pairing, cancellation/retry, exact approval, shielding and account-change invalidation with a generated test signer funded **only on local Anvil**. It requires the Ethereum build served on loopback (default port 4322), the prepared loopback fork and the public project ID in `.env.local`. Its browser-only fixture directs reads to that fork and hides development-node metadata; it does not alter the application or test live PPOI/broadcaster acceptance. No user wallet, recovery phrase or real funds are used.

The fork suites require a local Ethereum Anvil fork; they revert their snapshots. Do not run them concurrently with the browser roundtrip, which changes the same fork.

See [VALIDATION.md](./VALIDATION.md) for the completed local checks and their limits.

The standalone package pins pnpm10.33.2 and requires Node22.18 or newer. `railgun-ci.yml` runs its frozen scripts-disabled install, unit/dependency regressions, both TypeScript checks and production build without production credentials. Fork and browser roundtrips remain separate local checks.

For the full shield → private proof → swap → reshield → withdrawal → account-recovery test, keep the dev server running and run:

```sh
RAILGUN_TEST_PROFILE=/absolute/path/to/dedicated-test-profile node tests/fork-browser.mjs
```

Use a fresh generated test profile with no private WETH, never a normal browser profile. The capped-budget case requires an exact starting balance. Initial history download can take several minutes and needs an archive-capable upstream. The fixture bounds the public indexer at the fork block, disables live PPOI **inside the guarded fork fixture only** because fork-only shields do not exist in the live service, and injects a local Anvil gas sponsor instead of a real broadcaster. It still generates actual Railgun proofs and executes the existing Ethereum contracts. These fixtures are not imported by the application or included in `dist/`. A passing fork roundtrip does not verify live broadcaster acceptance or live PPOI timing.

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
