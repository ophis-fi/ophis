# `ophis.fi` — DNS hijack hardening runbook

Threat model: the April 2026 `cow.fi` hijack. Attacker socially-engineered the `.fi`
registry (Traficom) and/or the registrar (Gandi SAS) to redelegate the domain's
nameservers to attacker-controlled servers. Same registry, same registrar topology
applies to `ophis.fi`. **Three defenses, in increasing operational difficulty.**

## State (as of 2026-05-11)

| Layer | Before | After this runbook |
|---|---|---|
| Nameservers | `gabe.ns.cloudflare.com`, `paloma.ns.cloudflare.com` | unchanged |
| CAA | none — any CA could issue | **9 records published** (5 `issue` + 3 `issuewild` + 1 `iodef`) |
| DNSSEC signing | inactive at CF | **active at CF, status `pending` until DS lands** |
| DS record at Traficom | not published | **pending operator paste** (step 2 below) |
| Registry lock at Traficom | not applied (status `ACTIVE` plain) | **pending operator action** (step 3 below) |

## Step 1 — CAA (DONE, 2026-05-11)

Records added via CF API. Restricts cert issuance to CAs Cloudflare actually uses
when rotating Universal SSL certificates:

```
ophis.fi. CAA 0 issue     "letsencrypt.org"
ophis.fi. CAA 0 issue     "pki.goog"
ophis.fi. CAA 0 issue     "comodoca.com"
ophis.fi. CAA 0 issue     "digicert.com"
ophis.fi. CAA 0 issue     "ssl.com"
ophis.fi. CAA 0 issuewild "letsencrypt.org"
ophis.fi. CAA 0 issuewild "pki.goog"
ophis.fi. CAA 0 issuewild "comodoca.com"
ophis.fi. CAA 0 iodef     "mailto:clement@openletz.com"
```

The `iodef` is Cloudflare-CAA-compliant policy violation reporting — if any CA
attempts a non-allowed issuance, they're required to email this address.

Verify:
```
dig +short CAA ophis.fi @1.1.1.1
```

If TLS renewals start failing in the future, double-check whether CF added a new
issuer outside this list. CF's recommended list is at
https://developers.cloudflare.com/ssl/edge-certificates/caa-records/.

## Step 2 — DNSSEC DS record at Traficom (OPERATOR ACTION)

DNSSEC is signing at Cloudflare. The chain of trust completes when the DS record
below is published at the registry via Gandi.

**Paste-ready values** (Gandi UI → Domain → Glue records / DNSSEC):

| Field | Value |
|---|---|
| Key tag | `2371` |
| Algorithm | `13` (ECDSAP256SHA256) |
| Digest type | `2` (SHA256) |
| Digest | `5B7DFDBA23103B6378808EA0A27AB6257DB48513A2FD931852F49A5C730EBF66` |
| Public key (raw, only if Gandi asks) | `mdsswUyr3DPW132mOi8V9xESWE8jTo0dxCjjnopKl+GqJxpVXckHAeF+KkxLbxILfDLUT0rAK9iUzy1L53eKGQ==` |

Or as a raw DS record line (some registrars accept this directly):
```
ophis.fi. 3600 IN DS 2371 13 2 5B7DFDBA23103B6378808EA0A27AB6257DB48513A2FD931852F49A5C730EBF66
```

Verify (15-60 min after Gandi pushes to Traficom):
```
dig +short DS ophis.fi @1.1.1.1
dig +dnssec A ophis.fi @1.1.1.1 +short    # should now return RRSIG lines
```

The Cloudflare DNSSEC status should flip from `pending` to `active` within an
hour, observable at:
```
curl -sS -H "Authorization: Bearer $CF_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones/dd7588af506387891f094a4927e11d7a/dnssec" \
  | jq '.result.status'
```

## Step 3 — Registry lock at Traficom (OPERATOR ACTION, HIGHEST VALUE)

This is the single most important defense. The CoW Swap incident write-up confirms
their AWS Route 53 → Gandi setup did not support `.fi` registry lock, and that
moving to NETIM (which does) was their post-incident remediation.

Registry lock applies the following EPP status codes at the `.fi` registry level,
each of which requires out-of-band verification (phone + token) to lift:

- `serverUpdateProhibited` — blocks all DNS / glue / contact updates
- `serverTransferProhibited` — blocks registrar transfers
- `serverDeleteProhibited` — blocks domain deletion

Three paths to enable:

### Option A — Gandi (preferred if supported)

Gandi has a "Premium Lock" (a.k.a. registry lock) product. As of late 2025 it
supports a subset of TLDs. **Check if `.fi` is supported** by:

