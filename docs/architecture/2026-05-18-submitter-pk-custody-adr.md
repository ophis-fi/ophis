# ADR: Driver-Submitter Private Key Custody

**Date:** 2026-05-18
**Status:** Proposed (pending Clement decision on platform)
**Audit context:** Phase 1 audit HIGH-3 — current setup has the driver-submitter PK in plaintext at `~/greg/infra/<chain>-mainnet/rendered/driver.toml` (chmod 600) and in `.env` (chmod 600). Both readable by any process running as user `scep`. Submitter EOA `0xFB308397267878228f7761311DBD6Bc6FCa1bB5a` is the SOLE allowlisted solver-submitter across HL/OP/MegaETH. Compromise = arbitrary settle dispatch, drains every outstanding VaultRelayer approval.

## Constraints

1. **Hot key** — must sign every settlement tx (1Hz steady-state, up to ~10Hz burst on HL).
2. **Latency budget** — autopilot's `submission-deadline = 60 blocks`. On HL's 1s blocks = 60s end-to-end. Signing latency budget ≤ 200ms p99.
3. **Three chains** — single submitter EOA must sign for HL (chain 999), OP (10), MegaETH (4326). Per-chain isolation would require 3 separate keys + 3 separate `addSolver` calls per chain.
4. **Operator hardware** — Clement has 3 Ledger Nano devices + 1 YubiKey C Bio (FIDO Edition). Ledgers are reserved for the Safe; YubiKey Bio is FIDO2/WebAuthn only (no secp256k1, no PIV-OpenPGP — cannot directly sign Ethereum txs).
5. **Aleph free for Clement** — VM compute is $0, but external API costs count.
6. **Mac mini at home is the current execution host** — anything cloud-based depends on Mac mini's residential ISP.

## Candidate platforms

### A. AWS KMS (Asymmetric ECC_SECG_P256K1 key)

