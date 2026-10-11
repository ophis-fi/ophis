import { USDC_MAINNET, USDT } from '@cowprotocol/common-const'
import { OrderKind, SupportedChainId, type UnsignedOrder } from '@cowprotocol/cow-sdk'
import { CurrencyAmount } from '@cowprotocol/currency'

import { tradingSdk } from 'tradingSdk/tradingSdk'

import { addPendingOrderStep } from 'modules/trade/utils/addPendingOrderStep'
import { TradeFlowAnalytics } from 'modules/trade/utils/tradeFlowAnalytics'

import { computeOrderUid } from 'utils/orderUtils/computeOrderUid'

import { safeBundleFlow } from './safeBundleFlow'
import { tradeFlow } from './tradeFlow'
import { SafeBundleFlowContext } from './types'

import { defaultLimitOrdersSettings } from '../state/limitOrdersSettingsAtom'

jest.mock('tradingSdk/tradingSdk', () => ({
  tradingSdk: { postLimitOrder: jest.fn(), getPreSignTransaction: jest.fn() },
}))
jest.mock('@cowprotocol/tokens', () => ({
  assertTradeTokenPolicy: jest.fn(),
  TokenPolicyProfile: { ESTABLISHED_SETTLEMENT: 'established' },
}))
jest.mock('utils/orderUtils/computeOrderUid', () => ({ computeOrderUid: jest.fn() }))
jest.mock('modules/permit', () => ({
  handlePermit: jest.fn(async ({ appData }: { appData: unknown }) => appData),
  callDataContainsPermitSigner: () => false,
}))
jest.mock('modules/appData', () => ({
  removePermitHookFromAppData: jest.fn(async (appData: unknown) => appData),
}))
jest.mock('modules/orders', () => ({ emitPostedOrderEvent: jest.fn() }))
jest.mock('modules/trade/utils/addPendingOrderStep', () => ({ addPendingOrderStep: jest.fn() }))
jest.mock('modules/zeroApproval', () => ({ shouldZeroApprove: jest.fn().mockResolvedValue(false) }))
jest.mock('modules/operations/bundle/buildApproveTx', () => ({
  buildApproveTx: jest.fn().mockResolvedValue({ to: '0xtoken', data: '0xapprove' }),
}))
jest.mock('modules/operations/bundle/buildZeroApproveTx', () => ({ buildZeroApproveTx: jest.fn() }))
jest.mock('legacy/state/orders/utils', () => ({ partialOrderUpdate: jest.fn() }))
jest.mock('legacy/utils/trade', () => ({
  mapUnsignedOrderToOrder: jest.fn(() => ({ id: 'order' })),
  wrapErrorInOperatorError: (fn: () => Promise<unknown>) => fn(),
}))
jest.mock('common/utils/getSwapErrorMessage', () => ({ getSwapErrorMessage: (error: Error) => error.message }))
jest.mock('../utils/calculateLimitOrdersDeadline', () => ({ calculateLimitOrdersDeadline: () => 2000000000 }))

const CHAIN_ID = SupportedChainId.MAINNET
const OTHER_CHAIN_ID = SupportedChainId.GNOSIS_CHAIN
const ACCOUNT = '0x1111111111111111111111111111111111111111'
const OTHER_OWNER = '0x2222222222222222222222222222222222222222'
const UNSIGNED_ORDER = { kind: OrderKind.SELL, validTo: 2000000000 } as UnsignedOrder

// Stand-in for the real hashing (covered in assertOrderUidMatches.test.ts): one uid per (chain/domain, owner).
const uidFor = (chainId: number, owner: string): string => `0x${chainId}${owner.slice(2)}`

const noPriceImpact = { loading: false, priceImpact: undefined }
const analytics = {
  trade: jest.fn(),
  sign: jest.fn(),
  error: jest.fn(),
  approveAndPresign: jest.fn(),
} as unknown as TradeFlowAnalytics

type Flow = (params: SafeBundleFlowContext) => Promise<string>

const flows: [string, Flow][] = [
  [
    'tradeFlow (presign)',
    (params) =>
      tradeFlow(
        params,
        noPriceImpact,
        defaultLimitOrdersSettings,
        analytics,
        async () => true,
        async () => undefined,
        () => undefined,
      ),
  ],
  [
    'safeBundleFlow',
    (params) => safeBundleFlow(params, noPriceImpact, defaultLimitOrdersSettings, async () => true, analytics),
  ],
]

