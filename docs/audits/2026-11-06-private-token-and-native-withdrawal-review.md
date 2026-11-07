# Private token support and native BNB withdrawal review

Status: local implementation, final builds, fork validation and independent review closure passed. Hosted checks for the new revision are pending publication. Not a release approval.

## Scope

Extends the private client beyond the three configured tokens. Existing token identifiers remain valid; additional ERC20 principals use chain-specific contract addresses. The client shows positive private holdings from the RAILGUN balance event and supports explicit contract-address lookup in the existing picker. Unknown holdings are address-only until the user selects one: unsolicited tokens trigger no metadata RPC probes or catalog writes. Metadata is saved through encrypted wallet/chain storage before registration, and restored before transaction journals are opened.

New principal tokens do not become fee currencies. BNB fees remain WBNB-only. Additional assets on other configured networks use the already-supported wrapped native fee asset. Existing same-token fee paths remain compatible. No chain launch allowlist or protected submission identity is activated by this change.

Bound ERC20 withdrawals require an account-bound fee proof and principal proof, canonical signed self-transfer, exact recipient/net amount, and requireSuccess=true through the execution guard. Native BNB uses one WBNB proof covering fee and principal, then exact unwrapBase(net) and native transfer(net). No unrestricted call, zero-value full-balance sweep, or detachable COMMON fee proof is introduced.

Native confirmation checks canonical unshield and unwrap logs plus the actual transaction's exact signed calldata, deployed guard/account code and execution nonce before journal deletion. Failed or ambiguous outcomes preserve the saved execution and account index.

## Threat model and review method

High risk: token metadata/identity, proof and fee binding, arbitrary token callbacks, native recipient execution, saved-request recovery. Attackers can supply principal contracts, metadata, recipient contracts and malformed broadcaster packets. They cannot choose accepted fee assets or replace the canonical execution guard/delegate.

Trail of Bits token-integration and differential-review methods, ethskills security guidance, focused regression tests, actual SDK proof execution on isolated BNB forks, and independent Codex/Claude review are used. Findings and exact results are recorded below when complete. Solidity guard source/artifact is unchanged; this report does not claim a new full Pashov audit of RAILGUN's third-party contracts.

## Token behavior limits

Token discovery is not a token audit. RAILGUN supports compatible ERC20 behavior, not every contract that returns symbol/decimals. Rebasing, taxed transfers, hooks, pausing, blocklists, upgradeable behavior and false transfer events remain token-specific risks. Existing exact approvals, zero-reset handling, canonical proof verification and strict simulations are retained. No spot-price valuation of arbitrary fee assets is introduced.

Amounts use verified decimals and integer arithmetic. Address identity prevents duplicate symbols or a token called WBNB from replacing the authentic fee asset. Metadata uses text-only rendering and bounded calls/strings; imported tokens use a local neutral icon. Existing private holdings are not sent to third-party token-list services.

Routes remain direct or one-intermediate Uniswap V3 paths. Additional assets do not expand the intermediate set, keeping quote work bounded. A token may be withdrawable while no supported liquid swap route exists. Metadata precision is bounded to 0–77 decimals; the encrypted local catalog supports 1,024 entries.

## Validation

- Client: 458 passing tests / 12 skipped on the final source; 77 focused regression tests also cover the final display/scan refinement. Both browser/server TypeScript checks and BNB mainnet-profile compilation pass. This is not a production deployment.
- Broadcaster: 526 passing / 28 skipped in default configuration; 480 passing / 2 skipped in the BNB suite excluding four Ethereum-only harness files. Separate strict withdrawal tests cover Ethereum, Arbitrum, Polygon and BNB. Typecheck/build pass.
- Browser layout: desktop and 390/320-pixel widths pass; exact address search rejects a token-name impersonation; imported holdings selection and keyboard focus verified. DOM fixture uses no wallet secrets or network transactions.
- Actual BNB fork native withdrawal: one real WBNB proof; recipient receives 0.0009975 BNB; gas 1,247,010 at modeled 0.05 gwei = 0.0000623505 BNB. Private fee 0.000276 WBNB covers the signed 0.00024 BNB ceiling plus 15%. Failed unwrap rolls back fee, principal and internal execution nonce. Production native receipt binding and independent RPC readback pass.
- Actual BNB fork BTCB withdrawal: two real SDK proofs, BTCB outside original asset list; recipient receives 0.0000009975 BTCB; gas 1,579,790 = 0.0000789895 BNB at the same modeled gas price and fee ceiling. Ordinary-sender proof extraction, truncated signed batches and failing transfers are rejected/rolled back. Production validators and independent root receipt readback pass.
- Semgrep OSS: 20 changed production TypeScript files; no scanner errors. Two informational long-textContent-template hits are benign. Existing pinned rules reused; no claim of Pro cross-file analysis or latest-rule coverage.
- Independent Codex full review and final closure: no confirmed findings; final scoped hashes match the frozen source. Independent Claude identified selector/dust-lookup/recovery-scan issues; these were fixed with regression tests. No remaining high/medium findings in its final full review. Two low display/manual-scan suggestions were then addressed. Final closure confirmed both conditional follow-up items unreachable under the actual caller controls and reported no new confirmed defects. Root verified the complete production freeze before publication.
- Solidity source/artifact unchanged. This run does not claim a new Solidity implementation, a fresh full Pashov contract audit, a rerun of Slither, or a production CodeQL result before hosted CI completes.

Evidence: `/Users/scep/ophis-railgun-evidence/bnb-assets-20261106`, including `native-withdrawal/INDEPENDENT-READBACK.md`, `custom-token/README.md`, `root-btcb-readback.json`, test/build logs, frozen source manifests and review results.

## Review closure

Address search now compares exact contract identity, never untrusted symbol text. Imported tokens show a separately rendered address; full checksummed addresses are visible in confirmation and saved withdrawal details. Compact picker buttons retain shortened addresses for layout, with full addresses in the picker and confirmation. Unicode control characters are rejected; token metadata never controls HTML, image URLs or the bridged badge.

Unknown private balances no longer trigger identifying RPC probes or automatic persistent imports. The existing wallet-wide Web Lock prevents same-origin concurrent tabs from racing encrypted catalog writes. Address lookup uses a Map; route candidates stay bounded.

Failed-swap reconciliation uses its saved relevant asset list, not unrelated catalog entries. Manual recovery likewise checks seeded, selected and matching pending-operation assets, reports its limited coverage and retains unavailable-balance warnings. Exact approval preflight supports no-return, zero-reset-required and zero-approval-rejecting tokens; no fallback occurs after a transaction has been sent. Amounts outside the RAILGUN 120-bit limit are rejected before public approval spending.

## Release limits

Fork execution proves transaction logic against copied contract state; it does not prove BNB builder inclusion, exclusion of reverting transactions, custody commissioning or live broadcaster availability. An included outer revert still consumes operator gas and rolls back its private fee. BNB remains disabled pending a separately approved, bounded live test. No merge, deployment, mainnet signing, operator funding or user-wallet access is part of this implementation run.
