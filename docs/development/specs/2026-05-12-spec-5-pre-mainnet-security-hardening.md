# Spec 5 — Pre-mainnet security hardening

> **Precondition for Spec 2 + Spec 3 execution.** Neither mainnet backend deploys until this spec ships.

## Summary

Three hardening tracks, all required before any mainnet contract deploys:

1. **Hardware wallet for deployer keys** — Greg deployer addresses must never have private keys in software past the funding step. Use Ledger Nano (or Trezor) for the deploy transactions on Spec 2 + Spec 3 + any future mainnet.
2. **Transfer AuthListAuthentication ownership to a Safe immediately after deploy** — the deployer EOA's protocol-level power (addSolver, transferOwnership, upgrade) gets handed to a 2-of-3 Safe within minutes of the proxy being deployed.
3. **Bump partner-fee Safe to 2-of-3** — the treasury Safe at `0x858f0F5e…CeF8` is currently 1-of-1. Add 2 co-signers + change threshold to 2.

Plus a runtime alerting track:

4. **AllowList event monitoring** — extend the existing rebate-indexer alerter to Telegram-alert on every `SolverAdded`, `SolverRemoved`, `OwnershipTransferred`, and `Upgraded` event on every deployed AllowListAuthentication. If we didn't initiate it, it's a compromise → fast incident response window.

## Goals & non-goals

### Goals
- No single software key has unilateral protocol-level power on any mainnet after Spec 5 ships.
- Treasury single-point-of-failure removed.
- Real-time detection window for allowlist mutations.
- Operator runbook for key-rotation, recovery, and incident response.

### Non-goals
- Hardware wallet for the driver-submitter — the driver-submitter signs continuously; HW wallets aren't viable. Risk is bounded by gas-balance sweep policy (separate concern, addressed in operator runbook).
- Hardware wallet for the testnet deployer — testnet keys are throwaway, fine in Keychain.
- Formal threat-model document — covered inline here; a full STRIDE pass can wait until volume justifies it.
- Multisig for the driver-submitter solver allowlist entry itself — solver entries are EOAs by protocol design (they sign settlement txs); the protection is on who can ADD solvers, not on the solver EOAs themselves.
- Recovery of a stolen deployer — preventative only. If a deployer EOA is compromised and ownership has NOT yet been transferred to the Safe, the only recovery is to redeploy on a new salt + abandon the old contracts. Don't have a way to recover a stolen HW-wallet key either (that's a separate problem — see "Risks" section).

## Why this blocks Spec 2 + Spec 3

Without Spec 5, the Spec 2 + Spec 3 deploy puts a 1-of-1 software-key at the top of the protocol's authority chain. Compromise = drain users' approvals via attacker-added solver, OR lock us out via `transferOwnership`, OR install a backdoored AllowListAuthentication via `upgrade`.

The window between "deploy" and "transfer ownership to Safe" is the most dangerous moment in any chain's lifecycle. Spec 5 designs that window to be < 5 minutes and protected by HW-wallet signing throughout.

## Architecture

```
       Hardware wallet (Ledger Nano S Plus, your physical device)
              │
              │ derives address at m/44'/60'/0'/0/0
              │ → e.g. 0xNNNN... (the "deployer" address for chain X)
              │
              ▼
       Fund this address with ~0.05 native ETH
              │
              ▼
       Run hardhat-deploy via cast/foundry with --ledger flag
              │ (or hardhat-ledger plugin)
              ▼
       AllowListAuthentication_Proxy now deployed
       owner = HW-wallet address
       manager = HW-wallet address
              │
              │ IMMEDIATELY (same session, < 5 min)
              ▼
       transferOwnership(grEg_Safe_2of3)
       setManager(grEg_Safe_2of3)
              │
              ▼
       Greg Safe (2-of-3, all signers are hardware wallets)
       now controls:
         - solver allowlist
         - implementation upgrade
         - manager + ownership reassignment

       HW-wallet deployer's role is exhausted.
       Can be wiped from the device or kept for any future deploys.
```

Same pattern executes for each chain (MegaETH mainnet, OP mainnet, and any future mainnet).

## Components

### Component 1: Greg Multisig Safe (the protocol-control Safe)

