# Ophis OP Mainnet Audit — 2026-05-14

Audit pass triggered by the first end-to-end production swap on Optimism mainnet (settle tx [`0x4ba17913…`](https://optimistic.etherscan.io/tx/0x4ba179133fc2466a05637b55ee3850e6e0a909e89e0e885bb6ef2f35256fef12)). Eight-item scope; results below.

## Tools used (all free)

- **Slither 0.11.4** (Trail of Bits) — static analysis across 5 production contracts, run via the official `trailofbits/eth-security-toolbox` Docker image pinned to digest `a60d69da3d7f`. Result: 51 unique fingerprints. Gating logic in `scripts/slither-baseline.py` fails CI only on net-new fingerprints.
- **Echidna 2.3.2** (Trail of Bits) — property-based fuzz of 3 AllowList invariants and 3 Settlement invariants. 50k iterations, 4 parallel workers, all green. Harnesses in `contracts/echidna/`.
- **Verity** (Lean 4 formal verification, https://veritylang.com) — narrow proof that `AllowListAuthentication.addSolver`, `removeSolver`, and `setManager` correctly enforce manager/owner gating. 6 machine-checked theorems, 0 `sorry`, only `propext` + `Quot.sound` as axioms (Lean kernel standard).
- **Manual review** of the five 2026-05-14 backend ops fixes (PR #31) including the `disable-access-list-simulation` flag — confirmed safe by reading `apps/backend/crates/simulator/src/lib.rs:73-75` (skips only the gas-optimization preflight, not the main `gas()` simulation or revert check).
- **Empirical on-chain checks** of `AllowListAuthentication.manager`/`owner`, Safe `threshold`/`owners`, post-trade approvals and balances on the live Ophis OP settlement contract.

## Smart-contract findings

| Severity | Count | Notes |
|---|---|---|
| High | 6 | All documented design patterns — see Appendix A |
| Medium | 5 | All known/accepted CoW patterns |
| Low | 6 | All known/accepted CoW patterns |
| Informational | 32 | Style and naming conventions |
| Optimization | 2 | Storage-readers' `manager` + `_status` could be `constant` |

**Production code change recommended: none.** The two new "High" findings introduced by extending the Slither scope to `reader/*StorageReader.sol` are false positives — Slither cannot model the `simulateDelegatecall`-shadow pattern (these contracts' storage slots resolve to the *caller's* state, never to their own).

## Operational findings

| Item | Risk | Status |
|---|---|---|
| AllowList manager hot-key | n/a — verified the manager is the 2-of-2 Safe `0xe049a6…01cF`, not an EOA | ✓ Already hardened |
| Driver-submitter EOA `.env` exposure | World-readable plaintext PK on disk | ✓ Fixed in PR #33 (`chmod 600` + render hardening) |
| Solver supply chain (OKX, KyberSwap) | Bounded — see below | ✓ Bounded, runtime mitigation in place |
| 3rd Safe signer | Single point of failure on quorum loss | ⏸ Pending operator address pick |
| RPC dependency on `publicnode.com` | Public-RPC trust + availability | 🟡 Mitigation ready (Aleph op-reth synced); follow-up config PR |
| Warm-standby driver | Single Mac mini = no HA | ⏸ Multi-hour follow-up workstream |

### Solver supply-chain risk (the most nuanced finding)

Initially flagged as Item #1: if OKX is compromised, it could produce settle() interactions that leave persistent approvals on the settlement contract.

**Empirically verified:** post-trade allowances on the live Settlement contract are zero for all OKX/Kyber router addresses (`0x68d6b7…`, `0x100f3f74…`, `0x478946bc…`, `0xdd5e9b94…`). Our OKX driver uses exact-amount approvals which are consumed by the swap.

**Echidna invariant `echidna_settlement_never_approves`** passed at 50k iterations (random-fuzz can't synthesize a state where approvals are left behind).

**The honest residual risk:** Echidna's random calldata can't model a deliberately-crafted malicious solver interaction. The Solidity source of `GPv2Settlement` itself contains zero `approve()` callsites, but settlement-context approvals can still happen *via* solver-controlled interactions[0]. The actual mitigation is:
1. Solver-side discipline (verified for our OKX driver)
2. AllowList trust (only solvers in the AllowList can submit; AllowList is owned by the 2-of-2 Safe)

This is operational-trust, not Solidity-structural. Future work: a runtime check in the driver that asserts post-settle `allowance == 0` for all spenders touched in interactions, before broadcasting the tx.

## Verity formal verification result

Proven (machine-checked via `lake build`):

| Theorem | Statement |
|---|---|
| `addSolver_reverts_when_not_manager` | `msg.sender ≠ manager → addSolver(s)` reverts |
| `removeSolver_reverts_when_not_manager` | Same for `removeSolver` |
| `setManager_reverts_when_not_owner` | `msg.sender ≠ owner → setManager(m)` reverts |
| `addSolver_sets_flag_when_manager` | Effect: solver flag set when manager calls |
| `removeSolver_clears_flag_when_manager` | Effect: solver flag cleared when manager calls |
| `setManager_updates_manager_when_owner` | Effect: manager storage updated when owner calls |

Source: `/tmp/verity-allowlist/Contracts/AllowList/`.

**Honest limitations:**
1. EIP-1967 proxy admin slot abstracted as `storageAddr 1` rather than `keccak256("eip1967.proxy.admin") - 1`. The access-control logic is proven; the slot-derivation is not.
2. The disjunctive `onlyManagerOrOwner` gate's full coverage is left as follow-up (~5 lines).
3. Scope deliberately narrow — does not cover signature verification, settlement execution, or transfer logic.

## Frontend EIP-712 signing

Verified the on-chain `domainSeparator()` returned by `0x310784c7…` matches a byte-for-byte recompute from CoW SDK conventions (`name = "Gnosis Protocol"`, `version = "v2"`, `chainId = 10`, `verifyingContract = 0x310784c7…`):

```
on-chain:  0xa7c585ef3f51d32b0a58e1f145c3b8f3eb0c0f6932a12631c12c6927a91a52b6
computed:  0xa7c585ef3f51d32b0a58e1f145c3b8f3eb0c0f6932a12631c12c6927a91a52b6
```

Frontend correctly sets `settlementContractOverride[10] = 0x310784c7…` in `apps/frontend/libs/common-utils/src/cowProtocolContracts.ts`. Signatures are bound to chainId 10 + Ophis OP settlement — no cross-chain or cross-contract replay possible.

## Bottom line

- No CVE-class issues found in contracts.
- The biggest residual risk is operational, not cryptographic: trust in the allowlisted solver code (OKX, KyberSwap) to behave honestly. The AllowList being on the 2-of-2 Safe is the main containment.
- Open hardening items: 3rd Safe signer (operator action), RPC repointing to self-hosted op-reth (config PR ready), warm-standby driver (multi-hour follow-up).

## Appendix A — Baselined High-impact findings

All are documented CoW Protocol design patterns audited by Trail of Bits, G0 Group, and Gnosis:

| Detector | Location | Why baselined |
|---|---|---|
| `controlled-delegatecall` | `StorageAccessible.simulateDelegatecallInternal` | View-only storage simulation pattern |
| `unprotected-upgrade` | `GPv2AllowListAuthentication.initializeManager` | One-time init enforced by `Initializable`; verified initialized on-chain |
| `arbitrary-send-erc20` (x2) | `GPv2Transfer.transferFromAccounts`, `fastTransferFromAccount` | Settlement is *meant* to move user funds per signed orders |
| `uninitialized-state` (x2) | `AllowListStorageReader.solvers`, `SettlementStorageReader.filledAmount` | Storage-shadow contracts invoked via delegatecall; slots resolve to caller's state |

## Reproducing

```sh
# Slither
docker run --rm \
  -v /Users/scep/greg/contracts/src/contracts:/work \
  -v /tmp/slither-out:/out \
  -w /work \
  trailofbits/eth-security-toolbox@sha256:a60d69da3d7f3fb444be052f93caecac0b560085bf2ccf9c3dcb5386d7532fa9 \
  bash -c 'solc-select use 0.7.6 && slither <contract>.sol --compile-force-framework solc --json /out/<contract>.json'

# Echidna (AllowList)
docker run --rm \
  -v /Users/scep/greg/contracts:/work \
  -w /work \
  trailofbits/eth-security-toolbox@sha256:a60d69da3d7f3fb444be052f93caecac0b560085bf2ccf9c3dcb5386d7532fa9 \
  bash -c 'cd echidna && echidna E2EAllowList.sol --contract E2EAllowList --config echidna.yaml'

# Verity (requires elan)
cd /tmp/verity-allowlist && lake build
```
