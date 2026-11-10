# Current ANON operator recovery

This procedure resolves an already journaled outer gas transaction. It does not create a user proof, release a held credit, reset a nonce or activate public admission. The operator must approve the exact command, candidate image/bundle and, for cancellation, both gas prices. Preparing the container does not authorize unlocking or spending. The original ANON helper, encrypted records, manifest, certificate and fee-source pins remain unchanged.

Use this procedure after stopping the selected normal broadcaster through the existing operator procedure. Keep its original container stopped and present. The launcher refuses a running source or unexpected mounts; it never stops, renames, removes or starts the source, Waku or a node. It creates only a stopped recovery container; no RPC is contacted by the launcher. Starting that recovery process later performs the backend's configured chain checks and waits for owner unlock before signing.

## Prepare the exact recovery command

On Baal, from the reviewed release's `apps/broadcaster` directory, use the reviewed installed image ID and runtime bundle SHA-256. Values below are operator-supplied public pins, not tag names. The script uses `/usr/bin/docker` with the local `/var/run/docker.sock` daemon and inherits the current chain-specific container's environment privately; credentials never appear in its output or Docker command arguments. The environment allowlist permits only the canonical image PATH, inert NODE_VERSION/YARN_VERSION metadata, and the exact OPHIS_BROADCASTER configuration keys consumed by config.ts/main.ts. Unknown keys are rejected, including HOME, Node cache/TLS/module options, proxy/SSL variables and loader overrides. The Docker subprocess inherits no other host environment; private RPC values pass only through the supported OPHIS keys.

```sh
node scripts/anon-recovery.mjs CHAIN_ID IMAGE_ID BUNDLE_SHA256 retry
```

For a separately approved cancellation:

```sh
node scripts/anon-recovery.mjs CHAIN_ID IMAGE_ID BUNDLE_SHA256 cancel MAX_FEE_WEI PRIORITY_FEE_WEI
```

Only chains `1` and `56` are accepted. Cancellation prices must be positive, priority cannot exceed maximum, and the launcher checks the existing configured price and minimum transaction-cost bounds. The backend subsequently checks the actual pending nonce, higher replacement prices, chain gas estimate, reserve/daily limits and the already secured prepaid budget before signing. The launcher does not estimate, raise or recommend fees. A retry has no new fee parameters; expired original envelopes remain held.

The JSON result supplies the exact container ID, unique name, image, bundle and command. The candidate may differ from the old container's image, but must be the explicitly reviewed immutable image with the matching bundle label and Linux/amd64 platform. The new container inherits only the original's actual authoritative state mount with `--volumes-from`; an unrelated extra mount is rejected. This preserves the source container's mount metadata and avoids guessing a separate state path. It does not pin a host-directory inode against administrator replacement; the existing trusted-host and administrator custody boundary remains required. Existing state and all journals are used in place; nothing is copied, restored, initialized or deleted.

The image-environment compatibility policy is deliberately strict: there is no automatic merge of new image defaults. If a candidate adds an environment key absent from the source, effective-container attestation rejects it while the new container is still stopped. Review and update the supported profile before using such an image; do not start or unlock the rejected container. Existing inert NODE_VERSION/YARN_VERSION strings are retained from the source and may describe its older image. They are not proof of the running binary version: the explicitly approved immutable candidate image and bundle pins establish that identity.

The effective profile must attest successfully before continuing: same owner/chain/environment except `ENABLED=0`, approved image and command, no ports, no privileges, read-only root, bounded tmpfs, 1 CPU/3 GiB/no extra swap, and `restart=no`. A name collision or failed attestation requires inspection; never remove a container or journal merely to force preparation through. A created-but-unattested container is not approved for unlock.

Docker may still read the trusted operator's CLI configuration. If it injects proxy environment variables, effective attestation rejects them while the recovery container remains stopped. The host administrator, Docker daemon and owner SSH configuration remain within the accepted custody boundary.

## Owner-local recovery helper

Generate a new helper on the owner's Mac using the existing **public helper source**, not any key or encrypted wallet file:

```sh
node scripts/build-anon-recovery-client.mjs /Users/scep/ophis-railgun-evidence/baal-replacement-20261106/baal-owner.mjs NEW_RECOVERY_HELPER_PATH
```

The generator requires original helper SHA-256 `8c6f7a58aa4df0776e8f52aa7bed7505f0091881d6eef38b7ed422d8b217c364`, preserves its full cryptographic/custody prefix byte-for-byte, writes a new private output file without overwriting anything, and prints the new public file digest. Review that generated digest with the release. It adds no import or phrase entry mode. The original remains usable unchanged.

After approving the exact stopped container/command, start only its returned ID on Baal:

```sh
/usr/bin/env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin /usr/bin/docker --host unix:///var/run/docker.sock start RECOVERY_CONTAINER_ID
```

Then, in the owner's private interactive terminal on the Mac, pass the same public image, bundle, container ID and command/caps:

```sh
node NEW_RECOVERY_HELPER_PATH unlock CHAIN_ID IMAGE_ID BUNDLE_SHA256 RECOVERY_CONTAINER_ID retry
```

Or for the exact approved cancellation:

```sh
node NEW_RECOVERY_HELPER_PATH unlock CHAIN_ID IMAGE_ID BUNDLE_SHA256 RECOVERY_CONTAINER_ID cancel MAX_FEE_WEI PRIORITY_FEE_WEI
```

Before reading any owner material, the helper verifies the remote recovery configuration and that the original remains stopped. It then uses the existing owner-local encrypted runtime, manifest, fee-source and certificate validation, and sends only the existing runtime unlock payload to the immutable attested container ID over authenticated SSH. Both remote Docker calls use the absolute executable, fixed local daemon socket and a cleared command environment, matching the launcher. No owner spending phrase or fee-wallet spending key is added. Server administrator access to the unlocked software gas key remains the previously accepted custody boundary.

## Finish without reopening admission

The recovery command exits after protected submission or failure; `restart=no` prevents replay on restart. A submitted hash is not confirmation. Preserve the original request, every cancellation and both journals. Inspect the backend's sanitized result, then reconcile the original and cancellation hashes to canonical finality before permitting new work. The accepted original can win a cancellation race. Prepaid cancellation charges are bounded by the original reservation; unknown outcomes and restore holds stay closed.

Remove only the exact **stopped** recovery container after preserving its result; never remove its volume/state or use a broad cleanup command. The normal container is still stopped. Resume only the reviewed current candidate through the deployment procedure, with reconciliation and the existing manual owner unlock. Do not restart the preserved superseded image against an updated prepaid journal. Recovery completion does not enable admission or satisfy the live swap/refund/collection acceptance gates.

The focused tests use synthetic Docker metadata and public helper source. Backend cancellation/accounting tests exercise secured budget checks separately. A real owner unlock and live transaction are intentionally not performed by those tests.