- **How it works**: KMS holds the secp256k1 private key inside a FIPS 140-2 L3 HSM in AWS. Driver calls `Sign(KeyId, MessageHash, RAW)` over HTTPS; KMS returns DER signature; driver assembles r/s/v + recovers Ethereum address.
- **Latency**: ~50-200ms per signature (single round-trip to AWS region, e.g. eu-central-1 or eu-west-3).
- **Cost**: $1/month per key ($3/month for 3 keys) + $0.03 per 10k signatures. At ~1Hz settle rate, ≈ 3M sigs/year = ~$100/year total. **Negligible.**
- **Access control**: AWS SSO (IAM Identity Center) gated by WebAuthn → **YubiKey Bio satisfies WebAuthn as a FIDO2 second factor**. So Clement's YubiKey Bio IS the SSO unlock factor. Driver process has IAM role on a long-lived assume-role session.
- **Pros**: Mature Rust crate ([`aws-sdk-kms`](https://crates.io/crates/aws-sdk-kms) + [`ethers-aws-kms-signer`](https://github.com/rage-proof/ethers-aws-kms-signer) ports exist for alloy too), regional redundancy via multi-region KMS replication, audit logs via CloudTrail.
- **Cons**:
  - Mac mini home-ISP outage = signing outage. Mitigation: drive the driver from an Aleph VM (Tailscale tunnel to KMS), since Aleph is $0 for Clement.
  - Round-trip latency to AWS adds 50-200ms per settle. p99 still well under 200ms with eu-central-1; HL's 60s submission deadline is unaffected.
  - Depends on AWS account. Clement may not have one — needs setup pass.

### B. YubiHSM2 (PKCS#11 secp256k1)

- **How it works**: $650 USB-A HSM plugged into Mac mini. Driver speaks PKCS#11 via [`yubihsm-rs`](https://crates.io/crates/yubihsm). Key never leaves device; signing is local.
- **Latency**: ~10-50ms (local USB, no network).
- **Cost**: $650 one-time. Zero runtime cost.
- **Access control**: Auth-key + password / PIN. No WebAuthn integration without extra plumbing.
- **Pros**: Maximum performance, no cloud dependency, FIPS 140-2 L3, tamper-evident.
- **Cons**:
  - Single point of physical failure (Mac mini stolen → no backup signer).
  - No SSO/WebAuthn unlock layer; PIN brute-force is the only auth.
  - Mac mini at home has only residential physical security.
  - Requires Mac mini to be the execution host — can't migrate driver to Aleph without VPN-shaping the HSM.

### C. Defer (status quo)

- Keychain copy + `.env` plaintext as today.
- **Pros**: $0 cost, simple, already working.
- **Cons**: Any local process running as `scep` (a future npm postinstall, a browser, a homebrew binary, a malicious VS Code extension) can read the PK.

### D. Coinbase Custody / Fireblocks

- **How it works**: 3rd-party custodial signer with per-tx approval policies.
- **Latency**: 5-30s typical, sometimes more — **disqualifying for solver-submitter** (HL 60s submission deadline).
- **Cost**: $5k+/year minimum, custody contract.
- Excluded — too slow and too expensive.

## Excluded option: Ledger for solver-submitter signing

A Ledger CANNOT be used for the solver submitter, despite Clement having 3 of them. Reason: every Ledger transaction requires a physical button press on the device for confirmation. This is intentional security design — the Ledger has no "auto-approve" or "blind-sign-headless" mode. A solver signing ~1Hz settlements would need ~86,400 button presses/day. Ledgers are correct for **cold** keys (Safe signers — which they already are), wrong for **hot** keys.

Note: Ledgers ARE used today for the protocol Safe (`0xe049…01cF`) and the partner-fee Safe (`0x858f…CeF8`). Those are the right places for hardware-wallet security.

## New option: Free tier — dedicated macOS user + Docker (uses tools Clement already has)

Insertion before the AWS KMS recommendation: a $0 path that doesn't close the full threat model but addresses the actual audit-stated risk ("any process running as user `scep` can read the PK").

**Architecture**:
- Create dedicated macOS user `ophis-driver` with no shell (`UserShell /usr/bin/false`).
- Move the driver-submitter Keychain entry to that user's Login Keychain (or a System Keychain with ACL pinned to `ophis-driver`).
- Docker container runs as `ophis-driver` via launchd; reads PK once at container start via `security find-generic-password -w`; injects into container env; never writes PK to container filesystem.
- File permissions: `chmod 700 /Users/ophis-driver` so `scep` can't traverse.

**Threat model after free-tier**:

| Threat | Today | After free-tier | After KMS |
|---|---|---|---|
| Malicious npm postinstall as `scep` | ❌ PK exposed | ✓ different user | ✓ KMS holds key |
| Malicious browser extension as `scep` | ❌ PK exposed | ✓ different user | ✓ KMS holds key |
| Compromised dev tool as `scep` | ❌ PK exposed | ✓ different user | ✓ KMS holds key |
| Mac mini root compromise | ❌ PK exposed | ❌ PK in Keychain readable as root | ✓ KMS-side enforcement |
| Mac mini stolen (no disk encryption) | ❌ PK exposed | ❌ PK on disk | ✓ KMS-side enforcement |
| Mac mini stolen (FileVault on) | ✓ encrypted | ✓ encrypted | ✓ KMS-side enforcement |

**Cost**: $0. ~30 min setup.

**Limits**:
- Doesn't defend against root compromise or physical theft (use FileVault for the latter).
- All 3 chains still share one PK (same multi-chain exposure as today).
- No audit trail equivalent to CloudTrail.

**This is the recommended Tier 1**: ship before any KMS work. Even after KMS lands later, the dedicated-user pattern remains valuable.

## Original recommendation: AWS KMS (B) with WebAuthn-gated SSO unlock — now Tier 2

**Why**:
1. Latency overhead (~150ms p95) fits the 60-second HL submission window with massive margin.
2. WebAuthn via YubiKey Bio gates AWS SSO — every operator action requires a fingerprint touch on the YubiKey, but the **driver process** has a long-lived (12h+) STS session credential, so settle signing during a session needs no fingerprint touch.
3. Migration path is clean: generate KMS key → derive Ethereum address → `addSolver(newAddr)` from Safe → cut over driver in maintenance window → `removeSolver(oldAddr)` from Safe → rotate the old keychain PK.
4. AWS account is the only new dependency; Clement already has cloud services (Vercel, Cloudflare). KMS is among the simplest AWS services to bootstrap.
5. Total cost ~$100/year is irrelevant.
6. **Defends against the actual threat model**: a malicious local process running as `scep` cannot extract the key from KMS — it can only burn the IAM role's signing budget, which is rate-limit-able and per-tx-auditable via CloudTrail.

## Migration plan

### Phase 1: Setup (1 day, no production change)

1. Clement creates AWS account (Free Tier OK; KMS not Free Tier eligible but is ~$0/month).
2. Set up IAM Identity Center (formerly AWS SSO). Add Clement as a user, register YubiKey Bio as the FIDO2 MFA device.
3. Create KMS key: `aws kms create-key --customer-master-key-spec ECC_SECG_P256K1 --key-usage SIGN_VERIFY`. Get the key-id.
4. Derive Ethereum address from KMS public key (one-time, `aws kms get-public-key | python derive_eth_addr.py`).
5. Fund the derived address with 0.01 ETH / 0.01 HYPE / 0.01 MegaETH on each chain (use the existing driver-submitter or Clement's wallet).

### Phase 2: Driver patch (1 day, sepolia test)

6. Patch `apps/backend/crates/driver/src/infra/signer/` to support an `AwsKmsSigner` impl alongside the existing `PrivateKeySigner`. Add config knob `signer.type = "kms"` + `signer.kms_key_id = "..."`. Reference impl: [ethers-aws-kms-signer](https://github.com/rage-proof/ethers-aws-kms-signer/blob/main/src/lib.rs) (port to alloy types).
7. Test on Sepolia using the existing `infra/spec-1-sepolia/` stack. Sign + broadcast a no-op tx, verify gas + nonce + signature flow.
8. Run e2e settle test on Sepolia: orderbook accepts solution, driver signs via KMS, autopilot watches tx land, success.

### Phase 3: Production cutover (per chain, ~30 min each)

For each chain (HL, OP, MegaETH):
9. From Safe: `addSolver(newKMSAddress)`.
10. Update `infra/<chain>-mainnet/configs/driver.toml.tmpl` to point at `signer.type = "kms"` and the new key-id.
11. Restart driver. Verify metrics: `solutions{result="success"}` continues, no `mempool_submission{result="failure"}` spike.
12. Watch ≥1 settle land successfully.
13. From Safe: `removeSolver(0xFB308397…1bB5a)`.
14. Rotate Keychain entry `ophis-driver-submitter-2026-05-14` to an inert value (or delete).

### Phase 4: Hardening (1 week)

15. Configure CloudTrail data event logging on the KMS key. Send to S3.
16. Add Prom alert: `kms_signature_count_total{key_id="..."} > 200/min` (signature rate-limit canary).
17. Set up an AWS Lambda or EventBridge rule that pages Clement on any `kms.Sign` call from a non-driver IP.
18. Document key-rotation runbook: how to re-key when the time comes.

## Cost summary

| Phase | One-time | Recurring |
|---|---|---|
| AWS account + KMS setup | Free | $3/month for 3 keys |
| Sign volume (3M/year @ $0.03/10k) | — | ~$100/year |
| Driver patch (Rust dev) | ~1 day (Clement) | — |
| CloudTrail logging | Free up to 5GB | ~$0/month (low volume) |
| **Total** | ~1 day eng + AWS sign-up | **~$140/year** |

## Updated migration plan: Tier 1 (free, ship immediately) → optional Tier 2 (KMS, later)

### Tier 1: dedicated macOS user + Docker (FREE, ~30 min)

Phase 1a (setup, no production change):
1. `sudo dscl . -create /Users/ophis-driver` (UID 502, GroupID 1000, no shell, home `/Users/ophis-driver`).
2. `sudo security add-generic-password -a ophis-driver -s ophis-driver-submitter-2026-05-14 -w <PK> /Users/ophis-driver/Library/Keychains/login.keychain-db` — copy the PK into a Keychain accessible only to the new user.
3. `chmod 700 /Users/ophis-driver` so user `scep` can't read its files.
4. Verify: `sudo -u scep cat /Users/ophis-driver/Library/Keychains/login.keychain-db` fails with permission denied.

Phase 1b (driver migration):
5. Update launchd plist (`~/Library/LaunchAgents/ai.ophis.driver.plist` or the docker-compose equivalent) to run the driver container as `ophis-driver`.
6. Container start script reads PK via `security find-generic-password -s ophis-driver-submitter-2026-05-14 -w` and exports to driver env. PK never persists to host disk.
7. Delete the existing plaintext `OPHIS_DRIVER_SUBMITTER_KEY` line from `~/greg/infra/<chain>-mainnet/.env`. The render-configs.sh expects this var; update it to fail-loudly if absent and source from Keychain at render time too.
8. Verify on Sepolia first, then 1 settle per mainnet chain.

This addresses the audit's actual stated threat at $0 cost. **Recommended**.

### Tier 2: AWS KMS (Phase 2-5 from original ADR, OPTIONAL)

Sequence once Tier 1 is shipped. Adds defense against Mac mini root compromise / theft. ~$140/year + ~1 week of intermittent work. Defer until either:
- A specific incident raises the threat level
- Phase 2 audit (backend) lands and you want stronger hot-key custody as a precondition for higher TVL
- Or a security-conscious enterprise integrator asks for the SOC2/audit-trail story KMS gives

## Decisions needed

1. **Approve Tier 1 (dedicated user + Docker, FREE)?** Should ship this week.
2. **Tier 2 timing**: defer entirely / sequence after Phase 2 audit / sequence before Phase 2 audit?
3. **If Tier 2 someday**: AWS account exists already, or new sign-up? Region pref?

Until Tier 1 lands, current Keychain + .env setup remains — risk is unchanged from audit baseline.
