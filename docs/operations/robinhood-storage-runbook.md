# Robinhood storage on Cadia

Cadia runs Docker and Nitro inside the `Ubuntu-24.04` WSL2 distribution.
Its ext4 virtual disk is `D:\wsl\nitro\ext4.vhdx`. Windows D: capacity and
the Linux filesystem's maximum size are separate limits. The production Nitro
datadir, both Postgres instances and container logs share this Linux filesystem.
The alert uses application-available bytes, excluding ext4's reserved blocks.
Keep the 80% warning and 90% critical thresholds; do not silence capacity alerts.

## November 1–2, 2026 repair

The genesis-verifier container and `/home/clement/robinhood-nitro-genesis-data`
are already absent. The September instructions to reclaim another 571 GiB
are obsolete. The live `/home/clement/robinhood-nitro-data` must be preserved.
Before the repair the filesystem had about 1118 GiB in use. Growth varies with
chain activity and compaction, so measure it before sizing an expansion.

On November 2, the VHD and ext4 expansion from **1500 to 1700 GiB** completed
using existing physical space with no purchase. Linux application-available
space rose from approximately **282 to 471 GiB**, and the alert's used-space
measure fell from approximately **81% to 72%**. The filesystem UUID, all 32
container IDs, images, environment fingerprints and mounts were preserved.
Quotes and auctions passed, indexing advanced, and ten minutes of monitoring
showed no disk alerts, failed scrapes or additional container restarts.

Preflight required at least **100 GiB Windows headroom even if the enlarged
VHD reaches full physical allocation**; the measured margin was **195.6 GiB**.
This size is a dated capacity decision, not a value to reuse for later
expansions. No data was pruned, ext4 reserves were retained, and alert
thresholds were unchanged. Boot recovery and Windows supervision were
verified after restart, and the one-time resize task was removed.

Sanitized before/after evidence, the one-time controller and recovery details
are recorded under the operator's incident directory:
`/Users/scep/ophis-incidents/2026-11-01-robinhood-storage/`.

## Before a resize

Coordinate with every agent or operator using Cadia first. The rebate indexer
shares this WSL host. A container replacement during the clean-stop phase is
a conflicting deployment: abort and restore services, then wait for that work
to pause or finish. Do not infer that a healthy container means its agent is done.

1. Measure `df -hT / /mnt/d`, the root block-device size and recent filesystem
   growth. On Windows, measure D: capacity and the VHD's physically allocated
   bytes. Choose a growing-only cap that leaves a Windows reserve, accounting
   for other files on D:. A VHD's logical length may differ from allocation.
2. Inventory running containers, image IDs, mounts and environment fingerprints.
   Exclude temporary one-off jobs from automatic restart. Preserve all database
   volumes, chain files, signers and application configuration.
3. Verify `ophis-robinhood-boot-restore.service`. Its root-owned accepted-release
   override must match the clean deployed checkout, actual driver image revision
   and operator environment hash. A successful older boot is insufficient.
   The November repair found an obsolete accepted revision after a backend update.
4. Rehearse the existing root-owned restore script with the currently accepted
   revision and environment hash. Require identical actual mounted driver/RPC
   configuration hashes and unchanged container IDs. Keep any temporary backup
   of signer-bearing output on private tmpfs; never export or print private keys.
   Refresh the root-owned override only after those checks pass. Repeat this
   acceptance after subsequent backend/environment deployments.
5. Establish a Windows recovery task before shutdown. The task must run outside
   WSL, pass a harmless completion-marker test, and always relaunch the distro
   and recorded services after the resize attempt, including on resize failure.
   Do not shut down the machine's only SSH recovery path without this mechanism.
   Capture and temporarily pause `OphisNodeWatchdog` and `OphisNodeHolder` during
   the actual shutdown/resize so they cannot remount WSL midway through it.
   Restore their original enabled/running states in the recovery task's finally path.

## Resize and recover

Stop application writers first, then Nitro and both Postgres instances with
generous grace periods. Require clean exits for the data containers. Stop
Docker and its socket, then sync. Only then release the preflighted Windows
task to run `wsl --shutdown` and `wsl --manage Ubuntu-24.04 --resize` with the
reviewed size. Require exit-code checks; normal filesystem-check output on
stderr must not abort the recovery task.

The Windows task must restart `Ubuntu-24.04` in a `finally` path, start Docker
and the accepted boot-restore service, then start the exact previously running
containers. A filesystem expansion is not rolled back by shrinking it. If it
fails, bring services back and diagnose the reported error.

After boot, resolve the root device again with `findmnt -no SOURCE /`.
Do not reuse `/dev/sdd`; WSL can change device names. Verify the block-device
and ext4 sizes agree, and expand ext4 on the resolved device if the VHD grew
without its filesystem. Microsoft's supported resize procedure is documented
[here](https://learn.microsoft.com/en-us/windows/wsl/disk-space).

Verify RAM-backed mounts and exact driver/RPC hashes, image and environment
fingerprints, both databases, Nitro head progress against the official RPC,
driver readiness, quotes, auction/indexing progress and rebates. Observe for
at least ten minutes; confirm disk alerts clear naturally. Do not run a funded
canary as a storage check. Remove only the one-time recovery task after success.

## Alert rules

The legacy `OphisUniHostDiskLow` / `OphisUniHostDiskCritical` names remain stable
for existing routing. Their Robinhood annotations point here and contain no
destructive cleanup recipes or historical capacity promises. Validate them
with the repository's annotation checks and pinned Prometheus `promtool`.
Preserve the actual mounted rule file and existing TSDB when applying an update.
If an external rule-file override is used to keep the accepted application
checkout clean, record its Compose path for subsequent Prometheus recreation.

Nitro still grows. This repair adds bounded headroom; it does not make the
physical drive unlimited. Never delete live chain files, database volumes or
move Nitro onto the Windows `/mnt/d` filesystem as a quick fix.
