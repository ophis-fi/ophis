# `/api/intent` edge rate-limit (authoritative flood cap)

`functions/api/intent.ts` calls LibertAI on a cache miss. The function has two
_in-process_ backstops (a per-IP KV sliding window and a best-effort global
per-minute counter), but those are **defense-in-depth only** — KV has no atomic
increment, so concurrent cache-miss requests can under-count under burst.

The **authoritative** flood cap is a Cloudflare **edge rate-limiting rule**,
enforced at the POP _before_ the Pages Function runs (atomic, per-colo). This
document is the source of truth for that rule so it is verifiable from the repo
(closes the PR #608 review finding: "the authoritative defense was not in IaC").

## The rule (live config)

- **Zone:** `ophis.fi` (`dd7588af506387891f094a4927e11d7a`) — covers both
  `ophis.fi` and `swap.ophis.fi` (same zone). `/api/intent` is served from the
  `greg` Pages project on `swap.ophis.fi`.
- **Phase:** `http_ratelimit` (entrypoint ruleset).

```json
{
  "description": "Ophis intent API per-IP flood cap (20/10s/colo) - ophis.fi + swap.ophis.fi",
  "expression": "(http.request.uri.path eq \"/api/intent\")",
  "action": "block",
  "enabled": true,
  "ratelimit": {
    "characteristics": ["ip.src", "cf.colo.id"],
    "period": 10,
    "requests_per_period": 20,
    "mitigation_timeout": 10
  }
}
```

Plain English: **more than 20 requests to `/api/intent` from one IP within any
10-second window (per edge colo) is blocked for 10 seconds.** This sits above
the in-function per-IP cap (30 req / 60 s) and bounds a single source before it
can reach LibertAI.

## Verify (read-only)

```sh
CF=$(security find-generic-password -s cloudflare-api-token -w)   # never echo it
ZID=dd7588af506387891f094a4927e11d7a
curl -s -H "Authorization: Bearer $CF" \
  "https://api.cloudflare.com/client/v4/zones/$ZID/rulesets/phases/http_ratelimit/entrypoint" \
  | jq '.result.rules[] | select(.expression | contains("/api/intent"))'
unset CF
```

The output must match the JSON above. If the rule is missing or weakened, the
in-function counters still apply but the atomic edge cap is gone — restore it.

## (Re)apply

Edge rate-limiting rules are managed via the Cloudflare API (this account does
not use Terraform for CF zones).

> **DANGER — do NOT `PUT` the phase entrypoint with only this rule.** A `PUT` to
> `/rulesets/{id}` (or the `.../phases/http_ratelimit/entrypoint`) **replaces the
> entire rule list**; any other rules in the `http_ratelimit` phase would be
> silently deleted, disabling unrelated edge protections. See
> <https://developers.cloudflare.com/ruleset-engine/rulesets-api/update/#risk-of-replacing-all-rules>.

Use the **single-rule** endpoints, which preserve the rest of the phase. First
get the ruleset id (and confirm what is already there):

```sh
CF=$(security find-generic-password -s cloudflare-api-token -w)   # never echo it
ZID=dd7588af506387891f094a4927e11d7a
RS=$(curl -s -H "Authorization: Bearer $CF" \
  "https://api.cloudflare.com/client/v4/zones/$ZID/rulesets/phases/http_ratelimit/entrypoint")
echo "$RS" | jq '.result.id, [.result.rules[] | {id, description}]'
RSID=$(echo "$RS" | jq -r '.result.id')
```

- **Rule missing →** add it (appends, keeps existing rules):

  ```sh
  curl -s -X POST -H "Authorization: Bearer $CF" -H 'content-type: application/json' \
    "https://api.cloudflare.com/client/v4/zones/$ZID/rulesets/$RSID/rules" \
    --data @rule.json        # rule.json = the JSON object from "The rule" above
  ```

- **Rule present but drifted →** patch just that rule by its id (from the GET):

  ```sh
  curl -s -X PATCH -H "Authorization: Bearer $CF" -H 'content-type: application/json' \
    "https://api.cloudflare.com/client/v4/zones/$ZID/rulesets/$RSID/rules/<RULE_ID>" \
    --data @rule.json
  unset CF
  ```

Keep the description string stable so the verify step's `contains` match holds.

> Changing the threshold/period: update the JSON here in the same change so the
> repo stays the source of truth. The in-function global budget
> (`GLOBAL_LLM_CALLS_PER_MIN` in `functions/api/intent.ts`) is a separate,
> coarser backstop and does not need to track this value exactly.
