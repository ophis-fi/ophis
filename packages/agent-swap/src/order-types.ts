// The canonical GPv2 (CoW Protocol) Order EIP-712 type set. These field names, types, and ORDER
// are fixed by the GPv2Settlement contract on every CoW/Ophis chain — they are protocol constants,
// not configuration, so they are inlined here (the @ophis/sdk is deliberately dependency-free and
// does not export them, and pulling them from @cowprotocol/contracts drags in an ethers-v5 runtime
// shim). The struct that is signed must match this exactly or the settlement contract rejects the
// signature. Primary type is "Order".
export const GPV2_ORDER_EIP712_TYPES = {
  Order: [
    { name: 'sellToken', type: 'address' },
    { name: 'buyToken', type: 'address' },
    { name: 'receiver', type: 'address' },
    { name: 'sellAmount', type: 'uint256' },
    { name: 'buyAmount', type: 'uint256' },
    { name: 'validTo', type: 'uint32' },
    { name: 'appData', type: 'bytes32' },
    { name: 'feeAmount', type: 'uint256' },
    { name: 'kind', type: 'string' },
    { name: 'partiallyFillable', type: 'bool' },
    { name: 'sellTokenBalance', type: 'string' },
    { name: 'buyTokenBalance', type: 'string' },
  ],
} as const;

export const GPV2_ORDER_PRIMARY_TYPE = 'Order' as const;
