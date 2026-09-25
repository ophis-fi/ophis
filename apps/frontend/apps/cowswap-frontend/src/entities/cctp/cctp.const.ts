import { ARC_USDC_ADDRESS } from '@cowprotocol/common-const'

import { defineChain, parseAbi, type Address, type Chain } from 'viem'
import { arbitrum, base, mainnet, optimism, unichain } from 'viem/chains'

export const CCTP_API = 'https://iris-api.circle.com'
export const TOKEN_MESSENGER: Address = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d'
export const MESSAGE_TRANSMITTER: Address = '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64'
export const FORWARD_HOOK = '0x636374702d666f72776172640000000000000000000000000000000000000000'
export const QUOTE_LIFETIME_MS = 60_000
export const MAX_BURN = 10_000_000_000_000n

const arc = defineChain({
  id: 5042,
  name: 'Arc',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.arc.io'] } },
  blockExplorers: { default: { name: 'Arcscan', url: 'https://arcscan.app' } },
})

export interface CctpNetwork {
  chain: Chain
  domain: number
  usdc: Address
  rpc: string
}

// Circle mainnet tables, checked 2026-09-24. Arc's ERC-20 USDC has 6 decimals;
// native gas balances have 18. CCTP always uses the ERC-20 interface.
export const CCTP_NETWORKS: readonly CctpNetwork[] = [
  { chain: arc, domain: 26, usdc: ARC_USDC_ADDRESS, rpc: 'https://rpc.mainnet.arc.io' },
  { chain: base, domain: 6, usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', rpc: 'https://mainnet.base.org' },
  {
    chain: optimism,
    domain: 2,
    usdc: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    rpc: 'https://mainnet.optimism.io',
  },
  {
    chain: unichain,
    domain: 10,
    usdc: '0x078D782b760474a361dDA0AF3839290b0EF57AD6',
    rpc: 'https://mainnet.unichain.org',
  },
  {
    chain: mainnet,
    domain: 0,
    usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    rpc: 'https://ethereum-rpc.publicnode.com',
  },
  {
    chain: arbitrum,
    domain: 3,
    usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    rpc: 'https://arb1.arbitrum.io/rpc',
  },
]

export function cctpNetwork(chainId: number): CctpNetwork {
  const network = CCTP_NETWORKS.find((item) => item.chain.id === chainId)
  if (!network) throw new Error('Unsupported CCTP network')
  return network
}

export const CCTP_ABI = parseAbi([
  'function depositForBurnWithHook(uint256 amount,uint32 destinationDomain,bytes32 mintRecipient,address burnToken,bytes32 destinationCaller,uint256 maxFee,uint32 minFinalityThreshold,bytes hookData)',
  'function receiveMessage(bytes message,bytes attestation) returns (bool)',
  'function localDomain() view returns (uint32)',
  'event MessageSent(bytes message)',
  // V2 source ABI; the events table in Circle's prose also contains legacy V1 events.
  'event MessageReceived(address indexed caller,uint32 sourceDomain,bytes32 indexed nonce,bytes32 sender,uint32 indexed finalityThresholdExecuted,bytes messageBody)',
])
