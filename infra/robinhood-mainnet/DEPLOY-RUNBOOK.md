# Robinhood Chain (4663): Master Deploy Runbook

Single ordered guide to take the Ophis Robinhood-chain-4663 sovereign stack from
nothing to live. It consolidates the four canonical docs into one sequence and
flags every requirement the 2026-07 security audit introduced. Read it once
end to end before starting; each phase links the detailed doc for the mechanics,
this file is the ORDER plus the audit deltas, not a copy of the scripts.

Canonical docs (mechanics live there):

| What | File |
|------|------|
| Operator overview + gates | `README.md` |
| Contract ceremony (Ledger) | `deploy/deploy-mainnet-all.sh` |
| Address fill-in | `FILL-IN-AFTER-DEPLOY.md` |
| Nitro node bring-up | `nitro/BRINGUP.md` |
| WSL host specifics | `DEPLOY-WSL.md` |

Related ops runbooks: `docs/operations/allowlist-governance-runbook.md`,
`docs/operations/disaster-recovery-runbook.md`, `docs/operations/e2e-swap-verification.md`.

---

## 0. Pre-flight checklist (before any mainnet transaction)

- [ ] Ledger connected + unlocked, Ethereum app open. This is the deployer HW wallet.
- [ ] Deployer HW wallet funded on 4663 (the ceremony script prints the balance and refuses on empty).
- [ ] The **2-of-3 Ophis protocol Safe** created on 4663 via protocol-kit (the hosted Safe UI does not index 4663). Record its address and the 3 owner addresses, then set `OPHIS_PROTOCOL_SAFE_ROBINHOOD_MAINNET` and `OPHIS_SAFE_EXPECTED_OWNERS` in `.env` BEFORE the ceremony (Phase 1 reads them to validate the Safe).
- [ ] A **new per-chain Tier-1-isolated submitter EOA** generated, funded ~0.02 ETH on 4663, key stored file-backed. Install the key with the history-safe form, never `echo '0x...' | ...`:
      `read -rs PK; printf '%s' "$PK" | sudo install -m 600 -o ophis-driver -g ophis-driver /dev/stdin /home/ophis-driver/.config/submitter.key; unset PK`
- [ ] The Nitro node host (WSL2 or native Linux VM) provisioned, with the Docker data disk mounted (Phase 3).
- [ ] `.env` prepared (Phase 4 lists every variable).
- [ ] Trail of Bits tooling + codex ready for the bytecode gate in Phase 1 (the script hard-stops there).

---

## Phase 1: Contract ceremony (Ledger)  ->  `deploy/deploy-mainnet-all.sh`

Run on a machine with the Ledger, `cast`, and `forge`. The script sequence:

1. Asserts it is talking to chain 4663; validates the Safe has code, `threshold == 2`, and exactly 3 owners; and, only if `OPHIS_SAFE_EXPECTED_OWNERS` is set (strongly recommended), hard-asserts every expected owner is present (rejecting a wrong-but-valid 2-of-3 Safe), otherwise it prints a recommendation and continues. Prints the deployer and submitter balances; requires a typed `yes` to confirm the Safe (it will receive IRREVERSIBLE ownership of the Authenticator).
2. `[1/4]` Deploys GPv2 Settlement + VaultRelayer + Authenticator (Ledger).
3. `[2/4]` Deploys the GPv2 helpers (Balances, Signatures, HooksTrampoline) via `cast send --create --ledger`.
4. **`[GATE]` Deployed-bytecode integrity. THIS IS WHERE TRAIL OF BITS + CODEX RUN.** The script pauses: "Press ENTER ONLY after ToB+Codex confirm bytecode + wiring". Before pressing ENTER:
   - Compare each deployed contract's on-chain codehash against the compiled artifact (`cast code` / slither on the source, plus a codex diff of on-chain bytecode vs the artifact).
   - Confirm the wiring: Settlement points at the Authenticator and the VaultRelayer, Auth manager/owner are still the HW wallet at this point.
   - Do NOT continue until both confirm. If either flags a mismatch, STOP: an interrupted state here is safe, an allowlisted solver on wrong bytecode is not.
5. `[3/4]` Allowlists the driver-submitter EOA on the Authenticator (Ledger).
6. `[4/4]` Transfers Authenticator ownership FIRST, then manager, to the 2-of-3 Safe. The order is deliberate: an interrupted state leaves the Safe with strictly MORE authority than the HW wallet.

