# Backend-only Goldsky Boost

Use `/boost/10` and `/boost/4663`, never metered `/standard/evm/`.
The website uses its original public endpoints. `GOLDSKY_BOOST_KEY` belongs in
each backend's private `.env`; rendered credentials stay on RAM-disk.

Both Boost endpoints forward cache misses to Alchemy, identified by the
`x-alchemy-trace-id` response header on 2026-09-16. Do not change their upstream
to another voter or to the Ophis eRPC proxy without reviewing independence.

| Chain/methods | Voters | Required agreement |
| --- | --- | --- |
| OP state/simulation reads | Boost/Alchemy, ZAN, Tenderly | 2 of 3 |
| OP transactions, receipts, logs | dRPC, ZAN, Tenderly | 2 of 3 |
| Robinhood state/simulation reads | Cadia, Boost/Alchemy | 2 of 2 |
| Robinhood transactions, receipts, block by hash | Cadia, official RPC | 2 of 2 |
| Robinhood block stream, logs, traces | Cadia | Existing local-only routing |

Boost's cached full objects contain additional fields (including
`blockTimestamp` and gas metadata), and some transaction signatures use padded
hex instead of `0x0`. These objects do not compare identically with the other
providers. Keep those methods on their original voters; do not ignore response
fields or lower quorum thresholds to make them pass. This limits caching savings,
especially on Robinhood, whose block stream already uses our own node.

OP submits through both Boost and dRPC as well as its existing relays, preserving
the overlap between pending-nonce readers and transaction recipients.

Validate changes with `python3 scripts/test-boost-rpc.py` and each chain's
`assert-erpc-failclosed.py`. When deploying, render the new credential, recreate
only the affected RPC proxy (and OP driver), and test populated logs and mined
transaction receipts through the proxy, not merely `eth_chainId` or empty logs.

Goldsky currently charges neither cache hits nor forwarded Boost requests;
the configured upstream provider still meters forwarded calls. Measure cache
hits and provider usage before claiming a monetary saving.
