# Arbitrum native-credit operator recovery

Use this manual route for an already journaled Arbitrum operator transaction. The generic [ANON recovery launcher](ANON-RECOVERY.md) and its generated owner client support only Ethereum and BNB; do not add `42161` to that profile or substitute its environment allowlist. In particular, Arbitrum must retain its independently pinned credit ledger and any configured write RPC.

The existing backend `retry`/`cancel` commands support Arbitrum. The owner already has a separate reviewed L2 unlock helper that targets `ophis-broadcaster-42161-broadcaster-1`. A reviewed one-shot Arbitrum cancellation used this route on 14 November 2026 and was later reconciled. This is an operator-controlled procedure, not a self-service launcher: each operation needs a current, reviewed staging record and the owner's exact spending approval. A previous cancellation or retry approval is not reusable.

## Choose the existing request and command

Inspect the current chain/operator/ledger and retained request before staging anything. Record the immutable runtime image and bundle hash, current container ID, original transaction hash, outer nonce, fee-credit owner, reservation and any cancellation hashes. Preserve both `requests.sqlite` and `protected-transactions.sqlite`, their SQLite sidecars and the entire authoritative state directory. Do not create a replacement ledger, clear a hold, erase a pilot marker, reset a nonce or copy an earlier database over current state.

The container startup arguments are exactly one of:

```text
dist/main.mjs retry
dist/main.mjs cancel MAX_FEE_WEI PRIORITY_FEE_WEI
```

These are startup arguments for a separately staged one-shot process, not commands to execute beside the running service. `retry` retains the saved transaction and has no fee arguments. The backend refuses expired original fee envelopes and unsecured mainnet sponsorship retries. `cancel` creates a zero-value self-transfer at the held operator nonce; explicit replacement prices must exceed the retained prices and remain within the reviewed gas, reserve, daily-budget and secured-credit bounds. Arbitrum cancellation includes its chain-specific gas estimate; do not assume Ethereum's 21,000-gas ceiling. An expired original request is not made retryable by approving a larger RPC retry count.

If the retained request cannot pass these checks, stop with its state preserved. The November 16 expired-quote same-byte withdrawal controller was a separately approved, consumed exception; neither its approval files nor its fixed request/hash are a generic recovery route.

## Stage a locked one-shot process

The authorized host operator prepares and reviews a staging record against the actual current container before changing it. The existing Arbitrum service was created without Compose labels; do not use Ethereum's Compose recovery wrapper or infer a different data mount.

1. Pin the current container ID, installed image, executable bundle, network, command, complete effective configuration, operator address and guard. Privately compare configuration; never print raw environment values, RPC URLs or signed bytes. Preserve the current limits or use smaller limits explicitly approved for this recovery. No automatic escalation is allowed.
2. Preserve `OPHIS_BROADCASTER_CHAIN_ID=42161`, mainnet mode, `OPHIS_BROADCASTER_CREDIT_PAYMENT_MODE=public-native`, the existing `OPHIS_BROADCASTER_CREDIT_LEDGER_ID`, admission policy, read RPC, optional `OPHIS_BROADCASTER_WRITE_RPC`, any trace RPC, guard, encrypted-secret mount and owner metadata. The write route must not silently become the read route. Retain the original state mount and verify its host/container identity, including directory and journal inodes. The only routine mode change is `OPHIS_BROADCASTER_ENABLED=0`; the explicit CLI command can still sign after owner unlock.
3. Create a stopped candidate with the reviewed immutable image/bundle and exact command/caps. Require UID/GID 1000, read-only root, no added capabilities or privileges, `no-new-privileges`, bounded tmpfs/CPU/memory/PIDs, no published ports and `restart=no`. Attest its effective command, environment, image and mounts while it is stopped. Unexpected values or duplicate effective configuration require review; do not repair them by guessing.
4. Stop only the named Arbitrum service, then take an encrypted, consistent backup of both journals using the established backup certificate. Retain the stopped original under a unique archival name. Financial rows, holds, nonce/signature records and ledger identity must match the reviewed pre-stop state. Restored-state fences remain in force; a backup is not permission to roll financial state back.
5. Only after attestation and backup, place the candidate under the existing canonical name `ophis-broadcaster-42161-broadcaster-1` and start it locked. Confirm its chain and configured ledger before owner unlock. The backend takes the exclusive operator lock and checks the configured ledger before loading the gas key. No normal request service or other recovery process may use that state concurrently. Waku, Ethereum/BNB broadcasters, the Ethereum node and mev-boost are outside this operation.

The retained November 14 `stage-cancel.py` packet demonstrates this staging pattern, but pins a historical container, image, request and nonce. Its consumed operation must not be rerun or mechanically repinned as authority for another cancellation. A current staging record must be reviewed against the release and current state. Failed staging preserves the candidate, original and evidence; it does not automatically restore or retry.

## Owner-local unlock

After the host operator verifies the exact candidate and the owner approves the command and spending bounds, the owner runs the existing helper in a private interactive terminal on the Mac:

```sh
cd ~/ophis-railgun-evidence/multichain-prepaid-20261111/commissioning-preflight
/opt/homebrew/opt/node@22/bin/node baal-owner-l2-candidate.mjs unlock 42161
```

Reviewed public helper SHA-256: `0a3d6de1c0911a9c9edbd0e038a50dab09817e707b2b8195af270d5f422f2681`. Keep the existing encrypted runtime, owner manifest, fee-source and certificate pins unchanged. Do not run `provision-l2`, alter wallet material, use the legacy commissioning client or send any key to the host operator.

This helper checks the local custody material and sends the existing runtime unlock payload over authenticated SSH to the fixed Arbitrum container name. It does **not** independently attest that container's image, command or limits. The preceding operator attestation is therefore mandatory; the canonical name alone is not proof of the executable being unlocked. Unlocking this one-shot process authorizes its reviewed recovery command to run immediately.

## Reconcile and return to normal service

The process exits after its attempt and must not restart automatically. Keep the sanitized result and both journals even on a timeout or rejected submission. Verify canonical outcomes for the original and cancellation hashes, finality, outer nonce, actual gas debit and remaining credit hold. The original can win a cancellation race; a transaction hash alone does not establish settlement. Canceling the operator nonce does not invalidate the user's separately signed private authorization or clear the browser's saved proof.

Resume only the reviewed normal runtime on the same current state, ledger and write route after the one-shot process has exited and reconciliation allows it. Return to the recorded normal limits; do not restart a superseded image against a newer journal. The restarted normal signer requires its own owner unlock. No new deposit, private proof or customer-funded test is part of this procedure.

The runtime checks are implemented in [`main.ts`](src/main.ts), [`recovery.ts`](src/recovery.ts), [`credit.ts`](src/credit.ts) and [`protected-provider.ts`](../railgun/operator/protected-provider.ts). Operational backup/restore fences remain described in [OPERATIONS.md](OPERATIONS.md). Base remains separately held; this Arbitrum runbook does not authorize its activation.
