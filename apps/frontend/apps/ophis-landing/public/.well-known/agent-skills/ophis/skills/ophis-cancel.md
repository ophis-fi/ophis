---
name: ophis-cancel
description: Cancel one or many open Ophis orders, gasless, by signing an EIP-712 cancellation and sending it to the orderbook. State-changing but costs no gas. Use when the user asks to cancel, kill, or withdraw an order that has not settled yet. Also documents the on-chain hard cancel for orders a solver may already be settling.
license: MIT
---

# ophis-cancel: cancel open orders (state-changing, gasless)

## When to use

The user wants an unsettled order gone: wrong amount, stale price, changed
mind. Off-chain (soft) cancellation is free and instant; it needs the same
key that signed the order.

Only `open` orders can be cancelled. A `fulfilled`, `expired`, or already
`cancelled` order is final; check `ophis-order-status.md` first.

## Single-order cancellation

The cancellation is its own EIP-712 message over the same per-chain domain
as the order (resolve `ORDERBOOK` and `SETTLEMENT` from the umbrella
`SKILL.md`; the type string is `OrderCancellation(bytes orderUid)`, type
hash `0x7b41b3a6e2b3cae020a3b2f9cdc997e0d420643957e7fea81747e984e47c88ec`):

```bash
uid="0x..."   # the order UID to cancel

jq -n --argjson chainId "$chainId" --arg verifyingContract "$SETTLEMENT" --arg uid "$uid" '{
  types: {
    EIP712Domain: [
      {name:"name",type:"string"},{name:"version",type:"string"},
      {name:"chainId",type:"uint256"},{name:"verifyingContract",type:"address"}
    ],
    OrderCancellation: [ {name:"orderUid",type:"bytes"} ]
  },
  primaryType: "OrderCancellation",
  domain: { name: "Gnosis Protocol", version: "v2", chainId: $chainId, verifyingContract: $verifyingContract },
  message: { orderUid: $uid }
}' > /tmp/ophis-cancel-typed-data.json

signature=$(cast wallet sign --data --from-file /tmp/ophis-cancel-typed-data.json "${SIGNER_ARGS[@]}")

curl -sS -X DELETE "$ORDERBOOK/api/v1/orders/$uid" \
  -H 'Content-Type: application/json' \
  --data-raw "$(jq -nc --arg signature "$signature" \
    '{signature: $signature, signingScheme: "eip712"}')"
```

## Batch cancellation (many orders, one signature)

One signature cancels up to 1024 orders via `DELETE /api/v1/orders`.

**Mind the singular/plural trap.** The EIP-712 type string is
`OrderCancellations(bytes[] orderUid)`, type hash
`0x4c89efb91ae246f78d2fe68b47db2fa1444a121a4f2dc3fda7a5a408c2e3588e`: the
struct FIELD is the singular `orderUid` (an array of bytes). The JSON body
field, however, is the plural `orderUids`. Signing a struct with a field
named `orderUids` produces a different type hash and the orderbook rejects
the signature; sending a body with `orderUid` fails deserialization. The
snippet below has each name in the only place it belongs.

```bash
uids='["0x...", "0x..."]'   # JSON array of order UIDs (max 1024)

jq -n --argjson chainId "$chainId" --arg verifyingContract "$SETTLEMENT" --argjson uids "$uids" '{
  types: {
    EIP712Domain: [
      {name:"name",type:"string"},{name:"version",type:"string"},
      {name:"chainId",type:"uint256"},{name:"verifyingContract",type:"address"}
    ],
    OrderCancellations: [ {name:"orderUid",type:"bytes[]"} ]
  },
  primaryType: "OrderCancellations",
  domain: { name: "Gnosis Protocol", version: "v2", chainId: $chainId, verifyingContract: $verifyingContract },
  message: { orderUid: $uids }
}' > /tmp/ophis-cancel-batch-typed-data.json

signature=$(cast wallet sign --data --from-file /tmp/ophis-cancel-batch-typed-data.json "${SIGNER_ARGS[@]}")

curl -sS -X DELETE "$ORDERBOOK/api/v1/orders" \
  -H 'Content-Type: application/json' \
  --data-raw "$(jq -nc --argjson orderUids "$uids" --arg signature "$signature" \
    '{orderUids: $orderUids, signature: $signature, signingScheme: "eip712"}')"
```

## Verify, then report

Re-fetch the order (`ophis-order-status.md`) and confirm `status` is
`cancelled` before telling the user it is done.

> "Cancelled. The order can no longer settle; nothing was spent and no gas
> was paid. The sell-token allowance you granted is still in place; say the
> word if you want it revoked."

To revoke the leftover exact allowance:
`cast send <sellToken> "approve(address,uint256)" "$RELAYER" 0 --rpc-url "$RPC_URL" "${SIGNER_ARGS[@]}"` (this one costs gas).

## The race window and the on-chain hard cancel

Soft cancellation is an orderbook-side promise: if a solver included the
order in a settlement that is already in flight, the fill can still land.
For an order that must die even against an in-flight settlement, the owner
can invalidate it on-chain (costs gas):

```bash
cast send "$SETTLEMENT" "invalidateOrder(bytes)" "$uid" \
  --rpc-url "$RPC_URL" "${SIGNER_ARGS[@]}"
```

After `invalidateOrder`, any attempted settlement of that UID reverts.
Offer it only when the stakes justify gas; the soft cancel is the right
default.

## Errors

- `400 InvalidRequestBody` on batch: check the singular/plural trap above.
- `401` / signature rejected: the cancellation must be signed by the order's
  owner key, over the pinned per-chain domain.
- `404 NotFound`: wrong chain or wrong UID.
- "too many orders": the batch cap is 1024 UIDs; split it.
