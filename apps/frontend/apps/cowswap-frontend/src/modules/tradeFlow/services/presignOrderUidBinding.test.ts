import { USDC_MAINNET, USDT } from '@cowprotocol/common-const'
import { OrderKind, SupportedChainId, type UnsignedOrder } from '@cowprotocol/cow-sdk'
import { CurrencyAmount } from '@cowprotocol/currency'

import { tradingSdk } from 'tradingSdk/tradingSdk'

import { addPendingOrderStep } from 'modules/trade/utils/addPendingOrderStep'
import { TradeFlowAnalytics } from 'modules/trade/utils/tradeFlowAnalytics'

import { computeOrderUid } from 'utils/orderUtils/computeOrderUid'

import { safeBundleApprovalFlow } from './safeBundleFlow/safeBundleApprovalFlow'
import { safeBundleEthFlow } from './safeBundleFlow/safeBundleEthFlow'
import { swapFlow } from './swapFlow'

import { SafeBundleFlowContext, TradeFlowContext } from '../types/TradeFlowContext'

jest.mock('tradingSdk/tradingSdk', () => ({ tradingSdk: { getPreSignTransaction: jest.fn() } }))
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
jest.mock('modules/operations/bundle/buildWrapTx', () => ({
  buildWrapTx: jest.fn().mockResolvedValue({ to: '0xweth', data: '0xwrap', value: 1n }),
}))
jest.mock('legacy/state/orders/utils', () => ({ partialOrderUpdate: jest.fn() }))
jest.mock('legacy/utils/trade', () => ({
  mapUnsignedOrderToOrder: jest.fn(() => ({ id: 'order' })),
  wrapErrorInOperatorError: (fn: () => Promise<unknown>) => fn(),
}))
jest.mock('common/utils/getSwapErrorMessage', () => ({ getSwapErrorMessage: (error: Error) => error.message }))

const CHAIN_ID = SupportedChainId.MAINNET
const OTHER_CHAIN_ID = SupportedChainId.GNOSIS_CHAIN
const ACCOUNT = '0x1111111111111111111111111111111111111111'
const OTHER_OWNER = '0x2222222222222222222222222222222222222222'
const UNSIGNED_ORDER = { kind: OrderKind.SELL, validTo: 2000000000 } as UnsignedOrder

// Stand-in for the real hashing (covered in assertOrderUidMatches.test.ts): one uid per (chain/domain, owner).
const uidFor = (chainId: number, owner: string): string => `0x${chainId}${owner.slice(2)}`

type Flow = (ctx: TradeFlowContext, bundle: SafeBundleFlowContext) => Promise<void | boolean>

const noPriceImpact = { loading: false, priceImpact: undefined }
const flows: [string, Flow][] = [
  ['swapFlow (presign)', (ctx) => swapFlow(ctx, noPriceImpact, async () => true, analytics())],
  ['safeBundleApprovalFlow', (ctx, b) => safeBundleApprovalFlow(ctx, b, noPriceImpact, async () => true, analytics())],
  ['safeBundleEthFlow', (ctx, b) => safeBundleEthFlow(ctx, b, noPriceImpact, async () => true, analytics())],
]

function analytics(): TradeFlowAnalytics {
  return {
    trade: jest.fn(),
    sign: jest.fn(),
    error: jest.fn(),
    approveAndPresign: jest.fn(),
    wrapApproveAndPresign: jest.fn(),
  } as unknown as TradeFlowAnalytics
}

function setup(
  returnedUid: string,
  onPost?: (ctx: TradeFlowContext) => void,
): {
  ctx: TradeFlowContext
  bundle: SafeBundleFlowContext
  sendTransaction: jest.Mock
} {
  const inputAmount = CurrencyAmount.fromRawAmount(USDC_MAINNET, '10000000')
  const outputAmount = CurrencyAmount.fromRawAmount(USDT, '10000000')
  const sendTransaction = jest.fn().mockResolvedValue({ hash: '0xpresignhash' })
  const ctx = {
    context: { chainId: CHAIN_ID, inputAmount, outputAmount },
    flags: { allowsOffchainSigning: false },
    tradeQuoteState: {},
    bridgeQuoteAmounts: null,
    swapFlowAnalyticsContext: {},
    tradeConfirmActions: {
      requestPermitSignature: jest.fn(),
      onSign: jest.fn(),
      onSuccess: jest.fn(),
      onError: jest.fn(),
    },
    callbacks: {
      closeModals: jest.fn(),
      getCachedPermit: jest.fn().mockResolvedValue(undefined),
      dispatch: jest.fn(),
      addBridgeOrder: jest.fn(),
      setSigningStep: jest.fn(),
      verifyRecipientName: jest.fn().mockResolvedValue(undefined),
    },
    orderParams: {
      account: ACCOUNT,
      recipient: ACCOUNT,
      recipientAddressOrName: ACCOUNT,
      isSafeWallet: true,
      allowsOffchainSigning: false,
      appData: { doc: {}, fullAppData: '{}' },
      inputAmount,
      outputAmount,
      kind: OrderKind.SELL,
      validTo: 2000000000,
      signer: { sendTransaction },
    },
    tradeQuote: {
      postSwapOrderFromQuote: jest.fn(async () => {
        onPost?.(ctx)
        return { orderId: returnedUid, signature: ACCOUNT, signingScheme: 'presign', orderToSign: UNSIGNED_ORDER }
      }),
    },
  } as unknown as TradeFlowContext
  const bundle = {
    spender: '0xrelayer',
    sendBatchTransactions: jest.fn().mockResolvedValue('0xsafetx'),
    erc20Contract: {},
    wrappedNativeContract: {},
    needsApproval: true,
    amountToApprove: inputAmount,
  } as unknown as SafeBundleFlowContext

  return { ctx, bundle, sendTransaction }
}

