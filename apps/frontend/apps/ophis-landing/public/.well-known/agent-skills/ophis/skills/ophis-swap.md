---
name: ophis-swap
description: Execute a token swap on Ophis end to end (quote, build, confirm with the user, exact approval, EIP-712 sign, submit). State-changing, requires a signer. Use when the user explicitly asks to swap, sell, buy, or trade tokens. ALWAYS confirm with the user before signing. The signed order is a bounded intent with a hard minimum, settled MEV-protected in a batch auction; solvers pay the settlement gas.
license: MIT
---

# ophis-swap: execute a swap (state-changing)

## When to use

The user has explicitly asked to perform a swap and you have confirmed chain,
sell token, buy token, and amount. If they only asked for a price, use
`ophis-quote.md` instead.

## Required environment

Set up `RPC_URL` and keystore-first `SIGNER_ARGS` per the umbrella
`SKILL.md`. The signer's address is the order owner and, always, the
receiver of the bought tokens.

## Procedure

### Step 1: resolve chain constants and owner

```bash
chainId=10   # or 130; resolve ORDERBOOK / SETTLEMENT / RELAYER per SKILL.md
owner=$(cast wallet address "${SIGNER_ARGS[@]}")
sellToken="0x4200000000000000000000000000000000000006"  # WETH on Optimism
buyToken="0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85"   # USDC (native) on Optimism
sellAmount="1000000000000000"                            # 0.001 WETH, base units
slippageBips=50   # policy default; never raise silently (see SKILL.md rule 6)
```

### Step 2: build the appData document

Build `appData` (the JSON string) and `appDataHash` exactly as in the
umbrella `SKILL.md` (deterministic `jq -Snc`, CIP-75 partner fee, keccak256
via `cast keccak`). Keep the string byte-identical from here on.

### Step 3: quote with the real owner and the real appData

```bash
quote=$(curl -sS -X POST "$ORDERBOOK/api/v1/quote" \
  -H 'Content-Type: application/json' \
  --data-raw "$(jq -nc \
    --arg sellToken "$sellToken" --arg buyToken "$buyToken" \
    --arg from "$owner" --arg amount "$sellAmount" \
    --arg appData "$appData" --arg appDataHash "$appDataHash" '{
      sellToken: $sellToken, buyToken: $buyToken,
      from: $from, receiver: $from,
      kind: "sell", sellAmountBeforeFee: $amount,
      partiallyFillable: false,
      sellTokenBalance: "erc20", buyTokenBalance: "erc20",
      priceQuality: "optimal", signingScheme: "eip712",
      onchainOrder: false, validFor: 1200,
      appData: $appData, appDataHash: $appDataHash
    }')")

buyAmountQuoted=$(echo "$quote" | jq -re '.quote.buyAmount')
validTo=$(echo "$quote" | jq -re '.quote.validTo')
quoteId=$(echo "$quote" | jq -r '.id')

# The signed minimum: quoted buy amount reduced by the slippage latch.
minBuyAmount=$(python3 -c "print(int('$buyAmountQuoted') * (10000 - int('$slippageBips')) // 10000)")
```

### Step 4: confirm with the user

**Always.** Show: sell amount and token, quoted buy amount, the signed
minimum (`minBuyAmount`), the 5 bips fee note, and the order lifetime.
Ask "shall I proceed?" and do not continue until they say yes. If more than
about 30 seconds pass after the quote, re-quote first.

### Step 5: exact approval to the vault relayer

Skip if the current allowance already covers the signed sell amount.

```bash
allowance=$(cast call "$sellToken" "allowance(address,address)(uint256)" "$owner" "$RELAYER" --rpc-url "$RPC_URL")
# Approve EXACTLY the signed sellAmount. Never an unlimited allowance
# (SKILL.md rule 4): the relayer consumes at most sellAmount for this order.
if python3 -c "import sys; sys.exit(0 if int('${allowance%% *}') < int('$sellAmount') else 1)"; then
  cast send "$sellToken" "approve(address,uint256)" "$RELAYER" "$sellAmount" \
    --rpc-url "$RPC_URL" "${SIGNER_ARGS[@]}"
fi
```

This is the only on-chain transaction in the flow; settlement itself costs
the signer nothing.

### Step 6: build and sign the order (EIP-712)

