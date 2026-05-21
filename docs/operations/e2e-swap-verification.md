# E2E Swap Verification (Phase 3.1)

The first real $5 USDC→WETH swap on Optimism mainnet through ophis.fi. This
playbook walks the operator through initiating + verifying it end-to-end.

## What this proves

End-to-end pipeline integrity:

| Stage | Verifier |
|---|---|
| 1. Order signed in browser | MetaMask popup; no failure here = signature valid |
| 2. Order accepted by orderbook | autopilot log: `created auction` |
| 3. Solvers bid | driver log: `received N solutions` (N≥1) |
| 4. Driver picks winner + simulates | driver log: `winner solver=...`, `simulation passed` |
| 5. Driver broadcasts to 3 mempools (raced) | driver log: `submission accepted by ...` |
| 6. Settlement(driver_EOA) lands on-chain | `verify-e2e-swap.sh` reports `SETTLEMENT EVENT DETECTED` |
| 7. Trade event with `owner = user_wallet` | `verify-e2e-swap.sh` reports `Trade events for owner: 1` |
| 8. Partner-fee transfers to Safe (if applicable) | `verify-e2e-swap.sh` reports `Transfer→partner-fee: N` |

## Prereqs

- Stack healthy: `docker compose ps` shows all 13 containers up
- Driver EOA `0x92B9bE5e96795E8630fDC61efb0e705E75b1A1B1` funded (≥ 0.005 ETH on OP)
- User wallet funded on OP: ≥ 6 USDC (5 swap + 1 buffer) + ~0.001 ETH for gas
- `cast` (foundry) + `jq` installed locally

## Procedure

### Step 1 — Start the watcher

In **terminal A**, from `infra/optimism-mainnet/`:

```bash
./scripts/verify-e2e-swap.sh --owner <0xYourWallet> --timeout 900
```

This tails autopilot/driver/orderbook/solver logs in parallel AND polls the
on-chain Settlement contract for events matching the driver EOA. Leave it
running.

### Step 2 — Initiate the swap

In a **browser**, on the operator's primary machine (must be reachable to the
stack — Mac mini):

1. Open https://ophis.fi
2. Click **Connect** → choose MetaMask
3. Confirm wallet is on **Optimism** (chain 10). Switch if needed.
4. **Sell** field: `5 USDC` (native USDC `0x0b2C639c…3d097Ff85`, not bridged USDC.e)
5. **Buy** field: select `WETH` (`0x4200…06`)
6. If first-time: approve USDC for the VaultRelayer (~$0.10 gas on OP)
7. Click **Swap** → review quote → sign the order in MetaMask

The order is now an *off-chain signature* held by our orderbook. Settlement
typically lands within 30s (next auction tick).

### Step 3 — Observe terminal A

You should see, in approximate order:

```
[orderbook]   POST /api/v1/orders → 201
[autopilot]   created auction 12345 (1 order)
[okx-solver]  solving auction 12345
[kyberswap-solver]  solving auction 12345
[velora-solver]  solving auction 12345
[driver]      winner: okx-solver, surplus: 0.0001 ETH
[driver]      simulation passed
[driver]      submission accepted by publicnode-op (or mainnet-op-foundation / tenderly-op)
[driver]      tx 0x... included in block 151840xxx
...
════════════════════════════════════════════
  ✓ SETTLEMENT EVENT DETECTED (1 this scan)
════════════════════════════════════════════
  Tx: 0x...
  Block:                    151840xxx
  Gas used:                 285000
  Trade events for owner:   1
  Transfer→partner-fee:     1 (or 0 if sub-threshold)

✅ END-TO-END VERIFIED
```

Watcher exits 0.

### Step 4 — Cross-check the receipt

In **terminal B**:

```bash
# Replace TX_HASH with the one from step 3
cast receipt 0xTX_HASH --rpc-url http://localhost:4001/main/evm/10
```

Confirm:
- `status: 1`
- `gasUsed` is sane (~200-400k)
- `logs[]` includes Settlement + Trade + Transfer events

Bridge confirmation:
- User's MetaMask shows WETH balance increase (~0.0014 WETH @ $3500/ETH)
- User's MetaMask shows USDC balance -5
- [Safe app](https://app.safe.global/home?safe=eth:0x858f0F5eE954846D47155F5203c04aF1819eCeF8)
  shows USDC balance increase by the partner-fee delta (typically 1-5 bps of sell)

## Failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| `verify-e2e-swap.sh` TIMEOUT, no Settlement | Driver out of gas, or all 3 mempools rejected | Check driver logs for `submission failed` + the per-mempool `mempool_submission{result!="success"}` series. Top up driver EOA if balance is low. |
| Settlement landed, `Trade events for owner: 0` | Your order was matched but another user's was in the same batch instead | Re-submit — the auction will retry. |
| Frontend can't get a quote | NLP / `/api/intent` 5xx | Check `pnpm logs` for the frontend; LibertAI rate limit (429) is the usual cause. |
| MetaMask shows "wrong network" | App is on wrong chain | The frontend should request a switch — if not, manually switch in MM. |
| `Approve` infinite-pending | USDC approval gas estimate failed | Add manual gas in MM (use 50k limit + 0.001 gwei priority fee). |

## Tip-lag note (operational gotcha)

`eth_getLogs` against the local eRPC has a tip-lag of ~5 blocks where 2-of-3
consensus is not reliable (publicnode-op indexes faster than tenderly + the
self-hosted node's log index). The verifier accounts for this with
`TIP_LAG_BLOCKS=5`. This adds ~10s to event-detection latency but ensures
consensus-validated reads.

The driver itself uses `eth_call` + `eth_sendRawTransaction` which don't
hit the log index, so production settlement is unaffected. This only matters
for retrospective audit/indexing.

## Next: 3.2-3.5

After 3.1 confirms the happy path, run:
- **3.2** browser/wallet matrix (Chrome/FF/Safari × MM/WC/Rabby)
- **3.3** mobile UX (375/414/768 viewports)
- **3.4** error states (insufficient balance, expired quote, rejected sig)
- **3.5** quote types (exact-in, exact-out, market, limit)
