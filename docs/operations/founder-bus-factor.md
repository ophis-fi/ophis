# Founder bus-factor playbook

**Audience:** anyone other than Clement (operator, partner ops, post-Clement
maintainer) who needs to keep Ophis running without him.

**Why this exists.** Ophis's protocol code is open, but the *operational
knowledge* — which Safe owns what, where the submitter PK lives, how to
rotate it, how to redeploy, what's load-bearing on the Mac mini — was
mostly in Clement's head. This document moves it out. Read it
end-to-end before assuming anything.

**Last updated:** 2026-06-04 (bus-factor verification pass: corrected hosting
to Cloudflare Pages, repo org to `ophis-fi/ophis`, driver/orderbook ports to
8103/8102, partner-fee Safe config, pg_dump cadence/DB name, EIP-55-canonicalized
addresses, refreshed stale CONTRIBUTING.md / op-runbook TODOs).

---

## 1. What Ophis is, mechanically

- **One codebase fork** of [`cowprotocol/services`](https://github.com/cowprotocol/services).
- **One live deployment** today: Optimism mainnet (chain 10). HL was paused
  2026-05-19 — contracts deployed on chain 999, no stack running.
- **Revenue model:** CIP-75 partner-fee rebates skimmed from settled
  orders, paid to a Safe.
- **Per-chain stack:** db, autopilot, orderbook, driver, baseline+kyberswap+
  okx+velora solvers, rpc-proxy (eRPC), prometheus, alertmanager. All in
  `infra/<chain>-mainnet/docker-compose.yml`.

---

## 2. Addresses you must know

### 2.1 Submitter EOA (the hot key)

```
0x92B9bE5e96795E8630fDC61efb0e705E75b1A1B1
```

Single EOA, same address across all chains. Signs every settlement tx.
Allowlisted as solver on each chain's `GPv2AllowListAuthentication`
contract. If this EOA is compromised, the attacker becomes an
allowlisted solver until evicted: they can submit settlements and route
through arbitrary contracts, but **every settlement is still bounded by
each order's on-chain signed limit** — VaultRelayer only honours the
immutable Settlement, and `settle()` reverts unless every trader
receives at least their signed minimum-buy. Worst case is therefore
surplus/MEV extraction on *in-flight* signed orders plus censorship/DoS
— **not** draining idle wallets or arbitrary token approvals. Eviction:
2-of-3 `removeSolver` (Section 4.2). See `../../SECURITY.md` for the
disclosure process and the known-residuals list.

**PK custody (Tier 1):** plaintext file at
`/Users/ophis-driver/.config/submitter.key` on the Mac mini.
Owned by user `ophis-driver`, home dir mode `0700`, file mode `0600`.
Loaded into renders via `sudo cat` in `render-configs.sh`. Not in any
Keychain.

**Rotation:** generate a new EOA (`cast wallet new`), get current
solver-submitter REMOVED + new one ADDED via Safe vote on the
authenticator (Section 4.2 below). Update
`/Users/ophis-driver/.config/submitter.key`, re-render, restart driver.

### 2.2 Protocol Safe (cold)

```
0xe049a64546fb8564CC4c7D64A0A1BAe00Aa801cF
```

**2-of-3 multisig**, Safe 1.4.1. Threshold (2) and the three owner
addresses (`0x746Ad9C63cCA6d3A8588731d60Fb87deaB4da46A`,
`0x0494F503912C101Bfd76b88e4F5D8A33de284d1A`,
`0xBeC5B03ffDcac50071693E87bFDb88bAa6710199`) are verified on-chain.
The owners are intended to be Clement's 3 Ledger Nano devices — on-chain
proves they are plain EOAs but cannot prove hardware-wallet backing.

The address is CREATE2-deterministic and identical across chains *where
deployed*: confirmed live on Optimism (10), HyperEVM (999), and MegaETH
(4326). It is **NOT** currently deployed on Ethereum mainnet (1) or
Gnosis (100) — the address is only reserved there, not a live Safe.

This Safe is the `manager()` of the AllowList authenticator on every
chain. Any change to allowlisted solvers requires 2-of-3 Ledger
signatures.

**Per-chain AllowListAuthentication addresses** (the contract that
`addSolver` / `removeSolver` is called on — these are NOT in the
chain's tomls because the CoW configs only list `signatures`, which is
a different contract / signature validator):

| Chain | AllowListAuthentication address |
|---|---|
| Optimism mainnet (10) | `0xAAA13bC6C1A505ccE6B4BF262fdDf4c703B9BD70` |
| HyperEVM mainnet (999) — paused | check `Settlement.authenticator()` on chain |
| MegaETH mainnet (4326) — paused | check `Settlement.authenticator()` on chain |

To look up the AllowList address for any chain (canonical reference,
in case the per-chain table above goes stale):

```bash
cast call --rpc-url <RPC> <SETTLEMENT_ADDRESS> "authenticator()(address)"
```

**For the rotation procedure (§4.2), the Safe Transaction Builder
target is the AllowListAuthentication contract** (above), NOT the
Settlement contract and NOT the signatures validator
(`0x5f315a204e7971fc29a66fef3a5773f6b0202fac` on OP — common point of
confusion, that's the EIP-1271 signature validator listed as
`signatures` in the CoW config — canonical EIP-55 is
`0x5f315A204E7971fC29a66fef3a5773f6B0202fac`). 2026-05-20 incident: rotation
simulation reverted because the batch targeted the signatures
validator instead of the AllowList — see
[[feedback-allowlist-not-signatures]].

### 2.3 Partner-fee Safe (cold)

```
0x858f0F5eE954846D47155F5203c04aF1819eCeF8
```

CREATE2-deterministic, deployed on multiple chains. **Verified on-chain
(2026-06-04):**

- **Optimism (10):** Safe 1.4.1, **2-of-3**, owners identical to the
  protocol Safe set (`0x746Ad9C6…4da46A`, `0xBeC5B03f…0199`,
  `0x0494F503…284d1A`).
- **Gnosis (100)** and **Ethereum (1):** Safe 1.4.1, **2-of-3** (raised from
  2-of-2 on 2026-06-05 by adding the 3rd owner), owners identical to Optimism:
  `0x746Ad9C63cCA6d3A8588731d60Fb87deaB4da46A`,
  `0xBeC5B03ffDcac50071693E87bFDb88bAa6710199`,
  `0x0494F503912C101Bfd76b88e4F5D8A33de284d1A`.

The earlier "1-of-1, owner `0x0494F503…` only, lives on Gnosis" note was
**wrong on every dimension** and has been corrected from on-chain reads.
No single-signer config exists on any verified chain.

**Per-chain threshold unified (2026-06-05):** all three chains are now 2-of-3
with the same owner set — verified on-chain (`getThreshold()` == 2 and
`getOwners()` == the 3-address set on OP, Gnosis, and Ethereum).

### 2.4 Settlement contracts (per chain)

Same deterministic CREATE2 deployment as upstream CoW Protocol. Reference
`infra/<chain>-mainnet/configs/<chain>.toml` for the specific addresses.
Settlement, VaultRelayer, AllowList authenticator are the trio.

---

## 3. Where things live (physical / infra)

| Thing | Where | What if it dies |
|---|---|---|
| Mac mini (`scep.local`) | Clement's apartment, Luxembourg | Whole Ophis stack down. Recovery: bring up a replacement host with the same docker-compose, restore Postgres dumps from off-site backup (Section 6), restore `submitter.key` from off-site (Section 5). |
| Submitter PK | Mac mini at `/Users/ophis-driver/.config/submitter.key` | Settlement dispatch blocked. Solver shows liveness alarm. Recovery: Section 4.2 to rotate the EOA. |
| Ledger #1, #2, #3 | Clement's home, separately stored | If 1 is lost, still 2-of-3 → ops continue. If 2 are lost, Safe is bricked — need to factory-reset survivor + seed-restore, OR deploy a new Safe + migrate (Settlement contract `manager()` is non-rotatable, so a Safe loss = redeploy authenticator). |
| Cloudflare account | `4761b41ef352631db0ed367fea98ffdc` | DNS + tunnels (`mcp-api.3615crypto.com`, `allo.3615crypto.com`, `optimism-mainnet.ophis.fi`) AND the Ophis frontends (Cloudflare Pages — see next row). Account loss = everything below it down. |
| Cloudflare Pages (frontends) | `4761b41ef352631db0ed367fea98ffdc` account | All three live surfaces are CF Pages projects, auto-deployed from `ophis-fi/ophis` main via GitHub Actions (`wrangler pages deploy`): project `greg` → `swap.ophis.fi`, `ophis-docs` → `docs.ophis.fi`, `ophis-landing` → `ophis.fi`. MCP server is a CF Worker (`@ophis/mcp-server`). NOT Vercel — the `vercel.json` files in the repo are inherited CoW upstream sub-apps, not the deployed surfaces. Stop = static frontend cached at edge for a while, then 404. |
| Aleph VMs | postiz-stuart, mcp-services, allo.3615crypto | None are load-bearing for Ophis core (these are Stuart / mcp / allo work). |
| Tailscale | `100.100.107.110` (Mac mini IP) | Remote shell into Mac mini stops working. Stack stays up. |
| GitHub `ophis-fi/ophis` | org `ophis-fi` (owned by the `san-npm` account) | Source of truth. Canonical remote: `https://github.com/ophis-fi/ophis.git`. `san-npm` is the personal account that owns the org — the repo slug is always `ophis-fi/ophis`. |
| Domain `ophis.fi` | Registered via Cloudflare. Renewals: Clement. | If lapses, frontend serves a parking page. |

### 3.1 Mac mini health checklist

Quick reach-out to `ssh scep@100.100.107.110` (Tailscale) or in-person:

```bash
docker compose -f ~/greg/infra/optimism-mainnet/docker-compose.yml ps
df -h /                        # disk
top -l 1 | head -10            # cpu/mem
launchctl list | grep ophis    # any persistent services
```

If `df` shows < 5GiB free → `docker system prune -af` then full disk
audit. Disk pressure has crashed the stack before (2026-05-15 incident).

---

## 4. Common runbooks

### 4.1 Stack down / containers unhealthy

```bash
ssh scep@100.100.107.110            # or in-person at Mac mini
cd ~/greg/infra/optimism-mainnet
docker compose ps                    # see who's red
docker compose logs --since=10m driver autopilot orderbook | grep -iE "error|panic|fatal" | tail -50
```

**Common causes & fixes:**

| Symptom | Fix |
|---|---|
| All containers down | `docker compose up -d` |
| Driver crash-looping on bootstrap | Check eRPC consensus (`docker compose logs rpc-proxy --tail=50`). If consensus is failing, look at upstream RPC health: `for u in <upstreams>; do cast block-number --rpc-url $u; done` |
| Orderbook 503 | Check Postgres: `docker exec optimism-mainnet-db-1 pg_isready`. If down: `docker compose restart db`, wait 10s, then `docker compose restart orderbook autopilot`. |
| Driver healthz red but logs clean | `curl http://localhost:8103/healthz`. The driver runs balance check + consensus check + chain_id match. Any failing component is reported in the JSON body. |
| Autopilot ERROR logs about `essential maintenance` | This is the PR #89 visibility fix — autopilot view is stalling. Usually upstream RPC consensus failure. Same fix as driver crash-loop above. |

If nothing helps: `docker compose down && docker compose up -d --build` (full rebuild). Takes 10-15min on Mac mini.

### 4.2 Rotate the submitter EOA

You need this when:
- The Mac mini was potentially compromised.
- The submitter.key file was accidentally exposed (committed, screen-shared, emailed).
- A Phase audit recommends rotation.

**Steps:**

1. **Generate the new EOA** (offline if possible):
   ```bash
   cast wallet new
   # outputs: Address: 0x...newaddr
   # outputs: Private key: 0x...newpk
   ```

2. **Stage the new file**:
   ```bash
   sudo install -m 600 -o ophis-driver -g staff /dev/stdin /Users/ophis-driver/.config/submitter.key.NEW <<< '0x...newpk'
   ```

3. **Update AllowList via Safe** — protocol Safe (`0xe049…01cF`, 2-of-3 Ledgers):
   - Open Safe webapp on the chain you're rotating: `https://app.safe.global/transactions/queue?safe=oeth:0xe049a64546fb8564CC4c7D64A0A1BAe00Aa801cF`
   - Queue 2 transactions:
     - `removeSolver(address oldSubmitter)` — current `0x92B9…1A1B1`
     - `addSolver(address newSubmitter)` — your new address from step 1
   - Sign with 2 of the 3 Ledger devices.
   - Execute. Wait for confirmation.
   - **Repeat for every active chain.** Today: only Optimism.

4. **Swap the PK file**:
   ```bash
   sudo mv /Users/ophis-driver/.config/submitter.key /Users/ophis-driver/.config/submitter.key.OLD
   sudo mv /Users/ophis-driver/.config/submitter.key.NEW /Users/ophis-driver/.config/submitter.key
   ```

5. **Re-render + restart**:
   ```bash
   cd ~/greg/infra/optimism-mainnet
   ./render-configs.sh
   docker compose up -d --force-recreate driver
   ```

6. **Verify**: the driver healthz endpoint shows the new submitter:
   ```bash
   curl http://localhost:8103/healthz | jq '.submitter'
   ```

7. **Shred the old key** after 24h of clean operation:
   ```bash
   sudo shred -u /Users/ophis-driver/.config/submitter.key.OLD
   ```

### 4.3 Resume HL (if a paying partner asks)

```bash
cd ~/greg/infra/hyperevm-mainnet
./render-configs.sh
docker compose up -d --build
```

Then add `0x92B9…1A1B1` to chain 999's `AllowList.addSolver(...)` if it
was removed (likely still there — we only stopped containers, didn't
touch on-chain state).

Re-arm alerts: Alertmanager comes up with the stack and the silences
expired ~24h after the 2026-05-19 pause.

### 4.4 Renew domain / Cloudflare / Vercel

- **`ophis.fi`**: Cloudflare Dashboard → Domains → ophis.fi → ensure
  auto-renew on. Account: Clement's email.
- **Frontend deployment (Cloudflare Pages)**: all three surfaces
  auto-deploy from `ophis-fi/ophis` main via GitHub Actions
  (`wrangler pages deploy`): project `greg` → `swap.ophis.fi`,
  `ophis-docs` → `docs.ophis.fi`, `ophis-landing` → `ophis.fi`. To
  trigger manually, re-run the relevant workflow or run the
  `wrangler pages deploy` command from the workflow against a local
  build. (There is NO root Vercel project; do not run `vercel --prod`.)
- **Cloudflare Tunnels** (for `mcp-api.3615crypto.com`,
  `allo.3615crypto.com`, `optimism-mainnet.ophis.fi`): the tunnel daemon
  (`cloudflared`) runs on Mac mini via launchd.
  `launchctl list | grep cloudflared` to verify.

---

## 5. Off-site backups (do this before assuming bus-factor risk)

Two things are **only on the Mac mini** as of 2026-05-19 and would brick
Ophis if the Mac mini died:

### 5.1 Submitter PK

`/Users/ophis-driver/.config/submitter.key` — 32-byte hex.

**Backup strategy:** offline-only. NEVER in iCloud / Dropbox / Gmail /
second-Mac / partner-laptop / Notion / 1Password cloud.

Suggested:
- Encrypted USB stick (FileVault-style full-disk encrypt; passphrase in
  Clement's head OR a sealed envelope at a different physical location).
- Stored in a fire-rated safe, NOT in the same room as the Mac mini.
- Tested annually: plug in, decrypt, diff against live key, re-seal.

Alternative (slightly stronger): print the hex on paper + laminate +
safe deposit box. Recovery is annoying (re-type the hex) but the
backup itself cannot be hacked.

### 5.2 Postgres dumps (orderbook + autopilot state)

Daily dump → S3-compatible storage with version retention.

**Automated (this is where the real dumps live during DR):** a LaunchAgent on
the Mac mini runs `infra/shared/cron/postgres-backup.sh` daily at 03:30 (see
`postgres-backup-setup.md`). It writes `op-YYYY-MM-DD.pgdump` (mode 0600, 14-day
local retention) to:
```bash
$HOME/.local/state/ophis/pg-backups/op-$(date +%F).pgdump
```
The script also validates each dump, prunes old ones, and pushes off-site when
`REMOTE_BACKUP_CMD` is set (Backblaze B2 / AWS S3 / Hetzner Storage Box, ~$1/mo).

Manual one-off to the SAME location (do not invent a `~/backups/` path; DR looks
in the dir above):
```bash
docker exec optimism-mainnet-db-1 pg_dump -Fc -U ophis ophis \
  > "$HOME/.local/state/ophis/pg-backups/op-$(date +%F).pgdump"
```

Restore: `pg_restore -d ophis -U ophis < "$HOME/.local/state/ophis/pg-backups/op-2026-XX-XX.pgdump"`.

### 5.3 Ledger seed phrases

3 Ledgers, 3 seed phrases. Each is independently stored offline in
Clement's safe. Treat as critical infra:
- 2 of 3 lost = Safe is signature-stuck. Need to factory-reset survivor
  + restore from seed + recover.
- 3 of 3 lost = Safe is bricked, requires authenticator redeploy (which
  is a real operation, several hours of careful work).

Recommendation: any operator other than Clement should know WHERE the
3 seeds are stored (not the seeds themselves — just the locations) so
they can be retrieved by Clement's next-of-kin in emergency.

---

## 6. Decision authority (who can do what)

| Action | Authority | Why |
|---|---|---|
| Restart a container | Anyone with Mac mini ssh access | No on-chain consequence |
| Read logs | Anyone with Mac mini ssh access | Read-only |
| Update `infra/<chain>-mainnet/configs/*.toml` & redeploy | Anyone with Mac mini ssh + git push to `ophis-fi/ophis` | Reversible; PR + review preferred but not required for emergencies |
| Rotate submitter EOA | Operator + 2 of 3 Ledger holders | Requires Safe vote (Section 4.2) |
| Add new allowlisted solver | 2 of 3 Ledger holders | Safe vote |
| Deploy new Settlement contract | Clement (auditor sign-off first) | High-stakes, one-way |
| Move accrued partner fees out of the Safe | 2 signers (OP 2-of-3; Gnosis/Eth 2-of-2) | Multisig-gated, not single-key — see §2.3. Roadmap 1.8: unify the threshold across chains. |
| Press the big red button (stop all Ophis containers) | Anyone with Mac mini access | No on-chain consequence; users see "Ophis offline" but their funds are safe in Settlement contract |

**What CANNOT be undone without Clement / multi-sig action:** any
on-chain state mutation (allowlist changes, Safe vote, contract deploy).

---

## 7. Resuming from a cold start

Suppose: someone has the Mac mini's submitter PK and the GitHub
checkout, but zero context. Order of operations:

1. **`git clone https://github.com/ophis-fi/ophis.git`** somewhere with
   docker + 8GB RAM + 40GB disk.
2. **Restore `submitter.key`** to `/Users/ophis-driver/.config/`
   (mode 600, owned by a dedicated user).
3. **Copy `.env` files** (NOT in git — store these encrypted offsite):
   ```
   ~/greg/infra/optimism-mainnet/.env
   ```
   Required vars: `OPTIMISM_RPC` (Alchemy), `OPTIMISM_RPC_INTERNAL`,
   `ALCHEMY_API_KEY`, `OKX_API_KEY`, `OKX_API_SECRET`, `OKX_API_PASSPHRASE`,
   `OKX_API_PROJECT`, `TELEGRAM_BOT_TOKEN`, `HYPERSWAP_V3_SUBGRAPH_URL`
   (HL only — skip if HL paused).
4. **Render configs**:
   ```bash
   cd ~/greg/infra/optimism-mainnet && ./render-configs.sh
   ```
5. **Restore Postgres state** (Section 5.2).
6. **Bring up the stack**:
   ```bash
   docker compose up -d --build
   ```
7. **Wait 5 minutes**, then verify:
   ```bash
   curl localhost:8103/healthz | jq          # driver
   curl localhost:8102/api/v1/version | jq   # orderbook
   docker compose logs autopilot --since=2m | grep -iE "error|panic" | tail -10
   ```
8. **Bring up FE separately**: the frontends are Cloudflare Pages, not
   Vercel. Push to `ophis-fi/ophis` main (GitHub Actions runs
   `wrangler pages deploy` for `greg`/`ophis-docs`/`ophis-landing`), or
   run the workflow's `wrangler pages deploy` command against a local
   build. See §4.4.

If anything looks wrong, the runbooks in Section 4 cover most cases.

---

## 8. Where the rest of the knowledge is

- **Roadmap**: `[project_ophis_roadmap.md](../../../.claude/projects/-Users-scep/memory/project_ophis_roadmap.md)` (Clement's memory).
  Eventually move into `docs/roadmap.md` when stable.
- **Audit history**: `docs/audits/`.
- **Architecture decisions**: `docs/architecture/`.
- **Operational runbooks**: `docs/operations/` (this file + HL-specific
  one).
- **Spec validations**: `docs/development/`.
- **Repository conventions**: `CONTRIBUTING.md` (exists at repo root as
  of 2026-05-20).
- **Upstream CoW Protocol docs**: <https://docs.cow.fi>.

---

## 9. Things that aren't documented but should be (TODO)

- `docs/operations/safe-rotation-runbook.md` — full step-by-step for
  rotating any of the 3 Safes or adding signers.
- Recovery test — a periodic dry-run of the cold-start procedure in
  Section 7, to keep the recovery muscle warm.
