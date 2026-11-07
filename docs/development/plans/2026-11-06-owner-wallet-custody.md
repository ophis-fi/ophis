# Owner-selected broadcaster wallet

## Latest owner decision

The owner subsequently selected the existing ANON public account `0x001486E70A0c9291f5F55c68914eE0e4E4A604d4` as the replacement automatic gas signer on Baal. They explicitly accepted Baal's current administrative access model, including potential administrator access to its unlocked software key. The separate Mac mini account proposal was declined. No hardware-custody or agent-exclusion claim applies to this software signer.

The owner retains the ANON recovery material and personally imports only this public account's private key through a bound, non-logging interactive helper. Do not generate another gas wallet, request a key in chat, import the private fee wallet's spending key, or reactivate either retired generated signer. The validated ANON shareable viewing key supplies private fee verification. Its address and ciphertext pins remain in private operational records rather than this public document.

The Ledger account `0x58707c6C1E111c21cba4C9C8caE144175F84EceE` remains the treasury and the destination of the completed return below. Selecting the ANON address alone did not import its key, fund it, deploy its guard, or activate signing. The account had zero ETH, nonce zero and no code on Ethereum at block 26,356,375. Subsequent owner import, funding and guard deployment are recorded below; production acceptance remains separate.

## ANON import and BNB guard confirmed

The owner approved a local import from ANON recovery values and personally ran the reviewed helper with networking denied. Only the derived public-account gas key, the approved fee viewing key and a database encryption key are stored in the encrypted runtime; the recovery phrase/passphrase were not sent to Baal. The resulting public address matched the selected ANON operator. Separate encrypted runtime installations and journals are used for Ethereum and BNB.

The owner funded BNB with **0.02 BNB** and explicitly approved a **0.0005 BNB total commissioning limit**. The higher deposit did not increase that limit. The guard deployment approval reserves at least **0.0195 BNB**, caps deployment spending at **0.00005 BNB**, and keeps ordinary broadcasting disabled.

