# Ethereum broadcaster operations

**4 November integration checkpoint:** the restricted funded swap/withdrawal pilot completed on 3 November. The new source branch integrates current main and repairs dependency installation/audit coverage; the existing service and its financial limits are unchanged. Fresh installations stay unarmed, and the used pilot withdrawal marker must be retained through upgrades and restores. The dated custody-installation descriptions below are historical. See [dependency scope](DEPENDENCIES.md) and the [development plan](../../docs/development/plans/2026-11-04-railgun-broadcaster-integration.md).

Stage 3 is locally validated for repeated users. Admission defaults to `pilot`; `public` is currently a fork-validation policy, with enabled public mainnet startup explicitly blocked pending final acceptance. Do not change the live admission setting or clear the used withdrawal marker as part of this source integration.

Before an eventual upgrade, inspect an authenticated journal snapshot for every unresolved or unassured row using the following read-only query. The new settlement gate deliberately holds availability for such rows regardless of the current outer nonce. Preserve the rows and verify their chain/fee outcomes; an old confirmed row with missing assurance is not safe to ignore.

```sql
SELECT key, hash, nonce, confirmed, assured
FROM requests
WHERE hash IS NOT NULL AND (confirmed=0 OR assured=0);
```

An included sponsored revert now retains its unassured hold across restart. Monitoring and an owner-reviewed resolution procedure are required before public activation; no direct database edits or automatic release of the hold are supported. Explicit confirmed cancellations retain their existing resolution path and actual gas accounting. `/health` exposes the admission policy and pending fee-assurance count, in addition to readiness and pending nonces.

The current restricted pilot can authorize one USDC withdrawal by setting `OPHIS_BROADCASTER_PILOT_WITHDRAWAL_RECIPIENT` to the owner-selected public destination. Keep the existing gas limits, reserve, pilot swap account and margin unchanged. The `withdrawalPilot` setting is committed with the signed request and prevents a second withdrawal even after restart; do not clear it automatically after a timeout or cancellation. Reconcile the saved request before considering a separately authorized pilot. Withdrawals use the existing protected privacy-contract route, with the fee and output in one proof. No guard deployment or refill is needed.

The service lives on Baal under `/home/clement/.local/share/ophis-broadcaster`. The funded pilot deployed its operator-bound guard and confirmed a swap and withdrawal; public frontend activation remains pending. The owner selected Ambire + Ledger, without Safe. The old funding instructions are withdrawn. The migration rotated the gas and database keys, preserved the fee address, changed fee custody to view-only and removed the original plaintext key file after encrypted off-server recovery was verified.

## Custody migration

**Installation record, 2 November 2026:** custody was installed before funding; the successful funded pilot followed on 3 November. The custody design below remains applicable.

**Cost constraint: no new paid services or accounts.** The owner explicitly rejected paid signing services; the AWS/KMS recommendation is withdrawn. It must not be treated as a launch requirement. Use the existing Baal server, its Ethereum read node and the owner's existing Ambire + Ledger setup. No paid service was provisioned and no funds moved during custody migration. Ethereum transaction gas remains a network cost; this constraint does not authorize increasing the approved pilot budget.

The owner-supplied treasury/refill address is **`0x58707c6C1E111c21cba4C9C8caE144175F84EceE`**, controlled through Ambire + Ledger as reported by the owner. No Safe is selected or required. Its checksum is valid. Baal's synchronized Ethereum node reported zero ETH, zero transaction count and empty code at block 26,327,137. This is a historical read, not its current balance. Empty code alone does not distinguish a fresh EOA from an undeployed smart account or prove hardware ownership. Verify the intended account through Ambire + Ledger before signing funding instructions. The separate funded pilot gas account is **`0x65C3f921DB6f0e431C28EcbECFA7687fbD68f2a8`**. Neither account replaces the existing Ophis partner-fee recipient.

