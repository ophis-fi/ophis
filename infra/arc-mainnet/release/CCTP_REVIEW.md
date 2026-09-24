# CCTP frontend differential review — 2026-09-24

## Executive summary

Scope: the new `/bridge` page, its Circle API and wallet calls, recovery state, and the header/build flag wiring, against local base `3d188833`.

| Open findings | Critical | High | Medium | Low |
|---|---:|---:|---:|---:|
| After the fixes and checks below | 0 | 0 | 0 | 0 |

**Recommendation:** suitable for frontend publication with the limitations below. A real funded mainnet bridge has NOT been executed as part of this review. Simulated browser success must not be presented as proof of a real cross-chain transfer.

This is an agent-performed review using Ethskills and the Trail of Bits differential-review methodology. It is **not an audit, certification, or approval by Trail of Bits or Pashov**. The installed Pashov Solidity audit workflow is not applicable to this diff: no Solidity, Ophis deployment, solver, signing key, or backend service changes are included. Circle's existing contracts remain external dependencies.

## What changed

- Direct, same-wallet native-USDC CCTP V2 transfers between Arc, Base, OP, Unichain, Ethereum, and Arbitrum. Standard finality (2000) and Circle forwarding; no swap solver or post-swap hook.
- Exact-amount approval, explicit fee review, source burn, attestation tracking, destination receipt verification, and manual claim fallback.
- Feature gate `REACT_APP_CCTP_ENABLED=true`, additionally requiring Arc's existing deployment gate. No Circle API key in the client or build environment.
- Reuses installed viem, Jotai, wallet providers and zod. zod 3.25.76 is now declared directly, installed from the existing offline store.
- One pending transfer per browser origin, retained before requesting a wallet signature. No new backend, indexer, relayer, RPC subscription, or contract deployment.

## Baseline and blast radius

The baseline has existing Across/NEAR swap-and-bridge routes and Arc trading. None of their route selection, allowance targets, signing domains, gas handling, or settlement code is modified. The new route is lazy loaded; its header flag lives in common constants so importing the header does not eagerly import the bridge page.

New financial entry points are `approveCctp`, `burnCctp`, and `claimCctp` in `apps/frontend/apps/cowswap-frontend/src/modules/cctp/cctpWallet.service.ts`. All are reached through the one bridge page. Shared edits add a route, header link, public build flag, and package declaration. No historical security guard was removed.

## Trust boundaries and invariants

1. **Wallet → transaction:** chain and active account are re-read before submission; the account, Circle spender, amount, route, zero native value and finality are encoded locally. The wallet remains responsible for the user's final confirmation. A source nonce is explicitly bound before signing.
2. **Circle fees → quote:** JSON is parsed, only Standard forwarding is accepted, integer USDC units are used, protocol basis-point fees round upward, and total fee must be smaller than the transfer. Quotes expire locally after 60 seconds and approval requires a fresh review.
3. **RPC → preflight:** chain ID, Circle `localDomain()`, USDC decimals and messenger code are checked. Funds and allowance are fresh. Simulation and a conservative native-gas budget precede every financial action. Arc's ERC-20 USDC uses six decimals; native gas balances use eighteen.
4. **Browser storage → recovery:** storage is schema checked without throwing on malformed numeric strings. The intent is saved and read back before the wallet request. Web Locks serialize burns across tabs; Jotai storage subscriptions synchronize other tabs. Missing/unavailable storage fails before signing.
5. **Uncertain wallet response:** only explicit EIP-1193 rejection clears a submitted intent. Transport failures and ambiguous rejection messages leave it locked. A returned hash is retained; a lost hash can be supplied from wallet activity. No automatic burn retry exists.
6. **Source receipt → attestation:** recovery requires exact calldata, owner, messenger, value and nonce. Success requires the expected MessageSent from Circle's transmitter. An unrelated or historical reverted transaction cannot unlock a new burn.
7. **Attestation → manual claim:** binary V2 message fields are bound to source/destination domains, messenger addresses, burn token, recipient, sender, amount, maximum fee, zero destination caller and forwarding hook. Executed fee cannot exceed the reviewed cap. Attestation encoding/finality are checked; Circle's contract verifies its cryptographic signatures during simulation/execution.
8. **Destination → completion:** an attestation alone is never completion. A successful destination receipt must contain the matching V2 MessageReceived nonce/body/sender/domain/finality and the recipient's expected USDC Transfer. Pending claims remain locked; reverted manual claims do not permanently hide a later successful Circle forward.
9. **Same address across chains:** smart-account code on either side blocks the initial burn. Equal Safe addresses across chains do not prove equal ownership. This initial release supports personal wallets without account code; delegated EIP-7702 accounts are conservatively excluded too.

RPC/HTTPS integrity, Circle's deployed contracts and attestation system, and the user's wallet are explicit trust assumptions. This review does not cryptographically authenticate public RPC responses or independently audit Circle's contracts.

## Findings corrected before publication

