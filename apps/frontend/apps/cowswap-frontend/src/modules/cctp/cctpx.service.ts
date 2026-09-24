import { areAddressesEqual } from '@cowprotocol/cow-sdk'

import {
  encodeFunctionData,
  encodePacked,
  maxUint256,
  zeroAddress,
  zeroHash,
  type Hex,
  type createPublicClient,
} from 'viem'
import { z } from 'zod'

import { cctpNetwork } from './cctp.const'
import { type CctpQuote } from './cctp.service'
import {
  CCTPX_ABI,
  cctpAsset,
  cctpToken,
  cctpSpender,
  CROSS_CHAIN_TOKEN_SERVICE,
  type CctpAsset,
} from './cctpAssets.const'

const units = z.string().refine((value) => /^(0|[1-9]\d{0,77})$/.test(value) && BigInt(value) <= maxUint256)
const seconds = z.number().int().nonnegative().safe()
export const cctpxQuoteSchema = z.object({
  signedQuote: z
    .string()
    .regex(/^0x(?:[a-fA-F0-9]{2}){66,8192}$/)
    .transform((value) => value as Hex),
  feeTotalAmount: units,
  issuedAt: seconds,
  expiry: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('TIMESTAMP'), expiresAt: seconds }),
    z.object({ mode: z.literal('BLOCK_NUMBER'), expiresAtBlock: seconds, blockEstimatedAt: seconds }),
  ]),
})
export type CctpxQuote = z.infer<typeof cctpxQuoteSchema>
const responseSchema = cctpxQuoteSchema.extend({
  feeToken: z.literal(zeroAddress),
  items: z.array(z.object({ type: z.enum(['FORWARD', 'PROTOCOL']), amount: units, args: z.array(z.string()) })),
})

export function parseCctpxQuote(data: unknown, quote: CctpQuote): CctpxQuote {
  const parsed = responseSchema.parse(data)
  const forward = parsed.items.find((item) => item.type === 'FORWARD')
  const protocol = parsed.items.find((item) => item.type === 'PROTOCOL')
  if (
    parsed.items.length !== 2 ||
    !forward ||
    !protocol ||
    JSON.stringify(protocol.args) !== JSON.stringify([cctpAsset(quote.asset).tokenId]) ||
    forward.args.length !== 6 ||
    JSON.stringify(forward.args.slice(0, 5)) !==
      JSON.stringify([String(cctpNetwork(quote.destination).domain), 'TransferMessage', zeroHash, 'false', '']) ||
    !areAddressesEqual(forward.args[5], quote.owner) ||
    BigInt(forward.amount) + BigInt(protocol.amount) !== BigInt(parsed.feeTotalAmount)
  )
    throw new Error('Circle forwarding quote does not match this transfer')
  return cctpxQuoteSchema.parse(parsed)
}

export function assertCctpxQuote(quote: CctpxQuote, now: number): void {
  const expiry = quote.expiry.mode === 'TIMESTAMP' ? quote.expiry.expiresAt : quote.expiry.blockEstimatedAt
  if (quote.issuedAt * 1000 > now + 5000 || expiry * 1000 <= now + 15000)
    throw new Error('Circle fee quote expired. Refresh before signing.')
}

export function cctpxBurnData(quote: CctpQuote): Hex {
  const tokenId = cctpAsset(quote.asset).tokenId
  if (!tokenId || !quote.expanded) throw new Error('Missing non-USDC bridge terms')
  return encodeFunctionData({
    abi: CCTPX_ABI,
    functionName: 'crossChainTransfer',
    args: [
      tokenId,
      BigInt(quote.amount),
      cctpNetwork(quote.destination).domain,
      encodePacked(['address'], [quote.owner]),
      zeroHash,
      2000,
      { signedQuote: quote.expanded.signedQuote, refundAddress: quote.owner },
      false,
      '0x',
    ],
  })
}

export function assertCctpxTerms(quote: CctpQuote): void {
  if ((quote.asset ?? 'USDC') === 'USDC') {
    if (quote.expanded) throw new Error('Unexpected non-USDC fee terms')
  } else if (!quote.expanded || quote.maxFee !== '0') throw new Error('Invalid non-USDC fee terms')
}

export async function verifyCctpxNetwork(
  client: ReturnType<typeof createPublicClient>,
  chainId: number,
  remote: number,
  asset: CctpAsset,
): Promise<void> {
  const tokenId = cctpAsset(asset).tokenId
  if (!tokenId) return
  const [token, manager, trusted] = await Promise.all([
    client.readContract({
      address: CROSS_CHAIN_TOKEN_SERVICE,
      abi: CCTPX_ABI,
      functionName: 'resolveTokenAddress',
      args: [tokenId],
    }),
    client.readContract({
      address: CROSS_CHAIN_TOKEN_SERVICE,
      abi: CCTPX_ABI,
      functionName: 'resolveTokenManager',
      args: [tokenId],
    }),
    client.readContract({
      address: CROSS_CHAIN_TOKEN_SERVICE,
      abi: CCTPX_ABI,
      functionName: 'isTrustedDomain',
      args: [cctpNetwork(remote).domain],
    }),
  ])
  if (
    !areAddressesEqual(token, cctpToken(chainId, asset)) ||
    !areAddressesEqual(manager, cctpSpender(asset)) ||
    !trusted
  )
    throw new Error('Circle token or route configuration changed')
}
