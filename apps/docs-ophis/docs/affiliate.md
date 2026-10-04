---
id: affiliate
title: Affiliate program
description: Referral attribution and estimated shares of Ophis's verified base fee on indexed chains, including Arc. Payout execution is subject to activation and reconciliation.
sidebar_label: Affiliate program
sidebar_position: 4
---

# Affiliate program

Earn a share of your referrals’ trading fees. View rewards and payout status in
your [dashboard](https://swap.ophis.fi/#/affiliate).
Arc (5042) is included in affiliate and volume-tier rebate indexing.

Share a referral code. When someone you refer trades on an indexed Ophis chain, **you earn a
share of the verified base fee Ophis keeps on eligible attributed trades.**

:::note[Payout status]

WETH payouts require enabled processing, reconciled accounting, funds and Safe approval.
The dashboard shows current status; estimated earnings are not completed payments.
:::

## How it works

1. **Connect a wallet** on [swap.ophis.fi](https://swap.ophis.fi).
2. Open your **Profile** and find the **affiliate section**.
3. **Mint your referral code.** It is tied to your connected wallet.
4. **Share your link:** `https://swap.ophis.fi/?ref=YOURCODE`.

When a new trader arrives through your link and starts swapping, every trade they
route accrues a share of the fee back to you.

## What you earn

There are two tiers, and both numbers are published:

| | Self-serve | Partner |
| --- | --- | --- |
| Share of the verified base fee Ophis keeps | **8%** | **12%** |
| Referred volume counted | Capped at **$1,000,000/month** | **Uncapped** |
| How to get it | Mint a code on the swap page | [Contact us](https://business.ophis.fi) to upgrade your code |

- Payout denomination: **WETH**, with monthly processing when enabled.
- **Through your referral link,** counts only **net-new wallets**: wallets that
  had not traded on Ophis before arriving through the link. Volume you route
  yourself through the SDK or widget is not net-new gated.
- **Lifetime** attribution: once a referred wallet is bound to your code, you keep
  earning on its trades for as long as it trades.

The share is taken on the verified 1 bp base fee Ophis **retains**, not raw
volume. Improvement capture is excluded until actual transfers can be
reconciled to the Ophis Safe.

A quick read on the scale: drive **$1,000,000** of referred retail volume in a
month and the self-serve share works out to roughly **$6 to $8** in WETH for
that month ($9 to $12 on the partner tier), depending on the chains your
referrals trade on. If you run your own integration, the referral share is the
smallest of three earning layers: see
[Partner economics](./partners.md#partner-economics-the-three-layers) for the
chain-aware base, hosted partner rate, and how to charge your own fee on top.

## How attribution and payout work

- **Attribution is off-chain.** A wallet that arrives through your referral link
  is bound to your code on its first qualifying activity and must be net-new (no
  prior Ophis trades). One referrer per referred wallet, and the first valid bind
  wins. Integrators who route their own flow attribute differently: tagging orders
  with your active code through the [SDK](./partners.md) or [widget](./widget.md)
  credits that volume to you with no bind, and the net-new rule does not apply
  there.
- **Dashboard counts combine both attribution paths.** A wallet appearing through a
  link and an eligible code-tagged trade counts once. Code tags do not create permanent binds.

## Affiliate vs rebates

These are two separate ways to earn, and you can use both:

| | Affiliate program | Volume-tier rebates |
| --- | --- | --- |
| Who earns | You, on trades your **referrals** route | You, on **your own** trade volume |
| What | 8% (self-serve) or 12% (partner) of the verified base fee Ophis keeps | Share of the WETH rebate pool, weighted by your tier |
| Payout design | WETH, monthly when enabled | WETH, monthly subject to readiness and Safe approval |

See [Fees & rebates](./fees.md) for the volume-tier rebate model.

## Ready to start

1. [Open swap.ophis.fi](https://swap.ophis.fi) and connect your wallet.
2. Mint your code in the affiliate section of your Profile.
3. Share `https://swap.ophis.fi/?ref=YOURCODE` and start earning.
