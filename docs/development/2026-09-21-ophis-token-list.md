# Ophis token list — verification and staged rollout

User authorized production deployment on 2026-09-21. Replace the main CoW list
across Ophis; preserve supplemental feeds. This report describes verification,
not current deployment status. Release PRs and deployment runs track rollout.

## Dataset

968 unique chain/address entries cover all 14 configured networks:
Ethereum 161, Optimism 193, BNB 13, Gnosis 29, Unichain 308, Polygon 5,
Robinhood 206, Base 20, Plasma 2, Arbitrum 11, Avalanche 5, Ink 5, Linea 3,
and Sepolia 7. COW remains a token. Sepolia entries are existing test contracts.

The versioned static list is served at
`https://swap.ophis.fi/token-lists/ophis.json`. Generated JSON is compact to keep
release artifacts small; use `python3 -m json.tool FILE` to inspect it.

## Verification and evidence

Every included address/decimal pair is corroborated in published registries:
Superchain, Uniswap, CoinGecko, Honeyswap, DefiLlama or Robinhood's direct asset
registry. All 195 Robinhood stocks match the issuer registry. Sepolia retains
inherited test-token identities, not claims of mainnet issuer backing.

All included contracts passed chain-ID, deployed-bytecode and decimals checks,
with readable `symbol()`/`name()` at a fixed block per chain. The verifier checks
backup RPC chain IDs and retries failed batches on alternative endpoints.
No transactions are sent. Schema, checksums, duplicate identities, network
coverage and correspondence to saved evidence are tested.

- [Published-source matches and snapshot hashes](ophis-token-list-evidence/provenance.json)
- [Full contract results, RPCs and block numbers](ophis-token-list-evidence/onchain.json)
- [Initial problems](ophis-token-list-evidence/initial-findings.json)
- [Excluded entries and reasons](ophis-token-list-evidence/excluded.json)

Nineteen displayed symbols differ from onchain strings: case variants,
MIST/its emoji, tBTCv1/TBTC, USDC.e/USDC, USDT0/USDT or USD₮0, and WIF/$WIF.
These are flagged aliases. Names can reflect branding; addresses identify assets.
Metadata/catalog corroboration is not an exhaustive issuer attestation, contract
security audit, liquidity guarantee or guarantee of future proxy behavior.

## Corrections

bsdETH was wrongly listed on Ethereum. It is now on Base, corroborated by RPC,
the Base catalog and [Reserve's report](https://forum.reserve.org/t/report-bsdeth-quarterly-report-q4-2025/1425).
wUSDL returned 6 decimals against the inherited 18. It and USDL are withheld
following [Paxos's wind-down](https://www.paxos.com/newsroom/winding-down-usdl-lift-dollar).
Optimism ECO is excluded because two independent RPCs return `0xdead` as its
name/symbol. These stale/wrong-chain identities are filtered from supplements
and caches when the consumer changes ship. The existing OVM_ETH exclusion stays.

Another 19 inherited entries lack corroboration in the checked external
registries and are withheld pending issuer review, without claiming they are
invalid. They can remain discoverable through supplemental/custom feeds.
Polygon USDT0, Avalanche AAVE.e and Unichain EURA metadata were corrected.

## Release sequence and user impact

1. Publish only the dataset, verifier and evidence. No consumer switches yet.
2. Switch swap defaults, filtering and cache migration. Normalize the hydrated
   cache before token consumers read it, including offline; persist replacement
   on successful fetch. Keep disabled/deleted preferences and explicit custom
   or widget selections, matching selected URLs case-insensitively.
3. Switch explorer and MCP after the live dataset matches the audit hash.
   Explorer merges by address with Ophis precedence; MCP retains fail-closed
   handling for source failures and ambiguous symbols.

Supplemental feeds and regional curated-only rules stay configured. Some token
images, supplemental lists and signing metadata still use CoW-hosted services.
Wallet balances, approvals, orders, favorites and user-added tokens are not reset.
Listing does not add liquidity or settlement support. Ophis maintains this static
snapshot through review; updates are not automatically synchronized upstream.

## Checks and maintenance

Local validation includes schema/evidence tests, migration and explorer tests,
97 MCP tests, TypeScript/ESLint checks and both production builds. Review fixes
passed the complete 146-test token-library suite. A local built endpoint matched
the audited file byte-for-byte. CI reruns the relevant checks for each stage.
TypeSafe provided a bounded advisory review; executable tests determined behavior.

After editing the list, review issuer/source evidence, bump its version/timestamp,
and rerun `python3 scripts/verify-ophis-token-list.py --self-test`, then:

```sh
python3 scripts/verify-ophis-token-list.py --output docs/development/ophis-token-list-evidence/onchain.json
```

Tests bind the shipped file to the audit hash and require per-token source matches.
Confirm the live JSON hash/CORS and consumer behavior after each release stage.
