import { areAddressesEqual } from '@cowprotocol/cow-sdk'

import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  http,
  pad,
  parseUnits,
  zeroHash,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem'
import { z } from 'zod'

import {
  CCTP_ABI,
  CCTP_API,
  FORWARD_HOOK,
  MAX_BURN,
  MESSAGE_TRANSMITTER,
  QUOTE_LIFETIME_MS,
  cctpNetwork,
} from './cctp.const'
import { cctpAsset, cctpToken, cctpService, cctpSpender, type CctpAsset } from './cctpAssets.const'
import {
  assertCctpxQuote,
  assertCctpxTerms,
  verifyCctpxNetwork,
  cctpxBurnData,
  parseCctpxQuote,
  type CctpxQuote,
} from './cctpx.service'

export interface CctpQuote {
  asset?: CctpAsset
  expanded?: CctpxQuote
  source: number
  destination: number
  owner: Address
  amount: string
  maxFee: string
  quotedAt: number
}

export interface CctpTransfer extends CctpQuote {
  sourceNonce?: number
  burnHash?: Hex
  mintHash?: Hex
  claimNonce?: number
}

const feeSchema = z.array(
  z.object({
    finalityThreshold: z.number().int(),
    minimumFee: z.number().finite().nonnegative(),
    forwardFee: z.object({ med: z.number().int().safe().nonnegative() }).optional(),
  }),
)

export function cctpClient(chainId: number): ReturnType<typeof createPublicClient> {
  const network = cctpNetwork(chainId)
  return createPublicClient({
    chain: network.chain,
    transport: http(network.rpc, { retryCount: 0, timeout: 12_000 }),
    pollingInterval: 10_000,
  })
}

export function parseCctpAmount(value: string, asset: CctpAsset = 'USDC'): bigint {
  const { decimals } = cctpAsset(asset)
  if (!new RegExp(`^(0|[1-9]\\d*)(\\.\\d{1,${decimals}})?$`).test(value))
    throw new Error(`Enter a ${asset} amount with at most ${decimals} decimal places`)
  const amount = parseUnits(value, decimals)
  if (amount <= 0n || amount > MAX_BURN) throw new Error('Amount must be above zero and within the bridge limit')
  return amount
}

export function calculateCctpFee(data: unknown, amount: bigint): bigint {
  const fee = feeSchema.parse(data).find((item) => item.finalityThreshold === 2000)
  if (!fee?.forwardFee) throw new Error('Circle forwarding is unavailable for this route')
  const rate = String(fee.minimumFee)
  if (!/^\d+(\.\d{1,6})?$/.test(rate)) throw new Error('Unsupported Circle fee precision')
  const scaledRate = parseUnits(rate, 6)
  const protocolFee = (amount * scaledRate + 9_999_999_999n) / 10_000_000_000n
  const total = protocolFee + BigInt(fee.forwardFee.med)
  if (total >= amount) throw new Error('Amount is too small to cover the bridge fee')
  return total
}