Record every deployed address the script prints. You need them in Phase 2.

---

## Phase 2: Fill in addresses  ->  `FILL-IN-AFTER-DEPLOY.md`

Replace every `__FILL_AFTER_DEPLOY_*__` in `configs/*.toml.tmpl` from the ceremony output:

| Placeholder | Source |
|-------------|--------|
| `__FILL_AFTER_DEPLOY_SETTLEMENT__` | deployed `GPv2Settlement` |
| `__FILL_AFTER_DEPLOY_BALANCES__` | Balances helper |
| `__FILL_AFTER_DEPLOY_SIGNATURES__` | Signatures helper |
| `__FILL_AFTER_DEPLOY_HOOKS__` | HooksTrampoline |
| `__FILL_AFTER_DEPLOY_SUBMITTER_EOA__` | the driver-submitter EOA |
| `__FILL_AFTER_DEPLOY_ETHFLOW__` | `CoWSwapEthFlow`, only when native-ETH sells are enabled (commented + deferred day-1, but `render-configs.sh` greps comments too, so replace it there as well) |

The Safe env (`OPHIS_PROTOCOL_SAFE_ROBINHOOD_MAINNET`, `OPHIS_SAFE_EXPECTED_OWNERS`) was already set in pre-flight for the Phase 1 ceremony; `render-configs.sh` reads it too.
Do NOT change the verified constants: WETH9 `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`,
USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, LiFi 4663 router `0xB477751B76CF82d00a686A1232f5fCD772414Af3`.

---

## Phase 3: Nitro node bring-up  ->  `nitro/BRINGUP.md`  (on the node VM)

WSL2/Linux distro, Docker Engine inside the distro, the restore/verify tools, then repo + `.env` (set `L1_EXECUTION_RPC`, `L1_BEACON_URL`, `NITRO_DATA_DIR`), then:

**Snapshot restore (AUDIT-CHANGED: now fail-closed).** `restore-snapshot.sh` will not trust the mirror-supplied manifest checksum by default. Choose one:
- RECOMMENDED, authenticate with a checksum obtained OUT OF BAND from a trusted channel (not the mirror):
      `SNAPSHOT_SHA256=<64-hex> ./restore-snapshot.sh`
- Explicit opt-out (unverified third-party snapshot, transit integrity only):
      `I_ACCEPT_UNVERIFIED_SNAPSHOT=1 ./restore-snapshot.sh`

**First start.** Bring the node up so it serves RPC on `:8547`, bound to host loopback only (never expose `:8547` publicly; the shared-network alias is `ophis-rbh-node:8547`).

**Trust gate (AUDIT-CHANGED: now a hard gate).** WITH THE NODE RUNNING, run `verify-snapshot.sh` (it queries the live node). It exits non-zero if the L1 `AssertionConfirmed` anchor check fails or cannot run (node/RPC unreachable, non-array response, no matching anchor). Do NOT wire the node into eRPC until it passes. It anchors the header chain to L1 only; the flat state behind those headers still rests on whether the snapshot publisher is trustworthy (see the trust section in `BRINGUP.md`).

Then expose to eRPC and make it survive reboots.

---

## Phase 4: Stack bring-up  ->  `compose-up.sh`

Fill `.env` (see `.env.example`). Audit-relevant variables:

- `POSTGRES_PASSWORD`: `compose-up.sh` materializes the gitignored `secrets/postgres-password` from it. AUDIT-CHANGED: the DB container reads its password from that secret file (`POSTGRES_PASSWORD_FILE`), and Flyway reads `FLYWAY_PASSWORD`, so the password is no longer visible in `docker inspect`.
- `TELEGRAM_BOT_TOKEN`: also place the raw token in `secrets/telegram-token` (chmod 600, owned by the deploy user). AUDIT-CHANGED: `render-configs.sh` writes the uid-65534 container copy for alertmanager, and the host `settlement-anomaly-watch.sh` reads `secrets/telegram-token` (it can no longer read the container copy). On macOS setup, `setup-telegram-keychain.sh` now feeds the token to `security` on stdin, not on argv.
- `ALCHEMY_API_KEY` and `CHAINSTACK_API_KEY` (the BARE keys, the templates prepend the URL), `COINGECKO_API_KEY`, and `OPHIS_INTER_SERVICE_AUTH_TOKEN`.
- LEAVE `OPHIS_DRIVER_SUBMITTER_KEY` EMPTY. The submitter PK is file-based at `/home/ophis-driver/.config/submitter.key` (installed in pre-flight, read by `render-configs.sh` via sudo); `render-configs.sh` rejects a non-empty value here.
- Leave `ROBINHOOD_RPC_INTERNAL` EMPTY. Setting it bypasses the eRPC 3-of-4 consensus proxy; `compose-up.sh` refuses to start unless you also set `ALLOW_RPC_BYPASS=1`.

