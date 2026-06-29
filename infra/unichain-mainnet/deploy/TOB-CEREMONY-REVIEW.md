# Independent Adversarial Review — Unichain (130) Sovereign GPv2 Deploy Ceremony

Artifact: `infra/unichain-mainnet/deploy/deploy-mainnet-all.sh`
Relies on: `contracts/hardhat-megaeth.config.ts` (network `unichain-mainnet`, chainId 130)
Baseline (rehearsed): `infra/megaeth/deploy/deploy-mainnet-all.sh`
Deploy logic: `contracts/src/deploy/001_authenticator.ts`, `002_settlement.ts`, `contracts/src/ts/deploy.ts`
Authority contract: `contracts/src/contracts/GPv2AllowListAuthentication.sol`

Reviewer stance: independent attacker-perspective pass. Codex (gpt-5.5) already cleaned this over
3 rounds; this review assumes funded addresses, a valid 2-of-3 Safe with `OPHIS_SAFE_EXPECTED_OWNERS`
set, and live ToB+Codex at the 2.5 pause, and looks for what survives those guards.

---

## Diff vs the rehearsed MegaETH ceremony (what changed)

The Unichain script is a strict HARDENING of the MegaETH original, not a regression. New, all good:

- chainId==130 pre-flight assert (MegaETH had none).
- Full Safe validation BEFORE any tx: 0x-format, code-present, getThreshold==2, getOwners==3,
  optional `OPHIS_SAFE_EXPECTED_OWNERS` hard-assert, typed-`yes` confirm. (MegaETH: bare `read`.)
- Submitter balance floor enforced too, not just deployer; floor raised 0.001 -> 0.01 ETH.
- New step 2.5 integrity GATE: codehash print for immutable-free contracts + HARD-asserted wiring
  (authenticator/vaultRelayer/vault/HooksTrampoline.settlement/EIP-1967 impl slot) before addSolver.
- Gas limits normalized to the 60M OP-Stack block cap (15M create / 25M auth-proxy default), vs
  MegaETH's inflated 100M/150M/500M which would have exceeded Unichain's block gas limit.

No authority logic was weakened. The remaining findings below are residual, not introduced by the diff.

---

## Mechanics established by code reading (load-bearing facts)

1. **CREATE2 / deterministic deployment.** `001_authenticator.ts` and `002_settlement.ts` both pass
   `deterministicDeployment: SALT` where `SALT = formatBytes32String("Mattresses in Berlin!")`
   (`src/ts/deploy.ts:6` — public, fixed forever) via the Arachnid deterministic-deployment proxy
   `0x4e59b44847b379578588920cA78FbF26c0B4956C`. The Settlement, Auth proxy, and Auth impl land at
   addresses that are a pure function of (salt, init/creation bytecode, constructor args) — NOT of
   who runs the ceremony.

2. **The Auth proxy address is owner/manager-INDEPENDENT.** OP-mainnet and MegaETH-mainnet both
   deployed the proxy to the SAME address `0xAAA13bC6C1A505ccE6B4BF262fdDf4c703B9BD70`, despite
   different deployers/managers. Confirmed from the live artifacts. The EIP173 proxy CREATE2 salt
   does not fold in the `initializeManager` arg, so the proxy lands at the same address on chain 130.
   The impl address DOES differ (OP `0x59eE2d...cc9D` vs MegaETH `0xFAB548...FA31`) because impl
   creation bytecode/metadata differ per compile. The Settlement address is shared OP/MegaETH
   (`0x310784c7...B859`) because its args (authenticator, vault) and bytecode match.

3. **`setManager` / `transferOwnership` are single-step, no zero-guard, instant.** The contract
   itself carries a WARNING (`GPv2AllowListAuthentication.sol:103`) that a typo permanently locks
   solver control. The script's Safe validation neutralizes the typo path; nothing else does.

4. **The (1) codehash block in the gate ONLY PRINTS — it never asserts.** Lines ~242-245 loop and
   `printf` the codehashes; the hard `exit 10` asserts (lines 269-273) cover ONLY wiring, not
   codehash equality. Codehash integrity is delegated entirely to the human ToB+Codex eyeball at the
   pause. This is by design, but it is the gate's soft underbelly (Finding 4).

5. **Every wiring value the gate asserts is read from the same RPC** (`$RPC`, default the public
   `https://mainnet.unichain.org`). The gate trusts the RPC for codehash, getter, and storage-slot
   reads (Finding 6).

---

## RANKED FINDINGS

