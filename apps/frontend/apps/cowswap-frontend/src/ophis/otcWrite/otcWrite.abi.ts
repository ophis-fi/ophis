import type { Abi } from 'viem'

/** ERC-20-only Swapboard write surface for Milestone C. No payable/native variants. */
export const OTC_ERC20_WRITE_ABI = [
  {
    type: 'function',
    name: 'createOrder',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokenA', type: 'address' },
      { name: 'amountA', type: 'uint256' },
      { name: 'tokenB', type: 'address' },
      { name: 'amountB', type: 'uint256' },
    ],
    outputs: [{ name: 'orderId', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'fillOrder',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'orderId', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'cancelOrder',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'orderId', type: 'uint256' }],
    outputs: [],
  },
] as const satisfies Abi

/** Exact-amount approval is the only token write Milestone C may encode. */
export const OTC_APPROVE_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const satisfies Abi

/** Narrow ERC-20 read surface used to revalidate exact allowances. */
export const OTC_ALLOWANCE_ABI = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const satisfies Abi