1. Logging into Gandi → Domain → Security → Premium Lock
2. If the product is available for ophis.fi, follow Gandi's enrollment flow:
   - Pay enrollment fee (typically €100/yr)
   - Designate authorised users + recovery codes
   - Gandi sends a notarised request to Traficom on your behalf

If Gandi *doesn't* offer it for `.fi`, proceed to Option B.

### Option B — Migrate the domain to a registrar that supports `.fi` registry lock

Known supporters of `.fi` registry lock as of 2025:
- **NETIM** (France) — CoW Swap migrated here post-incident; offers `.fi` lock as a standard service
- **OpenSRS** (Tucows) — supports `.fi` lock for resellers
- **OVHcloud** — some `.fi` support; verify lock availability with their corporate team

Migration steps (Gandi → NETIM example):

1. Open a new account at NETIM (https://www.netim.com), enable 2FA, complete KYC
   for the contact details that match the current WHOIS for ophis.fi (Clement /
   COMMIT MEDIA — same legal entity, otherwise Traficom blocks the transfer).
2. In Gandi → Domain → Manage → unlock the domain (`clientTransferProhibited` →
   off), reveal the authorization code ("EPP code" / "transfer key").
3. At NETIM → Transfer → enter ophis.fi + the EPP code. NETIM initiates the
   transfer with Traficom. Gandi sends a confirmation email — **approve it**.
4. Traficom holds a 5-day approval window during which the domain is in transit.
   **DNS records continue to resolve** as long as the NS values stay at
   Cloudflare (the NS delegation transfers with the domain, not the records).
5. After transfer completes (5-7 days total), at NETIM → Domain → Registry Lock
   → enable. NETIM signs the request to Traficom; lock takes effect within 24h.
6. Re-verify status:
   ```
   whois ophis.fi | grep -i status
   ```
   Should now show `clientTransferProhibited` plus `serverUpdateProhibited /
   serverTransferProhibited / serverDeleteProhibited`.

### Option C — Self-direct relationship with Traficom

`.fi` allows direct end-user registration without a registrar (Traficom is the
registry). Documented at https://www.traficom.fi/en/communications/fi-domain.
This is heavy: requires Finnish business identifier or a Finnish-resident agent.
Only sensible if NETIM-style commercial registrar lock proves unworkable.

## Step 4 — Monitor

Already enabled this week per session log (`Traficom monitor active`). Verify:
- Email alerts on WHOIS changes (Gandi → Domain → Security → Notifications)
- DNSSEC monitoring at https://dnsviz.net/d/ophis.fi (manual periodic check)
- Cert-transparency monitor: subscribe to https://crt.sh/?q=ophis.fi RSS or set
  up a Cloudflare Worker that polls hourly and Telegrams on unexpected issuances

## Fallback domains (same defenses, separate registries)

The redirect-only domains `ophis.xyz`, `ophis.finance`, `ophis.exchange`
(all 301 → `ophis.fi`) got the **same CAA + DNSSEC-signing** applied
on 2026-05-11. Smaller attack surface (different TLDs = different
registries = different social-engineering targets), but the same
defense-in-depth so a hijacked fallback can't be turned into a phishing
funnel against users who type the wrong domain.

| Domain | DS record to paste at the registrar |
|---|---|
| `ophis.fi`       | `ophis.fi. 3600 IN DS 2371 13 2 5B7DFDBA23103B6378808EA0A27AB6257DB48513A2FD931852F49A5C730EBF66` |
| `ophis.xyz`      | `ophis.xyz. 3600 IN DS 2371 13 2 10A2D76075FE6571FFDA15D7E76A51ACAAD334711476A1BF35E66A42F0BB7B5C` |
| `ophis.finance`  | `ophis.finance. 3600 IN DS 2371 13 2 57013D7C6C07609FECB4F586A700260DC6DB8503F70D0151EA5ECBB237BBD52B` |
| `ophis.exchange` | `ophis.exchange. 3600 IN DS 2371 13 2 BF5C524A2FE0D10D6E78D3CDE5F7E51A5465F8C2B8DE78866E47A2E7E0468888` |

Field-form for each (Key tag, Algorithm, Digest type, Digest are all
the same shape — only the digest hex string differs):

- **Key tag:** `2371` (all four; Cloudflare's KSK rotation cycle happens to align)
- **Algorithm:** `13` (ECDSAP256SHA256)
- **Digest type:** `2` (SHA256)
- **Digest:** the 64-hex-char string from the table above

Registry-lock for the fallbacks is **not currently warranted** — they're
redirect-only and carry no rebate-relevant cookies, no API endpoints, and
no user-signed transactions land on them. If usage shifts (e.g., one of
the fallbacks becomes canonical for a partner integration), revisit.

## Rollback procedures

**Roll back CAA records** (if cert renewal starts failing for an unanticipated
issuer):
```
# List CAA records to find the IDs
CF_TOKEN=$(security find-generic-password -l "cloudflare-api-token" -w)
curl -sS -H "Authorization: Bearer $CF_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones/dd7588af506387891f094a4927e11d7a/dns_records?type=CAA" \
  | jq '.result[] | {id, name, data}'
# Delete by id:
curl -sS -X DELETE -H "Authorization: Bearer $CF_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones/dd7588af506387891f094a4927e11d7a/dns_records/<ID>"
```

**Roll back DNSSEC** (only if DS at registry would cause a resolution outage):
```
curl -sS -X PATCH -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
  -d '{"status":"disabled"}' \
  "https://api.cloudflare.com/client/v4/zones/dd7588af506387891f094a4927e11d7a/dnssec"
```
Then remove the DS at Gandi. There's a 24-48h NXDOMAIN risk window during this
sequence — only do this if active outage forces it.

## Edge security settings (HSTS / Always Use HTTPS / SSL) — issue #440

Source: 2026-06-04 Cloudflare Security Insights scan (all findings Moderate/Low).
The scanner flagged missing HSTS, missing "Always Use HTTPS", and SSL not
Full(strict) on `ophis.fi` + its subdomains (`optimism-mainnet`, `rebates`,
`mcp`, `megaeth*`) and the parked zones `ophis.xyz` / `ophis.finance` /
`ophis.exchange`. (`swap.ophis.fi` already sets HSTS via its `_headers`.)

**security.txt (done, in-repo):** `/.well-known/security.txt` is served from each
Pages surface's tracked static dir (swap/explorer/landing `public/.well-known/`,
docs `static/.well-known/`). Edit those 4 source files, not build output. Bump
`Expires:` before 2027-06-05.

**Zone settings (BLOCKED on token scope — needs action):** the Keychain
`cloudflare-api-token` can READ zone settings but PATCH returns `9109
Unauthorized` — it lacks **Zone Settings:Edit**. Either widen that token's scope
or run the calls below with a token that has it (or toggle in the dashboard:
SSL/TLS > Edge Certificates). Token is read into an env var in a subshell and
NEVER echoed:

```
CF_TOKEN=$(security find-generic-password -l "cloudflare-api-token" -w)
# Zone IDs: ophis.fi=dd7588af506387891f094a4927e11d7a
#           ophis.xyz=3569e4bcb2f7b82967fd5dbbf85c2d34
#           ophis.finance=e5439d6423c432ba0301831e57d2ace0
#           ophis.exchange=ec0a041627dc152e2ace46f70748f885
ZID=dd7588af506387891f094a4927e11d7a   # repeat per zone

# Always Use HTTPS (edge http->https redirect; safe)
curl -sS -X PATCH -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
  -d '{"value":"on"}' \
  "https://api.cloudflare.com/client/v4/zones/$ZID/settings/always_use_https"

# HSTS (1y, includeSubDomains, nosniff). NOTE: preload is FALSE here on purpose.
# The `preload` directive in the header is itself authorization for any third
# party to submit the apex to hstspreload.org, which is irreversible-ish. Leave
# it false until the soak/verification window is done, then flip preload:true as
# the FIRST step of the hstspreload submission (tracked in ophis-domains.md).
curl -sS -X PATCH -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
  -d '{"value":{"strict_transport_security":{"enabled":true,"max_age":31536000,"include_subdomains":true,"nosniff":true,"preload":false}}}' \
  "https://api.cloudflare.com/client/v4/zones/$ZID/settings/security_header"
```

**SSL Full(strict) — verify origins FIRST, do not blind-flip.** The `ophis.fi`
zone fronts both edge-terminated Pages hosts (fine) AND the tunnel origin
`optimism-mainnet.ophis.fi`. Cloudflared presents a valid cert to the edge, so
strict is normally safe, but confirm each origin's chain before flipping:
```
curl -sS -X PATCH -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
  -d '{"value":"strict"}' "https://api.cloudflare.com/client/v4/zones/$ZID/settings/ssl"
```
Verify after any change: `curl -sI https://<host>/` shows
`strict-transport-security: max-age=31536000; includeSubDomains` (NO `preload`
token yet) and an http URL 301-redirects to https. Do NOT submit to
hstspreload.org here, and do NOT add the `preload` directive until that separate
post-soak step (tracked in `ophis-domains.md`) is actually ready.
