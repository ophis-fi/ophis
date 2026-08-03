# CoW-arrival tripwire

Weekly watcher for signals that CoW Protocol is about to launch (or has
launched) hosted support on the Ophis sovereign chains (Optimism 10,
Unichain 130). The sovereign story ("the only batch-auction venue on these
chains, 100% fee keep, 100% of price improvement returned") needs weeks of
notice to re-position, not a surprise.

Script: `scripts/ops/cow-arrival-tripwire.sh`. Pure read-only probes; no keys
except the Telegram bot token (read from the macOS keychain at send time,
never echoed).

## What it watches

| Signal | Meaning when it fires |
| --- | --- |
| `sdk_enum` optimism/unichain = YES | Sell-from support merged into cow-sdk main. Earliest public code signal, expect launch in weeks to months. |
| `networks_stub` = GONE | The cowswap frontend's OPTIMISM "bridge-only" stub comment was removed, frontend migration started. |
| `barn_optimism` / `barn_unichain` = 200 | CoW staging orderbook is live for the chain. Launch imminent (days to weeks). |
| `api_optimism` / `api_unichain` = 200 | CoW hosted orderbook is LIVE. The only-venue claim on that chain is over. |
| `sdk_enum` = PARSE | NOT an arrival. The SupportedChainId enum was renamed or moved; the probe needs updating. |

Baseline as of 2026-07-04: all four orderbook probes 404, sdk enum has
neither chain, stub comment present.

### Hard signals vs soft signals

`api_*` and `barn_*` probe HTTP endpoints: they change only when CoW's
behaviour changes, so treat them as authoritative.

`sdk_enum` and `networks_stub` parse upstream SOURCE, including prose that CoW
reformats at will. Both have been fragile:

- **2026-08-03, `networks_stub` false positive.** Upstream reflowed the JSDoc
  comment across two lines; the then line-anchored grep stopped seeing it and
  the tripwire reported GONE ("frontend migration started") while nothing had
  changed. Fixed in PR #1067, and fixed again here: collapsing whitespace was
  not enough, because a wrap falling between the two words leaves
  `future * migration` with the JSDoc marker in the middle. Markers are now
  stripped before collapsing.
- **2026-08-03, `sdk_enum` audit.** Found to (a) read a member commented out
  with `/* */` as a real member, i.e. a false ARRIVAL alert, (b) return `ERR`
  on a reflowed declaration, which the alerting layer suppresses by design, so
  a genuine arrival shipping alongside a reformat would have been silently
  swallowed, and (c) keep substring-matching a renamed enum. Now parsed in
  slurp mode with comments stripped first, and a missing declaration reports
  `PARSE` (which alerts) rather than `ERR` (which does not).

**Triage rule:** if a soft signal flips ALONE while all four orderbook probes
are still 404, read the upstream file before acting on it. Only trust a soft
signal that is corroborated by a hard one, or by your own reading of the diff.

### Probe tests

`scripts/ops/test-cow-tripwire-probes.sh` mutation-tests both source-parsing
probes offline (inline fixtures, no network). It extracts the real functions
from the shipped script rather than reimplementing them, asserts each fixture
mutation actually applied, and covers both directions: a cosmetic reformat must
NOT alert, and a genuine arrival MUST still alert even if a reformat lands in
the same release.

```
bash scripts/ops/test-cow-tripwire-probes.sh
```

Run it after any edit to `sdk_signal` or `stub_signal`, and whenever upstream
restructures either file.

## Behavior

- State lives at `~/.local/state/ophis/cow-tripwire.json`; alerts fire on
  CHANGE only, so a quiet week is silent.
- Transitions into `ERR` (network noise) never alert; four or more failed
  probes aborts without touching state (exit 2).
- On change, a Telegram message goes to the ops chat with the diff and the
  playbook line.

## Install (Mac mini, launchd, weekly)

```bash
mkdir -p ~/bin ~/.local/state/ophis
cp scripts/ops/cow-arrival-tripwire.sh ~/bin/cow-arrival-tripwire.sh
chmod +x ~/bin/cow-arrival-tripwire.sh
cat > ~/Library/LaunchAgents/com.ophis.cow-tripwire.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.ophis.cow-tripwire</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string>
    <string>-c</string>
    <string>$HOME/bin/cow-arrival-tripwire.sh >> $HOME/.local/state/ophis/cow-tripwire.log 2>&amp;1</string>
  </array>
  <key>StartCalendarInterval</key><dict>
    <key>Weekday</key><integer>1</integer>
    <key>Hour</key><integer>9</integer>
    <key>Minute</key><integer>15</integer>
  </dict>
</dict></plist>
EOF
launchctl load ~/Library/LaunchAgents/com.ophis.cow-tripwire.plist
# First manual run to record the baseline (no alert on first run):
~/bin/cow-arrival-tripwire.sh
```

## When it fires

1. Confirm manually (curl the endpoint / read the upstream commit).
2. Weight all sovereign marketing toward the unaffected chain (as of July 2026
   there is no CoW orderbook on Unichain: api and barn both 404, and the chain
   is absent from the cow-sdk enum and the cowswap networks map).
3. Sweep the docs for only-venue claims about the affected chain
   (`docs/comparison.md`, `stats-page`, business page, llms.txt files).
4. Reassess the 100% fee-keep story for the affected chain; the fee keep
   survives CoW's arrival (Ophis still runs its own stack), the exclusivity
   claim does not.
