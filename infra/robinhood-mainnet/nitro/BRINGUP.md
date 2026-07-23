# Robinhood Nitro node - machine bring-up (Windows + WSL2, DB on D:)

The ordered procedure to stand up the self-hosted Nitro node on THIS machine
(Windows 11, 16 cores, 29.8 GB RAM, D: = 1.86 TB NVMe dedicated to node data).

This node is the **sovereign tie-breaker leg** of the hybrid trace setup: two
managed providers (Dwellir/Chainstack) carry trace availability now, and this node
is added as an independent third leg once it is restored and L1-verified. Because
of a fatal blob-DA gap, this node is brought up **from a snapshot**, not from
genesis - see `README.md` "From-genesis sync is NOT possible".

> Status 2026-07-22: disk D: formatted; WSL2 2.7.10 installed (`--no-distribution`);
> `.wslconfig` written to `C:\Users\clement\.wslconfig`. **A reboot is pending** to
> activate VirtualMachinePlatform. Everything below is authored but NOT yet run on
> this machine - validate each step, do not assume.

---

## 0. Reboot (REQUIRED, once)

VirtualMachinePlatform is enabled but inactive. Until you reboot, `wsl --status`
reports "virtualization is not enabled" and nothing here works. Reboot, then open
an elevated PowerShell and confirm:

```powershell
wsl --status      # should NOT complain about virtualization
wsl --version     # WSL 2.7.10+, kernel 6.18+
```

## 1. Create the Ubuntu distro with its disk ON D:

The distro's `ext4.vhdx` is a real block device to the WSL2 VM (no 9p penalty),
so putting it on D: puts the node DB on the fast NVMe. Only `/mnt/<letter>` paths
go through 9p - we never bind-mount one for the DB.

```powershell
# --location puts the vhdx on D:; --vhd-size raises the default 1 TB ceiling so a
# 181 GB restore that later grows has room. (Verify these flags on your WSL build:
#   wsl --install --help    -- older builds lack --location/--vhd-size and need
#   `wsl --import <name> D:\wsl\nitro <rootfs.tar>` instead.)
wsl --install Ubuntu-24.04 --location D:\wsl\nitro --vhd-size 1500GB
```

Set up the Linux user when prompted (e.g. `clement`). Then, inside the distro:

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true          # so Docker + the node can run as services
[automount]
enabled=true
EOF
```

Back in PowerShell: `wsl --shutdown`, wait 10s, reopen the distro (this also picks
up `.wslconfig`: 26 GB RAM, 14 CPUs, 12 GB swap on D:). Confirm inside the distro:

```bash
free -g            # ~25 GB total (proves .wslconfig took, not the ~15 GB default)
nproc              # 14
```

## 2. Install Docker Engine INSIDE the distro (not Docker Desktop)

Docker Desktop can't relocate its data to D: and only autostarts on sign-in.
Docker Engine in the distro is simpler and its data is already on D: (the vhdx).

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"       # log out/in (or `wsl --shutdown`) to take effect
sudo systemctl enable --now docker
docker run --rm hello-world           # smoke test
```

## 3. Tools the restore/verify scripts need

```bash
sudo apt-get update
sudo apt-get install -y jq zstd tar curl coreutils
curl -L https://foundry.paradigm.xyz | bash && ~/.foundry/bin/foundryup   # cast
```

## 4. Get the repo + config into the distro

Clone/copy the repo inside the distro (on the ext4 vhdx, NOT under /mnt/c). Then:

```bash
cd <repo>/infra/robinhood-mainnet/nitro
cp .env.example .env
# Edit .env:
#   L1_EXECUTION_RPC  = an Ethereum mainnet RPC (batch reads; own node or paid)
#   L1_BEACON_URL     = a beacon endpoint. For a SNAPSHOT restore this only needs
#                       to reach ~snapshot height forward (hours), so a free one
#                       (https://ethereum-beacon-api.publicnode.com) is fine here -
#                       the deep-archive requirement only applies to genesis sync.
#   NITRO_DATA_DIR    = /home/<you>/robinhood-nitro-data  (ext4, on the D: vhdx)
chmod 600 .env
```

`robinhood-chain-info.json` and `robinhood-genesis.json` are already in this dir.

## 5. Restore the snapshot (the ~107 GB step)

```bash
chmod +x restore-snapshot.sh verify-snapshot.sh
./restore-snapshot.sh          # manifest -> resumable download -> SHA256 -> extract -> chown
```

Budget ~2-3 h download on 100 Mbps + ~30-60 min extract. Peak disk during restore
is ~107 GB tarball + ~181 GB extracted; D: has 1.86 TB, so fine. The script
removes the bundled `wasm` dir (untrusted native code) and the node rebuilds it.

