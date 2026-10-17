// Signing happens in the user's own wallet app (phone, or Ledger through Ledger Wallet), reached with
// WalletConnect. The CLI never sees a private key: it asks the wallet to sign, then checks the answer.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import SignClient from '@walletconnect/sign-client'
import QRCode from 'qrcode'
import { getAddress, isHex, numberToHex, type Address, type Hex } from 'viem'
import { OPHIS_HOME } from './home.ts'
import { clean, UserError } from './ui.ts'

// ponytail: the swap.ophis.fi Reown project (public id). Give the CLI its own Reown project before any release.
const PROJECT_ID = process.env.OPHIS_WC_PROJECT_ID ?? '22b04d22ab97e563062ce2228546286f'
const METHODS = ['eth_sendTransaction', 'eth_signTypedData_v4']
const WAIT = 5 * 60 // seconds the wallet has to answer a request

type Client = Awaited<ReturnType<typeof SignClient.init>>
type Session = ReturnType<Client['session']['getAll']>[number]

/** A transaction for the wallet to sign and send. */
export interface TxRequest {
  to: Address
  data?: Hex
  value?: bigint
  gas?: bigint
  maxFeePerGas?: bigint
  maxPriorityFeePerGas?: bigint
  gasPrice?: bigint
}

/** EIP-712 data as wallets expect it in eth_signTypedData_v4 (numbers as decimal strings). */
export interface TypedDataJson {
  domain: { name: string; version: string; chainId: number; verifyingContract: Address }
  types: Record<string, { name: string; type: string }[]>
  primaryType: string
  message: Record<string, string | number | boolean>
}

export interface Signer {
  address: Address
  sendTransaction(chainId: number, tx: TxRequest): Promise<Hex>
  signTypedData(chainId: number, typed: TypedDataJson): Promise<Hex>
}

/**
 * WalletConnect's session store as one owner-only JSON file. It holds the pairing's own keys, never a
 * wallet key. (WalletConnect's default store picks its browser build inside a compiled binary.)
 */
class FileStorage {
  constructor(private readonly path: string) {}
  private read(): Record<string, unknown> {
    try {
      return JSON.parse(readFileSync(this.path, 'utf8'))
    } catch {
      return {}
    }
  }
  private write(data: Record<string, unknown>): void {
    writeFileSync(this.path, JSON.stringify(data), { mode: 0o600 })
  }
  async getKeys() {
    return Object.keys(this.read())
  }
  async getEntries<T>() {
    return Object.entries(this.read()) as [string, T][]
  }
  async getItem<T>(key: string) {
    return this.read()[key] as T | undefined
  }
  async setItem<T>(key: string, value: T) {
    this.write({ ...this.read(), [key]: value })
  }
  async removeItem(key: string) {
    const data = this.read()
    delete data[key]
    this.write(data)
  }
}

async function client(): Promise<Client> {
  mkdirSync(OPHIS_HOME, { recursive: true, mode: 0o700 })
  return SignClient.init({
    projectId: PROJECT_ID,
    metadata: { name: 'Ophis CLI', description: 'Swap on Ophis from your terminal', url: 'https://ophis.fi', icons: ['https://ophis.fi/favicon.ico'] },
    storage: new FileStorage(join(OPHIS_HOME, 'walletconnect.json')),
    logger: 'silent', // WalletConnect's own logs are noise here; real failures surface as errors
  })
}

// The connected address and chains (public information only), so a price check needs no wallet link.
const WALLET_FILE = () => join(OPHIS_HOME, 'wallet.json')

function remember(wallet: { address: Address; chains: number[] } | null): void {
  if (!wallet) return rmSync(WALLET_FILE(), { force: true })
  writeFileSync(WALLET_FILE(), `${JSON.stringify(wallet)}\n`, { mode: 0o600 })
}

/** The last connected wallet, read from disk without contacting it (null if none). */
export function savedWallet(): { address: Address; chains: number[] } | null {
  try {
    const saved = JSON.parse(readFileSync(WALLET_FILE(), 'utf8')) as { address: string; chains: number[] }
    return { address: getAddress(saved.address), chains: saved.chains.filter(Number.isInteger) }
  } catch {
    return null
  }
}

const liveSession = (c: Client): Session | undefined =>
  c.session.getAll().filter((s) => s.expiry * 1000 > Date.now()).sort((a, b) => b.expiry - a.expiry)[0]