BNB guard `0x5fa18eD9d36Fe8e6e30aCD4f894Df9C05913aB5E` was deployed in [transaction 0x7b42…03fe](https://bscscan.com/tx/0x7b42cef3420702abf5e8b6245747bf81dec74722c9cbbb12e25474876a2403fe), finalized at block **132040928**. Constructor calldata, canonical delegate, operator binding and deployed runtime match the reviewed artifact. Two read RPCs agreed on the receipt and code. Gas cost was **0.00001803105 BNB**, leaving **0.01998196895 BNB** and **0.00048196895 BNB** of the commissioning budget. The one-shot deployment process exited after submission, and the signed journal was retained and marked confirmed.

This receipt alone verifies guard deployment and its protected delivery. The separate bounded qualification below supplies type-4 and revert-exclusion evidence. Fee-paid user acceptance remains outstanding. No public service activation, merge, or Arbitrum/Polygon/Base activation follows from commissioning. Ethereum's later replacement guard deployment is recorded below.

## Bounded BNB mainnet qualification confirmed

After 16 synthetic failure-path tests and independent review, the owner unlocked the separately staged one-shot runner. Its pinned bundle SHA256 was `08be8c8348caf24e01c5104d542c95848542979390741b6add683b099a2609f1`. It used unfunded temporary probe accounts and no user private funds.

The successful guarded type-4 probe was included in [transaction 0x1c51…0a6e](https://bscscan.com/tx/0x1c511fbfd7b0f2a7b449bf73974ecb01e2c947fe8f91f157cd4a3d17c20d0a6e). The private builder explicitly rejected the known-reverting transaction and identified the reverting second transaction of the ordered pair. None of those three negative-test transactions was included. Private same-nonce cancellations confirmed at operator nonces 2, 3 and 4, making the unused originals invalid under the finalized chain state. Both read RPCs agreed on canonical receipts, absence of negative receipts, operator nonce 5, probe account state and guard bytecode.

Total actual expense, including guard deployment and all cancellations, was **0.00002974005 BNB**. The gas wallet retained **0.01997025995 BNB**, and **0.00047025995 BNB** remained within the original commissioning authorization. All held nonces were resolved; the runner exited successfully, and ordinary broadcasting stayed disabled.

These bounded live tests passed. They do not guarantee future builder behavior or replace a real user-paid RAILGUN swap and withdrawal, exact private fee-receipt checks, and the release review. Raw journals, builder responses, independent chain verification and audit hashes are retained in the private operational evidence directory.

## Ethereum replacement guard deployed

The owner explicitly requested the Ethereum guard deployment, funded the ANON gas account and ran the local chain-1 unlock. The existing deployment code was unchanged; 49 focused deployment/chain-configuration tests passed and independent review found no staging blockers. A funded constructor simulation matched the expected runtime before unlocking. Funding reached **0.009777018168890244 ETH**; the larger deposit did not increase the **0.00025 ETH** deployment expense ceiling.

The private Flashbots route acknowledged [transaction 0xef43…aedf](https://etherscan.io/tx/0xef439f66c3161ba451790ec0069bb368ea40aaeb16cf9d4dae6893c71ce0aedf), which succeeded at block **26358110**. No resubmission or replacement signature was needed. The Ethereum guard is `0x5fa18eD9d36Fe8e6e30aCD4f894Df9C05913aB5E`: the same deterministic address as BNB, but a separate deployment with the Ethereum delegate binding. The exact runtime, constructor, immutable operator/delegate bindings and canonical receipt agreed across two RPCs and the trusted Baal read endpoint. The initial checkpoint had at least five confirmations. At 20:29 UTC, both read RPCs reported finalized block 26358123 and agreed that the deployment receipt remained canonical, confirming finality.

Actual deployment cost was **0.000046193529179916 ETH**, leaving **0.009730824639710328 ETH**. The original signed journal and prior configuration were preserved. Only the new execution-guard address was added to the Ethereum operator configuration; ordinary broadcasting remains disabled and the deployment process exited with restart disabled. Acceptance under the replacement identity is recorded below; public activation remains separate. This guard deployment does not authorize a public release or activate other chains.

## Ethereum owner-identity pilot

The owner reused the existing private wallet at the original browser origin. The restricted pilot pinned public swap account `0xED16EFBa01fc8801888f3585512aa6CBC1a3cd2e` and withdrawal recipient `0x0494F503912C101Bfd76b88e4F5D8A33de284d1A`. The reviewed runtime and financial limits were unchanged: 0.5 gwei gas-price ceiling, 0.0015 ETH transaction and rolling-day ceilings, 0.0015 ETH reserve, and a minimum 15% markup over the signed gas ceiling. Initial history synchronization used a fresh owner-state database; the retired mixed wallet database was not copied.

| Operation | Authenticated broadcaster fee | Actual gas cost | Result |
| --- | --- | --- | --- |
| [Swap](https://etherscan.io/tx/0x92f015e9e650b0c4f50731447d7cad614233788aa9c2620fb8d674ec78015489) | 0.0002667069711594 WETH | 0.000098272146816379 ETH | 0.924522 USDC returned to the private pool |
| [Withdrawal](https://etherscan.io/tx/0xbe9fb517d87df4d52a7d8b194b2f87093499b7c0d7d66754528b38bd6fa15acb) | 0.184488 USDC | 0.000056511420922335 ETH | 0.738184 USDC received at the approved public address |

Both successful receipts agree across two read RPCs. Exact first fee commitments match the running view-only SDK's confirmed assurance records. Both fees exceed the signed maximum gas cost plus 15%; the USDC check also reproduces the historical Chainlink rates across the signing/cache window. The withdrawal reconciles exactly: 0.924522 USDC = 0.738184 received + 0.184488 broadcaster fee + 0.001850 protocol fee. The successful swap emitted no nested `CallError`, and its configured recovery-token/native balances are zero. At 22:53 UTC both read RPCs reported finalized block 26358857 and verified that both receipts remained canonical; the complete pilot is finalized.

Combined pilot gas was 0.000154783567738714 ETH, leaving 0.009576041071971614 ETH in the ANON gas address. Collected private fees remain 0.0002667069711594 WETH and 0.184488 USDC; collection or conversion is a separate owner operation. Transaction accounting leaves zero private USDC and 0.0000000000001656 WETH in the user's pilot wallet; this is not a separate rescan of the user's private wallet.

After both fees were assured, the broadcaster and its Waku service exited with code 0 at 22:44 UTC. Their restart policies and the operator's enabled flag are disabled. Signed journals, the used withdrawal marker, encrypted owner material and the synchronized database remain preserved. No new keys were generated, no owner recovery material was read by the agent, and no public release or other-chain activation occurred.

Operational evidence is retained in `ophis-railgun-evidence/ethereum-pilot-20261106`. Independent review of the saved transactions and accounting found no blocker for these observed results. They do not prove that future included reverts cannot cost the operator gas. Public release still needs its reviewed client fee-identity update and release approval. BNB user-paid acceptance, Arbitrum/Polygon delivery gates and the Base hold are unchanged. The pilot also exposed stale post-swap status/amount text; that UI cleanup remains a release follow-up.

## Earlier Ledger selection and completed return

The owner's instruction on 6 November supersedes the earlier generated-operator commissioning plans: return generated-wallet funds to `0x58707c6C1E111c21cba4C9C8caE144175F84EceE` and use that address as the default public gas/signing account. Do not generate another software wallet or reinterpret this address as merely a refill treasury.

The Ethereum generated signer `0x65C3f921DB6f0e431C28EcbECFA7687fbD68f2a8` is stopped with restart disabled. The prepared BNB signer `0x5C50454A635487c2ff22e9705FF3CB4C36a0F99B` is not activated. Both operator configurations now select the owner's address and remain disabled. Preserve their original journals, encrypted recovery records and backups until all funds are reconciled; never rewrite historical journal identities or owner ciphertext pins to pretend the old key belongs to the new address.

Generated-key material is authorized solely for the requested return of funds. Recover collected private fees before sweeping the remaining native gas balance. The fixed destination is the owner-selected address above; no new subscriptions, bridges, swaps or unrelated wallet access are part of this return.

Selecting a public address does not connect its signer. Before broadcasting resumes, integrate and verify the owner's Ambire + Ledger signing path. Do not import a Ledger recovery phrase/private key, silently fall back to a generated key, or claim hardware custody while a software key signs. The existing immutable Ethereum guard is bound to the retired generated operator and cannot be reused as the owner's guard. BNB guard deployment/qualification and other chain activation remain held.

## Confirmed return

The owner address received:

- **0.003123885195179473 ETH** in [transaction 0x0ddf…59c3](https://etherscan.io/tx/0x0ddf7a0022f383ab22efd37f1c76502b20d324f006387ed84bf941f9452459c3).
- **0.000304411174718283 WETH** and **0.398086 USDC** in [transaction 0x5205…7de3](https://etherscan.io/tx/0x5205e8aaa6a1c7cfc4f089179a5a47b17556ebdda2623559e76c61ba4d637de3).

Both receipts succeeded and the recipient amounts were verified. Network gas for both operations totaled **0.000105023724401776 ETH**. RAILGUN's withdrawal fee was **0.000000762935274983 WETH** and **0.000997 USDC**; no broadcaster fee was charged. The generated Ethereum gas wallet has zero ETH, and its dedicated private fee wallet has zero WETH and USDC after resynchronization.

The three generated gas addresses were checked across Ethereum, BNB, Arbitrum and Polygon: other native balances and configured wrapped/USDC/USDT balances were zero. Unknown airdrop tokens were not indexed. The old Ethereum signer container was removed after stopping, and its Waku service was stopped with restart disabled. Encrypted recovery records and original journals remain preserved.

Return receipts, source/review hashes and reconciliation are retained in `/Users/scep/ophis-railgun-evidence/custody-return-20261106`. The selected owner address is a configuration change, not a claim that Ambire + Ledger signing is already integrated. No new guard, mainnet signing activation, merge or application release was performed.
