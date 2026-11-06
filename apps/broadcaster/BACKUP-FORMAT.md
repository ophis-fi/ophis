# Broadcaster backup paths

`scripts/backup.sh INSTALLATION [critical|full]` resolves the broadcaster's bind mount at `/var/lib/ophis-broadcaster` through `docker compose config --format json`. This uses Compose's interpretation of `OPHIS_STATE_DIR` and never sources `compose.env` as shell code. The host needs Python 3 in addition to the existing Docker Compose, tar, OpenSSL and flock commands.

Both modes preserve existing archives and include `operator.env` and `compose.env` inside the encrypted archive. Their state layouts differ:

| Mode | Archive layout | Runtime behavior |
| --- | --- | --- |
| `full` | Actual mounted directory basename, such as `owner-state/` or historical `state/` | Stops the broadcaster for the snapshot; restarts it only if it was previously running. |
| `critical` | Normalized `state/` containing durable journals and encrypted custody records | Uses the live snapshot command; wallet-history databases are excluded and must resynchronize after restoration. |

A critical snapshot recognizes owner custody by `secrets/owner-manifest.json` and requires all four owner records: that manifest, `operator.sealed.json`, `fee-wallet-public.json`, and `fee-wallet.sealed.json`. Otherwise it requires the historical four records: `operator.sealed.json`, `operator-retired.sealed.json`, `operator-public.json`, and `backup-cert.pem`. Every copied record must pass the existing owned, private regular-file check. Missing records fail the snapshot; no retired wallet database or substitute legacy files are added. The installation's separate `backup-cert.pem` still encrypts the outer archive in either layout.

Before restoration, inspect the archive layout and identify the intended chain, operator and current Compose bind-mount source. A full `owner-state/` archive must restore to that owner's configured state directory, not to a retired `state/` directory. For a critical archive, map the contents of its normalized `state/` directory into the intended configured mount; its archive name does not select the runtime directory. Historical configuration files describe historical installations and must not silently replace the active owner's configuration or reactivate a retired signer.

Keep existing owner state, signed journals and retired archives until reconciliation and restoration checks are complete. Neither backup mode changes admission, gas budgets, custody pins or unlock requirements. Restarting a previously running mainnet broadcaster still requires the normal owner unlock.