A **2-of-3 Safe**, distinct from the partner-fee Safe. Owners:
1. **Clement primary** — Ledger Nano S Plus, daily-driver hardware wallet
2. **Clement backup** — second Ledger (or Trezor), stored offsite (e.g. safe deposit box)
3. **Recovery** — TBD. Options:
   - A trusted co-signer (engineering peer, lawyer, or family member with a hardware wallet you've configured)
   - A timelock-protected EOA in a separate Keychain on a separate machine (less ideal — software key)
   - A Safe recovery service (gnosis-recoverer module, with N-day delay)

Recommendation: option (a) with one trusted person + their HW wallet — simplest, no protocol risk. Option (c) is overengineered for current scale.

This Safe is **per-chain** (CREATE2 address depends on factory + initial owners; if you reuse the same owner set across chains, the address can be the same on every chain, like the partner-fee Safe).

### Component 2: Partner-fee Safe upgrade

The existing `0x858f0F5e…CeF8` Safe upgraded from 1-of-1 to 2-of-3 using the same three signers as Component 1.

Trade-off: same signer set across both Safes means a 2-key compromise drains both. Different signer sets adds defense-in-depth but operational complexity. **Recommended: same set initially**, split later if treasury value justifies it.

### Component 3: HW-wallet deploy flow

Replace `pnpm exec hardhat deploy --network <chain>` with a flow that signs every transaction via the Ledger:

**Path A (cleanest): cast with --ledger flag**
- All `cast send` calls in `deploy-mainnet-all.sh` get a `--ledger` flag added
- Hardhat-deploy step is harder — needs `hardhat-ledger` plugin OR replaced with cast-based deploys
- Net: rewrite the hardhat-deploy step to use cast for the CoW core contract deploys

**Path B: hardhat-ledger plugin**
- Add `@nomicfoundation/hardhat-ledger` to contracts/package.json
- Configure in hardhat-megaeth.config.ts
- `pnpm exec hardhat deploy --network <chain>` then prompts on the Ledger for each tx
- Cast calls in the rest of the script still need `--ledger`

Recommendation: **Path B for hardhat-deploy + Path A's `--ledger` flag for the rest**. Mixed but pragmatic.

### Component 4: Ownership-transfer post-deploy

Add to `deploy-mainnet-all.sh` (both megaeth + optimism versions): after AllowListAuthentication is deployed, immediately:

```bash
cast send --ledger --rpc-url "$RPC" "$GREG_AUTH_*" \
  "transferOwnership(address)" "$GREG_PROTOCOL_SAFE_$CHAIN"
cast send --ledger --rpc-url "$RPC" "$GREG_AUTH_*" \
  "setManager(address)" "$GREG_PROTOCOL_SAFE_$CHAIN"
```

Both as one-shot commands signed on the device. Total time: ~30 seconds.

### Component 5: AllowList event monitor

Extend `apps/rebate-indexer/src/alerter.ts` (or co-located alerter) with a new check that runs every block (or every minute):

```typescript
// Pseudocode
const events = await provider.getLogs({
  address: GREG_AUTH_CHAIN_X,
  topics: [
    // SolverAdded(address) | SolverRemoved(address)
    // | OwnershipTransferred(address, address) | Upgraded(address)
    [SOLVER_ADDED, SOLVER_REMOVED, OWNERSHIP_TRANSFERRED, UPGRADED],
  ],
  fromBlock: lastSeenBlock,
  toBlock: 'latest',
});

if (events.length > 0) {
  for (const e of events) {
    // Match against a list of our own expected tx hashes
    if (!OUR_RECENT_TX_HASHES.includes(e.transactionHash)) {
      telegram(`🚨 ALLOWLIST EVENT (unexpected): chain=${chain} event=${e.event} block=${e.blockNumber} tx=${e.transactionHash}`);
    }
  }
}
```

Run for every Greg-deployed AllowListAuthentication across every chain. Latency target: < 60s from event to Telegram.

## Cost

| Item | Cost |
|---|---|
| Ledger Nano S Plus (primary) | $79 |
| Ledger Nano S Plus (backup) | $79 |
| Recovery co-signer's HW wallet (if person doesn't already have one) | $79 |
| Gas: Safe deploy on MegaETH mainnet | ~$1 |
| Gas: Safe deploy on OP mainnet | ~$2 |
| Gas: transferOwnership + setManager (2 txs × N chains) | ~$1-2 total |
| Eng time: HW-wallet flow integration, ownership-transfer additions, alerter extension | ~1 day |
| **Total** | **~$240 hardware + $5 gas + 1 day work** |

(Compare to potential blast radius from a deployer compromise: protocol-level full takeover. The ROI is overwhelming.)

## Risk & rollback