### F1 — [MEDIUM] Direct-to-Safe launch: a single compromised Safe signer + one phished co-signer = instant rogue solver, no timelock backstop
**Maps to question 5.**

**Attacker model**
- WHO: external attacker who has compromised ONE of the three 2-of-3 Safe signer keys (malware,
  phishing, a leaked hot signer), OR one malicious insider signer, in either case needing exactly
  one more signature.
- ACCESS: 1 of 3 Safe owner keys + social-engineer/collude for a 2nd.
- INTERFACE: the 2-of-3 Safe -> `Auth.addSolver` / `Auth.upgradeTo` / `Auth.setManager`.

**Attack vector**
With ownership AND manager both on the bare Safe and NO 24h TimelockController/Guardian in the path,
a 2-of-3 quorum executes `addSolver(attackerEOA)` or `upgradeTo(maliciousImpl)` that takes effect in
ONE block. There is no delay window in which honest signers or monitoring can `removeSolver` / veto /
rotate before the malicious solver can submit settlements. `upgradeTo` is the worst case: a malicious
implementation behind the proxy can rewrite `isSolver` semantics entirely.

**Exploitability:** MEDIUM. Requires 2-of-3, which is the security assumption — but the absence of a
timelock removes the second line of defense that the OP deployment explicitly added post-launch. The
blast radius of a partial Safe compromise is "instant + irreversible-until-noticed," not "delayed +
vetoable."

**Concrete impact**
A rogue allowlisted solver on a GPv2 Settlement can submit settlements that drain user/settlement
funds via crafted interactions and pull approved balances through the VaultRelayer, bounded by what
users have approved to the VaultRelayer and what sits in Settlement at settle time. On a low-TVL
Phase-0 chain this is small; the finding is that the posture does not scale safely to TVL.

**Is the documented "Timelock before TVL" blocker sufficient?** As written, only partially:
- It is a PROSE blocker in a `.md` (`VALIDATION.md`) and the script's closing echo. Nothing
  technical enforces it. There is no on-chain or CI gate that prevents the public `cowSdk.ts`
  frontend flip (which drives TVL) from shipping while Auth ownership is still the bare Safe.
- Recommend converting it to an enforced gate: have the frontend-enable / config-render step assert
  `Auth.owner()==Auth.manager()==<TimelockController>` (not the bare Safe) before the chain can serve
  public swap traffic. Until that exists, "before meaningful TVL" depends on operator discipline.

**Root cause:** governance posture choice (no Timelock at launch), `deploy-mainnet-all.sh:295-318`
and closing note `:366-371`. Not a script bug; a risk-acceptance that needs a hard downstream gate.

---

### F2 — [MEDIUM] Codehash arm of the 2.5 gate is print-only: a wrong-but-functional impl/helper passes the automated checks and rides entirely on the human review
**Maps to question 4.**

**Attacker model**
- WHO: NOT a remote attacker. The realistic adversary here is operator error / a tainted local build:
  a stale or wrong `apps/backend/contracts/artifacts/*.json`, a dirty `contracts/` working tree, or a
  compiler/metadata drift that yields a functionally-similar-but-not-audited bytecode.
- ACCESS: local repo state at ceremony time.
- INTERFACE: the deploy itself.

**Attack vector**
The Auth impl, Balances, and Signatures are immutable-free, so their codehash is the only integrity
signal — and the script's section (1) loop merely `printf`s the codehash. The HARD `exit 10` asserts
cover wiring only. A Balances/Signatures/Auth-impl built from a wrong artifact still wires up
correctly (Settlement.authenticator/vaultRelayer/vault, HooksTrampoline.settlement, impl-slot all
consistent), so the AUTOMATED gate passes; only the human ToB+Codex codehash comparison can catch it.
If the operator rubber-stamps the ENTER prompt (`:279`) without truly diffing the printed codehashes
against the pinned OP/MegaETH equivalents, a non-audited contract gets solver authority.

**Exploitability:** MEDIUM (as a process-failure path), LOW as a remote exploit. The named human gate
is the mitigation; the risk is that it is the ONLY mitigation for the most security-critical property.

**Concrete impact**
A subtly-wrong Auth implementation could ship with altered `isSolver`/`onlyManager` semantics behind
the proxy and still pass every machine check, granting unintended solver authority. Bounded by the
same settlement blast radius as F1.

**Hardening (turns the human gate into a machine gate):** pin the expected OP/MegaETH codehashes for
AuthImpl/Balances/Signatures as constants in the script (or read them from `deployments/optimism-mainnet`
/ `deployments/megaeth-mainnet` at runtime) and `exit` on mismatch BEFORE the pause, exactly as the
wiring block already does. The data to do this is already in-repo (the impl/Balances/Signatures live
artifacts). This converts "human must notice" into "script refuses."

