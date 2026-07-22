---
id: affiliate
title: Affiliate program
description: Share an Ophis referral code and earn 8% (self-serve) or 12% (partner tier, uncapped) of the net fee Ophis keeps on every trade your referrals route. Paid monthly in WETH, for life.
sidebar_label: Affiliate program
sidebar_position: 4
---

# Affiliate program

The Ophis affiliate program is a referral scheme that pays you a share of the fee
Ophis keeps whenever a wallet you referred trades, settled monthly in WETH.

Share a referral code. Every time someone you refer trades on Ophis, **you earn a
share of the fee Ophis keeps on that trade, for life.** It is paid in WETH, every
month, from the same Safe that pays volume-tier rebates.

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
| Share of the net fee Ophis keeps | **8%** | **12%** |
| Referred volume counted | Capped at **$1,000,000/month** | **Uncapped** |
| How to get it | Mint a code on the swap page | [Contact us](https://business.ophis.fi) to upgrade your code |

- Paid **monthly in WETH**, from the Ophis fee Safe, on-chain.
- **Through your referral link,** counts only **net-new wallets**: wallets that
  had not traded on Ophis before arriving through the link. Volume you route
  yourself through the SDK or widget is not net-new gated.
- **Lifetime** attribution: once a referred wallet is bound to your code, you keep
  earning on its trades for as long as it trades.

The share is taken on the fee Ophis **retains**, not the headline volume fee, so
your earnings track the real fees your referrals generate, never a bounty on raw
volume.

A quick read on the scale: drive **$1,000,000** of referred retail volume in a
month and the self-serve share works out to roughly **$60 to $80** in WETH for
that month ($90 to $120 on the partner tier), depending on the chains your
referrals trade on. If you run your own integration, the referral share is the
smallest of three earning layers: see
[Partner economics](./partners.md#partner-economics-the-three-layers) for the
5 bps partner rate and how to charge your own fee on top.

## How attribution and payout work

- **Attribution is off-chain.** A wallet that arrives through your referral link
  is bound to your code on its first qualifying activity and must be net-new (no
  prior Ophis trades). One referrer per referred wallet, and the first valid bind
  wins. Integrators who route their own flow attribute differently: tagging orders
  with your active code through the [SDK](./partners.md) or [widget](./widget.md)
  credits that volume to you with no bind, and the net-new rule does not apply
  there.
- **Payout is monthly, in WETH.** At the end of each cycle, Ophis tallies the fees
  earned from your referrals' trades and batches the WETH owed to you in a single
  monthly payout from the fee Safe.

## Affiliate vs rebates

These are two separate ways to earn, and you can use both:

| | Affiliate program | Volume-tier rebates |
| --- | --- | --- |
| Who earns | You, on trades your **referrals** route | You, on **your own** trade volume |
| What | 8% (self-serve) or 12% (partner) of the net fee Ophis keeps | Share of the WETH rebate pool, weighted by your tier |
| Paid in | WETH, monthly | WETH, monthly |

See [Fees & rebates](./fees.md) for the volume-tier rebate model.

## Ready to start

1. [Open swap.ophis.fi](https://swap.ophis.fi) and connect your wallet.
2. Mint your code in the affiliate section of your Profile.
3. Share `https://swap.ophis.fi/?ref=YOURCODE` and start earning.
