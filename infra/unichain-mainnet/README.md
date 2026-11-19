# Retired Unichain deployment

Ophis retired Unichain (chain 130) on 19 November 2026. It is removed from
active trading, bridge routing, agent integrations and scheduled trade indexing.
The Compose deployment, renderer, boot restoration and tunnel service installers
have been removed. The shared watchdog must never restart this stack.

The remaining configuration, deployment receipts, contract addresses, recovery
and sweep scripts are historical records. They are retained to reconcile old
trades, refunds and treasury balances. They do not describe a supported trading
deployment. Do not delete databases, wallet records or keys as part of retirement.

During deployment of this removal, stop and disable any installed Unichain
boot, tunnel and health-check services; remove the retired public orderbook route.
Check for outstanding native-order refunds, bridge claims and fee payouts before
removing any persistent infrastructure. The accounting chain IDs and historical
reward eligibility remain intact; the settlement-buffer monitor remains available
for treasury wind-down. Existing CCTP claims retain their network metadata.

The previous deployment procedure is available in Git history. A replacement
network is deferred until the Ophis security, code and development cleanup.
