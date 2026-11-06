# Owner-selected broadcaster wallet

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
