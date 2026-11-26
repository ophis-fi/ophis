# Ophis status page

status.ophis.fi: a page that checks every public Ophis service by itself and shows which are up, with their history over 90 days. One Worker on Cloudflare's Free plan, no server, no dependency of its own.

Deploys run in CI on merge to main (`.github/workflows/status-deploy.yml`); never deploy from a laptop.

## How it works

1. A Cron Trigger runs the Worker every minute (`worker.ts`). It checks the services due that minute (`due` in `core.ts`) and hands the results to one Durable Object.
2. The Durable Object keeps the whole state as one JSON string (`apply` in `core.ts`): the current state of each service, its last 60 checks, one pair of counters per day for 90 days, and the last 50 outages.
3. The page (`public/`) is static. It reads that JSON on `/status.json`, the only path that runs the Worker, and the notes written by hand in `public/incidents.json`.

A check is one GET. A service is down when the answer is not the expected status twice in a row, 1.5 seconds apart. The rewards indexer is also read: `ok` false is down, `data_fresh` false is degraded. An answer slower than 3 seconds is degraded. Nothing an origin sends is copied into `/status.json`: a failure is named with a fixed word (`timeout`, `unreachable`, `http 530`, `bad response`, `unhealthy`).

## Free plan

The owner pays for nothing (rule of 2026-11-17, `apps/business-console/OPERATIONS.md`), so the design starts from the limits. Read in Cloudflare's documentation on 2026-11-26:

| Limit (Workers Free)         | Value                               | Used here                                                                                                                                                                                                                                                                            |
| ---------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Requests                     | 100,000 a day for the whole account | 2,160 a day (2.2%): 1,440 cron runs, and 720 checks of the five services whose check runs this account's own Worker or Pages Function code (swap, business console, Intent API, MCP, compatibility API), checked every 10 minutes for that reason. Plus 1 per read of `/status.json` |
| CPU time                     | 10 ms per cron run and per request  | A run starts 8 checks at most and makes one call to the store. Waiting for answers is not CPU time, and the JSON work happens in the Durable Object, whose own limit is 30 seconds. Not measured yet: see "After the first deploy"                                                   |
| Subrequests                  | 50 per run                          | 8 checks at most, 16 if every one is retried (asserted in the test `due`)                                                                                                                                                                                                            |
| Cron Triggers                | 5 for the account                   | 1 (the business console uses another)                                                                                                                                                                                                                                                |
| Durable Objects requests     | 100,000 a day                       | 1,440 writes, and one read per data centre every 30 seconds at most (Cache API)                                                                                                                                                                                                      |
| Durable Objects rows written | 100,000 a day                       | 1,440: one row a run                                                                                                                                                                                                                                                                 |
| Static assets                | Free and unlimited                  | The page, its script and style, the logo, `incidents.json`                                                                                                                                                                                                                           |

Sources: https://developers.cloudflare.com/workers/platform/limits/, https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/, https://developers.cloudflare.com/durable-objects/platform/pricing/.

What keeps the cost down:

- The page is a static asset, so a view costs one request (the JSON), which browsers are told not to keep. A hidden tab asks for nothing.
- The self-hosted services (the three orderbooks, the indexer) are the likeliest to fail and cost nothing to check, so they get the one-minute cadence. Static sites and partner APIs cost nothing either: 5 minutes.
- A Durable Object, not D1: the deploy token cannot touch D1, and D1's daily rows are the business console's budget.

If the account spends its 100,000 requests, Cloudflare refuses until 00:00 UTC and never bills. The page still loads and says that status data is unavailable.

## Change something

- **Add, remove or rename a service:** the `SERVICES` list in `core.ts`. `every` follows the rule written above the list. A removed service leaves the page at the next run; its past outages stay in the history.
- **Write an incident note:** add an entry to `public/incidents.json` and merge. While `status` is not `resolved` the note shows under the headline; afterwards it stays in the outage history. `updates` are oldest first, times in UTC.

  ```json
  [
    {
      "title": "Robinhood Chain orders are paused",
      "status": "investigating",
      "updates": [
        {
          "at": "2026-11-26T14:32:00Z",
          "text": "The orderbook is not answering. We are looking into it."
        }
      ]
    }
  ]
  ```

- **Change the look:** `public/style.css`. The tokens are the landing's (`apps/frontend/apps/ophis-landing/scripts/tokens-to-css.mjs`).

## Run it

From the repository root, after `pnpm install`:

```sh
pnpm exec tsc -p apps/status --noEmit
node --experimental-strip-types --test tests/functions/status.test.ts
pnpm --filter @ophis/mcp-server exec wrangler dev --test-scheduled --config "$PWD/apps/status/wrangler.jsonc"
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"   # one round of live checks
```

The local round checks the live services. Two rounds in the same minute count once.

## After the first deploy

The first deploy creates the Durable Object, the Cron Trigger and the custom domain. Then check, once:

1. `https://status.ophis.fi/status.json` fills within two minutes, and every service has a state after ten.
2. Workers Logs of `ophis-status`: the CPU time of the scheduled runs stays under 10 ms. If it does not, split the list over two Cron Triggers.
3. The states match what a browser sees. The Worker reaches the other `ophis.fi` hostnames from inside the zone, where Cloudflare skips the zone's firewall rules (https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public). If one of them answers the Worker differently, add the compatibility flag `global_fetch_strictly_public`.

## Known limits

- The monitor runs on Cloudflare, like every Ophis front door. A Cloudflare-wide outage takes this page down with the rest.
- A check proves that a service answers, not that a swap settles. The daily canaries (`.github/workflows/robinhood-mainnet-canary.yml`) go deeper.
- The Intent API is checked with a GET, which never reaches the model behind it.
- Nobody is alerted. The page is for users; operator alerts stay with the canaries and the Prometheus rules.
