# Ophis token-list replacement — verification and local review

Prepared 2026-09-21 on `feat/ophis-token-list`, based on `main` at `56a51f1bac`.
Deployment authorized by the user on 2026-09-21. This report records the local
verification; live rollout is tracked by the release PRs and deployment runs.
Scope: replace the main CoW list everywhere; preserve supplemental feeds.

## Result

`apps/frontend/apps/cowswap-frontend/public/token-lists/ophis.json` contains
**968 unique (chain ID, address) entries** across all 14 configured networks.
The swap UI, explorer, and MCP resolver now use this Ophis-owned snapshot as their
main list. COW itself remains a listed token.

| Network | Chain ID | Entries |
| --- | ---: | ---: |
| Ethereum | 1 | 161 |
| Optimism | 10 | 193 |
| BNB Chain | 56 | 13 |
| Gnosis | 100 | 29 |
| Unichain | 130 | 308 |
| Polygon | 137 | 5 |
| Robinhood | 4663 | 206 |
| Base | 8453 | 20 |
| Plasma | 9745 | 2 |
| Arbitrum | 42161 | 11 |
| Avalanche | 43114 | 5 |
| Ink | 57073 | 5 |
| Linea | 59144 | 3 |
| Sepolia (testnet) | 11155111 | 7 |

## What was verified

1. Compared chain/address identities and decimals against published token
   registries: official Superchain and Uniswap lists, CoinGecko, Honeyswap,
   DefiLlama, and Robinhood's direct official asset registry. All 195 Robinhood
   stock entries match that registry. Sepolia retains seven existing test-token
   contracts; these are test assets, not claims of mainnet issuer backing.
2. Queried every included contract through a chain-checked RPC at a fixed block
   per chain: `eth_getCode`, `decimals()`, `symbol()`, and `name()`. All **968**
   have bytecode, readable metadata and the expected decimals. RPC results accept
   standard ABI strings and legacy bytes32 metadata. No transactions were sent.
3. Validated token-list schema, EIP-55 addresses, chain coverage, duplicate
   identities, excluded entries and saved evidence coverage. No decimal conflicts
   remain among the matched source records.

The evidence directory records source URLs and snapshot SHA-256 hashes,
per-token source matches, RPC URLs, block numbers, code hashes and results:

- [Published-source corroboration](ophis-token-list-evidence/provenance.json)
- [Full onchain results](ophis-token-list-evidence/onchain.json)
- [Problems found in the initial draft](ophis-token-list-evidence/initial-findings.json)
- [Excluded entries and reasons](ophis-token-list-evidence/excluded.json)

Nineteen displayed symbols intentionally differ from their onchain strings:
case variants, MIST/its emoji, tBTCv1/TBTC, bridged USDC.e/USDC, USDT0/USDT or
USD₮0, and WIF/$WIF. The report flags each difference. Display names can differ
from contract names; addresses and decimals define the asset, not its ticker.

These checks establish deployed contracts and metadata consistency, with
published registry corroboration. They are not exhaustive issuer attestations,
a smart-contract security audit, or proof of liquidity/transferability. Source
URLs are mutable; hashes identify the snapshots checked on the date above.

## Corrections and exclusions

