import { USDC_MAINNET } from '@cowprotocol/common-const'

import { submitOtcTransaction } from './prepareOtcTransaction'
import {
  MAKER,
  mockOtcAuthorization,
  mockOtcManifest,
  mockOtcOrder,
  mockOtcWriteClient,
} from './prepareOtcTransactionTest.utils'

import type { OtcCreateDraft, OtcWalletSubmitter, OtcWriteIntent } from './otcWrite.types'

jest.mock('@cowprotocol/common-utils', () => ({ ...jest.requireActual('@cowprotocol/common-utils'), isLocal: false }))
const originalFetch = global.fetch

beforeEach(() => {
  process.env.REACT_APP_OTC_WRITE_MODE = 'public'
  global.fetch = jest.fn(
    async (url) =>
      ({
        ok: true,
        json: async () => ({
          enabled: true,
          mode: 'public',
          nonce: new URL(String(url), 'https://swap.ophis.fi').searchParams.get('nonce'),
        }),
      }) as Response,
  )
})
afterEach(() => {
  delete process.env.REACT_APP_OTC_WRITE_MODE
  global.fetch = originalFetch
})

it.each(['unknown escrow token', 'unknown payment token', 'zero amount', 'same token', 'wrong owner'])(
  'public access preserves the shared transaction boundary: %s',
  async (failure) => {
    const order = mockOtcOrder()
    const invalid = '0x1111111111111111111111111111111111111111'
    const draft: OtcCreateDraft = {
      ...order,
      tokenA:
        failure === 'unknown escrow token' ? invalid : failure === 'same token' ? USDC_MAINNET.address : order.tokenA,
      tokenB: failure === 'unknown payment token' ? invalid : order.tokenB,
      amountA: failure === 'zero amount' ? 0n : order.amountA,
    }
    const intent: OtcWriteIntent =
      failure === 'wrong owner'
        ? { kind: 'cancel' as const, account: invalid, order }
        : { kind: 'create' as const, account: MAKER, draft }
    const wallet: OtcWalletSubmitter = { sendTransaction: jest.fn(), waitForTransactionReceipt: jest.fn() }
    await expect(
      submitOtcTransaction(
        mockOtcWriteClient({ allowance: order.amountA }),
        wallet,
        intent,
        mockOtcAuthorization({ isLocal: false, writeMode: 'public' }),
        mockOtcManifest(),
      ),
    ).rejects.toThrow()
    expect(wallet.sendTransaction).not.toHaveBeenCalled()
  },
)
