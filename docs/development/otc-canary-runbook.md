# Restricted ERC-20 OTC canary

Status: runtime activation infrastructure, 2026-09-08. No wallet or pair is admitted by the checked-in policy. Live trading requires the operator-supplied admission policy and expiry; provisioning and control rehearsals do not sign mainnet transactions.

Canary signing uses the same-origin `/api/otc-control` endpoint backed by private R2, independently of LaunchDarkly. The production build selects canary mode. Follow the [runtime control procedure](otc-runtime-control.md) to initialize, verify, enable or stop it. Keep the compiled write default false.

## Activation record — complete in the separately approved release

| Required field | Value |
|---|---|
| Final reviewed commit and deployment | Pending |
| Owner's explicit mainnet-write approval | Pending |
| Live flag provider and production build wiring | Private R2 control and canary build mode; verify the deployed endpoint before activation |
| Witnessed flag-off, provider-failure and existing/fresh-tab tests | Pending; activation blocked until demonstrated |
| Frontend/QA and final security/manifest approvals | Pending; see expanded audit limitations |
| Admitted wallet addresses (checksum), responsible operator | Pending; no test wallets |
| Token pair addresses and each leg's maximum, in raw units and display units | Pending; approved ERC-20 policy only |
| UTC trading expiry and its Unix seconds | Pending |
| Operator's total exposure budget and reconciliation cadence | Pending; UI does not enforce aggregate exposure |
| Monitoring owner, observation window, incident contact | Pending |
| Previous read-only release SHA/deployment and rollback operator | Pending |
| Rollback rehearsal evidence on the release candidate | Pending |

Populate `ophis/otcWrite/otcCanary.const.ts` with the approved live wallets, token pairs, per-leg limits and expiry in a reviewed release. The read flag and nonce-bound runtime permission must both be literal `true`. Keep the runtime control off while deploying/verifying that policy. The local write override and compiled write default cannot enable canary mode. Before live trading, verify control shutdown and provider-failure behavior in existing and fresh tabs. Control-only on/off rehearsals may run with the empty policy; never admit public test wallets in production.

Verify the immutable Ethereum manifest independently against the exact reviewed commit. The existing `scripts/otc-mainnet-canary.mjs --self-test` checks manifest drift; its no-argument mode checks live identity and index reconciliation using public read-only endpoints. The deployed contract cannot be paused or upgraded by Ophis. No contract deployment is involved.

## Scope of the controls

- Wallet admission, both token legs, positive raw-unit caps and expiry are checked before new approval/create/fill exposure. The policy is rechecked after simulation and by the adapter immediately before requesting a signature. Cancellation and zero-approval revocation remain available to admitted wallets after expiry or pair removal, subject to the global write gate and existing token policy.
- Limits constrain each action through this UI. They do not constrain the immutable contract, direct contract calls, existing orders, repeat intentional orders, or total exposure. There is no price oracle or USD risk cap. Expiry closes UI trading; it does not expire existing escrow orders or wallet prompts already issued.
- Wallet block identity is compared with the independent Ophis Ethereum reader. Settlement reads, allowance, simulation, transaction identity and receipts all come from that independent reader. Matching block identity is an RPC cross-check, not a cryptographic proof of every RPC response. Fork mode remains separately bound to its stable node instance ID.
- Mainnet locks share the `ethereum-mainnet` domain across wallet transports. A missing receipt or unresolved replacement keeps the lock. Identical repricing may confirm; an arbitrary replacement never becomes permission to retry the original intent. Recovered success finishes the displayed action; reload and review fresh order/allowance state to continue, including after recovered approvals.
- Before signing, require agreement between wallet and canonical pending nonces and recheck wall-clock expiry. Immediately before the signer call, persist a unique attempt ID and the reviewed sender/target/calldata/value fingerprint with the exact canonical pending nonce sent to the wallet. Receipt reconciliation requires that exact nonce and fingerprint, including for a hash supplied from wallet activity. A missing, unrelated or older transaction never clears the lock. A stale tab cannot clear a newer attempt, even when both lack a hash.
- A lost wallet response, malformed hash or provider error (including code 4001) after the prompt boundary leaves a durable hashless marker. If wallet activity provides a mined hash, use the in-app verification field. Otherwise leave the action locked; do not clear browser storage or repeat the create. The interface cannot authenticate a rejection solely from an error code.
- Use a trusted wallet that honors the supplied nonce. Do not edit its nonce or submit competing transactions through another client during the canary. The application cannot constrain transactions independently signed by the wallet owner.
- Browser storage v1 mirrors known hashes into v0 and rereads both keys under the shared Web Lock. New legacy hashes supersede stale known v1 hashes, while nullable v1 records survive legacy writes. Valid legacy removals resolve known fork locks without proof. Missing/corrupt legacy snapshots cannot unlock v1; nullable and canonical-proof records remain authoritative there. Close legacy fork-mode tabs before using the new release; old and new bundles must not operate local forks concurrently after migration. Browser storage and native Web Locks coordinate tabs on one origin. This is not coordination across devices, cleared browser data, different origins, or direct contract clients. Do not run the same intent from another device/browser while its outcome is unknown.
- The canary network button requests Ethereum through the connected wallet; rejection is recoverable. Rechecking chain ID alone is insufficient; the canonical block check must also pass. Recovery cannot make an unknown replacement disappear.

