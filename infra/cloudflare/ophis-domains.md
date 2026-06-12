# Ophis domains — Cloudflare setup runbook

Steps and ready-to-run snippets for migrating the four `ophis.*` domains
from Gandi LiveDNS to Cloudflare and wiring them to the `greg-etm` Pages
project.

| Domain | Role | Status |
| --- | --- | --- |
| `ophis.fi` | Canonical (serves the app) | registered 2026-05-10 at Gandi |
| `ophis.xyz` | Redirect → `ophis.fi` | already at Gandi (autorenew on, expires 2027-05-10) |
| `ophis.finance` | Redirect → `ophis.fi` | already at Gandi (autorenew on, expires 2027-05-10) |
| `ophis.exchange` | Redirect → `ophis.fi` | already at Gandi (autorenew on, expires 2027-05-10) |

Cloudflare account: `4761b41ef352631db0ed367fea98ffdc` (per memory).
Pages project: `greg` (project URL `https://greg.pages.dev`; canonical
user-facing domain `https://swap.ophis.fi`). The `.pages.dev` URL is the
internal deploy target only and is not in any Origin allow-list.

---

## Phase 1 — Add the four domains as Cloudflare zones

```bash
# Required env vars before running anything below:
#   CF_API_TOKEN  — Cloudflare API token with Zone:Edit, DNS:Edit, Pages:Edit
#   CF_ACCOUNT    — 4761b41ef352631db0ed367fea98ffdc
#   GANDI_TOKEN   — Gandi PAT with domain:tech scope (changes nameservers)
export CF_ACCOUNT=4761b41ef352631db0ed367fea98ffdc

for d in ophis.fi ophis.xyz ophis.finance ophis.exchange; do
  curl -sS -X POST "https://api.cloudflare.com/client/v4/zones" \
    -H "Authorization: Bearer $CF_API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"$d\",\"account\":{\"id\":\"$CF_ACCOUNT\"},\"type\":\"full\"}" \
    | python3 -c "import json,sys; r=json.load(sys.stdin); z=r['result']; print(z['name'], z['id'], z['name_servers'])"
done
```

Cloudflare returns two assigned NS values per zone (e.g. `*.ns.cloudflare.com`).
Save them.

---

## Phase 2 — Repoint Gandi NS to Cloudflare

For each domain, update the registrar NS records at Gandi:

```bash
# CF1, CF2 = the two NS values returned in Phase 1 for this zone.
for pair in \
  "ophis.fi:CF1:CF2" \
  "ophis.xyz:CF1:CF2" \
  "ophis.finance:CF1:CF2" \
  "ophis.exchange:CF1:CF2"; do
  d="${pair%%:*}"
  rest="${pair#*:}"
  ns1="${rest%%:*}"
  ns2="${rest#*:}"
  curl -sS -X PUT "https://api.gandi.net/v5/domain/domains/$d/nameservers" \
    -H "Authorization: Bearer $GANDI_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"nameservers\":[\"$ns1\",\"$ns2\"]}"
done
```

NS propagation: 5–60 min for `.fi`, `.xyz`, `.exchange`. `.finance` can be
slower (gTLD with longer registry update windows).

Verify with `dig NS ophis.fi +short`.

---

## Phase 3 — Wire `ophis.fi` to the Pages project

Add `ophis.fi` and `www.ophis.fi` (optional) as custom domains on the
`greg-etm` Pages project. Pages will provision a TLS certificate via
Cloudflare's edge.

```bash
for host in ophis.fi www.ophis.fi; do
  curl -sS -X POST \
    "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT/pages/projects/greg-etm/domains" \
    -H "Authorization: Bearer $CF_API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"$host\"}"
done
```

Pages will tell you which DNS records to create. Typically:

- `ophis.fi` → `CNAME` to `greg.pages.dev` (CF will flatten the apex
  CNAME automatically since the zone lives on CF).
- `www.ophis.fi` → `CNAME` to `greg.pages.dev`.

Add the records to the `ophis.fi` zone:

```bash
ZONE_FI=$(curl -sS -H "Authorization: Bearer $CF_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones?name=ophis.fi" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['result'][0]['id'])")

# Apex (CNAME-flattened by CF)
curl -sS -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_FI/dns_records" \
  -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"CNAME","name":"@","content":"greg.pages.dev","proxied":true}'

# www
curl -sS -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_FI/dns_records" \
  -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"CNAME","name":"www","content":"greg.pages.dev","proxied":true}'
```

Wait for the Pages domain to flip from `pending` → `active` (~5 min).

---

## Phase 4 — Redirects: `ophis.{xyz,finance,exchange}` → `ophis.fi`

