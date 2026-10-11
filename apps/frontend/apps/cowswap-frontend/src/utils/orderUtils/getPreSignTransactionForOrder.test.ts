import { SupportedChainId } from '@cowprotocol/cow-sdk'
import type { JsonRpcSigner } from '@ethersproject/providers'

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

describe('getPreSignTransactionForOrder', () => {
  beforeEach(() => jest.clearAllMocks())

  it('binds the snapshotted chain and signer, leaving env/settlement override to the SDK defaults', async () => {
    mockViemMigration = false
    await getPreSignTransactionForOrder(UID, SupportedChainId.GNOSIS_CHAIN, SIGNER)

    expect(tradingSdk.getPreSignTransaction).toHaveBeenCalledWith({
      orderUid: UID,
      chainId: SupportedChainId.GNOSIS_CHAIN,
      signer: SIGNER,
    })
  })

  it('still binds the chain but does not hand an ethers signer to the viem adapter', async () => {
    mockViemMigration = true
    await getPreSignTransactionForOrder(UID, SupportedChainId.GNOSIS_CHAIN, SIGNER)

    expect(tradingSdk.getPreSignTransaction).toHaveBeenCalledWith({
      orderUid: UID,
      chainId: SupportedChainId.GNOSIS_CHAIN,
    })
  })
})