**Root cause:** `deploy-mainnet-all.sh:242-245` (print-only loop) vs `:269-273` (hard wiring asserts).

---

### F3 — [LOW] Hostile/man-in-the-middle RPC can make the entire gate pass on fabricated data
**Maps to question 6.**

**Attacker model**
- WHO: an attacker controlling, MITM-ing, or DNS/BGP-hijacking the path to the configured RPC
  (`UNICHAIN_MAINNET_RPC`, default public `https://mainnet.unichain.org`), OR a malicious operator who
  points `UNICHAIN_MAINNET_RPC` at their own node.
- ACCESS: network position or `.env` write.
- INTERFACE: every `cast call` / `cast code` / `cast codehash` / `cast storage` in the script.

**Attack vector**
ALL gate evidence is read back from `$RPC`: `cast chain-id` (the 130 check), `cast code` (Safe-has-code),
`getThreshold`/`getOwners`, every wiring getter, the codehash, the EIP-1967 storage slot, and the
final `owner()/manager()` confirmation. A hostile RPC can return chainId=130, a fabricated 2-of-3
owner set that happens to include the expected owners, correct-looking wiring, and matching
`owner()==manager()==Safe` after the ownership txs — while the txs (which are Ledger-SIGNED and
broadcast through the same RPC) are either dropped, replayed, or relayed to a different chain/contract.
The signed txs themselves are safe (Ledger shows the operator real calldata), but the script's
*verification* of success is only as trustworthy as the RPC. The codehash baseline is pinned to
OP/MegaETH, but the LIVE codehash being compared is RPC-sourced, so a hostile RPC defeats even a
machine-ified F2 check.

**Exploitability:** LOW. Requires MITM of a TLS endpoint or operator misconfiguration; the public
unichain.org endpoint over HTTPS is a reasonable trust anchor. Real but conditional.

**Concrete impact**
The operator could believe the ceremony succeeded (Safe owns Auth, wiring correct) when on-chain
reality differs — e.g. ownership never actually transferred, leaving the Ledger as a live unilateral
manager (see F5), or a malicious solver silently allowlisted. No direct fund loss from the RPC alone;
the damage is a false "all-clear" that masks one of the other findings.

**Hardening:** cross-check the critical reads against a SECOND independent RPC (or a block explorer)
at the gate and at the final `owner()/manager()` confirm. Pin RPC by TLS cert/known-good URL in
`.env.example` and treat a non-default `UNICHAIN_MAINNET_RPC` as requiring a typed confirm.

---

### F4 — [LOW] CREATE2 front-run / address-squat of the deterministic Settlement & Auth-impl is a griefing DoS, not a takeover
**Maps to question 4 (CREATE2 frontrun/squat) and question 1 (other bricking paths).**