Use Cloudflare **Redirect Rules** (free, in the Rulesets engine,
phase `http_request_dynamic_redirect`). One ruleset per zone.

The ruleset uses a wildcard match and preserves the path + query so:

- `https://ophis.xyz/foo?bar=baz` → `https://ophis.fi/foo?bar=baz`
- `https://ophis.xyz/` → `https://ophis.fi/`

```bash
for d in ophis.xyz ophis.finance ophis.exchange; do
  ZID=$(curl -sS -H "Authorization: Bearer $CF_API_TOKEN" \
    "https://api.cloudflare.com/client/v4/zones?name=$d" \
    | python3 -c "import json,sys; print(json.load(sys.stdin)['result'][0]['id'])")

  # Park: dummy A record needed so traffic reaches the proxy.
  # 192.0.2.1 is reserved (RFC 5737); CF only needs the proxied flag.
  curl -sS -X POST "https://api.cloudflare.com/client/v4/zones/$ZID/dns_records" \
    -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" \
    -d '{"type":"A","name":"@","content":"192.0.2.1","proxied":true}'
  curl -sS -X POST "https://api.cloudflare.com/client/v4/zones/$ZID/dns_records" \
    -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" \
    -d '{"type":"A","name":"www","content":"192.0.2.1","proxied":true}'

  # Find the dynamic-redirect ruleset (CF auto-creates it on first use).
  RULESET=$(curl -sS -H "Authorization: Bearer $CF_API_TOKEN" \
    "https://api.cloudflare.com/client/v4/zones/$ZID/rulesets/phases/http_request_dynamic_redirect/entrypoint" \
    | python3 -c "import json,sys; r=json.load(sys.stdin); print(r['result']['id'] if r.get('result') else '')" 2>/dev/null)

  # Add a single rule: 301 redirect everything to ophis.fi preserving path+query.
  PAYLOAD=$(cat <<JSON
{
  "rules": [
    {
      "expression": "true",
      "description": "Redirect ${d} → ophis.fi (apex + paths, preserve query)",
      "action": "redirect",
      "action_parameters": {
        "from_value": {
          "status_code": 301,
          "target_url": {
            "expression": "concat(\"https://ophis.fi\", http.request.uri.path)"
          },
          "preserve_query_string": true
        }
      },
      "enabled": true
    }
  ]
}
JSON
  )

  if [ -n "$RULESET" ]; then
    # Update existing ruleset
    curl -sS -X PUT "https://api.cloudflare.com/client/v4/zones/$ZID/rulesets/$RULESET" \
      -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" \
      -d "$PAYLOAD"
  else
    # Create entrypoint ruleset
    BODY=$(echo "$PAYLOAD" | python3 -c "import json,sys; r=json.load(sys.stdin); r['name']='Ophis canonical redirect'; r['kind']='zone'; r['phase']='http_request_dynamic_redirect'; print(json.dumps(r))")
    curl -sS -X POST "https://api.cloudflare.com/client/v4/zones/$ZID/rulesets" \
      -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" \
      -d "$BODY"
  fi
done
```

Verify with:

```bash
for d in ophis.xyz ophis.finance ophis.exchange; do
  echo "=== $d ==="
  curl -sIL "https://$d/some/path?q=1" 2>&1 | grep -E "HTTP/|location:"
done
```

Expected: `HTTP/2 301` followed by `location: https://ophis.fi/some/path?q=1`.

---

## Phase 5 — Cleanup / verification

- [ ] All four zones show "Active" in Cloudflare dashboard
- [ ] `ophis.fi` Pages custom domain is `Active`, TLS issued
- [ ] `dig +short ophis.fi` resolves to a CF anycast IP
- [ ] Redirects: `curl -sIL https://ophis.xyz/anything` → 301 to `https://ophis.fi/anything`
- [ ] `https://ophis.fi/api/intent` accepts requests with `Origin: https://ophis.fi`
  (Origin allow-list update lives in `functions/api/intent.ts`)
- [x] Dropped legacy `https://greg.pages.dev` from the Origin allow-lists
  (done 2026-06-12: removed from `functions/api/intent.ts`,
  `functions/api/bungee`, and the rebate-indexer CORS list; no traffic remained)
- [x] Canonical user-facing domain is `https://swap.ophis.fi`

## Notes

- The HSTS header in `apps/.../public/_headers` includes `preload`. After
  `ophis.fi` has been live with valid TLS for 7 days, submit it to
  https://hstspreload.org for inclusion in the browser HSTS preload list.
- CSP `frame-ancestors 'self'` is host-relative, so no change needed when
  the canonical host changes.
- The Cloudflare Pages `_redirects` file in the Pages project does NOT
  need updates — those are SPA-internal rewrites; cross-zone redirects
  live in each zone's Redirect Rules ruleset.
