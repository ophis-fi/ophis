---
id: privacy-pools
title: Privacy pools and private swaps
description: Use Ophis's RAILGUN shielded wallet, understand public gas credit and refunds, and recover interrupted private transactions.
sidebar_label: Privacy pools
---

# Privacy pools and private swaps

Ophis private mode uses **RAILGUN shielded pools** and a separate private wallet. You deposit assets from a public wallet, swap supported tokens, and withdraw to a public address when needed. Switching to **Private** does not shield your existing public balance.

RAILGUN holds the shielded assets and verifies private spending proofs. **Uniswap v3 pools** provide the swap liquidity. These are different roles: depositing into a shielded pool does not provide DEX liquidity or earn liquidity-provider yield. This guide describes Ophis's RAILGUN integration, not a separate integration with the Privacy Pools protocol.

## Networks and assets

| Production network | Chain ID | Default private assets | Public gas and fee credit |
| --- | --- | --- | --- |
| Ethereum | 1 | WETH, USDC, USDT | ETH |
| Arbitrum One | 42161 | WETH, native USDC, USDT | ETH |
| BNB Chain | 56 | WBNB, Binance-pegged USDC and USDT | BNB |

Native deposits wrap ETH or BNB into the corresponding wrapped asset. Check token contracts: assets with the same symbol on different networks are not interchangeable. The BNB stablecoins above are Binance-pegged assets.

These are the default choices. A token found by address can lack a supported swap route or liquidity. Private balances stay on their selected network; private mode does not bridge them. The public app's wider network and bridge coverage does not apply.

New activity requires synchronized wallet history and an available broadcaster on the selected network.

## Create or restore your wallet