/** "eip155:8453:0xabc..." entries -> the account and the chains the wallet allowed. */
function accountsOf(session: Session): { address: Address; chains: number[] } {
  const entries = (session.namespaces.eip155?.accounts ?? []).map((a) => a.split(':'))
  const first = entries[0]
  if (!first?.[2]) throw new UserError('The wallet connected without an Ethereum account. Run ophis connect again.')
  return { address: getAddress(first[2]), chains: entries.map((e) => Number(e[1])) }
}

/** Starts a pairing: a QR code to show, and a wait() that resolves once the user approves in their wallet. */
export async function startConnect(chainIds: number[]): Promise<{ qr: string; uri: string; wait: () => Promise<{ address: Address; chains: number[] }> }> {
  const c = await client()
  for (const old of c.session.getAll()) await c.disconnect({ topic: old.topic, reason: { code: 6000, message: 'Replaced' } }).catch(() => {})
  const { uri, approval } = await c.connect({
    optionalNamespaces: { eip155: { chains: chainIds.map((id) => `eip155:${id}`), methods: METHODS, events: ['accountsChanged', 'chainChanged'] } },
  })
  if (!uri) throw new UserError('Could not start a WalletConnect pairing. Check your internet connection.')
  const wait = async () => {
    const session = await Promise.race([
      approval(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new UserError('No wallet connected within 5 minutes.')), WAIT * 1000)),
    ])
    const wallet = accountsOf(session)
    remember(wallet)
    return wallet
  }
  return { qr: await QRCode.toString(uri, { type: 'terminal', small: true }), uri, wait }
}

/** The connected wallet, or null when there is none. */
export async function connected(): Promise<{ address: Address; chains: number[]; expires: Date } | null> {
  const session = liveSession(await client())
  const wallet = session ? accountsOf(session) : null
  remember(wallet)
  return session && wallet ? { ...wallet, expires: new Date(session.expiry * 1000) } : null
}

export async function disconnect(): Promise<boolean> {
  const c = await client()
  const all = c.session.getAll()
  for (const s of all) await c.disconnect({ topic: s.topic, reason: { code: 6000, message: 'User disconnected' } }).catch(() => {})
  remember(null)
  return all.length > 0
}

const hex = (n: bigint | undefined) => (n === undefined ? undefined : numberToHex(n))

/** A signer that forwards every request to the connected wallet app. */
export async function phoneSigner(chainId: number): Promise<Signer> {
  const c = await client()
  const session = liveSession(c)
  if (!session) throw new UserError('No wallet connected. Run: ophis connect')
  const { address, chains } = accountsOf(session)
  if (!chains.includes(chainId)) throw new UserError('Your wallet did not allow this chain. Run ophis connect again and accept it.')
  // The session asks the wallet on `chainId` alone: a request meant for another chain must not go through.
  const sameChain = (asked: number) => {
    if (asked !== chainId) throw new UserError(`This request is for chain ${asked} but the wallet session is on chain ${chainId}. Nothing was sent.`)
  }
  const ask = async <T>(method: string, params: unknown[]): Promise<T> => {
    try {
      return await c.request<T>({ topic: session.topic, chainId: `eip155:${chainId}`, request: { method, params }, expiry: WAIT })
    } catch (err) {
      const message = String((err as Error)?.message ?? err)
      if (/reject|denied|cancel/i.test(message)) throw new UserError('You declined the request in your wallet. Nothing more was sent.')
      // The wallet wrote this text: clean it so it cannot steer the terminal.
      throw new UserError(`Your wallet did not answer: ${clean(message).slice(0, 120)}`)
    }
  }
  return {
    address,
    async sendTransaction(chain, tx) {
      sameChain(chain)
      const request = Object.fromEntries(
        Object.entries({ from: address, to: tx.to, data: tx.data, value: hex(tx.value ?? 0n), gas: hex(tx.gas), maxFeePerGas: hex(tx.maxFeePerGas), maxPriorityFeePerGas: hex(tx.maxPriorityFeePerGas), gasPrice: hex(tx.gasPrice) })
          .filter(([, v]) => v !== undefined),
      )
      const hash = await ask<Hex>('eth_sendTransaction', [request])
      if (!isHex(hash) || hash.length !== 66) throw new UserError('The wallet returned an invalid transaction id.')
      return hash
    },
    async signTypedData(chain, typed) {
      sameChain(chain)
      sameChain(Number(typed.domain.chainId))
      const signature = await ask<Hex>('eth_signTypedData_v4', [address, JSON.stringify(typed)])
      if (!isHex(signature)) throw new UserError('The wallet returned an invalid signature.')
      return signature
    },
  }
}
