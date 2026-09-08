# Public Ethereum OTC desk

Public mode lets users connect their own standard Ethereum account wallets (EOAs) that already have at least one confirmed outgoing Ethereum transaction, select WETH, USDC or DAI, choose both exact amounts, approve only the required amount, then create or fill an order. Makers can cancel their active orders. No wallet registration, operator-assigned pair cap or trial expiry applies. Safe, other contract wallets, delegated accounts with code, native ETH and wallet batching are not supported in this release.

The existing immutable escrow supports open, full-fill orders. Anyone may fill an active order; there is no private counterparty or automatic order expiry. A fill transaction has a short execution deadline, which does not expire the order. Orders remain active until filled or cancelled, and pending fills can race cancellations. The UI discloses these terms before signing.

## Operation

The production build explicitly selects `REACT_APP_OTC_WRITE_MODE=public`. The compiled write default stays false; the same-origin runtime control is required before preflight and immediately before a wallet prompt. To activate, run `gh workflow run otc-runtime-control.yml --ref main -f mode=public`. To stop new prompts, run the same workflow with `-f mode=off` and verify success. Public service stays enabled until stopped; timed `on` trials still require an expiry within 24 hours. See [runtime control](otc-runtime-control.md) for credential rotation and verification.

A control or Ethereum verification failure blocks new signing. Shutdown preserves submitted-transaction and recovery tracking. A prompt already issued or a signed transaction cannot be recalled by the switch; the immutable contract has no Ophis pause function. Order cancellation and allowance revocation through the interface also require runtime permission.

Both token legs retain the reviewed token policy. Contract identity, exact order terms and allowance are checked on Ethereum, the exact request is simulated, and the connected wallet's chain, head, account and pending nonce are verified before signing. The application persists an exact-intent proof before the prompt and reconciles confirmations using an independent reader. Do not edit the supplied nonce or sign competing transactions while a submission is pending.

A missing wallet response or uncertain receipt stays locked. Use the wallet activity hash in the recovery field; only a verified matching transaction or identical repricing resolves the attempt. A rejection error code alone cannot establish that no transaction was broadcast. Do not clear browser storage or repeat an uncertain create from another browser/device. Tabs on the same origin coordinate through browser storage and native Web Locks; this does not coordinate independent clients.

## Release verification

Run the existing ERC-20 lifecycle and runtime-shutdown browser scenarios with `OTC_PUBLIC_REHEARSAL=true` against local Anvil and an independent reader configured for that fork. Keep Anvil mining current-time blocks so the canonical freshness guard remains meaningful. Keep the trial policy empty; mock only runtime control and unrelated host token lists, never OTC RPC results. Check the English interface and compiled Spanish/Russian catalogs (locale selection follows the existing global internationalization flag) and verify supported-token, maker-only cancellation, proof/replacement and shutdown tests.

After deployment, verify signed asset provenance, public create/browse/detail rendering, unauthenticated control rejection, and shutdown in existing and fresh tabs. Enable public service only after these checks pass. Production activation verifies control delivery and the user interface; local fork tests are the funded transaction evidence. No funded mainnet transaction is required for deployment.
