import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Wallet, type JsonRpcProvider } from 'ethers'
import { alchemyCU } from '../../railgun/rpc-policy'

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })

it.each([42161, 8453])('bounds idle discovery CU on chain %i without polling an empty journal', async (chainId) => {
  vi.stubEnv('OPHIS_BROADCASTER_CHAIN_ID', String(chainId))
  const { Broadcaster } = await import('../src/broadcaster')
  const { Store } = await import('../src/storage')
  const { config } = await import('./request.fixture')
  const directory = mkdtempSync(join(tmpdir(), 'ophis-discovery-cost-')), store = new Store(directory)
  const operator = Wallet.createRandom(), rpc: string[] = []
  const provider = {
    getNetwork: async () => { rpc.push('eth_chainId'); return { chainId: BigInt(chainId) } },
    getBlock: async (tag: string | number) => {
      rpc.push('eth_getBlockByNumber')
      return { number: typeof tag === 'number' ? tag : 10000, hash: `0x${'11'.repeat(32)}`,
        timestamp: Math.floor(Date.now() / 1000), baseFeePerGas: 1n }
    },
    getCode: async () => { rpc.push('eth_getCode'); return '0x' },
    getTransactionCount: async () => { rpc.push('eth_getTransactionCount'); return 0 },
    getBalance: async () => { rpc.push('eth_getBalance'); return 10n ** 18n },
  }
  const unused = async (): Promise<never> => { throw new Error('Discovery must not inspect or spend private notes') }
  const sdk = { ready: () => true, validatePrepaid: unused, sign: async () => 'fixture-signature',
    fee: unused, validate: unused, assure: unused, privateViewingKey: new Uint8Array(), publicViewingKey: '',
    address: '0zk1qy08nqrftxezyxdegx6ca055tr65f2hf3u24j9urx04e5fnzepv6nrv7j6fe3z53luvr6qkgtjukzmkcp856gs5a6wzdd3pnesr9r6ljvym9l3a4fcepgkvek3f' }
  try {
    store.bindIdentity(chainId, operator.address)
    const service = new Broadcaster({ ...config, creditPaymentMode: 'public-native', admission: 'public' }, store,
      sdk, provider as unknown as JsonRpcProvider, operator,
      { broadcastTransaction: async () => { throw new Error('No transaction is authorized by discovery') } },
      { rates: async () => { throw new Error('Native credit does not need a price feed') } })
    await service.creditInfo()
    rpc.length = 0
    const advertisement = await service.feeAdvertisement()
    expect(advertisement.available).toBe(true)
    const envelope = JSON.parse(Buffer.from(advertisement.message).toString())
    expect(JSON.parse(Buffer.from(envelope.data, 'hex').toString()).availableWallets).toBe(1)
    expect(rpc).toEqual(['eth_chainId', 'eth_getBlockByNumber', 'eth_getBlockByNumber',
      'eth_getTransactionCount', 'eth_getTransactionCount', 'eth_getBalance'])
    expect(rpc.reduce((cu, method) => cu + alchemyCU(method)!, 0)).toBe(100)
    rpc.length = 0
    await service.reconcile()
    expect(rpc).toEqual([])
    provider.getBalance = async () => 0n
    expect((await service.feeAdvertisement()).available).toBe(false)
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }) }
})
