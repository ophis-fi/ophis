# Protected broadcaster transport

This is the Node-only sender used by [Ophis's broadcaster](../../broadcaster/README.md), not a browser RPC setting or a complete broadcaster server. The Ethereum profile routes signed transactions to `https://rpc.flashbots.net?hint=hash` exclusively. Reads continue through the operator's trusted node. It never falls back to that node for writes. Endpoint, confirmation and cancellation-gas examples below describe Ethereum.

The browser uses Waku to request execution from Ophis's broadcaster. Its fee identity and protected chain configuration must be verified before being trusted; an advertised name is insufficient. Installing frontend code alone does not qualify private delivery or activate another chain.

## Integration

Use Node 22.18+ and the versions of Ethers and Railgun shared models already pinned in this app. Instantiate once per dedicated operator gas wallet, at service startup. Reuse that provider for every send from the wallet; never share the wallet with another sender or use a fallback provider around it.

```ts
import { ProtectedEthereumProvider } from './protected-provider.ts'

const provider = new ProtectedEthereumProvider(
  existingReadProvider._getConnection(),
  existingGasWallet.address,
  '/var/lib/ophis-broadcaster/protected-ethereum',
)
const gasWallet = existingGasWallet.connect(provider)

// Keep the operator's existing decryption, proof-policy, fee,
// nullifier, gas-cap, calldata and execution-signature validation before this step.
const transaction = await gasWallet.sendTransaction(validatedTransaction)
await transaction.wait(2)

// At service shutdown:
provider.destroy()
```

The directory must be owned by the service user and have mode `0700`; the SQLite journal has mode `0600`. Mount it on persistent local storage, not an ephemeral container filesystem. It contains signed, potentially executable transactions; exclude it from logs, public backups and web roots. Do not enable Ethers RPC debug logging or log transaction requests.

The provider validates the signed operator, chain, canonical proxy/delegate, chain-bound EIP-7702 authorization, fee fields and mined nonce. **It does not replace the broadcaster's Railgun/proof-policy/fee/calldata validation.** The public `ppoi-safe-broadcaster-example` at `ec49691533b4edc2dafefbd8cdb5f611290b2115` does not accept the current type-4 flow; changing its provider alone will not make it compatible.

## Unknown outcomes and recovery

Before sending any signed payload, the provider durably journals its bytes and locks that operator's nonce. A timeout, RPC error, rejected redirect or unexpected response hash leaves that record in place. Do not release the wallet, delete its journal or sign a replacement just because `sendTransaction` threw.

`provider.pendingTransaction()` returns only its hash and nonce. After a restart, `await provider.retryPending()` resubmits **the identical bytes privately**. It does not create a replacement or increase the gas fee. If that nonce was mined, reconcile its receipt through the read node instead of retrying it. A new transaction can replace the record only after mined state shows the previous nonce consumed with two confirmations; public `pending` counts are insufficient.

Flashbots normally drops an unincluded transaction after 25 blocks. That does **not** invalidate its signature. This adapter deliberately keeps the journal locked after that interval. A stuck nonce needs a separately reviewed cancellation/recovery procedure; automatic public rebroadcast and automatic fee bumps are disabled.

For recovery, the operator can explicitly sign a **type-2, zero-value self-transfer**, with empty calldata, `21000` gas, the journaled nonce and operator-approved positive fee caps. Pass those signed bytes to `await provider.cancelPending(signedCancellation)`. The cancellation goes through the same private-only endpoint. The journal retains the original transaction and its hash, records the cancellation before sending, and blocks further original-transaction retries. `retryPending()` then retries the latest signed cancellation. Fee increases require another explicitly signed cancellation; no fees are raised automatically.

Check receipts for the original hash and `pendingTransaction().cancellationHash`: either can win the same nonce. Wait for two confirmations of consumed nonce state before accepting another transaction. Cancellation cannot undo an already mined swap, and the original may win the race. A confirmed nonce can remain visible in `pendingTransaction()` until the next valid send replaces that record; a confirmed transaction is not retried. Keep the dedicated gas wallet undelegated, and do not delete the journal to unblock it.

This cancellation invalidates **only the outer gas-wallet transaction**. It does not revoke the user's authorization, signed private batch or proof. Keep the user's existing recovery journal and nullifier/ephemeral-nonce checks; never clear it merely because the operator cancelled its own nonce.

Fork checks require unknown `anvil_metadata` and `hardhat_metadata` methods to return JSON-RPC `-32601`. Other failures stop submission; verify the operator's actual read node before activation instead of relaxing that check.

## Verification and activation

```sh
pnpm exec vitest run operator/protected-provider.test.ts
RAILGUN_PROTECTED_FORK_TEST=1 RAILGUN_FORK_RPC_URL=http://127.0.0.1:8559 \
  pnpm exec vitest run operator/protected-provider.fork.test.ts --no-file-parallelism
```

The fork test requires an existing loopback Anvil Ethereum fork. It generates test wallets, funds them using Anvil only, and intercepts every protected write so it stays on that fork. It exercises real type-4 execution against the deployed delegate, not a mainnet swap or Flashbots inclusion.

Production activation still requires an operator-controlled sender using this transport, a verified binding to its advertised `0zk` fee identity, and a supervised protected inclusion test with an agreed gas budget. None of those are established by a signed Waku fee advertisement. Do not approve an identity merely because its display name looks familiar.

Chain-bound transport, journals and validation are implemented for Ethereum, Arbitrum, Polygon and BNB Chain, but all three added-chain mainnet signing paths remain blocked in source. Arbitrum and Polygon have no configured protected write route; BNB's candidate route still requires qualification. Each added chain needs verified type-4 delivery and revert filtering, an approved operator/guard and native budgets, and live fee-receipt/recovery acceptance before activation. Base remains excluded.

Flashbots documents the [hash-only privacy setting, default builder, positive-tip requirement and 25-block lifetime](https://docs.flashbots.net/flashbots-protect/settings-guide). Its [EIP-7702 example](https://github.com/flashbots/mevrepl) demonstrates type-4 submission support. The builder still receives transaction contents; private submission reduces public-mempool exposure and is not an absolute guarantee against every form of MEV.
