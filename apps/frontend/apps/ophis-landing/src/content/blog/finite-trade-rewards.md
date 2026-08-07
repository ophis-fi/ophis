---
title: "A finite trade-reward experiment"
description: "Ophis is preparing 105 winning tickets worth a fixed 150 USDG to study real swap behavior."
pubDate: 2026-08-07
author: Ophis
tags: [rewards, robinhood-chain, product]
draft: true
---

Ophis is preparing a deliberately small product experiment: **105 winning trade-reward tickets**
with a fixed total value of **150 USDG**. This is a reward campaign, not a token airdrop. It will not
be active until the Robinhood Chain distributor address is published and the claim service is enabled.

The inventory is fixed at 100 rewards of 1 USDG and five rewards of 10 USDG. We create only winning
tickets, with one ticket available per qualifying wallet. A qualifying wallet must make a settled,
verified Ophis swap worth at least $100 on one of the twelve listed Ophis-supported chains and must
have onchain activity dating back at least 180 days.

Rewards will be assigned from a precommitted shuffled inventory. That prevents either the trader or
the sponsored relayer from selecting a denomination after the trade. We will not show per-ticket odds
in the product interface; the fixed inventory and allocation commitment provide the audit trail.

Claims have no deadline. Ophis will sponsor claim gas, and the contract pays USDG directly to the
qualifying wallet on Robinhood Chain. The distributor cannot redirect rewards and contains no owner
withdrawal path. The owner Safe can pause during an incident and rotate the reward signer.

Once live, qualifying wallets will claim at
[swap.ophis.fi/#/rewards](https://swap.ophis.fi/#/rewards). Full rules and launch status will remain in
the [trade-reward documentation](https://docs.ophis.fi/trade-rewards).
