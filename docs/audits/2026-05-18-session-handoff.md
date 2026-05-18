# Session Handoff — 2026-05-18

**Reason for handoff:** Mac mini macOS update (Tahoe 26.4.1 → 26.5) requiring reboot. Capture state so the next session can resume cleanly.

## Completed this session

### Phase 1 audit (PR #68 — batch 1)

Branch: `feat/phase1-audit-hardening-batch1` ([PR #68](https://github.com/ophis-fi/ophis/pull/68))

8 findings shipped, Codex-Cyber-reviewed, awaiting merge:
- **HIGH-4** autopilot `max-settlement-transaction-wait = 120s`
- **MEDIUM-3** frontend ethFlow zero-EthFlow guard inside try/catch
- **MEDIUM-5** driver `gas-price-cap` 10 → 100 gwei
- **MEDIUM-6** orderbook `eip1271-skip-creation-validation = false` (HL + OP + MegaETH mirror)
- **MEDIUM-9** `OphisHlBlockTimeDrift` Prom alert via real `last_block_number` metric
- **LOW-1** `HYPERSWAP_V3_SUBGRAPH_URL` empty-string error (not silent default)
- **LOW-2** deploy `manager()` pre-handoff atomic-init assertion
- ~~MEDIUM-4~~ withdrawn — `latest.gasLimit` check was structurally invalid (HL big-block routing is per-address, not global)

### Phase 1 audit (PR #69 — batch 2)

Branch: `feat/phase1-audit-hardening-batch2` ([PR #69](https://github.com/ophis-fi/ophis/pull/69), stacked on #68)

- **MEDIUM-7** AllowList IMPL lock — **DONE on-chain** (all 3 mainnets):
  - HL: tx `0x0042f9b3748a51df4385c8c359f28a791b035dca1c797db45a293948c5a78f78` (block 35424809)
  - OP: tx `0xca38b4a87c8c06c03ede817fea06240d8878f60820e5c2bb8a450bc06b32cf6f` (block 151750173)
  - MegaETH: tx `0xca6e902deb38e9ab1258b8c6c606587b06abfa6a42df0ca827776e12babe3ff0` (block 16302115)
  - IMPL at `0xfab54856b6731bc0c32904be5297a627d9fdfa31` (CREATE2-deterministic across chains); `manager() = 0xe049…01cF` on all 3.
  - Re-call attempt verified to revert `Initializable: initialized`.
- **HIGH-2** WHYPE↔WETH9 parity — **empirically validated**:
  - WHYPE codehash `0xe2e18bc11f218432ca1aabc44b53cce54a78c77ae2d76093a577e0564a77aa04`, 2042 bytes (33% smaller than canonical WETH9 3125 bytes; different implementation).
  - Functional ABI matches WETH9 for every path EthFlow + Spardose depend on. 5 on-chain tests pass (approve/withdraw/deposit/fallback/balanceOf slot 3).
  - Full report: `docs/audits/2026-05-18-whype-weth9-parity.md`
  - Defense-in-depth: `OphisHlEthFlowTransferFailed` Prom alert added (canaries any future divergence).
- **HIGH-3** Submitter PK custody — ADR drafted: `docs/architecture/2026-05-18-submitter-pk-custody-adr.md`
  - Recommended: **Tier 1 free** (dedicated `ophis-driver` macOS user) NOW + optional Tier 2 (AWS KMS) later.
  - Ledger NOT viable for solver-submitter (per-tx button press).

### HIGH-1 protocol Safe (closed via Clement's on-chain action)

Protocol Safe `0xe049a64546fb8564CC4c7D64A0A1BAe00Aa801cF` is now 2-of-3 on all 3 mainnets (HL + OP + MegaETH).
- New 3rd owner: `0x746Ad9C63cCA6d3A8588731d60Fb87deaB4da46A`
- MegaETH addOwner tx today: `0x46283cdc89897480ce362ad1652746b98d2106278eb3d7b20825fbfd9f805ea7`

### Partner-fee Safe (separate from protocol Safe)

Partner-fee Safe `0x858f0F5eE954846D47155F5203c04aF1819eCeF8` (CIP-75 rebate recipient):
- ✅ OP: 2-of-3
- ⚠️ ETH mainnet: still 2-of-2 (pending — task #143)
- ⚠️ Gnosis: still 2-of-2 (pending — task #143)
- ⚠️ MegaETH: still 2-of-2 (pending — task #143)

## Tier 1 PK isolation — IN PROGRESS

`./infra/tier1-pk-isolation-setup.sh` was started but interrupted at Step 3.

**State on Mac mini RIGHT NOW (before reboot):**
- ✅ `ophis-driver` macOS user EXISTS (UID 502, /Users/ophis-driver, /usr/bin/false shell)
- ❌ `/Library/Keychains/ophis-driver.keychain-db` NOT created yet
- ❌ `/etc/ophis-driver-keychain.pass` NOT created yet
- ❌ PK NOT copied into system keychain yet
- ✅ PK still in scep's login keychain at service `ophis-driver-submitter-2026-05-14` (unchanged, original)

**After macOS update, to resume:**

```bash
cd /Users/scep/greg
git pull
./infra/tier1-pk-isolation-setup.sh
```

The script is idempotent — Step 2 will detect `ophis-driver` exists and skip. Step 3 will pick up from system-keychain creation. Sudo password will be needed.

**After Step 3-4 complete, the script lists 5A-D follow-ups as MANUAL steps:**
- 5A: launchd plist update (driver runs as `ophis-driver`)
- 5B: render-configs.sh patch (read PK from system keychain, not `.env`)
- 5C: delete plaintext `OPHIS_DRIVER_SUBMITTER_KEY` from `~/greg/infra/<chain>-mainnet/.env`
- 5D: drain old keychain entry (point of no return)

These need a maintenance window. Driver / autopilot / orderbook containers stay running on the OLD keychain path the whole time until Step 5A-D land.

## Open Phase 1 follow-up tasks (after reboot priority order)

1. **Finish Tier 1** (~30 min): re-run setup script, then Steps 5A-D in a maintenance window.
2. **Install Tier 1.A patches** (5 min): macOS 26.5 — happening now via this reboot.
3. **Tier 1.B YubiKey C Bio sudo MFA** (~30 min): biggest per-hour-spent win. See `docs/architecture/2026-05-18-mac-mini-root-hardening.md`.
4. **Merge PR #68 + PR #69** (after CI passes).
5. **Task #143**: partner-fee Safe 3rd signer on ETH/Gnosis/MegaETH (3 Safe txs, Clement's Ledgers).
6. **Task #136**: max-settlement-transaction-wait + RPC redundancy (eRPC sticky-routing OR driver code).
7. **Task #140**: driver-side hook gas preflight (Rust change).
8. **Task #142**: wire HL basefee Prom metric producer.

## Phase 2-5 audit roadmap (unchanged from original plan)

- Phase 2: backend stack (autopilot, orderbook, driver, baseline solver, KyberSwap solver)
- Phase 3: frontend (cowswap-frontend, sdk patches, OPHIS_ETHFLOW_OVERRIDES wiring)
- Phase 4: infra (Cloudflare Tunnels, eRPC, docker-compose, observability)
- Phase 5: cross-chain rollover audit on OP + MegaETH

Not started yet — green-light when Phase 1 follow-ups land.

## Quick post-reboot health-check sequence

```bash
# 1. macOS hardening still on
fdesetup status
csrutil status
spctl --status
/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate

# 2. ophis-driver user survived reboot
dscl . -read /Users/ophis-driver | grep RecordName

# 3. Driver/autopilot containers up
docker ps | grep -E "driver|autopilot|orderbook"

# 4. All 3 chains responsive
cast block-number --rpc-url https://rpc.hyperliquid.xyz/evm
cast block-number --rpc-url https://mainnet.optimism.io
cast block-number --rpc-url https://mainnet.megaeth.com/rpc

# 5. Safes still 2-of-3
cast call 0xe049a64546fb8564CC4c7D64A0A1BAe00Aa801cF "getOwners()(address[])" --rpc-url https://rpc.hyperliquid.xyz/evm

# 6. AllowList IMPL still locked
cast call 0xfab54856b6731bc0c32904be5297a627d9fdfa31 "manager()(address)" --rpc-url https://rpc.hyperliquid.xyz/evm
# expected: 0xe049a64546fb8564CC4c7D64A0A1BAe00Aa801cF
```
