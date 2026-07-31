---
name: ophis-order-status
description: Check the status of an Ophis order by its UID. Read-only, never signs and never broadcasts. Use when the user asks "did my swap go through", "what happened to my order", or wants fill amounts, surplus earned, or the settlement transaction for a specific order.
license: MIT
---

# ophis-order-status: track an order (read-only)

## When to use

The user has an order UID (from `ophis-swap` or the swap app) and wants to
know where it stands: open, filled, cancelled, or expired, and at what price
it settled.

## Inputs you need

- **chainId**: 10, 130, or 4663 (an order lives on exactly one chain's orderbook).
- **orderUid**: `0x` + 112 hex chars (56 bytes: order digest ++ owner ++
  validTo). If it looks shorter, it is not a UID.

## Procedure

Resolve `ORDERBOOK` for the chain from the umbrella `SKILL.md`, then fetch
the order and its competition status in parallel:

```bash
uid="0x..."   # 112 hex chars after 0x

order=$(curl -sS "$ORDERBOOK/api/v1/orders/$uid")
status=$(curl -sS "$ORDERBOOK/api/v1/orders/$uid/status")

echo "$order" | jq '{
  status,
  kind: .kind,
  sellToken, buyToken,
  sellAmount, buyAmount,
  executedSellAmount, executedBuyAmount,
  validTo, creationDate,
  invalidated
}'
echo "$status" | jq .
```

- `GET /api/v1/orders/{uid}` is the order record and the source of truth:
  signed terms plus executed amounts and lifecycle `status` (`open`,
  `fulfilled`, `cancelled`, `expired`, `presignaturePending`).
- `GET /api/v1/orders/{uid}/status` is the live auction view (whether
  solvers are actively bidding, which solver won). It covers the recent
  competition window only: for a settled or aged order it returns 404
  `order status not found` even though the order exists and filled. Treat
  that 404 as "no live competition data", never as "unknown order".

For the settlement record (tx hash, block, executed amounts per fill),
which keeps working long after the competition view has aged out:

```bash
curl -sS "$ORDERBOOK/api/v1/trades?orderUid=$uid" | jq '[.[] | {txHash, blockNumber, sellAmount, buyAmount}]'
```

## Interpreting the result for the user

- **fulfilled**: compare `executedBuyAmount` with the signed `buyAmount`
  minimum (sell orders). The difference is the surplus the batch auction
  returned above the signed limit; say it in token units, and link
  `https://explorer.ophis.fi/orders/<UID>`.
- **open past its quote**: solvers are still bidding; batch auctions run
  continuously, a fill typically lands within a couple of minutes when the
  limit is marketable.
- **expired**: `validTo` passed without a fill; nothing was spent, the
  allowance is untouched. Offer to re-quote.
- **cancelled**: it was cancelled (see `ophis-cancel.md`); nothing settled.

A well-formed but unknown UID returns 404 `NotFound`:

```bash ci:live-readonly
ORDERBOOK="https://optimism-mainnet.ophis.fi"
absentUid="0x$(printf '0%.0s' $(seq 1 112))"
code=$(curl -sS -o /dev/null -w '%{http_code}' "$ORDERBOOK/api/v1/orders/$absentUid")
test "$code" = "404"
```

## Errors

- `404 NotFound` from `GET /orders/{uid}` (the order record): no such UID
  on THIS chain's orderbook; check the chain before telling the user the
  order does not exist.
- `404 order status not found` from `GET /orders/{uid}/status`: NOT proof
  the order is unknown; the competition view ages out after settlement.
  Answer "did it go through?" from the order record's `status` and from
  `GET /trades?orderUid=` (the settlement tx hash), never from this 404.
- A UID is chain-local: the same trade concept on another chain is a
  different order with a different UID.
