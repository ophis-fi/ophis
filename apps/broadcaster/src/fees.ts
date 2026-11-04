import { Contract, getAddress, hexlify, JsonRpcProvider, randomBytes } from 'ethers'
import { FEE_LIFETIME_MS, TOKENS } from './config'
import type { Store } from './storage'

const FEED_ABI = [
  'function decimals() view returns (uint8)', 'function description() view returns (string)',
  'function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)',
]
// Chainlink's published ENS feed names; resolve once and verify description/precision on chain.
const FEEDS = [
  { name: 'eth-usd.data.eth', description: 'ETH / USD', age: 3720 },
  { name: 'usdc-usd.data.eth', description: 'USDC / USD', age: 86400 },
  { name: 'usdt-usd.data.eth', description: 'USDT / USD', age: 86400 },
] as const
export const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b

export function checkedAnswer(round: readonly bigint[], timestamp: number, maxAge: number): bigint {
  const [id, price, , updated, answered] = round
  if (!id || price <= 0n || updated <= 0n || updated > BigInt(timestamp) ||
    BigInt(timestamp) - updated > BigInt(maxAge) || answered < id)
    throw new Error('Fee pricing oracle is stale or invalid.')
  return price
}

export class FeeOracle {
  private feeds?: Contract[]
  private cached?: { at: number; rates: Record<string, bigint> }
  private refreshing?: Promise<Record<string, bigint>>
  constructor(private readonly provider: JsonRpcProvider, private readonly marginBps: bigint) {}

  async rates(): Promise<Record<string, bigint>> {
    if (this.cached && Date.now() - this.cached.at < 30_000) return this.cached.rates
    this.refreshing ??= this.refresh().finally(() => { this.refreshing = undefined })
    return this.refreshing
  }
  private async refresh(): Promise<Record<string, bigint>> {
    if (!this.feeds) {
      this.feeds = await Promise.all(FEEDS.map(async (feed) => {
        const address = await this.provider.resolveName(feed.name)
        if (!address || await this.provider.getCode(address) === '0x') throw new Error('Fee oracle is unavailable.')
        const contract = new Contract(address, FEED_ABI, this.provider)
        if (await contract.getFunction('decimals')() !== 8n || await contract.getFunction('description')() !== feed.description)
          throw new Error('Unexpected fee oracle identity or precision.')
        return contract
      }))
    }
    const block = await this.provider.getBlock('latest')
    if (!block || Math.abs(Date.now() / 1000 - block.timestamp) > 45) throw new Error('The pricing read node is stale.')
    const answers = await Promise.all(this.feeds.map(async (feed, i) => {
      const round = await feed.getFunction('latestRoundData').staticCall({ blockTag: block.number })
      return checkedAnswer(Array.from(round, BigInt), block.timestamp, FEEDS[i].age)
    }))
    const rates: Record<string, bigint> = { [getAddress(TOKENS[0].address)]: 10n ** 18n }
    for (let i = 1; i < TOKENS.length; i++) {
      // Halt stablecoin fee acceptance outside this band; never assume a one-dollar peg.
      if (answers[i] < 98_000_000n || answers[i] > 102_000_000n) throw new Error('Stablecoin fee pricing is outside the accepted band.')
      rates[getAddress(TOKENS[i].address)] = ceilDiv(answers[0] * 10n ** BigInt(TOKENS[i].decimals), answers[i])
    }
    for (const token of Object.keys(rates)) rates[token] = ceilDiv(rates[token] * (10_000n + this.marginBps), 10_000n)
    this.cached = { at: Date.now(), rates }
    return rates
  }
}

export function issueFee(store: Store, rates: Record<string, bigint>): { id: string; expiration: number; rates: Record<string, string> } {
  const id = hexlify(randomBytes(32)).slice(2), expiration = Date.now() + FEE_LIFETIME_MS
  const strings = Object.fromEntries(Object.entries(rates).map(([token, rate]) => [getAddress(token), `0x${rate.toString(16)}`]))
  store.db.prepare('INSERT INTO fees(id,expiration,rates) VALUES(?,?,?)').run(id, expiration, JSON.stringify(strings))
  store.db.prepare('DELETE FROM fees WHERE expiration<?').run(Date.now() - FEE_LIFETIME_MS)
  return { id, expiration, rates: strings }
}

export function validateFee(
  store: Store, id: string, paid: Record<string, bigint>, gasBudgetWei: bigint, freshRates: Record<string, bigint>,
): void {
  const quote = store.db.prepare('SELECT expiration,rates FROM fees WHERE id=?').get(id) as { expiration: number; rates: string } | undefined
  if (!quote || quote.expiration <= Date.now()) throw new Error('Broadcaster fee quote expired.')
  const issued = JSON.parse(quote.rates) as Record<string, string>
  const entries = Object.entries(paid)
  if (entries.length !== 1 || gasBudgetWei <= 0n) throw new Error('A single supported broadcaster fee payment is required.')
  const [rawToken, amount] = entries[0], token = getAddress(rawToken)
  const freshRate = Object.entries(freshRates).find(([address]) => getAddress(address) === token)?.[1]
  if (!issued[token] || !freshRate || amount <= 0n || amount < ceilDiv(gasBudgetWei * freshRate, 10n ** 18n))
    throw new Error('The private broadcaster fee does not cover the signed execution budget.')
}
