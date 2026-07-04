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

Baseline as of 2026-07-04: all four orderbook probes 404, sdk enum has
neither chain, stub comment present.

## Behavior

- State lives at `~/.local/state/ophis/cow-tripwire.json`; alerts fire on
  CHANGE only, so a quiet week is silent.
- Transitions into `ERR` (network noise) never alert; four or more failed
  probes aborts without touching state (exit 2).
- On change, a Telegram message goes to the ops chat with the diff and the
  playbook line.

## Install (Mac mini, launchd, weekly)

```bash
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