export async function circleGet(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${CCTP_API}${path}`, {
    signal: AbortSignal.timeout(12_000),
    credentials: 'omit',
    ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  })
  if (response.status === 404) return null
  if (!response.ok)
    throw new Error(
      response.status === 429 ? 'Circle is busy. Try again shortly.' : 'Circle is temporarily unavailable',
    )
  return response.json()
}

export async function quoteCctp(
  source: number,
  destination: number,
  owner: string,
  input: string,
  asset: CctpAsset = 'USDC',
): Promise<CctpQuote> {
  if (source === destination) throw new Error('Choose two different networks')
  cctpToken(source, asset)
  cctpToken(destination, asset)
  const amount = parseCctpAmount(input, asset)
  const from = cctpNetwork(source)
  const to = cctpNetwork(destination)
  const quote: CctpQuote = {
    source,
    destination,
    owner: getAddress(owner),
    amount: amount.toString(),
    maxFee: '0',
    quotedAt: Date.now(),
    asset,
  }
  if (asset === 'USDC') {
    const fees = await circleGet(`/v2/burn/USDC/fees/${from.domain}/${to.domain}?forward=true`)
    return { ...quote, maxFee: calculateCctpFee(fees, amount).toString() }
  }
  const data = await circleGet(`/v2/quote/cctpx/${cctpAsset(asset).tokenId}/${from.domain}/${to.domain}`, {
    amount: quote.amount,
    feeToken: zeroAddress,
    requests: [{ type: 'FORWARD', params: { msgType: 'TransferMessage', destinationAddress: quote.owner } }],
  })
  const result = { ...quote, expanded: parseCctpxQuote(data, quote) }
  assertCctpxQuote(result.expanded, await cctpClient(source).getBlock())
  assertCctpQuote(result)
  return result
}

export function assertCctpTerms(quote: CctpQuote): void {
  cctpToken(quote.source, quote.asset)
  cctpToken(quote.destination, quote.asset)
  getAddress(quote.owner)
  if (
    quote.source === quote.destination ||
    BigInt(quote.amount) <= BigInt(quote.maxFee) ||
    BigInt(quote.amount) > MAX_BURN ||
    BigInt(quote.maxFee) < 0n
  )
    throw new Error('Invalid bridge terms')
  assertCctpxTerms(quote)
}

export function assertCctpQuote(quote: CctpQuote, now = Date.now()): void {
  assertCctpTerms(quote)
  if (now < quote.quotedAt || now - quote.quotedAt > QUOTE_LIFETIME_MS)
    throw new Error('Bridge quote expired. Refresh the fee before signing.')
}

export function cctpAddressWord(address: string): Hex {
  return pad(getAddress(address) as Hex)
}

export function cctpBurnData(quote: CctpQuote): Hex {
  if (quote.asset && quote.asset !== 'USDC') return cctpxBurnData(quote)
  return encodeFunctionData({
    abi: CCTP_ABI,
    functionName: 'depositForBurnWithHook',
    args: [
      BigInt(quote.amount),
      cctpNetwork(quote.destination).domain,
      cctpAddressWord(quote.owner),
      cctpNetwork(quote.source).usdc,
      zeroHash,
      BigInt(quote.maxFee),
      2000,
      FORWARD_HOOK,
    ],
  })
}

export async function verifyCctpNetwork(chainId: number, asset: CctpAsset = 'USDC', remote?: number): Promise<void> {
  const client = cctpClient(chainId)
  const network = cctpNetwork(chainId)
  const [id, domain, decimals, code] = await Promise.all([
    client.getChainId(),
    client.readContract({ address: MESSAGE_TRANSMITTER, abi: CCTP_ABI, functionName: 'localDomain' }),
    client.readContract({ address: cctpToken(chainId, asset), abi: erc20Abi, functionName: 'decimals' }),
    client.getCode({ address: cctpService(asset) }),
  ])
  if (id !== chainId || domain !== network.domain || decimals !== cctpAsset(asset).decimals || !code || code === '0x')
    throw new Error('CCTP network verification failed')
  if (remote !== undefined) await verifyCctpxNetwork(client, chainId, remote, asset)
}

export async function readCctpFunds(quote: CctpQuote): Promise<{ allowance: bigint; balance: bigint }> {
  const client = cctpClient(quote.source)
  const address = cctpToken(quote.source, quote.asset)
  const [allowance, balance] = await Promise.all([
    client.readContract({
      address,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [quote.owner, cctpSpender(quote.asset)],
    }),
    client.readContract({ address, abi: erc20Abi, functionName: 'balanceOf', args: [quote.owner] }),
  ])
  return { allowance, balance }
}

export function isCctpOwner(owner: string, account: string | undefined): boolean {
  return !!account && areAddressesEqual(owner, account)
}