Then `./compose-up.sh`. It sources `.env`, materializes the postgres secret, runs `render-configs.sh` (which fails closed if any `__FILL_AFTER_DEPLOY_*__` placeholder remains), and brings the stack up.

---

## Phase 5: Verify

- `SETTLEMENT=<deployed-4663-settlement> ./scripts/check-settlement-buffer.sh`. AUDIT-CHANGED: `SETTLEMENT` is now env-configurable and the script exits with a `skipped` JSON if it is still the placeholder; it monitors the WETH9/USDG buffers on 4663 (was querying Optimism addresses before).
- `./scripts/verify-e2e-swap.sh --owner <0xUserWallet>` after placing a test order (the `--owner` arg is required). AUDIT-CHANGED: it reports VERIFIED only when the Trade-event match count for that owner is a positive integer (it no longer passes on an empty count).
- `python3 assert-erpc-failclosed.py configs/erpc.yaml.tmpl`. AUDIT-CHANGED: it now reports the `preferBlockHeadLeader` pricing residual accurately instead of certifying it as fully fail-closed. See the decision below.

---

## Audit-introduced decisions (make these consciously)

1. **eRPC `eth_call` uses `preferBlockHeadLeader`** (single-upstream-selectable on a dispute) for availability, because `returnError` there failed ~30-50% of `latest` reads (#476). This is acceptable for day-1, where quote pricing comes from LiFi's off-chain API. BEFORE you enable a self-run pricing solver (a V4Quoter reading prices through `eth_call`), flip that consensus rule to `disputeBehavior: returnError` (fully fail-closed) and accept the availability cost. The by-hash settlement-decode reads are already `returnError`.
2. **node-exporter disk metrics** mount only `/var/lib/docker` read-only (so the disk-full alerts keep paging without exposing the compose-dir secrets). If the Docker data disk is mounted elsewhere on this VM, edit that one path in `docker-compose.yml`.
3. **Image digests** (eRPC, postgres, busybox) are pinned by `@sha256`. Bump them deliberately when you update, not implicitly.

---

## Rollback and safety

- Ceremony: the ownership-transfer ordering means a Ctrl-C leaves the Safe with more authority than the HW wallet (fail-safe). If the Phase 1 bytecode gate fails, STOP before `addSolver`.
- Snapshot: if `verify-snapshot.sh` fails, the node is not trustworthy. Do not wire it to eRPC (see `docs/operations/disaster-recovery-runbook.md`).
- Disk: never `rm` container logs. `truncate -s 0` them (the ENOSPC crash-loop is the documented outage). The alerts page on `node_filesystem_*{fstype="ext4"}`.

---

## Appendix: Vault policy module deploy (separate target)

The `OphisVaultPolicyModule` (curator-gated vault-rebalance module) deploys to the
VAULT chains (Optimism, Base, Arbitrum, Unichain, Ethereum), NOT chain 4663, via
`contracts/script/DeployVaultPolicyModule<Chain>.s.sol` (Ledger). The audit deltas
are already wired into those scripts:

- `allowNoSequencerFeed`: Ethereum L1 = `true` (no sequencer), every L2 = `false` with a real `SEQ_FEED`. A zero feed without the flag now reverts `SequencerFeedRequired` at construction (fail-closed instead of a silently disabled gate).
- Per-token `minPrice18` / `maxPrice18` bounds are set, so a clamped/depegged Chainlink price reverts `OraclePriceOutOfBounds` instead of lowering the floor.
- `MAX_SLIPPAGE_BPS_CAP` is now 1000 (10%), was 5000 (50%).

Before deploying, run `forge test` (322 green as of this writing) and validate the
deployed module with slither + a codex bytecode check, same gate discipline as
Phase 1.