**Attacker model**
- WHO: anyone watching the public mempool of chain 130 (the SALT "Mattresses in Berlin!", the
  Arachnid deployer, and Ophis's exact artifacts are all public — addresses are fully precomputable).
- ACCESS: an RPC and a few cents of gas on 130.
- INTERFACE: the Arachnid deterministic-deployment proxy `0x4e59b448...4956C`.

**Attack vector**
Because every deterministic address is precomputable, an attacker can deploy *something* to the
Settlement or Auth-impl CREATE2 address before the ceremony does.
- Settlement / Auth-impl: the CREATE2 address is a function of the EXACT creation bytecode+args. To
  squat the address with DIFFERENT code, the attacker would need a bytecode preimage colliding on the
  CREATE2 salt — infeasible. They can only deploy the IDENTICAL Ophis bytecode there (which is benign:
  it IS the intended contract). So a *malicious-code* squat at these addresses is not possible.
- The realistic attack is GRIEFING: front-run with the identical bytecode so the ceremony's own
  CREATE2 deploy reverts ("contract already deployed at address"), or self-destruct-then-redeploy
  games. On a deterministic-deploy this typically just means the deploy no-ops to the already-present
  (correct) code, but it can also break hardhat-deploy's bookkeeping and stall the ceremony.
- The Auth PROXY address is manager-independent (proven: OP==MegaETH proxy address). A pre-deployed
  proxy at that address initialized by an ATTACKER (attacker as manager) is the one scenario worth a
  hard check — see below.

**Exploitability:** LOW. Code-substitution is infeasible (CREATE2 binds bytecode). Pure griefing/DoS
is EASY but only costs the ceremony a restart, not funds or authority.

**Concrete impact**
Worst realistic case: ceremony stalls / a step reverts and must be re-run. The new clean-tree check
(`deployments/unichain-mainnet/` is currently absent — verified) means no stale local artifact
mis-binds a prior run. No governance loss.

**Hardening (closes the proxy-squat residue):** the gate already asserts the proxy's impl slot points
at the verified impl. ADD an explicit assert that `Auth.owner()` (proxy admin, EIP-1967 admin slot)
== the expected deployer/Ledger at the gate, BEFORE transferOwnership. If an attacker pre-seeded the
proxy with themselves as admin/manager, `owner()` would not be the Ledger and the script would refuse.
Today the script reads the impl slot but not the admin slot at the gate.

---

### F5 — [LOW] Interrupt windows leave recoverable states, EXCEPT one: a dropped/failed transferOwnership that the operator believes succeeded
**Maps to question 3.**

**Attacker model**
- WHO: operator interrupting (Ctrl-C) or an on-chain tx silently failing, combined with a later
  Ledger compromise.
- ACCESS: physical ceremony + later theft of the Ledger.
- INTERFACE: the partial-migration state of `Auth`.

**Attack vector (window analysis)**
- Between deploy steps (1 -> 2 -> 2.5): contracts exist, Ledger is owner+manager, no solver yet.
  Safe; re-runnable. CREATE2 makes re-runs idempotent on address.
- Step 3 done, step 4 not started: Ledger is owner+manager AND the driver is an allowlisted solver.
  This is a UNILATERAL-AUTHORITY window: a stolen Ledger here can addSolver/removeSolver/upgrade/
  setManager at will. The script minimizes it (step 4 immediately follows), but if the operator stops
  at the gate-after for ToB and walks away, the Ledger is a live single key with full protocol power.
- Between transferOwnership and setManager (the documented window): order is transferOwnership FIRST,
  so the interrupted state is Safe=owner, Ledger=manager. The Safe strictly dominates (can
  removeSolver + setManager(Safe)); a stolen Ledger can only addSolver (bounded). This is the
  correct fail-safer ordering and is RECOVERABLE. Good.
- THE ONE SHARP EDGE: `cast send ... transferOwnership` uses `>/dev/null` and does NOT verify the
  receipt status === success before firing setManager and before the final owner() check. The final
  `owner()` check (`:320,329`) DOES catch a failed transferOwnership (owner!=Safe -> exit 6). BUT if
  the RPC is hostile (F3) or the owner() read is stale, a transferOwnership that actually FAILED could
  be masked, leaving the Ledger as owner+manager while the operator sees "OK." Combined with the
  walk-away-after-success assumption, that is a latent unilateral-Ledger state.

**Exploitability:** LOW. Requires interrupt/failure PLUS later Ledger compromise PLUS (for the masked
case) a hostile RPC. The fail-closed ordering and the final owner()/manager() asserts cover the
honest-RPC case well.

**Concrete impact**
Latent unilateral Ledger authority over the allowlist if a failure is masked. Bounded by settlement
blast radius. Not a permanent brick (the Ledger can still complete the transfer).

**Hardening:** check each `cast send` receipt `status==1` inline (cast send exits nonzero on revert,
but `>/dev/null` hides the body; add `|| exit`), and re-read owner() from a second RPC at the final
confirm.

---

### F6 — [INFO/LOW] Bricking paths beyond the (now-guarded) zero/typo Safe
**Maps to question 1.**

The zero/typo/EOA/wrong-chain Safe brick is fully guarded (format + code + threshold==2 + owners==3 +
optional owner-set assert + typed confirm). Residual brick vectors, all LOW/operator-class:
- **setManager to a non-Safe by manual recovery typo.** The documented Ctrl-C recovery line
  (`:305`) is a raw `cast send ... setManager(address) $SAFE`. If the operator hand-edits that and
  fat-fingers the target, `setManager` is single-step with no zero-guard (contract WARNING at
  `GPv2AllowListAuthentication.sol:103`) -> permanent loss of manager control. The script's automated
  path can't typo $SAFE (it's validated), but the documented MANUAL recovery path is unguarded copy-paste.
- **Wrong Safe on a forked/duplicate chainId.** chainId==130 is asserted from the RPC (F3 caveat). A
  Safe that is valid on a DIFFERENT chain but the RPC reports 130 (hostile RPC) would pass and receive
  authority that is meaningless on the real 130. Tied to F3.
- **upgradeTo to a bad impl by the Safe later** is governance risk (F1), not a ceremony brick.

**Exploitability:** LOW, operator-error class. The primary script flow is well-guarded.

