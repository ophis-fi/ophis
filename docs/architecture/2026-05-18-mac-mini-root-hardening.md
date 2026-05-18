# Mac Mini Root-Compromise Hardening

**Date:** 2026-05-18
**Audit context:** Phase 1 HIGH-3 follow-up. After Tier 1 PK isolation, the dominant remaining threat is a Mac mini root compromise that bypasses user-isolation.

## Current state (probed 2026-05-18)

| Defense | Status | What it stops |
|---|---|---|
| FileVault | ✓ ON | Stolen-powered-off attack. Apple Silicon Secure Enclave holds the FileVault key. |
| System Integrity Protection (SIP) | ✓ enabled | Root cannot modify `/System`, `/usr/bin`, kexts, launchd binaries. Kernel exploits required. |
| Gatekeeper | ✓ enabled | Unsigned/notarized apps don't run silently — user prompt at launch. |
| Firewall + Stealth mode | ✓ on | No unsolicited inbound connections. Ping/probe replies suppressed. |
| macOS version | ⚠️ 26.4.1 (26.5 available) | Security patches pending — install. |
| Xcode CLT update | ⚠️ pending | Patch when convenient. |

The baseline is already strong. macOS Tahoe + Apple Silicon Secure Enclave + FileVault + SIP + Gatekeeper closes most realistic attack paths.

## What "root compromise" actually requires today

For an attacker to get root on the Mac mini, one of these must happen:

1. **macOS kernel zero-day** — rare, fixed within 1-2 weeks usually. Mitigation: keep updates current.
2. **You enter your password into something malicious** — fake "install Xcode tools" prompt, supply-chain compromise in a brew/npm package that asks for sudo, social-engineering. Mitigation: sudo-MFA via YubiKey, never paste sudo passwords into anything that wasn't started by you.
3. **Physical theft + booted Mac with FileVault active and you logged in** — attacker waits for FileVault to be unlocked, exfiltrates while alive. Mitigation: lock screen on inactivity (≤5 min), wake password required, FileVault re-lock on sleep.
4. **Network → local privilege escalation chain** — exploit some daemon listening on a port. Mitigation: firewall + stealth (✓ done), no unnecessary services.

## Recommended additional hardening (FREE, uses existing tools)

### Tier 1.A: Install pending security patch (5 min)

```bash
sudo softwareupdate -i -a -R
```

This installs both macOS 26.5 and the Xcode CLT update, restarts. Apply during a maintenance window where no driver is running.

### Tier 1.B: YubiKey C Bio as sudo MFA (30 min) — uses hardware you already have

YubiKey Bio is FIDO2-only, but macOS supports PIV-based smart-card login via the YubiKey, and PAM modules can require a YubiKey-presence challenge for sudo. Either pathway works.

**Easiest path: `pam_yubico`** (HMAC-SHA1 challenge-response):

```bash
brew install ykman ykpers
# Configure the YubiKey with a per-host HMAC slot
ykman otp chalresp --generate 2

# Authorize this YubiKey for user scep
mkdir -p ~/.yubico
ykman otp calculate 2 "$(uuidgen)" > /tmp/yk_test
# Map serial → user in /var/yubico/authorized_yubikeys (one line: scep:CCCCC...)

# Add to /etc/pam.d/sudo at the TOP:
#   auth required /usr/local/lib/security/pam_yubico.so mode=challenge-response
```

After: every `sudo` requires YubiKey touch + fingerprint. Cuts off the "you typed sudo password into malware" path entirely — a stolen password is useless without the physical YubiKey.

### Tier 1.C: Drop ARD daemon if not used (1 min)

The `com.apple.remotemanagementd` daemon is running. If you don't use Apple Remote Desktop or Screen Sharing:

```bash
# Disable Screen Sharing
sudo launchctl bootout system/com.apple.screensharing
# Disable Remote Management (kickstart with -deactivate)
sudo /System/Library/CoreServices/RemoteManagement/ARDAgent.app/Contents/Resources/kickstart -deactivate -stop
```

### Tier 1.D: Separate admin / daily user (medium effort, optional)

Create a `scep-admin` user with admin privileges, demote `scep` to Standard. Daily work as `scep` can no longer `sudo`; admin work requires explicit user switch. Significant friction; consider only if other measures aren't enough.

### Tier 1.E: Tailscale ACL strict (5 min, if not already)

Check `~/.config/tailscale.json` or the Tailscale web admin: ACL should restrict who can reach the Mac mini's tailscale interface. By default Tailscale is mesh-open within a tailnet — for a single-user tailnet this is fine.

## Recommended ongoing hygiene

1. **Don't `sudo npm install` random packages.** npm/pnpm/yarn don't need sudo to install in user-scoped projects. If a package asks for sudo, audit it.
2. **Avoid `curl | sudo bash`.** Read the script first.
3. **Use Homebrew without `sudo`** — Homebrew installs under `/opt/homebrew/` owned by `scep`, doesn't need root.
4. **macOS Auto Update**: ON for Security Responses (System Settings → General → Software Update → Automatic Updates → Install Security Responses and system files).
5. **Lock screen quickly**: System Settings → Lock Screen → "Require password [Immediately] after screen saver / sleep begins".

## What none of this defends against

- Cryptographically-broken hardware (extremely unlikely on Apple Silicon)
- An attacker who already has your AppleID + 2FA AND physical access to the Mac mini for several minutes
- A compromised Apple software update mechanism (essentially nation-state level)

These are out of scope for routine hardening. They're addressed by the Tier 2 (AWS KMS) path — if root can't compromise the key because the key isn't on the box, the root-compromise threat goes away by construction.

## Decision matrix

| Want | Cost | Time | Closes |
|---|---|---|---|
| Tier 1 PK isolation (this session) | $0 | 30 min | "process running as scep" threat |
| Tier 1.A patch install | $0 | 5 min | known kernel CVEs |
| Tier 1.B YubiKey sudo MFA | $0 | 30 min | "you typed sudo password into malware" |
| Tier 1.C drop ARD if unused | $0 | 1 min | one daemon, marginal |
| Tier 1.D split admin user | $0 | 1 hour | admin-creep, defense-in-depth |
| Tier 2 AWS KMS | ~$140/yr | 1 week | root compromise / theft entirely |

**Recommended pick-list** (defense ROI):
1. Tier 1 PK isolation — ship now
2. Tier 1.A patch install — this week
3. Tier 1.B YubiKey sudo MFA — this week, biggest per-hour-spent win
4. Tier 1.C drop ARD if you don't use it
5. Tier 1.D + Tier 2 — defer until incident or TVL growth justifies