## 6. First start, then GATE trust before wiring to Ophis

```bash
docker compose --env-file .env up -d
docker compose logs -f nitro     # expect "catching up" from snapshot height, NOT
                                 # "creating genesis" (that would mean the restore
                                 # was not picked up - stop and re-check NITRO_DATA_DIR)
```

Once it is following the tip, run the trust gate:

```bash
L1_RPC=https://eth.drpc.org ./verify-snapshot.sh
```

It cross-checks block hashes vs the public RPC, **anchors the header chain to
L1-confirmed assertions**, and proves `debug_traceTransaction` works. Read its
header comment: it proves the header chain, not the flat state DB - an anonymous
snapshot stays a reputational bet, which is exactly why this node is only ONE of
>=3 eRPC legs, never the sole trace authority.

## 7. Expose to eRPC + make it survive reboots

- Join this host to Tailscale as `ophis-rbh-node` so the eRPC proxy reaches
  `http://ophis-rbh-node:8547`. Keep :8547 bound to 127.0.0.1 (it already is).
- **Autostart across Windows reboots.** WSL2 has NO supported service-model and
  the widely-cited `autostart=true` .wslconfig key DOES NOT EXIST. TWO things must
  happen on boot: (a) the distro must be *started* (WSL boots it lazily), and (b)
  something must *hold* a session open, because WSL2 shuts the VM down ~60s after
  the LAST session closes and takes the container with it (`vmIdleTimeout=-1` is
  NOT honored - observed 2026-07-23). A plain `wsl -e /bin/true` at startup fails
  BOTH: it exits immediately (no hold), and SYSTEM can't see a distro registered
  under a normal user. The working shape (tested 2026-07-23):

  1. `keepalive-node.sh` (committed here) - a `while true; docker compose up -d;
     sleep 120; done` loop. It runs as ONE long-lived wsl session, so it both
     holds the VM up AND keeps the container running. Copy it into the distro at
     `/home/<user>/keepalive-node.sh` (chmod +x).
  2. A Task Scheduler task at **logon of the distro-owner user** (NOT SYSTEM -
     the distro is registered per-user), running that keep-alive:

  ```powershell
  $action    = New-ScheduledTaskAction -Execute 'wsl.exe' `
                 -Argument '-d Ubuntu-24.04 -u root -e bash /home/clement/keepalive-node.sh'
  $trigger   = New-ScheduledTaskTrigger -AtLogOn -User 'CADIA\clement'
  $principal = New-ScheduledTaskPrincipal -UserId 'CADIA\clement' -LogonType Interactive -RunLevel Highest
  $settings  = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) `
                 -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable `
                 -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName 'OphisRobinhoodNode' -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force
  Start-ScheduledTask -TaskName 'OphisRobinhoodNode'   # start it now, don't wait for next logon
  ```

  **Reliability envelope:** the AtLogOn trigger means the node comes back after a
  reboot ONCE THE OWNER LOGS IN (fine for a workstation that auto- or promptly
  logs in). Truly headless (boot with no login) would need S4U/service + WSL
  working without a user profile, which is finicky and NOT set up here. VALIDATE
  by doing a real reboot and confirming `eth_blockNumber` on :8547 comes back on
  its own; do not trust settlement to it until you've seen that at least once.

---

## Known risks specific to this host (watch these)

1. **RAM (highest).** Robinhood docs say 64 GB min; this box has 26 GB in the VM.
   The counter-case (young non-archive Orbit chain fits in far less) is plausible
   but UNVERIFIED. Watch RSS during restore/prune and steady state:
   `docker stats nitro` and the `:6070` metrics. If it OOMs, the fallbacks are:
   lower `--execution.caching.{trie-clean,trie-dirty,snapshot,database}-cache`,
   or accept that mainnet needs a bigger box and keep the two managed legs only.
2. **DRAM-less NVMe.** The Predator GM7 is an HMB consumer drive; fsync-heavy DB
   writes are slower than datacentre NVMe. Fine for a follower node; would hurt a
   from-genesis sync (not what we do).
3. **Snapshot trust.** Anonymous publisher; the gate in step 6 bounds but does not
   erase the risk. Prefer an official Robinhood snapshot if `chain-developers-
   group@robinhood.com` provides one - set SNAPSHOT_URL/SNAPSHOT_SHA256 and re-run.
4. **Snapshot retention ~3 days.** If a restore stalls for days, the manifest sha
   rotates; re-run `restore-snapshot.sh` to pick up the current file.