**Hardening:** add a zero/format/code/threshold check to the documented manual recovery snippet, or
better, ship a `resume.sh` that re-validates $SAFE before the manual setManager.

---

### F7 — [PASS] Wrong solver / submitter substitution
**Maps to question 2.**

- The allowlisted address is `DRIVER=0x7A956C269a12f1B897367663b536EB5dd29f3fBb`, a hardcoded constant
  in the script (`:65`), NOT read from `.env` — so an attacker who can write `.env` cannot substitute
  the submitter EOA without editing the (presumably reviewed, version-controlled) script itself. Good.
- After addSolver, `isSolver(DRIVER)` is asserted true (exit 5 otherwise). A wrong/extra solver is not
  silently added by the script.
- The driver PK lives 0600 on the stack host, never in this script or repo. Good.
- Residual: the script does NOT assert that DRIVER is the ONLY solver, and does not assert
  `isSolver` is false for any OTHER address. If the deterministic Auth proxy were somehow pre-seeded
  with an extra solver (only possible via the manager, i.e. the Ledger or a squatted proxy per F4),
  it would not be detected. Covered by F4's proxy-admin assert recommendation.

**Verdict:** no substitution path through the script's inputs. PASS.

---

### F8 — [PASS] Secret / key handling
**Maps to question 7.**

- No private key is ever in this script or in `hardhat-megaeth.config.ts` for the mainnet path.
  Mainnet signs via Ledger (`ledgerAccounts: [OPHIS_HW_WALLET]`); `accounts` is empty for the
  Ledger networks. `OPHIS_MEGAETH_DEPLOYER_PK` is consumed only by TESTNET networks.
- The driver submitter PK is explicitly NOT in the repo (comment `:64`), lives 0600 on the host.
- `.env` is sourced with `set -a` and holds only addresses/RPC URL + the optional expected-owners
  list — no secret material is required by the ceremony.
- The deploy log (`tee "$LOG"`) captures hardhat-deploy output (addresses, gas), not keys.
- One nit: `set -a; source "$ENV_FILE"; set +a` exports EVERY var in `.env` into the environment of
  all child `cast`/`hardhat`/`python3` processes for the whole run. If an operator ever puts an
  unrelated secret in that `.env`, it leaks into every subprocess env and into the hardhat process.
  Keep `.env` strictly address-only; do not co-locate the driver PK or any token there. INFO-level.

**Verdict:** clean for the documented usage. PASS, with the keep-.env-secret-free nit.

---

## OVERALL VERDICT

**SAFE TO RUN** under the stated preconditions (funded deployer+submitter, a real 2-of-3 Safe on 130
with `OPHIS_SAFE_EXPECTED_OWNERS` set, live ToB+Codex at the 2.5 pause, trusted RPC).

The diff from the rehearsed MegaETH ceremony is a pure hardening: it adds a chainId assert, full Safe
validation, a dual balance floor, and a wiring-asserted integrity gate. No authority logic was
weakened and no new bricking path was introduced. The deterministic-CREATE2 design means the worst
CREATE2 attack is griefing-DoS (a restart), not code substitution or takeover, because the salt binds
the bytecode.

There are NO HIGH findings and NO CRITICAL findings. The residual risk is concentrated in two
process-dependent properties that the script delegates to humans rather than enforcing:

1. (F2) The codehash integrity check is print-only — the security of the most critical property
   (is the deployed code the audited code) rests entirely on the operator actually diffing the
   printed codehashes at the pause. This is trivially convertible to a hard machine assert using the
   in-repo OP/MegaETH baseline artifacts. RECOMMEND doing so before run.
2. (F1) The direct-to-Safe, no-Timelock posture is acceptable ONLY for genuine Phase-0 low/zero TVL,
   and the "Timelock before TVL" rule is prose, not an enforced gate. RECOMMEND wiring a technical
   block: the public frontend-enable / config-render step must refuse until Auth owner==manager is a
   24h TimelockController, not the bare Safe.

Recommended-but-not-blocking hardening before the run: machine-assert the (1) codehashes (F2);
add an `Auth.owner()`/admin-slot==expected-Ledger assert at the gate (F4); verify each `cast send`
receipt status and cross-check the final owner()/manager() on a second RPC (F3/F5); guard the
documented manual recovery snippet (F6). None of these block the ceremony; all reduce reliance on
flawless operator behavior.

Bottom line: ship it as-is if the operator is disciplined at the pause; ship it with the F2 codehash
machine-assert if you want the gate to be self-enforcing rather than human-enforcing.
