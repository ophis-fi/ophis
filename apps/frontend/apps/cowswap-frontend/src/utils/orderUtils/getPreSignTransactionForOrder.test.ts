import { getGlobalAdapter, setGlobalAdapter, SupportedChainId, TradingSdk } from '@cowprotocol/cow-sdk'
import { Web3Provider, type JsonRpcSigner } from '@ethersproject/providers'

import { tradingSdk } from 'tradingSdk/tradingSdk'

import { getPreSignTransactionForOrder } from './getPreSignTransactionForOrder'

let mockViemMigration = false
jest.mock('@cowprotocol/common-const', () => ({
  get LAUNCH_DARKLY_VIEM_MIGRATION() {
    return mockViemMigration
  },
}))
jest.mock('tradingSdk/tradingSdk', () => ({ tradingSdk: { getPreSignTransaction: jest.fn() } }))

const UID = '0xuid'
const SIGNER = { sendTransaction: jest.fn() } as unknown as JsonRpcSigner
const VIEM_SIGNER = { estimateGas: jest.fn().mockResolvedValue(50_000n) } as unknown as ReturnType<
  typeof getGlobalAdapter
>['signer']
const adapter = {
  signer: VIEM_SIGNER,
  createSigner: jest.fn(() => VIEM_SIGNER),
  utils: { encodeFunction: jest.fn(() => '0xdeadbeef') },
} as unknown as ReturnType<typeof getGlobalAdapter>

describe('getPreSignTransactionForOrder', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.mocked(tradingSdk.getPreSignTransaction).mockReset()
    setGlobalAdapter(adapter)
    mockViemMigration = false
  })

  it('binds the snapshotted chain and signer, leaving env/settlement override to the SDK defaults', async () => {
    mockViemMigration = false
    await getPreSignTransactionForOrder(UID, SupportedChainId.GNOSIS_CHAIN, SIGNER)

    expect(tradingSdk.getPreSignTransaction).toHaveBeenCalledWith({
      orderUid: UID,
      chainId: SupportedChainId.GNOSIS_CHAIN,
      signer: SIGNER,
    })
  })

  it('binds the chain and the viem adapter signer', async () => {
    mockViemMigration = true
    await getPreSignTransactionForOrder(UID, SupportedChainId.GNOSIS_CHAIN, SIGNER)

    expect(tradingSdk.getPreSignTransaction).toHaveBeenCalledWith({
      orderUid: UID,
      chainId: SupportedChainId.GNOSIS_CHAIN,
      signer: VIEM_SIGNER,
    })
  })

  it('overrides a stale ethers signer retained by the real SDK in viem mode', async () => {
    mockViemMigration = true
    const sdk = new TradingSdk({ chainId: SupportedChainId.MAINNET, appCode: 'test', signer: SIGNER })
    jest.mocked(tradingSdk.getPreSignTransaction).mockImplementation((params) => sdk.getPreSignTransaction(params))

    await getPreSignTransactionForOrder(UID, SupportedChainId.GNOSIS_CHAIN, SIGNER)

    expect(adapter.createSigner).toHaveBeenCalledWith(VIEM_SIGNER)
    expect(adapter.createSigner).not.toHaveBeenCalledWith(SIGNER)
    expect(VIEM_SIGNER.estimateGas).toHaveBeenCalled()
  })

  it('keeps the reviewed chain in the wallet request after ethers caches the previous network', async () => {
    let walletChain = '0x1'
    const walletCalls: unknown[] = []
    const provider = new Web3Provider(
      {
        request: async ({ method, params }: { method: string; params?: unknown[] }) => {
          if (method === 'eth_chainId') return walletChain
          if (method === 'eth_blockNumber') return '0x100'
          if (method === 'eth_accounts') return ['0x1111111111111111111111111111111111111111']
          if (method === 'eth_sendTransaction') {
            const transaction = params?.[0] as { chainId?: string }
            walletCalls.push(transaction)
            if (transaction.chainId !== walletChain) throw new Error('Chain mismatch')
            throw new Error('Unexpected submission on the switched chain')
          }
          throw new Error(`Unexpected mock request: ${method}`)
        },
      },
      SupportedChainId.MAINNET,
    )
    jest.mocked(tradingSdk.getPreSignTransaction).mockResolvedValue({
      to: '0x2222222222222222222222222222222222222222',
      data: '0xdeadbeef',
      gasLimit: '0x10000',
      value: '0',
    })

    try {
      await provider.getBlockNumber()
      walletChain = '0xa'
      const signer = provider.getSigner()
      const transaction = await getPreSignTransactionForOrder(UID, SupportedChainId.MAINNET, signer)

      await expect(signer.sendTransaction(transaction)).rejects.toThrow('Chain mismatch')
      expect(walletCalls).toEqual([expect.objectContaining({ chainId: '0x1' })])
    } finally {
      provider.removeAllListeners()
    }
  })
})