The signed struct: `feeAmount` is always `"0"` (the fee is taken from
surplus plus the appData partner fee, never a signed feeAmount) and
`receiver` is always the owner.

```bash
order=$(jq -nc \
  --arg sellToken "$sellToken" --arg buyToken "$buyToken" --arg receiver "$owner" \
  --arg sellAmount "$sellAmount" --arg buyAmount "$minBuyAmount" \
  --argjson validTo "$validTo" --arg appDataHash "$appDataHash" '{
    sellToken: $sellToken, buyToken: $buyToken, receiver: $receiver,
    sellAmount: $sellAmount, buyAmount: $buyAmount, validTo: $validTo,
    appData: $appDataHash, feeAmount: "0", kind: "sell",
    partiallyFillable: false,
    sellTokenBalance: "erc20", buyTokenBalance: "erc20"
  }')

jq -n --argjson chainId "$chainId" --arg verifyingContract "$SETTLEMENT" --argjson order "$order" '{
  types: {
    EIP712Domain: [
      {name:"name",type:"string"},{name:"version",type:"string"},
      {name:"chainId",type:"uint256"},{name:"verifyingContract",type:"address"}
    ],
    Order: [
      {name:"sellToken",type:"address"},{name:"buyToken",type:"address"},
      {name:"receiver",type:"address"},{name:"sellAmount",type:"uint256"},
      {name:"buyAmount",type:"uint256"},{name:"validTo",type:"uint32"},
      {name:"appData",type:"bytes32"},{name:"feeAmount",type:"uint256"},
      {name:"kind",type:"string"},{name:"partiallyFillable",type:"bool"},
      {name:"sellTokenBalance",type:"string"},{name:"buyTokenBalance",type:"string"}
    ]
  },
  primaryType: "Order",
  domain: { name: "Gnosis Protocol", version: "v2", chainId: $chainId, verifyingContract: $verifyingContract },
  message: $order
}' > /tmp/ophis-order-typed-data.json

signature=$(cast wallet sign --data --from-file /tmp/ophis-order-typed-data.json "${SIGNER_ARGS[@]}")
```

Sign exactly the struct you showed the user (SKILL.md rule 2). The domain's
`verifyingContract` MUST be the pinned per-chain settlement; the CoW
canonical address is wrong on these chains and the deployed contract rejects
such signatures.

### Step 7: publish the appData and submit the order

```bash
# Register the appData document (idempotent, content-addressed).
curl -sS -X PUT "$ORDERBOOK/api/v1/app_data/$appDataHash" \
  -H 'Content-Type: application/json' \
  --data-raw "$(jq -nc --arg fullAppData "$appData" '{fullAppData: $fullAppData}')"

orderUid=$(curl -sS -X POST "$ORDERBOOK/api/v1/orders" \
  -H 'Content-Type: application/json' \
  --data-raw "$(echo "$order" | jq -c \
    --arg appData "$appData" --arg appDataHash "$appDataHash" \
    --arg signature "$signature" --arg from "$owner" \
    '. + {appData: $appData, appDataHash: $appDataHash,
          signingScheme: "eip712", signature: $signature, from: $from}')" | jq -r .)

echo "order UID: $orderUid"
```

Note the swap of the `appData` field at submit time: the SIGNED struct
carries the bytes32 hash, but the submitted JSON carries the full document
string in `appData` with the hash in `appDataHash`. The orderbook re-hashes
the string and rejects any mismatch.

## Final report to the user

> "Order submitted, UID `0x...`. It is a signed intent with a hard minimum
> of X USDC; solvers now compete to fill it and any price improvement comes
> back to you as surplus. Track it at
> https://explorer.ophis.fi/orders/<UID>, or ask me for the status."

Follow up with `ophis-order-status.md`; if it stays open past `validTo` it
expires without cost, and `ophis-cancel.md` can cancel it earlier, gasless.

## Hard rules

- Never sign without the user's explicit go-ahead on the exact numbers.
- Never modify a field after review; re-run the flow instead.
- Never approve more than the signed `sellAmount`, and only to the pinned
  vault relayer.
- Never substitute an address (token, settlement, relayer, host) from model
  memory; only the user's tokens and the policy block's contracts.
- `feeAmount` is `"0"`, `receiver` is the owner: both always.