Use the selected Ambire + Ledger account to control treasury funds and approve bounded refills. [Ambire's hardware-wallet documentation](https://help.ambire.com/en/articles/13714236-using-ambire-extension-with-hardware-wallets) describes Ambire as the interface and the hardware device as the holder of its controlling keys. The Ledger must generate its own key. Importing the old server key would not remove its prior exposure. Keep existing prototype keys and encrypted backups for recovery, but leave the old gas address unfunded; its zero balance and unused nonce were rechecked at the same block.

Automatic swaps use the dedicated software gas wallet on existing Baal infrastructure. The operator files use AES-256-GCM with a fixed 128-bit authentication tag and a fresh data key wrapped with RSA-OAEP/SHA-256 under the existing 3072-bit backup certificate. Only the public certificate is on Baal. The recovery private key remains on the owner's Mac, outside the repository and server. It is protected by local file permissions, not by the Ledger. The gas key is available in process memory only after manual unlock. No new password or automatic unlock credential is stored on Baal.

After every service restart, run this from the owner's Mac:

```sh
node /Users/scep/ophis-private-swap-design/apps/broadcaster/dist/unlock-client.mjs unlock
```

The standalone client uses the existing off-server recovery key at `~/.local/share/ophis-broadcaster-backup-key/restore-key.pem`. It authenticates the encrypted payload before sending only runtime gas/viewing keys over SSH to a 0600 Unix socket in the private container temporary directory. It never prints keys. `verify` and `verify-retired` check the encrypted runtime/retired records without uploading their plaintext. There is no HTTP unlock route. Unlocking never enables signing or changes financial limits. Keep a separate secure copy of the recovery key; losing every copy loses access to the encrypted gas key and retired fee-spending material.

Retain the exact request/fee/proof validation, guard attestation, zero native value, nonce checks, aggregate gas limits, durable journals and private-only publication. The shared PPOI-free policy remains in force. These checks defend admission of user requests; they cannot constrain an attacker who controls the host and its unlocked key. In that case, the full online gas balance is exposed regardless of configured per-transaction or daily limits. Keep the main reserves under Ledger control and provide no automatic refills, treasury signing key or treasury spending allowance to Baal. An independent signer on separately controlled existing hardware could improve separation later, but neither new hardware nor a paid HSM/KMS is assumed or required by this plan.

The `GasSigner` boundary checks the returned sender and full transaction before journaling or submission. It is not hardware custody or independent policy enforcement. Mainnet accepts only the configured gas address and a runtime payload with a fee viewing key and no fee mnemonic. Guard, positive markup, spending limits and restricted pilot checks remain mandatory. Fresh installations keep signing disabled; the funded pilot retains its explicitly approved limits.

The running private fee wallet is view-only. Its receiving identity is unchanged. Its spending mnemonic and former database key are retained only in the encrypted retired operator record and older encrypted backups; they are excluded from the runtime unlock payload. Historical encrypted wallet records remain under that retired database key. Previously existing copies cannot be erased by this migration. The Ambire treasury can receive public assets after owner-controlled fee collection; its Ethereum address is not a private RAILGUN-note wallet. Exact live pilot fees have been verified; owner-controlled collection and operational acceptance remain pending.

The pilot's margin/funding approval, operator-bound guard deployment and first funded swap/withdrawal are complete. This integration does not change those identities or authorize another deposit, deployment or refill.

## Payment policy

The minimum private fee is `ceil(maximum signed gas cost × current token conversion rate × (1 + markup))`. Both the advertised conversion rate and the final fee round upward. The broadcaster rechecks the current rate and its actual signed gas limit before signing. An enabled instance requires an explicitly positive markup; the approved pilot minimum is 15%.

The user pays the quoted private token fee within execution. Ophis advances ETH. This fee is fixed rather than refunded down to receipt gas, so its surplus can exceed the quoted markup. Collection/unshielding, ETH conversion and hosting costs reduce net profit. An included outer revert or an operator cancellation can consume Ophis ETH without a fee; the guard, private endpoint and spending limits contain this exposure but cannot make it zero.

The approved pilot limits, last verified on 3 November, are 0.5 gwei maximum gas price, 0.0015 ETH maximum transaction cost, 0.0015 ETH rolling 24-hour gas budget, and 0.0015 ETH minimum reserve. Preserve these limits through this integration; a funding transfer alone does not enable the service. The earlier unapproved 0.003 ETH funding packet and its different limits remain withdrawn.

## Installed release and service

`Dockerfile` pins Node 22.23.4 by digest, installs production dependencies from the frozen lockfile without lifecycle scripts, and checks the compiled bundle hash. Build from a sanitized context containing only the allowlisted package/lock/patch files and `dist/main.mjs`; `Dockerfile.dockerignore` excludes credentials and state. Supply `OPHIS_BUNDLE_SHA256` when building. The deployed image and source manifests are recorded in the private launch evidence, not inferred from an uncommitted Git revision.

The container runs as UID/GID 1000, with no capabilities, a read-only image, a 64 MiB temporary filesystem, 3 GiB memory and 1.5 CPU limits. Its only host mount is the private operator state directory. The existing SSH deployment account owns that state. Waku is isolated in its own container, capped at 768 MiB and 0.5 CPU, with localhost REST only. There is no Docker socket, host home or validator mount inside either container.

Compose configuration is in `compose.env`; financial configuration is in private `operator.env`. Only this project uses its network and container names. The `current` symlink selects a manifest-checked release.

```sh
base=/home/clement/.local/share/ophis-broadcaster
docker compose --env-file "$base/compose.env" -f "$base/current/compose.yml" ps
docker exec ophis-broadcaster-broadcaster-1 node -e 'fetch("http://127.0.0.1:4340/health").then(async r=>console.log(await r.text()))'
```

Unarmed synchronization uses `OPHIS_BROADCASTER_COMMAND=sync`. Before manual unlock, `locked:true`, `synchronized:false` and `ready:false` are expected. After scans finish in that mode, `locked:false`, `synchronized:true`, `enabled:false` and `ready:false` are expected. `run`, the verified public gas address, actual execution guard, an owner-controlled pilot swap account, a positive markup and all explicit financial limits are required for the restricted pilot. Admission covers that swap account and one positive USDC withdrawal to the configured recipient. A used withdrawal marker can keep an enabled, unlocked, synchronized service unavailable; do not clear it to bypass the restriction. General activation cannot be enabled merely by adding a frontend address.

Docker health checks verify service liveness; the health response also reports synchronization, pending requests and errors. Resource ceilings and bounded container logs are installed. Gas balance, unresolved requests, fee assurance and backup/storage checks remain operator monitoring duties; no external alert destination has been configured.

## Recovery and backups

Stop the service before `status`, `retry` or `cancel`: all commands share its native exclusive operator lock. `status` uses the public gas address without unlocking. For signing recovery, run a Compose one-off container named `ophis-broadcaster-recovery` with the same state mount, then run the Mac unlock client with `recovery` instead of `unlock`. Restart and manually unlock the normal service afterward. Original mainnet retries remain blocked; explicit bounded cancellation and an identical cancellation retry are supported while unarmed. Never prepare a different user spend to resolve an unknown operator submission. Recovery permits a preceding transport-journal entry to be replaced only after the trusted node confirms its nonce was consumed.

The daily default `scripts/backup.sh` takes online SQLite backups and copies the encrypted operator records, public certificate and configuration. It snapshots the protected-transport journal before the request journal, preserving the record-before-disclosure order. It never stops or relocks the running signer. The archive is authenticated/encrypted with AES-256-GCM and RSA-OAEP/SHA-256. A critical-state restore starts from an empty wallet cache and rescans history; the snapshot removes only its own saved wallet ID so the view-only identity can be recreated. The live database is unchanged.

Passing `full` as the second argument retains a stop/archive/restart backup of the complete wallet cache and journals. A full backup requires manual unlock afterward. Both modes take an exclusive backup lock and remove incomplete output. Only the public encryption certificate lives on Baal; the recovery private key remains off-server. Use OpenSSL 3 to authenticate CMS restores; macOS's bundled LibreSSL does not support this authenticated CMS envelope.

A daily user cron job runs the online backup at 03:17 in Baal's server timezone. Its output is private `backup.log`; the pre-install user crontab was preserved. A fresh full pre-migration archive and an online critical-state archive were copied off-server and successfully authenticated without writing a plaintext backup.

```sh
bash "$base/current/scripts/backup.sh" "$base"
```

Retain an off-server encrypted copy. For restore, decrypt into a private temporary file and require successful GCM authentication **before** extracting it into a stopped, empty operator installation. Restore the recorded permissions and configuration, verify the gas address and both journals against current chain state, and start unarmed. Do not pipe unauthenticated partial decryption straight into an active state directory. Restore and restart were tested with dummy data, and the initial real operator-key backup was decrypted and matched without writing a plaintext backup.

Track backup growth along with the state directory against the planned 50 GiB operating allowance; the application refuses work with less than 6 GiB free on its filesystem. Backup pruning is manual after a newer off-server copy is verified.

## Restricted pilot and public activation

The restricted pilot's custody, funding, guard deployment, swap, withdrawal and exact fee-receipt checks are complete. Preserve its used withdrawal marker and both journals. Public activation still requires the following work in the development plan:

1. Validate repeated-user admission, supported tokens and saved-proof recovery in the isolated integration environment before replacing pilot restrictions. Do not intentionally include a failing mainnet transaction to test rejection.
2. Complete the hosted Ophis flow, owner-controlled fee collection/refill preparation, monitoring and disposable restore/reconciliation checks.
3. Run final security, fork and hosted compatibility checks on the exact release; record frontend/backend versions, the current live guard/fee identities and a state-preserving rollback. Recheck the live configuration rather than copying an old funding packet.
4. Bind the verified fee identity and current price anchor to the Ethereum protected allowlist with a review expiry, then roll out within the approved financial limits. Keep other chains disabled until their own protected path passes acceptance. Stop for unresolved nonce, absent fee assurance, stale pricing, exceeded limits or an unexpected delegate.

New COMMON withdrawals require the fee and requested unshield to share one proof before any private or public submission. A fragmented withdrawal that needs separable proofs is rejected before a pending record is created; a smaller amount may fit. Older separable records remain available for receipt reconciliation/manual recovery and are not automatically rebroadcast. Supported public-gas resumption uses the saved atomic proof, including its original private fee. Swap and withdrawal confirmation binds the receipt to the exact UTXO-tree/nullifier pairs and a block no earlier than submission, in addition to the expected output.
