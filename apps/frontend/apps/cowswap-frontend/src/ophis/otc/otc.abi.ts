import type { Abi, AbiEvent } from 'viem'

/**
 * Deployed struct layout, verified on-chain by decoding getOrder(143) on
 * 2026-08-19 and against the Sourcify exact_match ABI. `active` is the
 * SECOND field; upstream NatSpec lists it last — the tuple order below is
 * the authority for decoding.
 */
const ORDER_COMPONENTS = [
  { name: 'maker', type: 'address' },
  { name: 'active', type: 'bool' },
  { name: 'tokenA', type: 'address' },
  { name: 'amountA', type: 'uint256' },
  { name: 'tokenB', type: 'address' },
  { name: 'amountB', type: 'uint256' },
] as const

/**
 * Independently defined minimal read ABI (interface facts derived from the
 * public ABI; no upstream implementation source is used). Read-only by
 * construction: no nonpayable or payable fragment may ever be added here —
 * otc.boundary.test.ts enforces this.
 */
export const OTC_READ_ABI = [
  {
    type: 'function',
    name: 'getOrder',
    stateMutability: 'view',
    inputs: [{ name: 'orderId', type: 'uint256' }],
    outputs: [{ name: 'order', type: 'tuple', components: ORDER_COMPONENTS }],
  },
  {
    type: 'function',
    name: 'getOrders',
    stateMutability: 'view',
    inputs: [{ name: 'orderIds', type: 'uint256[]' }],
    outputs: [{ name: 'result', type: 'tuple[]', components: ORDER_COMPONENTS }],
  },
  {
    type: 'function',
    name: 'canFill',
    stateMutability: 'view',
    inputs: [{ name: 'orderId', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'weth',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'nextOrderId',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const satisfies Abi

/** Order lifecycle events, for future checkpointed log ingestion (not used in A/B reads). */
export const OTC_EVENT_ABI = [
  {
    type: 'event',
    name: 'OrderCreated',
    inputs: [
      { name: 'orderId', type: 'uint256', indexed: true },
      { name: 'maker', type: 'address', indexed: true },
      { name: 'tokenA', type: 'address', indexed: false },
      { name: 'amountA', type: 'uint256', indexed: false },
      { name: 'tokenB', type: 'address', indexed: false },
      { name: 'amountB', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'OrderFilled',
    inputs: [
      { name: 'orderId', type: 'uint256', indexed: true },
      { name: 'taker', type: 'address', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'OrderCanceled',
    inputs: [{ name: 'orderId', type: 'uint256', indexed: true }],
  },
] as const satisfies readonly AbiEvent[]