function setup(returnedUid: string, onPost?: (params: SafeBundleFlowContext) => void): SafeBundleFlowContext {
  const inputAmount = CurrencyAmount.fromRawAmount(USDC_MAINNET, '10000000')
  const params = {
    chainId: CHAIN_ID,
    allowsOffchainSigning: false,
    rateImpact: 0,
    amountToApprove: inputAmount,
    dispatch: jest.fn(),
    verifyRecipientName: jest.fn().mockResolvedValue(undefined),
    signer: { sendTransaction: jest.fn().mockResolvedValue({ hash: '0xpresignhash' }) },
    spender: '0xrelayer',
    erc20Contract: {},
    sendBatchTransactions: jest.fn().mockResolvedValue('0xsafetx'),
    postOrderParams: {
      account: ACCOUNT,
      recipient: ACCOUNT,
      recipientAddressOrName: ACCOUNT,
      isSafeWallet: true,
      allowsOffchainSigning: false,
      appData: { doc: {}, fullAppData: '{}' },
      sellToken: USDC_MAINNET,
      buyToken: USDT,
      inputAmount,
      outputAmount: CurrencyAmount.fromRawAmount(USDT, '10000000'),
      kind: OrderKind.SELL,
      partiallyFillable: true,
    },
  } as unknown as SafeBundleFlowContext

  jest.mocked(tradingSdk.postLimitOrder).mockImplementation(async () => {
    onPost?.(params)
    return {
      orderId: returnedUid,
      signature: ACCOUNT,
      signingScheme: 'presign',
      orderToSign: UNSIGNED_ORDER,
    } as unknown as Awaited<ReturnType<typeof tradingSdk.postLimitOrder>>
  })

  return params
}

function walletActions(params: SafeBundleFlowContext): number {
  const { signer, sendBatchTransactions } = params as unknown as {
    signer: { sendTransaction: jest.Mock }
    sendBatchTransactions: jest.Mock
  }

  return signer.sendTransaction.mock.calls.length + sendBatchTransactions.mock.calls.length
}

describe('limit order presign flows bind the orderbook uid to the reviewed order', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.mocked(computeOrderUid).mockImplementation(async (chainId, owner) => uidFor(chainId, owner))
    jest.mocked(tradingSdk.getPreSignTransaction).mockResolvedValue({
      to: '0xsettlement',
      data: '0xpresign',
    } as Awaited<ReturnType<typeof tradingSdk.getPreSignTransaction>>)
  })

  it.each(flows)('%s: presigns when the uid matches the reviewed order, owner and chain', async (_, flow) => {
    const uid = uidFor(CHAIN_ID, ACCOUNT)
    const params = setup(uid)

    await expect(flow(params)).resolves.toBe(uid)

    expect(computeOrderUid).toHaveBeenCalledWith(CHAIN_ID, ACCOUNT, UNSIGNED_ORDER)
    expect(tradingSdk.getPreSignTransaction).toHaveBeenCalledWith({
      orderUid: uid,
      chainId: CHAIN_ID,
      signer: params.signer,
    })
    expect(addPendingOrderStep).toHaveBeenCalledWith(expect.objectContaining({ id: uid }), expect.anything())
    expect(walletActions(params)).toBe(1)
  })

  it.each(flows)(
    '%s: builds the presign tx on the snapshotted chain and signer if context changes mid-post',
    async (_, flow) => {
      const uid = uidFor(CHAIN_ID, ACCOUNT)
      const otherSigner = { sendTransaction: jest.fn() }
      // The wallet switches network/signer while the orderbook still returns the legitimate original uid.
      const params = setup(uid, (p) => {
        p.chainId = OTHER_CHAIN_ID
        p.signer = otherSigner as unknown as SafeBundleFlowContext['signer']
      })
      const originalSigner = params.signer

      await expect(flow(params)).resolves.toBe(uid)

      expect(tradingSdk.getPreSignTransaction).toHaveBeenCalledTimes(1)
      expect(tradingSdk.getPreSignTransaction).toHaveBeenCalledWith({
        orderUid: uid,
        chainId: CHAIN_ID,
        signer: originalSigner,
      })
      expect(otherSigner.sendTransaction).not.toHaveBeenCalled()
    },
  )

  it.each(flows)('%s: rejects a uid bound to another owner before any wallet action', async (_, flow) => {
    const params = setup(uidFor(CHAIN_ID, OTHER_OWNER))

    await expect(flow(params)).rejects.toThrow(/refusing to presign/)

    expect(tradingSdk.getPreSignTransaction).not.toHaveBeenCalled()
    expect(addPendingOrderStep).not.toHaveBeenCalled()
    expect(walletActions(params)).toBe(0)
  })

  it.each(flows)(
    '%s: rejects a uid for another chain/domain, using the chain snapshotted before posting',
    async (_, flow) => {
      // The wallet switches network while the order is being posted.
      const params = setup(uidFor(OTHER_CHAIN_ID, ACCOUNT), (p) => {
        p.chainId = OTHER_CHAIN_ID
      })

      await expect(flow(params)).rejects.toThrow(/refusing to presign/)

      expect(computeOrderUid).toHaveBeenCalledWith(CHAIN_ID, ACCOUNT, UNSIGNED_ORDER)
      expect(tradingSdk.getPreSignTransaction).not.toHaveBeenCalled()
      expect(addPendingOrderStep).not.toHaveBeenCalled()
      expect(walletActions(params)).toBe(0)
    },
  )
})