- **bsdETH:** removed the erroneous Ethereum identity and added the same address
  on **Base**, where the contract exists and reports bsdETH/18 decimals. Verified
  using Base RPC and the Base CoinGecko catalog; Reserve's
  [official report](https://forum.reserve.org/t/report-bsdeth-quarterly-report-q4-2025/1425)
  confirms the Base asset.
- **wUSDL:** the inherited entry said 18 decimals, while the contract returned 6.
  Excluded pending issuer review. Also excluded **USDL**, whose issuer announced
  its [wind-down](https://www.paxos.com/newsroom/winding-down-usdl-lift-dollar).
- **Optimism ECO:** excluded because two independent Optimism RPCs return
  `0xdead` for both symbol and name.
- Updated Polygon **USDT0** branding following the
  [issuer's upgrade announcement](https://blog.usdt0.to/polygon-usdt-now-upgraded-to-usdt0-1-3b-in-usdt-liquidity-available-natively-omnichain),
  Avalanche **AAVE.e**, and Unichain **EURA** metadata.
- Withheld **19 additional entries** for which the checked external registries
  did not corroborate the inherited CoW address. Their exclusion is pending
  issuer review; it does not establish that they are invalid tokens.
- Preserved the existing exclusion of Optimism's deprecated OVM_ETH placeholder.

The stale USDL/wUSDL/ECO entries and wrong-chain bsdETH identity are also filtered
at the shared token boundary and MCP resolver, so supplemental lists and old
browser caches cannot silently restore the known bad records. Other withheld
entries can still appear through existing supplemental/custom discovery feeds.

## Integration and user impact

The main-list URL is `https://swap.ophis.fi/token-lists/ophis.json`. No new backend
is required. The explorer now merges tokens by address and gives Ophis metadata
precedence; previously, one source could overwrite another's whole chain map.
Its touched data fetch uses the existing Jotai query stack and shared validator.

The browser migration runs only after the Ophis list loads successfully. It
preserves enabled/disabled/deleted preferences, existing choices on the new URL,
custom lists and other chains' caches. It does not reset favorites or user-added
tokens. Explicit user-imported CoW sources remain user choices. Old URL strings
in migration code/tests are necessary to recognize existing caches.

Supplemental CoinGecko, Uniswap, LP, issuer-stock and permissionless discovery
feeds remain configured. Regional curated-only rules are unchanged. CoW-hosted
supplemental feeds, signing metadata and some token images remain intentionally;
this change removes the main CoW lists, not all CoW-hosted services.

After release, users see the Ophis list and corrected metadata. The 22 withheld
entries leave this curated list; the erroneous Ethereum bsdETH identity moves to
Base. Wallet balances, approvals and existing orders are not changed. Listing a
token does not add liquidity or change settlement-chain support.

## Local validation

- Fresh frozen dependency installs for the frontend and root workspaces.
- **130 tests passed:** 31 token/migration/evidence tests, 2 explorer tests and
  97 MCP tests. Includes preference preservation, source failure behavior,
  duplicate-symbol ambiguity, supplemental exclusions and shipped JSON resolution.
- Token-library, explorer and MCP TypeScript checks passed; SDK built normally.
- Changed frontend TypeScript files passed ESLint with the Nx project graph.
- Swap and explorer production builds passed locally. Existing build warnings
  about chunk sizes, sourcemaps and deprecated glob options remain.
- A local HTTP request to the built `/token-lists/ophis.json` returned 200 and
  bytes identical to the checked-in artifact and audit hash.
- TypeSafe supplied a small advisory semantic review of migration/merge behavior
  (2,572 input + 53 output tokens). Its migration judgment was uncertain; runnable
  regression tests, not model probabilities, determined correctness.

Re-run the read-only full contract scan after editing the list:

```sh
python3 scripts/verify-ophis-token-list.py --self-test
python3 scripts/verify-ophis-token-list.py \
  --output docs/development/ophis-token-list-evidence/onchain.json
```

Token-list tests require the saved audit hash and every contract result to match
the shipped JSON. Review source evidence separately: the RPC script cannot prove
issuer identity. Source-corroboration tests require a recorded address/decimal
match for every included entry.

## Maintenance and eventual release

Ophis now owns updates to the static snapshot. Review source evidence for each
addition, bump its semantic version and timestamp, and regenerate the audit.
Increment minor for additions, major for removals/identity changes, patch for
metadata fixes. There is no automatic upstream synchronization.

Release in stages: publish the JSON with the swap frontend and explorer, verify
the public endpoint and CORS, then release the MCP changes. Local verification
used the checked-in and built artifact. Deployment success must be confirmed
against the live endpoints, not inferred from the local checks.
