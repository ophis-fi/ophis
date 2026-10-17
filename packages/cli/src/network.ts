// Chains people can trade on, and RPC connections to them.
import { createPublicClient, fallback, http, type Chain } from 'viem'
// ponytail: the chain list and RPC defaults come straight from the MCP server module (one source of truth);
// move them into @ophis/sdk before any public release.
import { listChains, NATIVE_SYMBOL, PUBLIC_RPCS } from '@ophis/mcp-server/src/ophis.ts'
import { clean, UserError } from './ui.ts'

// Short names people type. The first name listed for a chain is the one we show.
const ALIASES: Record<string, number> = {
  ethereum: 1, eth: 1, mainnet: 1, optimism: 10, op: 10, bnb: 56, bsc: 56, gnosis: 100,
  unichain: 130, polygon: 137, base: 8453, plasma: 9745, arbitrum: 42161, arb: 42161,
  avalanche: 43114, avax: 43114, ink: 57073, linea: 59144, robinhood: 4663, arc: 5042,
  sepolia: 11155111, // testnet: free test funds, handy for a first try
}

// Chains the MCP server deliberately leaves without a default RPC, which the CLI still trades on
// (both answered the right eth_chainId on 2026-10-15).
const MORE_RPCS: Record<number, string[]> = {
  9745: ['https://rpc.plasma.to'],
  11155111: ['https://ethereum-sepolia-rpc.publicnode.com', 'https://sepolia.drpc.org'],
}

export interface Network {
  id: number
  name: string
  alias: string
  native: string
  rpc: string[]
  chain: Chain
}

/** RPC addresses must be https (plain http only for this computer) and carry no user name or password. */
export function checkRpc(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new UserError(`"${clean(url)}" is not a valid RPC address.`)
  }
  const local = parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
  if ((parsed.protocol !== 'https:' && !local) || parsed.username || parsed.password) {
    throw new UserError('RPC addresses must start with https:// (http only for localhost) and contain no user name or password.')
  }
  return url
}

function describe(id: number, name: string, rpcOverride?: string): Network {
  const alias = Object.keys(ALIASES).find((key) => ALIASES[key] === id) ?? String(id)
  const native = NATIVE_SYMBOL[id] ?? 'ETH'
  const fromEnv = process.env[`OPHIS_RPC_URL_${id}`]?.split(',').map((url) => url.trim())
  const rpc = (rpcOverride ? [rpcOverride] : (fromEnv ?? PUBLIC_RPCS[id] ?? MORE_RPCS[id] ?? [])).map(checkRpc)
  const chain: Chain = {
    id,
    name,
    nativeCurrency: { name: native, symbol: native, decimals: 18 },
    rpcUrls: { default: { http: rpc } },
    contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
    // Fee cap = 2 x base fee + tip: still valid after about six blocks of rising fees while the user confirms.
    fees: { baseFeeMultiplier: 2 },
  }
  return { id, name, alias, native, rpc, chain }
}

/** Every chain with a live Ophis orderbook. */
export const networks = (): Network[] => listChains().tradeable.map(({ chainId, name }) => describe(chainId, name))

/** Finds a chain by short name, full name or id, e.g. "arb", "Arbitrum One" or "42161". */
export function network(input: string, rpc?: string): Network {
  const key = input.trim().toLowerCase()
  const id = /^\d+$/.test(key) ? Number(key) : ALIASES[key]
  const found = listChains().tradeable.find((c) => c.chainId === id || c.name.toLowerCase() === key)
  if (!found) throw new UserError(`Unknown chain "${input}". Try one of: ${Object.keys(ALIASES).filter((a, i, all) => all.findIndex((b) => ALIASES[b] === ALIASES[a]) === i).join(', ')}.`)
  const net = describe(found.chainId, found.name, rpc)
  if (!net.rpc.length) throw new UserError(`No public RPC is known for ${net.name}. Pass one with --rpc <url>.`)
  return net
}

const transport = (net: Network) => fallback(net.rpc.map((url) => http(url)))
export const reader = (net: Network) => createPublicClient({ chain: net.chain, transport: transport(net) })