function expectNoWalletAction(bundle: SafeBundleFlowContext, sendTransaction: jest.Mock): void {
  expect(tradingSdk.getPreSignTransaction).not.toHaveBeenCalled()
  expect(sendTransaction).not.toHaveBeenCalled()
  expect(bundle.sendBatchTransactions).not.toHaveBeenCalled()
  expect(addPendingOrderStep).not.toHaveBeenCalled()
}

describe('presign flows bind the orderbook uid to the reviewed order', () => {
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
    const { ctx, bundle, sendTransaction } = setup(uid)

    await expect(flow(ctx, bundle)).resolves.toBe(true)

    expect(computeOrderUid).toHaveBeenCalledWith(CHAIN_ID, ACCOUNT, UNSIGNED_ORDER)
    expect(tradingSdk.getPreSignTransaction).toHaveBeenCalledWith({
      orderUid: uid,
      chainId: CHAIN_ID,
      signer: ctx.orderParams.signer,
    })
    expect(addPendingOrderStep).toHaveBeenCalledWith(expect.objectContaining({ id: uid }), expect.anything())
    expect(sendTransaction.mock.calls.length + jest.mocked(bundle.sendBatchTransactions).mock.calls.length).toBe(1)
    expect(ctx.tradeConfirmActions.onSuccess).toHaveBeenCalledWith(uid)
  })

  it.each(flows)(
    '%s: builds the presign tx on the snapshotted chain and signer if context changes mid-post',
    async (_, flow) => {
      const uid = uidFor(CHAIN_ID, ACCOUNT)
      const otherSigner = { sendTransaction: jest.fn() }
      // The wallet switches network/signer while the orderbook still returns the legitimate original uid.
      const { ctx, bundle, sendTransaction } = setup(uid, (c) => {
        c.context.chainId = OTHER_CHAIN_ID
        c.orderParams.signer = otherSigner as unknown as TradeFlowContext['orderParams']['signer']
      })
      const originalSigner = ctx.orderParams.signer

      await expect(flow(ctx, bundle)).resolves.toBe(true)

      expect(tradingSdk.getPreSignTransaction).toHaveBeenCalledTimes(1)
      expect(tradingSdk.getPreSignTransaction).toHaveBeenCalledWith({
        orderUid: uid,
        chainId: CHAIN_ID,
        signer: originalSigner,
      })
      expect(otherSigner.sendTransaction).not.toHaveBeenCalled()
      expect(sendTransaction.mock.calls.length + jest.mocked(bundle.sendBatchTransactions).mock.calls.length).toBe(1)
    },
  )

  it.each(flows)('%s: rejects a uid bound to another owner before any wallet action', async (_, flow) => {
    const { ctx, bundle, sendTransaction } = setup(uidFor(CHAIN_ID, OTHER_OWNER))

    await flow(ctx, bundle)

    expectNoWalletAction(bundle, sendTransaction)
    expect(ctx.tradeConfirmActions.onError).toHaveBeenCalledWith(expect.stringMatching(/refusing to presign/))
  })

  it.each(flows)(
    '%s: rejects a uid for another chain/domain, using the chain snapshotted before posting',
    async (_, flow) => {
      // The wallet switches network while the order is being posted.
      const { ctx, bundle, sendTransaction } = setup(uidFor(OTHER_CHAIN_ID, ACCOUNT), (c) => {
        c.context.chainId = OTHER_CHAIN_ID
      })

      await flow(ctx, bundle)

      expect(computeOrderUid).toHaveBeenCalledWith(CHAIN_ID, ACCOUNT, UNSIGNED_ORDER)
      expectNoWalletAction(bundle, sendTransaction)
      expect(ctx.tradeConfirmActions.onError).toHaveBeenCalledWith(expect.stringMatching(/refusing to presign/))
    },
  )
})