| Issue | Impact before fix | Fix and check |
|---|---|---|
| Numeric refinement ran after a failed string regex | Corrupt persisted data could crash recovery | Guard BigInt conversion; malformed storage regression |
| Case-sensitive byte comparisons | A valid mint could remain pending | Normalize both hex operands; valid/mismatched receipt checks |
| Arbitrary reverted recovery receipt | Could unlock a duplicate burn while an earlier transfer was uncertain | Bind calldata, account, value and explicit source nonce; unrelated and historical-nonce regressions |
| Broad rejection-message matching for the journal | Ambiguous transport failures could discard recovery intent | Only explicit rejection codes/classes clear it; interrupted-broadcast regression |
| Shared storage without tab notifications | Another tab could show stale recovery state | Standard Jotai JSON storage plus an origin-wide Web Lock and fresh shared-storage check |
| Status from an earlier transfer arriving late | Could display the wrong completion state | Bind returned status to the transfer and ignore cancelled requests; hook regression |
| Repeated claim while a destination hash was pending | Wasted gas on competing claims | Disable pending claim action and recheck status before submitting |
| Account or quote changed during preflight | Could submit stale user intent | Recheck account, chain and quote after asynchronous reads; wallet regressions |
| Source native USDC treated as ERC-20 units | Could fail to reserve Arc gas | Convert principal to 18-decimal native units only for Arc gas accounting; regression |

## Validation

- 14 unit/regression checks in four files: amount/fee arithmetic, ABI encoding, message substitution, source/destination receipt evidence, durable recovery, nonce matching, explicit rejection, unavailable storage/locks, account changes, stale quotes, smart accounts, Arc gas, exact approvals, hidden/offline polling, and stale responses.
- TypeScript application typecheck; scoped ESLint; `git diff --check`; production Nx/Vite build.
- Chromium desktop and WebKit mobile exercise the actual built page: wallet connection → exact approval → refreshed fee → burn → destination completion → reload/recovery. All wallet operations, Circle responses and RPC requests are intercepted and simulated. Exactly two simulated submissions (approval and burn), two requested fee quotes, zero external RPC calls, no uncaught page errors.
- Bounded read-only mainnet preflight: 24 free RPC calls across six chains. All chain IDs, domains, six-decimal USDC interfaces, and deployed TokenMessenger code matched. No QuickNode/dRPC requests.
- Public Iris fee checks: Base→Arc and Arc→Base return Standard forwarding fees. Arc→Base returned HTTP 200 and `Access-Control-Allow-Origin: *`.
- The Circle LIVE API key was not stored, transmitted, logged, added to configuration, or included in bundles.

Local release evidence is under `infra/arc-mainnet/release/generated/`: `cctp-preflight.json`, `cctp-arc-base-fees.json`, `cctp-browser-chromium.json`, `cctp-browser-webkit.json`, and `cctp-*.png`. The generated directory is ignored because it contains deployment-specific evidence.

## Reproduce

From `apps/frontend`:

```sh
pnpm exec jest --config apps/cowswap-frontend/jest.config.ts --runInBand --testPathPatterns=modules/cctp
pnpm exec eslint apps/cowswap-frontend/src/modules/cctp
NODE_OPTIONS=--max-old-space-size=6144 pnpm exec tsc --project apps/cowswap-frontend/tsconfig.app.json --noEmit --pretty false
```

After building with the verified public Arc deployment environment and `REACT_APP_CCTP_ENABLED=true`, from the repository root:

```sh
node infra/arc-mainnet/release/check-cctp-browser.cjs
node infra/arc-mainnet/release/check-cctp-browser.cjs --webkit
```

`--live` loads the published frontend assets while still simulating all wallet/chain/Circle traffic. It does not send funds.

## Limitations and operations

- No real mainnet burn/mint was signed. The first funded user transfer remains an operational verification step.
- Personal wallets only; no custom recipient, Fast transfers, EURC, wrapped assets or automatic swap-and-bridge composition. Add these only with separate route and ownership validation.
- Local quote expiry cannot invalidate an already-open wallet request. The on-chain maximum fee and recipient remain encoded; changing destination gas conditions may delay forwarding. Manual claim requires destination gas.
- Keep browser storage and source hash until delivery. Clearing browser data, changing browser origins, a cancelled/replaced source transaction, or an uncertain submission without a recoverable hash can require manual recovery. The UI deliberately does not offer a blind retry or discard button for unresolved burns.
- Public RPC outages pause progress and produce an error. No retries on the transport, no idle fee polling, no hidden/offline status polling, and no private paid RPC fallback. Polling is every 15 seconds only while the bridge page is visible and online.
- `REACT_APP_CCTP_ENABLED=false` hides new bridging. Preserve a prior enabled build and transaction details for recovery if rolling back; disabling a UI does not undo a burn.
- Existing unrelated build warnings about large chunks and wallet barrel cycles remain. Browser execution checks passed.

## Sources and methodology

Sources checked against current Circle documentation and read-only chain state on 2026-09-24:

- https://developers.circle.com/api-reference/keys — CCTP is permissionless and requires no API key; secret API keys are server-side only.
- https://developers.circle.com/api-reference/cctp
- https://developers.circle.com/cctp/concepts/supported-chains-and-domains
- https://developers.circle.com/cctp/references/contract-addresses
- https://developers.circle.com/stablecoins/usdc-contract-addresses
- https://developers.circle.com/cctp/howtos/transfer-usdc-with-forwarding-service
- https://github.com/circlefin/evm-cctp-contracts/blob/master/src/v2/MessageTransmitterV2.sol — V2 event ABI; do not substitute the legacy V1 event from mixed prose tables.

Review strategy: focused differential review of every new production bridge file and changed caller, with trust-boundary, adversarial state-transition and amount/decimal analysis. Ethskills frontend/security principles and the installed Trail of Bits differential-review methodology informed the checks. No external firm endorsement is implied.