1. Open [the Ophis swap app](https://swap.ophis.fi) and select **Private**. Choose the network before unlocking the private wallet.
2. Select **Create private wallet**, or **Restore a private wallet** to enter an existing recovery phrase. For a saved wallet, select **Unlock private wallet**.
3. Save the recovery phrase offline and set the local wallet password. Confirm the backup checkbox before **Save and continue**. Never share the phrase with support or a broadcaster.
4. Wait for history synchronization and balance verification. Only balances marked **Spendable** can fund a new private transaction. A restored wallet may need to scan older history.

The password protects local wallet storage; it does not replace the recovery phrase. Preserve the browser's encrypted transaction and fee-credit records as well. Restoring the phrase alone does not restore every local record of a pending payment or an executable transaction that has not appeared onchain. Avoid clearing site data while anything is pending, and do not use the same phrase concurrently on different devices.

Lock the private wallet before changing networks. Pending transactions remain associated with their original network.

## Add funds

1. Open **Add funds** from the wallet controls and connect the public wallet on the selected network.
2. Choose the deposit asset and amount, then select **Check shield amount**. Keep native currency in the public wallet for gas.
3. Review the protocol fee and wallet request. For an ERC-20 deposit, approve the displayed amount if requested, then select **Shield amount**.
4. Wait for confirmation and synchronization. Check **Wallet & balances** and **Pending balances**; a pending balance is not yet available for a swap.

Shielding is a public transaction. Its source wallet, asset, amount and timing are visible. Shielding fees and gas are separate from swap fees and broadcaster credit.

The current Ophis wallet and broadcaster **do not require Private Proofs of Innocence (PPOI)**. This does not remove transaction-proof verification or balance checks. Other RAILGUN wallets and services may apply their own PPOI rules; using Ophis does not establish eligibility with them.

## Fund transaction fees

The production Ophis broadcaster uses **public native-currency fee credit**. This is a separate balance from the assets in your shielded wallet.

1. Open **Wallet & balances → Ophis fee credit** and select **Check fee credit**.
2. To add credit, connect an ordinary public account, enter the amount, review the public-link notice and select **Add fee credit**. Smart or delegated accounts are not accepted for this top-up.
3. Your public wallet sends ETH or BNB to the configured operator and pays that transaction's gas. Wait for chain finality, then use **Check top-up**. Confirmation alone may precede finality.
4. Review available and reserved credit before authorizing a swap or withdrawal. Already-funded credit can pay for later operations without another top-up.

The operator reserves the reviewed maximum gas cost plus margin before signing. Finalized successful and reverted attempts charge their actual gas plus the agreed margin; unused reservation returns to available credit. A failed swap can therefore still cost gas.

:::warning[Fee credit is held by the operator]

Native fee credit is custodial, separate from your shielded assets. The operator holds the funds and processes refunds. Backing checks do not remove operator, signing-key or RPC risk, and there is no independent onchain withdrawal of this credit. Top-ups publicly expose the sender, operator and amount; the operator can associate requests using the same credit account.

:::

For an uncertain payment, check the public wallet's activity first. **Check top-up** can reconcile the saved payment with its transaction hash, including a replacement hash. **Set payment aside** preserves its encrypted record for later recovery; it does not cancel the payment. Sending a new top-up adds another payment, so do not use it as a blind retry.

## Make a private swap

1. Select the sell token, buy token and amount from your spendable private balance.
2. Select **Review swap**. Check the route, minimum amount after fees, Ophis fee, broadcaster identity and available fee credit.
3. Select **Confirm private swap** only after reviewing those terms. Keep the saved transaction record until its outcome is known.
4. Wait for settlement and synchronization before spending the resulting balance again. If the outcome is uncertain, use [recovery](#interrupted-transactions) before preparing another transaction.

The current router quotes **Uniswap v3 only**, using direct or one-intermediate-token paths and supported fee tiers. It selects the highest successful quote among those paths. Private swaps do not enter the public batch auction.

Ophis charges **0.1% (10 bps) of swap output**, in addition to liquidity-pool fees, broadcaster costs and applicable deposit or withdrawal fees. Review [Fees](/fees#private-swap-costs) and the current quote. Slippage limits still matter, and private submission is not a universal MEV or transaction-inclusion guarantee.

## Withdraw to a public wallet

1. Open **Withdraw to a public wallet** from the wallet controls.
2. Choose the token and amount, enter the public recipient, and review any **Receive native currency** option offered for the selected asset.
3. Select **Review withdrawal fee** and verify the destination, net amount and fee. Then select **Confirm withdrawal**.
4. Keep the record until confirmed. For a pending or uncertain result, use **Check pending withdrawal** instead of preparing another withdrawal.

The withdrawal destination and amount are public. A withdrawal can use existing fee credit, but broadcaster availability and the current quote still apply. Withdrawing shielded assets and refunding unused gas credit are separate operations.

## Refund unused fee credit

1. In **Ophis fee credit**, open **Request unused credit back**.
2. Enter the credit amount and **Public refund address**, then select **Review refund fee**.
3. Check the gross credit reserved, maximum processing fee and exact net payout before **Confirm reviewed refund**.
4. Use **Check or resume refund** until its finalized outcome is verified. Do not submit another refund while the first remains unresolved.

A successful refund charges the net payout plus actual gas and margin against the reserved credit. Unused allowance returns to credit. A reverted or cancelled refund pays no refund amount, but can still charge gas and the reviewed margin.

The maximum processing allowance may leave a small credit remainder. A balance too small to cover that allowance cannot produce a positive refund; it remains usable for later transaction fees. Refunds require sufficient backing and an enabled signing service. During a pause, balance checks and saved-request reconciliation remain available, but new payouts must wait for the service to resume. See the [operator's refund policy](https://github.com/ophis-fi/ophis/blob/main/apps/broadcaster/PREPAID-REFUNDS.md).

## Interrupted transactions

Open **Recovery and pending transactions**. The app saves encrypted recovery records before disclosing an executable private transaction. An unknown submission outcome is not proof of failure: another service may already hold the signed transaction.

| Situation | Next step |
| --- | --- |
| Swap pending or result unknown | **Reconcile pending swap**; inspect the saved result before retrying. |
| Withdrawal pending or result unknown | **Check pending withdrawal**; use **Retry saved withdrawal through broadcaster** only when the app offers it. |
| Top-up missing or replaced | **Check top-up** against the saved payment and public transaction hash. |
| Refund pending | **Check or resume refund**; its reserved credit stays unavailable until reconciled. |
| Balance still synchronizing | Wait for verified history, then **Refresh balances**. Do not deposit again to address a synchronization delay. |
| No quote or unavailable broadcaster | Check network, route, liquidity and fee-credit status. Wait or choose another supported pair; the public orderbook's health does not establish private-route availability. |

**Advanced recovery** can require public native gas. Funding a temporary recovery account from your public wallet creates a public link. Cancelling a pending swap invalidates its authorization; it does not move or recover leftover tokens. Keep the displayed temporary-account index and inspect its balance before clearing a record. Native gas is not automatically shielded again.

Where offered, public-wallet withdrawal recovery reuses the saved proof and retains its committed private fee; it requires a compatible public wallet and additional gas. The app blocks this path when the broadcaster may already hold the withdrawal. Follow the displayed recovery state rather than creating a replacement spend. See the [technical recovery instructions](https://github.com/ophis-fi/ophis/blob/main/apps/railgun/README.md#interrupted-transactions).

## What remains visible

| Activity or service | Privacy limit |
| --- | --- |
| Public deposits and withdrawals | Public addresses, assets, amounts and timing are visible and may allow correlation. |
| DEX execution | Confirmed pool trades, amounts and the Ophis fee are public; shielding does not hide every part of a swap. |
| Gas-credit top-ups and refunds | Public transfers expose their participants and amounts. The operator can correlate requests sharing a credit account. |
| Ophis gateway and Cloudflare | They can see the client's IP address. |
| Gateway simulation provider | It receives the executable signed batch without the original client-IP header and may be able to submit that batch. |
| Public recovery | Gas funding and recovery transactions can link public and temporary execution accounts. |

Timing, amounts and network metadata can still link private activity. Availability also depends on RPC access, synchronization, delivery services and their policies. The [security page](/audits#private-wallet-security) distinguishes shielded-asset custody, operator-held credit and review scope.