| Risk | Likelihood | Impact | Mitigation | Rollback |
|---|---|---|---|---|
| HW wallet lost | Low | Can't sign Safe txs from that key. Safe is 2-of-3, so still operational with the other 2. | Backup HW wallet kept offsite. | Replace lost owner via Safe tx signed by remaining 2. |
| Recovery co-signer turns hostile | Very low | They can collude with one other signer to drain. | Pick someone you trust + write a Safe-module-restricted timelock for the recovery key. | Replace via Safe tx (the 2 you control still hit threshold). |
| Ledger firmware vulnerability | Low | Theoretical attack against the device | Use the latest firmware. Pin to a known-good version after upgrades. | Replace HW wallet. |
| Ownership transfer fails partway (proxy ownership but not manager, or vice versa) | Low | Inconsistent state where deployer still has manager but Safe has ownership | Run both transferOwnership + setManager in the same script with atomic check at end. | Re-execute the missing step from Safe (Safe can call setManager once it's owner). |
| Safe address differs across chains | Medium initially | Address typos when filling configs | Confirm Safe deploys land at the expected CREATE2 address on each chain before transferring ownership. | Re-derive correct Safe address, retry. |
| You lose all 3 HW wallets | Negligible (requires 3 simultaneous events) | Total protocol lockout | Defense-in-depth via geographic separation + the recovery co-signer | Practically irrecoverable. Spec-level acceptance of this residual risk. |
| Spec 5 itself delays Spec 2/3 mainnet by ~1 day | Certain | Slows shipping | Accepted trade-off. The alternative is shipping with 1-of-1 EOA ownership which is reckless. | None. |

## Open questions for implementation plan

1. **Recovery co-signer identity.** Who's the third 2-of-3 owner? Pending Clement decision.
2. **Same-address-across-chains for the Greg protocol Safe?** Use the same 3 owners + same initial config so the Safe CREATE2 address is identical on every Greg-target chain. Recommended.
3. **`hardhat-ledger` plugin version compatibility** with our hardhat 2.x + hardhat-deploy versions. Verify before plan-write.
4. **Cast `--ledger` derivation path default.** Standard is `m/44'/60'/0'/0/0` for the first account. For the deployer specifically, do we use account 0 or a dedicated higher index (e.g. account 5 reserved for "Greg deployer")? Recommended: dedicated index for clarity in the device UI.
5. **Existing partner-fee Safe upgrade path.** Bumping 1-of-1 → 2-of-3 requires you to sign a Safe tx that adds 2 owners and changes threshold. The execution is straightforward via Safe Web UI; document the exact button-click sequence.
6. **Alerter chain coverage.** Run the AllowList monitor only on chains where we've deployed (testnet stacks too?), or just on mainnets? Recommended: only mainnets (testnet allowlists are throwaway).

The implementation plan should resolve 1-6 inline.

## Success metrics + done-checklist

### Hardware-wallet flow
- [ ] You have a Ledger Nano S Plus (primary) — buy + initialize if not already
- [ ] You have a second Ledger (backup) — buy + initialize, store offsite
- [ ] Recovery co-signer identified + has a HW wallet
- [ ] Test run: `cast send --ledger --rpc-url <Sepolia> ... transfer ...` succeeds end-to-end on a testnet

### Safes deployed
- [ ] Greg protocol Safe (2-of-3) deployed on a test chain first (Sepolia) — verify address + behavior
- [ ] Partner-fee Safe at `0x858f0F5e…CeF8` upgraded to 2-of-3 with the same signer set
- [ ] Safe addresses confirmed CREATE2-identical across the chains we plan to deploy to next

### Deploy script integration
- [ ] `deploy-mainnet-all.sh` (megaeth + optimism versions) updated with `--ledger` flag on all signing operations
- [ ] Final step of each deploy script: `transferOwnership` + `setManager` to the Greg protocol Safe
- [ ] Dry-run on Sepolia: full deploy → ownership transfer → Safe controls AllowList → verified

### Monitor
- [ ] AllowList event monitor running, watching all mainnet AuthLists
- [ ] Test fire: manually emit a SolverAdded on a test deployment → Telegram receives within 60s

### Repo state
- [ ] Hardware-wallet + Safe addresses documented in `infra/cloudflare/ophis-chain-backends.md` under "Useful constants"
- [ ] `project_greg.md` security section reflects the new ownership model
- [ ] Operator runbook for "lost HW wallet" + "Safe owner rotation" recovery procedures

### Negative checks (must NOT happen)
- [ ] No deployer private key ever stored in macOS Keychain (replaced by HW wallet)
- [ ] No mainnet deploy executed with the deployer-EOA-as-owner state lingering past 1 hour
- [ ] No Safe with threshold == owners_count (avoids no-margin-for-key-loss configurations)

## Dependencies

| Other spec | Relationship |
|---|---|
| Spec 1 (testnet revival) | shipped — independent of this |
| Spec 2 (OP mainnet) | **BLOCKED by Spec 5** |
| Spec 3 (MegaETH mainnet) | **BLOCKED by Spec 5** |
| Spec 4 (frontend wiring) | independent — frontend doesn't sign anything protocol-critical |

Ship order: **Spec 5 → (Spec 2, Spec 3 in either order) → Spec 4**.
