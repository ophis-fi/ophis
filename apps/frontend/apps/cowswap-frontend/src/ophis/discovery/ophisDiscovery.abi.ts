import type { Abi } from 'viem'

const SUMMARY_COMPONENTS = [
  { name: 'id', type: 'uint256' },
  { name: 'account', type: 'bytes32' },
  { name: 'chainId', type: 'uint64' },
  { name: 'decimals', type: 'uint8' },
  { name: 'kind', type: 'uint8' },
  { name: 'standard', type: 'uint8' },
  { name: 'deployed', type: 'bool' },
  { name: 'onchainSvg', type: 'bool' },
  { name: 'synced', type: 'bool' },
  { name: 'color', type: 'uint24' },
  { name: 'rank', type: 'uint32' },
  { name: 'frozen', type: 'bool' },
  { name: 'name', type: 'string' },
  { name: 'symbol', type: 'string' },
] as const

export const OPHIS_DISCOVERY_ABI = [
  {
    type: 'function',
    name: 'tokenList',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'summariesPaged',
    stateMutability: 'view',
    inputs: [
      { name: 'start', type: 'uint256' },
      { name: 'count', type: 'uint256' },
    ],
    outputs: [{ name: 'out', type: 'tuple[]', components: SUMMARY_COMPONENTS }],
  },
  {
    type: 'function',
    name: 'conviction',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
] as const satisfies Abi