## Monitoring during the canary

A named operator must observe the entire window. Before any signed action, record the admitted wallet, intended token amounts, order ID when applicable, and current allowance. After broadcast, record the original hash and every replacement hash; independently verify receipt status, escrow order state, and residual allowance. Reconcile all admitted wallets' active orders and allowance against the operator's total exposure budget before admitting further exposure.

The existing `OTC mainnet canary` GitHub workflow checks contract identity and index/read health. It does **not** monitor admitted-wallet transactions, guarantee notification delivery, or enforce exposure caps. Run the script locally for a notification-free health check. Confirm ownership and actual alert delivery separately before activation; do not use the scheduled health job as transaction evidence.

Stop new activity immediately on one unexpected target/value/amount, unlisted wallet/pair, duplicate order, bytecode/WETH mismatch, uncertain replacement, or unexplained residual allowance. After one 120-second receipt timeout, retain the lock and reconcile; never repeat a create merely because the original hash is absent. Two consecutive failed network/order refreshes require operator investigation before further exposure. Index degradation is disclosed and never substitutes for direct state; suspend if the operator cannot reconcile exposure.

## Stop and rollback

1. Stop operator activity and reject outstanding wallet prompts where possible. A flag or deployment cannot cancel a signed transaction, undo a mined escrow, or revoke allowance. Record and reconcile all in-flight hashes and replacements before further action.
2. Run `gh workflow run otc-runtime-control.yml --ref main -f mode=off` and wait for successful public-endpoint verification. Confirm disabled actions in existing and fresh tabs. The UI polls every five seconds and new signatures require a fresh control read; receipt/recovery tracking remains mounted. A provider failure blocks signing. Already-issued wallet prompts can still execute.
3. The currently wired fallback is the repository variable `REACT_APP_OTC_ENABLED`: set it to the literal `false` and run the existing **Deploy to Cloudflare Pages** workflow on `main`. Its build passes this variable to the feature hook, where false overrides other read flags and removes the OTC route. Wait for successful deployment, verify the served build identity, and reload or close existing tabs. This is a deployment control, not an instantaneous update to already-loaded bundles; it does not stop direct contract calls.
4. A hard stop removes UI cancellation/revocation too. For an orderly wind-down after activation without a suspected signing defect, keep wallet admission and the verified write provider available but close the static trading window through a reviewed deployment. Verify approval/create/fill are blocked while cancel/revoke work. Removing an account does not clean up its allowance.
5. Restore the recorded read-only release through the reviewed deployment path when appropriate. Verify `/otc` behavior and the absence of signing actions in both refreshed and fresh tabs. Never clear local uncertainty records as part of rollback. The immutable escrow has no Ophis pause or upgrade control.
6. Independently reconcile active orders and residual allowance with the wallet owner. No automatic mainnet unwind is authorized. Preserve receipts and incident evidence before reopening; activation remains blocked without the required flag-provider and rollback demonstrations.

## Rehearsal without real funds

The runnable offline rehearsal is the existing feature-boundary tests plus `submitOtcCanaryTransaction.test.ts`: both flags off deny before RPC/signature; empty policy denies; expiry before and after simulation blocks entries; expiry at the adapter's final guard blocks signing; cancellation remains available after window closure. `useOtcCanaryRecovery.test.ts` proves missing/replaced/invalid receipts and context drift retain locks, and a known receipt is reconciled across wallet transports. These tests exercise mocked policy and receipts, not production flag delivery.

The actual deployed-contract fork suite and six injected-wallet browser scenarios use only local Anvil writes with a keyless PublicNode upstream and zero RPC retries. They validate shared ERC-20/receipt/recovery plumbing; they do not authorize funded Ethereum transactions. A local rehearsal on 2026-09-07 also exercised all six flows in canary mode using an isolated, temporary public test-account policy and a separate reader configured only for local Anvil (6/6 passed). The first attempt exposed two fork-only text expectations; updating those isolated expectations to the canary notice made the full run pass. The runtime-control browser scenario additionally checks shutdown, reload and provider failure with nonce-aware control stubs. This is not evidence of production flag propagation: a witnessed production control/rollback drill remains required before live trading. Never put a public test account in the production policy to run that rehearsal.

See [canary work/evidence](plans/2026-09-07-ophis-otc-canary.md) and [expanded review and limitations](../audit/otc-expanded-security-review-2026-09-06.md). Native ETH wrappers and Safe/EIP-5792 batching remain deferred.
