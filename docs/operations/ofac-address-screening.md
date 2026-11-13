# OFAC listed-address screening

Status: local implementation prepared for review. No rollout is authorized by this change.

Chainalysis [deprecated its sanctions oracle](https://go.chainalysis.com/chainalysis-oracle-docs.html), with its last update on March 18, 2026, and advises against production use. A successful Optimism RPC call can therefore return outdated screening data. The backend no longer discovers or queries that oracle.

The replacement downloads OFAC's complete [SDN XML export](https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML). OFAC [provides downloadable data for automated screening of listed digital currency addresses](https://ofac.treasury.gov/faqs/594). The updater extracts, normalizes and deduplicates EVM-shaped digital currency identifiers. Passport numbers and other identifiers are excluded. The same listed EVM addresses apply on Optimism, Unichain, Robinhood and Arc; no screening contract is needed on those networks.

This is exact listed-address screening against the SDN list. It does not trace transactions, identify indirect exposure, infer ownership of unlisted wallets, implement the OFAC 50 Percent Rule, or screen every jurisdiction's sanctions lists. Non-SDN lists can carry different restrictions and are not silently treated as blocking designations. These limits remain relevant to any wider compliance process.

## Data and failure behavior

- Each stack runs one `ofac` service with no subscription or API key. It refreshes every 15 minutes and retries failed downloads every minute. The download permits only HTTPS on the official OFAC host and its current exact government S3 publication host. Schema changes, malformed or incomplete XML, future publication dates, empty address sets, and publication-date rollback are rejected.
- A validated snapshot records the publication date, download timestamp, source URL and XML SHA-256. It is written atomically to a named `sanctions` volume. Orderbook and autopilot mount the directory read-only and reload every minute. Mounting the directory allows atomic replacement of the file to remain visible.
- A successful refresh replaces the OFAC set, so delisted addresses disappear. Independently configured `[banned-users].addresses` remain banned. The updater never edits those manual entries.
- Short outages preserve the last validated snapshot. After 24 hours without a validated download, orderbook returns HTTP 503 (`SanctionsScreeningUnavailable`) and autopilot withholds cached auctions. A confirmed address match still returns HTTP 403. An outage does not mark every account as banned or persist every pending order as invalid.
- An unavailable or stale snapshot prevents backend startup. Compose waits for the updater's health check on startup; freshness is also enforced by the running backend because Docker dependency health alone does not stop existing containers. A source digest change prevents reuse of an auction built with the previous snapshot. The public auction endpoint also checks freshness and rescreens persisted auction owners and receivers against the current list, returning no active auction if screening is unavailable or an address matches.
- The 24-hour limit measures time since download, not time since the SDN publication date: OFAC may legitimately leave a publication unchanged for days. Download requests bypass caches, and publication rollback is rejected relative to the previous snapshot. This is a local availability policy, not an OFAC-prescribed refresh interval.

The poll and reload intervals mean newly published addresses are not applied instantaneously. Orders already handed to solvers or transactions already submitted are not cancelled by this mechanism. Screening applies to the order owner's and receiver's addresses in the operated orderbook path; direct external routes and private trading services need their own screening policies.

## Review and rollout

Before rollout, review the backend changes, refresh script, tests, all four compose definitions and generated Arc configuration together. Build backend images from the reviewed commit using each stack's existing revision checks. Deploying the new configuration with an older backend image will fail configuration parsing; deploying only the updater leaves old binaries using the deprecated oracle. Do not apply either half alone.

After explicit deployment approval:

1. Render each stack using its existing release procedure, carrying forward any operator-maintained `[banned-users].addresses`. The updater preserves manual bans in the loaded configuration; it cannot restore entries omitted during rendering. Arc uses `infra/arc-mainnet/release/docker-compose.yml`; its root compose file is the RPC stack.
2. Start `ofac`, verify its first download and health, then recreate orderbook and autopilot from the matching reviewed backend image. Preserve the existing database and other stack volumes.
3. Inspect `docker compose logs --tail 30 ofac` and run `docker compose exec ofac python /app/refresh.py --check /data/addresses.json` in the relevant stack directory. Verify that both backend services have loaded the current timestamp and that ordinary orders are accepted while a listed owner or receiver is rejected. Use quotes or disposable local fixtures for address checks, without submitting real-fund orders.
4. Verify the warning and critical alerts in Prometheus on Optimism, Unichain and Robinhood. Arc currently has no equivalent Prometheus/Alertmanager stack: Docker health and backend metrics are available, but do not imply that Arc has automated paging.

Orderbook metrics use the existing `gp_v2_api` prefix below. Autopilot exports the same suffixes with its `gp_v2_autopilot` prefix:

| Metric | Meaning |
| --- | --- |
| `gp_v2_api_sanctions_snapshot_fetched_at` | Download timestamp of the snapshot loaded by this process |
| `gp_v2_api_sanctions_snapshot_max_age_seconds` | Configured freshness limit |
| `gp_v2_api_sanctions_snapshot_reload_failed` | Failed file reloads; may indicate corruption, permissions or stale data |

The three monitored stacks warn after one hour without a download and alert critically at expiry or when either backend snapshot metric is absent. Confirm metric names and scrape labels in the running environment before treating alerts as operational coverage.

## Recovery

Inspect updater logs first. Download or validation failures leave the previous file untouched. Restore OFAC connectivity, storage permissions or the reviewed parser/host allowlist, then run `docker compose exec ofac python /app/refresh.py --once /data/addresses.json`. The updater resumes its regular schedule; backend reloads require at most one minute.

A malformed existing snapshot also blocks replacement because its prior publication metadata cannot be trusted. Restore a known validated snapshot with its original metadata, or stop the two backend services, preserve the corrupt file for investigation, remove it from the sanctions volume, and obtain a fresh official download before restarting. An intentionally empty OFAC address export requires operator review rather than automatically clearing screening.

Do not disable expiry, erase manual bans, supply a fabricated recent timestamp, or roll back to the deprecated Chainalysis oracle to restore availability. A safe recovery preserves screening and can keep submissions unavailable until fresh data is restored.
