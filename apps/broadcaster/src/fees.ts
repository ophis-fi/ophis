import { Contract, getAddress, hexlify, JsonRpcProvider, randomBytes } from 'ethers'
import { CHAIN_ID, FEE_LIFETIME_MS, FEE_TOKENS } from './config'
import type { Store } from './storage'

const FEED_ABI = [
  'function decimals() view returns (uint8)', 'function description() view returns (string)',
  'function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)',
]
type Feed = { target: string; description: string; age: number; decimals?: number }
// Chainlink directory pins: https://reference-data-directory.vercel.app/feeds-{bsc-mainnet,matic-mainnet,ethereum-mainnet-arbitrum-1}.json
// Non-Ethereum ages allow the published heartbeat plus 60 seconds; metadata was verified onchain.
const FEEDS: Record<number, readonly Feed[]> = {
  1: [
    { target: 'eth-usd.data.eth', description: 'ETH / USD', age: 3720 },
    { target: 'usdc-usd.data.eth', description: 'USDC / USD', age: 86400 },
    { target: 'usdt-usd.data.eth', description: 'USDT / USD', age: 86400 },
  ],
  42161: [
    { target: '0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612', description: 'ETH / USD', age: 1815 },
    { target: '0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3', description: 'USDC / USD', age: 315 },
    { target: '0x3f3f5dF88dC9F13eac63DF89EC16ef6e7E25DdE7', description: 'USDT / USD', age: 315 },
  ],
  56: [], // WBNB fees reimburse native BNB directly; no USD conversion is required.
  137: [
    { target: '0xAB594600376Ec9fD91F8e885dADF0CE036862dE0', description: 'MATIC / USD', age: 87 },
    { target: '0xfE4A8cc5b5B2366C1B58Bea3858e81843581b2F7', description: 'USDC / USD', age: 87 },
    { target: '0x0A6513e40db6EB1b165753AD52E80663aeA50545', description: 'USDT / USD', age: 87 },
  ],
}
// https://docs.chain.link/data-feeds/l2-sequencer-feeds
const SEQUENCER: Feed = { target: '0xFdB631F5EE196F0ed6FAa767959853A9F217697D',
  description: 'L2 Sequencer Uptime Status Feed', decimals: 0, age: 0 }
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
  private cached?: { expires: number; rates: Record<string, bigint> }
  private refreshing?: Promise<Record<string, bigint>>
  constructor(private readonly provider: JsonRpcProvider, private readonly marginBps: bigint) {
    if (!FEEDS[CHAIN_ID]) throw new Error('Fee pricing is unavailable for this broadcaster chain.')
  }

  async rates(): Promise<Record<string, bigint>> {
    // Recheck Arbitrum's sequencer and BNB's trusted head even while a price cache would be young.
    if (CHAIN_ID !== 42161 && CHAIN_ID !== 56 && this.cached && Date.now() < this.cached.expires) return this.cached.rates
    this.refreshing ??= this.refresh().finally(() => { this.refreshing = undefined })
    return this.refreshing
  }
  private async refresh(): Promise<Record<string, bigint>> {
    const feeds = FEEDS[CHAIN_ID]
    if (!this.feeds) {
      const definitions = CHAIN_ID === 42161 ? [...feeds, SEQUENCER] : feeds
      this.feeds = await Promise.all(definitions.map(async (feed) => {
        const address = CHAIN_ID === 1 ? await this.provider.resolveName(feed.target) : feed.target
        if (!address || await this.provider.getCode(address) === '0x') throw new Error('Fee oracle is unavailable.')
        const contract = new Contract(address, FEED_ABI, this.provider)
        if (await contract.getFunction('decimals')() !== BigInt(feed.decimals ?? 8) ||
          await contract.getFunction('description')() !== feed.description)
          throw new Error('Unexpected fee oracle identity or precision.')
        return contract
      }))
    }
    const block = await this.provider.getBlock('latest')
    const sampledAt = Date.now()
    if (!block || Math.abs(sampledAt / 1000 - block.timestamp) > 45) throw new Error('The pricing read node is stale.')
    if (CHAIN_ID === 42161) {
      const round = await this.feeds[feeds.length].getFunction('latestRoundData').staticCall({ blockTag: block.number })
      const [id, status, started, updated, answered] = Array.from(round, BigInt)
      const now = BigInt(block.timestamp)
      if (!id || status !== 0n || started <= 0n || updated < started || updated > now || answered < id || now - started <= 3600n)
        throw new Error('The Arbitrum sequencer is unavailable or its recovery grace period has not passed.')
    }
    let expires = Math.min(sampledAt + 30_000, (block.timestamp + 45) * 1000)
    const answers = await Promise.all(this.feeds.slice(0, feeds.length).map(async (feed, i) => {
      const round = Array.from(await feed.getFunction('latestRoundData').staticCall({ blockTag: block.number }), BigInt)
      const answer = checkedAnswer(round, block.timestamp, feeds[i].age)
      const lastValid = round[3] + BigInt(feeds[i].age) + 1n
      expires = Math.min(expires, Number(lastValid) * 1000,
        Math.floor(sampledAt / 1000) * 1000 + Number(lastValid - BigInt(block.timestamp)) * 1000)
      return answer
    }))
    const rates: Record<string, bigint> = { [getAddress(FEE_TOKENS[0].address)]: 10n ** 18n }
    for (let i = 1; i < FEE_TOKENS.length; i++) {
      // Halt stablecoin fee acceptance outside this band; never assume a one-dollar peg.
      if (answers[i] < 98_000_000n || answers[i] > 102_000_000n) throw new Error('Stablecoin fee pricing is outside the accepted band.')
      // shortcut: underlying USD feeds exclude bridge risk; disable affected fee tokens if redemption parity is uncertain.
      rates[getAddress(FEE_TOKENS[i].address)] = ceilDiv(answers[0] * 10n ** BigInt(FEE_TOKENS[i].decimals), answers[i])
    }
    for (const token of Object.keys(rates)) rates[token] = ceilDiv(rates[token] * (10_000n + this.marginBps), 10_000n)
    if (Date.now() >= expires) throw new Error('Fee pricing expired during refresh.')
    this.cached = { expires, rates }
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
  if (!FEE_TOKENS.some((item) => item.address === token) || !issued[token] || !freshRate || amount <= 0n ||
    amount < ceilDiv(gasBudgetWei * freshRate, 10n ** 18n))
    throw new Error('The private broadcaster fee does not cover the signed execution budget.')
}
