# Spec 5 — Pre-mainnet security hardening (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace 1-of-1 software-key authority over Greg's protocol contracts with a 2-of-3 Safe + hardware-wallet deploy flow + real-time allowlist event monitoring, before any mainnet contract deploy.

**Architecture:** HW wallet `0xBeC5B03f…0199` signs CoW core mainnet deploys via `@nomicfoundation/hardhat-ledger` + `cast --ledger`. Same script transfers AllowListAuthentication ownership to a 2-of-3 Safe within seconds of proxy deploy. Partner-fee Safe at `0x858f…CeF8` upgrades from 1-of-1 to 2-of-3 with the same signer set. AllowList mutation events monitored continuously by the existing rebate-indexer alerter, with a 60s Telegram alert latency target.

**Tech Stack:** Ledger Nano hardware wallet, `@nomicfoundation/hardhat-ledger` plugin, foundry `cast --ledger`, Safe Wallet Web UI (app.safe.global), the existing rebate-indexer alerter (`apps/rebate-indexer/src/alerter.ts`).

**Open questions from spec — resolved here:**
1. **Recovery co-signer identity:** **OPEN** (Clement to pick). Plan assumes "to be filled" placeholder.
2. **Same-address-across-chains for protocol Safe:** Yes. Use identical owner set + identical salt across chains so the Safe CREATE2 address matches everywhere.
3. **hardhat-ledger plugin compatibility:** `@nomicfoundation/hardhat-ledger` works with Hardhat 2.x + hardhat-deploy. Configured via `ledgerAccounts: [<HW_WALLET>]` in the network config of `hardhat-megaeth.config.ts`.
4. **Cast `--ledger` derivation path:** Use the **default account 0** (`m/44'/60'/0'/0/0`). Clement's HW wallet was already initialized with this path producing `0xBeC5B03f…0199`. No custom path needed.
5. **Partner-fee Safe upgrade path:** Via Safe Wallet Web UI. Three transactions (add owner #2, add owner #3, change threshold), each signed by the current 1-of-1 owner.
6. **Alerter chain coverage:** Mainnets only (OP mainnet + MegaETH mainnet once deployed). Testnet allowlists stay unmonitored.

---

## File Structure

To be created:

| Path | Responsibility |
|---|---|
| `contracts/hardhat-megaeth.config.ts` | EXISTING — gets a `ledgerAccounts: ["0xBeC5B03f…0199"]` block added to the `optimism-mainnet` and `megaeth-mainnet` network entries |
| `infra/megaeth/deploy/deploy-mainnet-all.sh` | EXISTING — gets `--ledger` flags on all `cast send` calls + a Task 4 "transferOwnership" block appended |
| `infra/optimism/deploy/deploy-mainnet-all.sh` | EXISTING — same `--ledger` + transferOwnership additions |
| `apps/rebate-indexer/src/alerter.ts` | EXISTING — extended with `pollAllowListEvents()` + chain-config table |
| `apps/rebate-indexer/src/allowListMonitor.ts` | NEW — pulls AllowList events from configured chains; emits to Telegram |
| `docs/development/specs/2026-05-12-spec-5-pre-mainnet-security-hardening.md` | EXISTING — marked SHIPPED post-completion |

External (no repo change):
- Greg protocol Safe — deployed once per chain via Safe Wallet UI
- Partner-fee Safe — owners + threshold updated via Safe Wallet UI

---

## Tasks

### Task 1: Provision the secondary HW wallet + identify recovery co-signer

**Files:** none (operator-side)

- [ ] **Step 1: Buy + initialize a second Ledger Nano S Plus** (or equivalent)

Derive an EOA at `m/44'/60'/0'/0/0` (same path as primary). Address: `0x???` (to fill).

Store seed phrase in a fireproof safe at an offsite location, geographically separated from the primary device.

- [ ] **Step 2: Pick the recovery co-signer**

Options (per Spec 5):
- A trusted person who already has (or is willing to acquire) a Ledger
- A lawyer or family member with hardware-wallet aptitude

The recovery co-signer:
- Holds the third Ledger
- Co-signs Safe txs only in emergencies (key loss recovery, hostile-takeover incident response)
- Is NOT a daily-active signer

Record their HW wallet address: `0x???` (to fill).

- [ ] **Step 3: Confirm the three addresses**

```
PRIMARY  = 0xBeC5B03ffDcac50071693E87bFDb88bAa6710199  # already known
BACKUP   = 0x???  # from Step 1
RECOVERY = 0x???  # from Step 2
```

No commit at this step — operator-side identity decisions.

### Task 2: Deploy Greg protocol Safe on each mainnet target

**Files:** none (Safe Wallet UI flow)

- [ ] **Step 1: Verify all 3 owners' addresses on chain**

For each chain we plan to deploy to (initial set: OP mainnet, MegaETH mainnet):

```bash
RPC=$OP_MAINNET_RPC
cast call --rpc-url "$RPC" "$PRIMARY" "0x" 2>/dev/null
cast call --rpc-url "$RPC" "$BACKUP" "0x" 2>/dev/null
cast call --rpc-url "$RPC" "$RECOVERY" "0x" 2>/dev/null
```

Each should not error (the addresses don't need to be funded; just need to be valid EOAs).

- [ ] **Step 2: Deploy the Safe via app.safe.global**

For each chain:
1. Go to https://app.safe.global → top-left network switcher → select target chain
2. "Create new Safe" → enter PRIMARY as the first owner
3. Add BACKUP + RECOVERY as additional owners
4. Set threshold to 2 (of 3)
5. Use a deterministic salt for cross-chain consistency. Safe's default salt nonce is timestamp-derived; **override with `0x0000000000000000000000000000000000000000000000000000000000000001`** (or another agreed value) so the CREATE2 address is the same on every chain.
6. Connect PRIMARY Ledger wallet → sign the deploy tx → submit.

Confirm the Safe deploys at the expected CREATE2 address on every chain (write it down).

- [ ] **Step 3: Record the Safe address**

Append to `infra/optimism/.env` and `infra/megaeth/.env`:

```
GREG_PROTOCOL_SAFE_OP_MAINNET=0x???
GREG_PROTOCOL_SAFE_MEGAETH_MAINNET=0x???
```

Append to `infra/cloudflare/ophis-chain-backends.md` "Useful constants" table.

- [ ] **Step 4: Test a Safe tx (sanity check)**

From the Safe Web UI, queue a no-op tx (e.g. "Send 0 ETH to self"). Sign with PRIMARY → it queues. Sign with BACKUP → it executes. Confirms the 2-of-3 flow works.

No commit at this step (state lives on chain).

### Task 3: Upgrade partner-fee Safe to 2-of-3

**Files:** none (Safe Wallet UI flow)

- [ ] **Step 1: Open the existing partner-fee Safe**

URL: https://app.safe.global/home?safe=eth:0x858f0F5eE954846D47155F5203c04aF1819eCeF8

(Or the appropriate chain prefix per your active network.)

- [ ] **Step 2: Add owner BACKUP**

Settings → Owners → "Add new owner" → enter BACKUP address → submit (1-of-1 signs immediately).

After this, Safe is 1-of-2.

- [ ] **Step 3: Add owner RECOVERY + raise threshold to 2 in the same tx**

Settings → Owners → "Add new owner" → enter RECOVERY → set new threshold to 2 → submit.

After this, Safe is 2-of-3 with the desired signer set.

- [ ] **Step 4: Verify**

```bash
cast call --rpc-url <chain-rpc> 0x858f0F5eE954846D47155F5203c04aF1819eCeF8 \
  "getOwners()(address[])"
cast call --rpc-url <chain-rpc> 0x858f0F5eE954846D47155F5203c04aF1819eCeF8 \
  "getThreshold()(uint256)"
```

Expect 3 owners + threshold 2.

- [ ] **Step 5: Repeat on every chain the partner-fee Safe is deployed on**

The Safe address is CREATE2-deterministic across chains, but **owner changes apply per chain** — each deployment has its own owner storage. Do steps 2-4 on every chain.

(For chains where the Safe isn't deployed yet but will be after Spec 2/3: the upgrade flow runs at Safe-deploy time with the right owners/threshold from the start.)

### Task 4: Integrate hardhat-ledger + cast --ledger into deploy scripts

**Files:**
- Modify: `contracts/hardhat-megaeth.config.ts`
- Modify: `contracts/package.json` (add `@nomicfoundation/hardhat-ledger` dep)
- Modify: `infra/megaeth/deploy/deploy-mainnet-all.sh`
- Modify: `infra/optimism/deploy/deploy-mainnet-all.sh`

- [ ] **Step 1: Install the plugin**

```bash
cd contracts
pnpm add -D @nomicfoundation/hardhat-ledger
```

- [ ] **Step 2: Register the plugin in `hardhat-megaeth.config.ts`**

Add to imports:

```typescript
import "@nomicfoundation/hardhat-ledger";
```

In the `networks` block, add `ledgerAccounts` to each mainnet network:

```typescript
"megaeth-mainnet": {
  url: MEGAETH_MAINNET_RPC,
  chainId: 4326,
  ledgerAccounts: ["0xBeC5B03ffDcac50071693E87bFDb88bAa6710199"],
},
"optimism-mainnet": {
  url: process.env.OP_MAINNET_RPC ?? "https://mainnet.optimism.io",
  chainId: 10,
  ledgerAccounts: ["0xBeC5B03ffDcac50071693E87bFDb88bAa6710199"],
},
```

Keep `accounts: accounts` on the testnet entries (they still use the software-key Keychain pattern — fine for non-mainnet).

In `namedAccounts.owner` and `namedAccounts.manager`, hardcode the HW wallet for the two mainnet networks (replace the `GREG_DEPLOYER_ADDRESS` env var pattern):

```typescript
owner: {
  ...existing,
  "megaeth-mainnet": "0xBeC5B03ffDcac50071693E87bFDb88bAa6710199",
  "optimism-mainnet": "0xBeC5B03ffDcac50071693E87bFDb88bAa6710199",
},
manager: {
  ...existing,
  "megaeth-mainnet": "0xBeC5B03ffDcac50071693E87bFDb88bAa6710199",
  "optimism-mainnet": "0xBeC5B03ffDcac50071693E87bFDb88bAa6710199",
},
```

- [ ] **Step 3: Update `deploy-mainnet-all.sh` (both megaeth + optimism)**

Replace:

```bash
DEPLOYER_PK=$(security find-generic-password -a greg-megaeth-deployer -s greg-megaeth-deployer -w)
```

with:

```bash
DEPLOYER_ADDR=0xBeC5B03ffDcac50071693E87bFDb88bAa6710199
echo ""
echo "⚠️  Hardware wallet flow active. Connect your Ledger and open the Ethereum app."
echo "    Each transaction will require physical confirmation on the device."
echo "    Estimated total: 6 prompts (3 deploys + 3 ownership transfers)."
read -p "Press enter when ready..."
```

Replace every `cast send --rpc-url "$RPC" --private-key "$DEPLOYER_PK"` invocation with:

```bash
cast send --rpc-url "$RPC" --ledger
```

Remove every `--private-key "$DEPLOYER_PK"` argument from the script.

Drop the hardhat-deploy command's `GREG_MEGAETH_DEPLOYER_PK=$DEPLOYER_PK` env export. The hardhat-ledger plugin reads from the connected Ledger automatically.

- [ ] **Step 4: Add the ownership-transfer block to both scripts**

Append after the existing `[3/3] Allowlisting driver-submitter` section:

```bash
# --- 4. Transfer ownership of AllowListAuthentication to the Greg protocol Safe ---
echo ""
echo "=== [4/4] Handing AllowListAuthentication to the protocol Safe ==="

if [[ -z "${GREG_PROTOCOL_SAFE_MAINNET:-}" ]]; then
  echo "ERROR: GREG_PROTOCOL_SAFE_MAINNET must be set in infra/<chain>/.env" >&2
  echo "       (the 2-of-3 Safe deployed in Spec 5 Task 2)" >&2
  exit 6
fi

# transferOwnership(safe) — atomic
echo "  transferOwnership($GREG_PROTOCOL_SAFE_MAINNET)..."
cast send --rpc-url "$RPC" --ledger \
  "$GREG_AUTH_MAINNET" "transferOwnership(address)" "$GREG_PROTOCOL_SAFE_MAINNET"

# setManager(safe) — same Safe holds the manager role
echo "  setManager($GREG_PROTOCOL_SAFE_MAINNET)..."
cast send --rpc-url "$RPC" --ledger \
  "$GREG_AUTH_MAINNET" "setManager(address)" "$GREG_PROTOCOL_SAFE_MAINNET"

# Verify
NEW_OWNER=$(cast call --rpc-url "$RPC" "$GREG_AUTH_MAINNET" "owner()(address)")
NEW_MANAGER=$(cast call --rpc-url "$RPC" "$GREG_AUTH_MAINNET" "manager()(address)")
if [[ "${NEW_OWNER,,}" != "${GREG_PROTOCOL_SAFE_MAINNET,,}" ]]; then
  echo "ERROR: owner is $NEW_OWNER, expected $GREG_PROTOCOL_SAFE_MAINNET" >&2
  exit 7
fi
if [[ "${NEW_MANAGER,,}" != "${GREG_PROTOCOL_SAFE_MAINNET,,}" ]]; then
  echo "ERROR: manager is $NEW_MANAGER, expected $GREG_PROTOCOL_SAFE_MAINNET" >&2
  exit 8
fi
echo "  ✓ ownership + manager fully handed to the Safe"
```

Update the env-append cat block at the bottom of the script to reference the chain-specific Safe address (`GREG_PROTOCOL_SAFE_MAINNET` is the script-level alias; it sources from `GREG_PROTOCOL_SAFE_OP_MAINNET` or `GREG_PROTOCOL_SAFE_MEGAETH_MAINNET` per chain).

- [ ] **Step 5: Dry-run on a testnet to verify the HW-wallet flow**

Add a `optimism-sepolia-test` profile to `hardhat-megaeth.config.ts` that uses the Ledger. Deploy a throwaway AllowListAuthentication on Sepolia. Transfer ownership to a test Safe deployed on Sepolia. Confirm full flow works on the device before doing it on mainnet for real.

- [ ] **Step 6: Commit**

```bash
git add contracts/hardhat-megaeth.config.ts contracts/package.json contracts/pnpm-lock.yaml \
        infra/megaeth/deploy/deploy-mainnet-all.sh \
        infra/optimism/deploy/deploy-mainnet-all.sh
git commit -m "feat(deploys): integrate hardhat-ledger + cast --ledger + auto-transfer ownership to Safe"
```

### Task 5: AllowList event monitor

**Files:**
- Create: `apps/rebate-indexer/src/allowListMonitor.ts`
- Modify: `apps/rebate-indexer/src/alerter.ts` (import + invoke the new monitor)
- Modify: `apps/rebate-indexer/src/config.ts` (or wherever chain config lives — add `ALLOWLIST_AUTHS` map)

- [ ] **Step 1: Write `allowListMonitor.ts`**

```typescript
import { createPublicClient, http, parseAbiItem, type Log } from 'viem';

const EVENTS = [
  parseAbiItem('event SolverAdded(address solver)'),
  parseAbiItem('event SolverRemoved(address solver)'),
  parseAbiItem('event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)'),
  parseAbiItem('event Upgraded(address indexed implementation)'),
];

type Chain = {
  name: string;
  rpc: string;
  authListProxy: `0x${string}`;
};

export async function pollAllowListEvents(
  chains: Chain[],
  knownTxHashes: Set<string>,
  onAlert: (msg: string) => Promise<void>,
  lastSeenBlock: Map<string, bigint>,
): Promise<void> {
  for (const chain of chains) {
    const client = createPublicClient({ transport: http(chain.rpc) });
    const fromBlock = lastSeenBlock.get(chain.name) ?? (await client.getBlockNumber()) - 100n;
    const toBlock = await client.getBlockNumber();
    if (toBlock <= fromBlock) continue;

    for (const ev of EVENTS) {
      const logs = await client.getLogs({
        address: chain.authListProxy,
        event: ev,
        fromBlock: fromBlock + 1n,
        toBlock,
      });
      for (const l of logs) {
        if (knownTxHashes.has(l.transactionHash)) continue;
        await onAlert(
          `🚨 ALLOWLIST EVENT (unexpected)\nchain=${chain.name}\nevent=${ev.name}\nblock=${l.blockNumber}\ntx=${l.transactionHash}\nargs=${JSON.stringify(l.args, (_, v) => typeof v === 'bigint' ? v.toString() : v)}`
        );
      }
    }
    lastSeenBlock.set(chain.name, toBlock);
  }
}
```

- [ ] **Step 2: Wire it into the existing alerter loop**

In `alerter.ts`, after the existing balance-check logic, add a call to `pollAllowListEvents(chains, knownTxHashes, sendTelegram, lastSeenBlock)`. `knownTxHashes` is read from a `data/allowlist-known-txs.txt` file (one tx hash per line; operator appends after legitimate `addSolver` calls).

Configure the chain list:

```typescript
const ALLOWLIST_CHAINS = [
  {
    name: 'op-mainnet',
    rpc: 'https://ophis-op-node.tail565030.ts.net:8545', // tailnet
    authListProxy: process.env.GREG_AUTH_OP_MAINNET!,
  },
  {
    name: 'megaeth-mainnet',
    rpc: 'https://mainnet.megaeth.com/rpc',
    authListProxy: process.env.GREG_AUTH_MEGAETH_MAINNET!,
  },
];
```

(The OP RPC over Tailscale — by the time Spec 5 ships, the chain stack will already be using it.)

- [ ] **Step 3: Test fire**

On Sepolia (which the Spec 5 dry-run from Task 4 Step 5 sets up):
1. Run the alerter
2. Manually call `cast send <test_auth_list> "addSolver(address)" <attacker_eoa>` (signed by a different EOA than the legitimate deployer)
3. Wait < 60s
4. Confirm Telegram receives the alert

- [ ] **Step 4: Commit**

```bash
git add apps/rebate-indexer/src/allowListMonitor.ts apps/rebate-indexer/src/alerter.ts apps/rebate-indexer/src/config.ts
git commit -m "feat(alerter): AllowList event monitor for mainnet authlists"
```

### Task 6: Documentation + ship marker

**Files:**
- Modify: `docs/development/specs/2026-05-12-spec-5-pre-mainnet-security-hardening.md`
- Modify: `infra/cloudflare/ophis-chain-backends.md`
- Modify: `/Users/scep/.claude/projects/-Users-scep/memory/project_greg.md`

- [ ] **Step 1: Mark Spec 5 SHIPPED**

At top of the spec file, add: `## Status: SHIPPED 2026-MM-DD`

- [ ] **Step 2: Update runbook**

Append a "Security model — Greg protocol Safe" section to `ophis-chain-backends.md`:
- 2-of-3 Safe addresses per chain
- Signer set + custody plan
- Where each Ledger lives + recovery seed location
- Incident-response playbook (what to do if you suspect compromise)

- [ ] **Step 3: Update memory**

In `project_greg.md`, replace the "Multisig threshold upgrade" parked item with "Done — Spec 5 shipped <date>".

- [ ] **Step 4: Commit + PR + merge**

```bash
git commit -m "docs(spec-5): mark shipped + runbook security section"
git push origin <branch>
gh pr create --title "feat: Spec 5 — pre-mainnet security hardening live"
```

---

## Done definition

All Task 6 boxes checked PLUS:
- Greg protocol Safe deployed on every Spec 2/3 target chain
- Partner-fee Safe at 2-of-3 on every chain it lives on
- Deploy scripts dry-run-tested on a testnet
- AllowList event monitor running and verified via Telegram fire-test
- No software-keyed deployer EOA can call `addSolver` or `transferOwnership` on any mainnet AuthList (verifiable via `cast call <auth> "owner()(address)"`)
- Memory + runbook updated

After Spec 5 done: unblock Spec 2 + Spec 3 execution.

---

## Notes for the executor

- **Ledger Live must be closed** during all `cast --ledger` and hardhat-deploy operations. The plugin and Live both try to claim the USB device; conflict makes the device unreachable. Document this loudly.
- **Test on Sepolia first.** Burning ~$5 of Sepolia gas to verify the full HW-wallet → Safe flow saves catastrophic mainnet errors. The dry-run is non-negotiable.
- **Safe deploys cost real ETH.** ~$2-5 per chain (Safe contracts cost ~200k gas to deploy). Budget for it.
- **The plan reserves placeholders for BACKUP and RECOVERY HW wallet addresses.** Don't execute Task 2 until these are filled.
- **Re-runnability:** Tasks 2-3 are one-shot (on-chain Safe state). Tasks 4-6 are repeatable; if anything fails, fix and retry.
