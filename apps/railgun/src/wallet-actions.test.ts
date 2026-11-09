import { EventEmitter } from 'node:events'
import { makeError } from 'ethers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { WalletSession } from './wallet'
import { SwapBalanceError } from './private-swap'
import { withdrawalData } from '../tests/withdrawal.fixture'
import { TOKENS, registerToken, tokenFor } from './config'

const mocks = vi.hoisted(() => ({
  environment: 'fork',
  connect: vi.fn(), signer: vi.fn(), allowance: vi.fn(), approve: vi.fn(), network: vi.fn(), balance: vi.fn(),
  shield: vi.fn(),
  sync: vi.fn(),
  requireSync: vi.fn(),
  pendingWithdrawal: vi.fn(), pendingSwap: vi.fn(),
  preserved: vi.fn(), preserve: vi.fn(), pilot: undefined as string | undefined,
  selectBroadcaster: vi.fn(), prepareSwap: vi.fn(), prepareMax: vi.fn(), prepareWithdrawal: vi.fn(), quoteSwap: vi.fn(), unused: vi.fn(),
  credit: vi.fn(), creditBalance: vi.fn(), pendingCredit: vi.fn(), topUp: vi.fn(), claimCredit: vi.fn(), checkCredit: vi.fn(), retryCredit: vi.fn(),
  refundCredit: vi.fn(), retryTopUp: vi.fn(), refundFee: vi.fn(), requestRefund: vi.fn(), checkRefund: vi.fn(),
}))
vi.mock('./prepaid', () => ({ preparePrepaid: mocks.credit, preparePrepaidRefund: mocks.refundCredit, prepaidBalance: mocks.creditBalance,
  pendingPrepaid: mocks.pendingCredit, topUpPrepaid: mocks.topUp, claimPrepaidTopUp: mocks.claimCredit,
  retryPrepaidTopUp: mocks.retryTopUp,
  checkPrepaid: mocks.checkCredit, retryPrepaid: mocks.retryCredit, prepaidRefundFee: mocks.refundFee,
  requestPrepaidRefund: mocks.requestRefund, checkPrepaidRefund: mocks.checkRefund }))
vi.mock('./storage', () => ({ readPrivateState: vi.fn(), writePrivateState: vi.fn(), deletePrivateState: vi.fn() }))
vi.mock('./config', async (original) => ({
  ...await original<typeof import('./config')>(),
  get ENVIRONMENT() { return mocks.environment },
  get PILOT_WITHDRAWAL_RECIPIENT() { return mocks.pilot },
}))
vi.mock('./public-connection', () => ({ connectPublicWallet: mocks.connect }))
vi.mock('./shield', () => ({
  publicSigner: mocks.signer, shieldAllowance: mocks.allowance, approveShield: mocks.approve,
  assertPublicNetwork: mocks.network,
  requireShieldBalance: mocks.balance,
  shield: mocks.shield, PublicNetworkError: class extends Error {},
}))
vi.mock('./journal', () => ({ pendingSwap: mocks.pendingSwap, reconcilePendingSwap: vi.fn() }))
vi.mock('./withdrawal-journal', async (original) => ({ ...await original<typeof import('./withdrawal-journal')>(),
  pendingWithdrawal: mocks.pendingWithdrawal, preservedWithdrawal: mocks.preserved, preserveWethWithdrawal: mocks.preserve,
  reconcilePendingWithdrawal: vi.fn(), resumePendingWithdrawal: vi.fn() }))
vi.mock('./broadcaster', () => ({ selectBroadcaster: mocks.selectBroadcaster, startBroadcasters: vi.fn(), privateSubmitter: vi.fn() }))
vi.mock('./private-swap', async (original) => ({ ...await original<typeof import('./private-swap')>(), executePrivateSwap: vi.fn(), preparePrivateSwap: mocks.prepareSwap, prepareMaxPrivateSwap: mocks.prepareMax }))
vi.mock('./recipe', () => ({
  amountFromInput: vi.fn((value: string) => {
    if (!value.trim()) throw new Error('Enter a positive token amount.')
    return 1n
  }),
  quoteSwap: mocks.quoteSwap,
}))
vi.mock('./recovery', () => ({ recoverToken: vi.fn(), recoveryIndex: vi.fn(), scanRecovery: vi.fn() }))
vi.mock('./unshield', () => ({ executeUnshield: vi.fn(), prepareUnshield: mocks.prepareWithdrawal }))
vi.mock('./wallet', () => ({ requireWalletSync: mocks.requireSync, syncWallet: mocks.sync }))
vi.mock('./account', () => ({ unusedSwapAccount: mocks.unused }))
vi.mock('./cancel', () => ({ cancelPendingSwap: vi.fn() }))
vi.mock('./wallet-layout', () => ({ renderWalletLayout: vi.fn(), setSwapReview: vi.fn(), setPendingNotice: vi.fn(), showWalletView: vi.fn() }))

let elements: Record<string, { value: string, hidden: boolean, textContent: string, className: string, checked: boolean, onclick?: () => Promise<void>, oninput?: () => void, dispatchEvent: () => boolean, scrollIntoView: () => void, setAttribute: () => void }>
let provider: EventEmitter & { request: ReturnType<typeof vi.fn> }
beforeEach(() => {
  vi.clearAllMocks()
  mocks.environment = 'fork'
  elements = new Proxy({} as typeof elements, { get: (values, id: string) => values[id] ??= {
    value: ['token', 'shield-token'].includes(id) ? 'WETH' : '1', hidden: ['approve', 'shield', 'switch-network', 'review-shield'].includes(id),
    textContent: '', className: '', checked: false, dispatchEvent: () => { elements[id].oninput?.(); return true }, scrollIntoView: () => {}, setAttribute: () => {},
  } })
  vi.stubGlobal('document', {
    getElementById: (id: string) => elements[id],
    querySelectorAll: () => [], documentElement: { dataset: {} },
  })
  provider = Object.assign(new EventEmitter(), { request: vi.fn().mockResolvedValue(undefined) })
  mocks.connect.mockReset().mockResolvedValue(provider)
  mocks.signer.mockReset().mockResolvedValue({ getAddress: async () => '0x0000000000000000000000000000000000000001' })
  mocks.allowance.mockReset().mockResolvedValue(0n)
  mocks.approve.mockReset().mockResolvedValue(undefined)
  mocks.network.mockReset().mockResolvedValue(undefined)
  mocks.balance.mockReset().mockResolvedValue(undefined)
  mocks.shield.mockReset().mockResolvedValue({ hash: 'confirmed deposit' })
  mocks.sync.mockReset().mockResolvedValue(undefined)
  mocks.requireSync.mockReset()
  mocks.pendingWithdrawal.mockReset().mockResolvedValue(undefined)
  mocks.pendingSwap.mockReset().mockResolvedValue(undefined)
  mocks.preserved.mockReset().mockResolvedValue(undefined)
  mocks.preserve.mockReset()
  mocks.pilot = undefined
  mocks.selectBroadcaster.mockReset()
  mocks.prepareSwap.mockReset().mockImplementation(async (_session, quote) => ({ quote, fee: { amount: 1n } }))
  mocks.prepareMax.mockReset()
  mocks.prepareWithdrawal.mockReset().mockResolvedValue({ fee: { amount: 1n }, minimum: 900n, amounts: [{ amount: 999n }] })
  mocks.quoteSwap.mockReset().mockResolvedValue({ sell: 'WETH', buy: 'USDC', amount: 1000n, minimum: 1000n, shieldFee: 25n, ophisFee: 1n })
  mocks.unused.mockReset().mockResolvedValue({ address: '0x0000000000000000000000000000000000000001' })
  mocks.credit.mockReset().mockResolvedValue({ selected: { tokenAddress: TOKENS.WETH.address } })
  mocks.pendingCredit.mockReset().mockResolvedValue(undefined)
  mocks.creditBalance.mockReset().mockResolvedValue({ available: 1000n, reserved: 2n })
  mocks.topUp.mockReset().mockResolvedValue(`0x${'44'.repeat(32)}`)
  mocks.retryTopUp.mockReset().mockResolvedValue(`0x${'55'.repeat(32)}`)
  mocks.refundCredit.mockReset().mockResolvedValue({ scope: {}, selected: { tokenAddress: TOKENS.WETH.address }, maximumRefundGross: 1_000n })
  mocks.claimCredit.mockReset().mockResolvedValue({ available: 2000n, reserved: 0n })
  mocks.checkCredit.mockReset()
  mocks.retryCredit.mockReset()
  mocks.refundFee.mockReset().mockReturnValue(10n)
  mocks.requestRefund.mockReset().mockResolvedValue({ state: 'awaiting-owner-transfer', net: 90n })
  mocks.checkRefund.mockReset().mockResolvedValue({ state: 'awaiting-owner-transfer', net: 90n })
})
afterEach(() => vi.unstubAllGlobals())

it('shows the full contract address when reviewing an imported token with a familiar ticker', async () => {
  const custom = registerToken({ address: '0x0000000000000000000000000000000000001234', symbol: 'USDC', decimals: 8 })
  elements.token.value = custom
  mocks.selectBroadcaster.mockResolvedValue({ tokenAddress: 'verified fee token' })
  const { wireWalletActions } = await import('./wallet-actions')
  await wireWalletActions({} as WalletSession)
  await elements['withdraw-quote'].onclick?.()
  expect(elements['withdraw-details'].textContent).toContain(`Token contract: ${tokenFor(custom).address}`)
  mocks.quoteSwap.mockResolvedValue({ sell: custom, buy: 'USDC', amount: 1000n, minimum: 1000n, shieldFee: 25n, ophisFee: 1n })
  await elements.quote.onclick?.()
  expect(elements['quote-details'].textContent).toContain(`Sell token contract: ${tokenFor(custom).address}`)
})

it('preserves the WETH proof and prepares a USDC review without submitting either proof', async () => {
  mocks.pilot = '0x0000000000000000000000000000000000001234'
  const saved = { token: 'WETH', recipient: mocks.pilot,
    transaction: { data: withdrawalData(1, 1, mocks.pilot, TOKENS.WETH.address) } }
  mocks.pendingWithdrawal.mockResolvedValue(saved)
  mocks.preserve.mockImplementation(async () => {
    mocks.pendingWithdrawal.mockResolvedValue(undefined)
    mocks.preserved.mockResolvedValue(saved)
  })
  mocks.selectBroadcaster.mockResolvedValue({ tokenAddress: TOKENS.USDC.address })
  const { wireWalletActions } = await import('./wallet-actions')
  await wireWalletActions({} as WalletSession)
  expect(elements['retry-withdrawal'].hidden).toBe(true)
  expect(elements['use-usdc-withdrawal'].hidden).toBe(false)
  await elements['use-usdc-withdrawal'].onclick?.()
  expect(mocks.preserve).toHaveBeenCalledOnce()
  expect(elements.token.value).toBe('USDC')
  expect(elements.recipient.value).toBe(mocks.pilot)
  expect(mocks.prepareWithdrawal.mock.calls[0][1]).toBe('USDC')
  expect(mocks.prepareWithdrawal.mock.calls[0][5]).toBe(true)
  expect(elements['preserved-withdrawal-details'].textContent).toContain('WETH')
  expect(elements.withdraw.hidden).toBe(false)
  const { showWalletView } = await import('./wallet-layout')
  expect(showWalletView).toHaveBeenCalledWith('withdrawal')
  const { executeUnshield } = await import('./unshield')
  expect(executeUnshield).not.toHaveBeenCalled()
})

it('opens recovery and directs the user to the saved withdrawal instead of preparing another one', async () => {
  mocks.pendingWithdrawal.mockResolvedValue({ token: 'WETH', recipient: '0x0000000000000000000000000000000000001234',
    transaction: { data: withdrawalData(1, 1, '0x0000000000000000000000000000000000001234', TOKENS.USDC.address) } })
  const { wireWalletActions } = await import('./wallet-actions')
  await wireWalletActions({} as WalletSession)
  expect(elements['withdraw-shortcut'].textContent).toBe('Continue saved withdrawal')
  expect(elements['withdraw-max'].hidden).toBe(true)
  expect(elements['withdraw-quote'].hidden).toBe(true)
  expect(elements['retry-withdrawal'].hidden).toBe(false)
  expect(elements['withdraw-pending-help'].textContent).toContain('already saved')
  expect(elements['pending-details'].textContent).toContain('Saved withdrawal: 0.001 USDC')
  expect(mocks.prepareWithdrawal).not.toHaveBeenCalled()
})

it('explains bound public-resume compatibility while keeping all recovery choices available', async () => {
  const account = '0x0000000000000000000000000000000000001234'
  mocks.pendingWithdrawal.mockResolvedValue({ token: 'USDC', feeToken: 'WETH', recipient: account, minimum: '997',
    execution: { index: 7, account } })
  const { wireWalletActions } = await import('./wallet-actions')
  await wireWalletActions({} as WalletSession)
  expect(elements['pending-details'].textContent).toContain('requires support for externally signed EIP-7702 authorizations')
  expect(elements['pending-details'].textContent).toContain('some wallets reject')
  for (const action of ['resume-withdrawal', 'retry-withdrawal', 'cancel-swap']) expect(elements[action].hidden).toBe(false)
  expect(elements['cancel-swap'].textContent).toContain('Invalidate saved withdrawal authorization')
  expect(mocks.connect).not.toHaveBeenCalled()
  expect(mocks.signer).not.toHaveBeenCalled()
})

it('selects the new pending swap recovery index and then preserves a manual selection', async () => {
  const { wireWalletActions } = await import('./wallet-actions')
  const { executePrivateSwap } = await import('./private-swap')
  await wireWalletActions({} as WalletSession)
  await elements.quote.onclick?.()
  vi.mocked(executePrivateSwap).mockImplementationOnce(async () => {
    mocks.pendingSwap.mockResolvedValue({ index: 7, account: 'fixture-recovery-account' })
    throw new Error('Submission outcome unknown')
  })
  await elements.swap.onclick?.()
  expect(elements['recovery-index'].value).toBe('7')
  elements['recovery-index'].value = '8'
  await elements.broadcasters.onclick?.()
  expect(elements['recovery-index'].value).toBe('8')
})

it('clears the spent amount only after swap confirmation and finishes the balance-refresh status', async () => {
  const { wireWalletActions } = await import('./wallet-actions')
  const { executePrivateSwap } = await import('./private-swap')
  let confirm!: (hash: string) => void, finishSync!: () => void
  vi.mocked(executePrivateSwap).mockImplementationOnce(() => new Promise((resolve) => { confirm = resolve }))
  mocks.sync.mockImplementationOnce(() => new Promise<void>((resolve) => { finishSync = resolve }))
  await wireWalletActions({} as WalletSession)
  await elements.quote.onclick?.()
  const reviewedAmount = elements.amount.value
  const executing = elements.swap.onclick?.()
  await vi.waitFor(() => expect(executePrivateSwap).toHaveBeenCalledOnce())
  expect(elements.amount.value).toBe(reviewedAmount)
  expect(mocks.sync).not.toHaveBeenCalled()
  confirm('confirmed swap hash')
  await vi.waitFor(() => expect(mocks.sync).toHaveBeenCalledOnce())
  expect(elements.amount.value).toBe('')
  expect(elements.status.textContent).toBe('Swap confirmed: confirmed swap hash. Updating private balance.')
  finishSync()
  await executing
  expect(elements.status.textContent).toBe('Swap confirmed: confirmed swap hash. Private balance updated.')
  expect(elements.swap.hidden).toBe(true)
  expect(elements['quote-details'].textContent).toBe('')
  expect(elements['receive-amount'].textContent).toBe('—')
  await elements.quote.onclick?.()
  expect(mocks.quoteSwap).toHaveBeenCalledOnce()
  expect(elements['private-wallet-error'].textContent).toBe('Enter a positive token amount.')
})

it('keeps a confirmed swap distinct from a failed balance refresh and does not restore its spent amount', async () => {
  const { wireWalletActions } = await import('./wallet-actions')
  const { executePrivateSwap } = await import('./private-swap')
  vi.mocked(executePrivateSwap).mockResolvedValueOnce('confirmed swap hash')
  mocks.sync.mockRejectedValueOnce(new Error('History verification timed out.'))
  await wireWalletActions({} as WalletSession)
  await elements.quote.onclick?.()
  await elements.swap.onclick?.()
  expect(elements.amount.value).toBe('')
  expect(elements.status.textContent).toBe('Swap confirmed: confirmed swap hash. Private balance refresh is incomplete. Refresh balances to retry.')
  expect(elements['private-wallet-error'].textContent).toBe('History verification timed out.')
  expect(elements.swap.hidden).toBe(true)
  expect(executePrivateSwap).toHaveBeenCalledOnce()
})

it('preserves the amount and recovery record when swap confirmation remains uncertain', async () => {
  const { wireWalletActions } = await import('./wallet-actions')
  const { executePrivateSwap } = await import('./private-swap')
  const { deletePrivateState } = await import('./storage')
  const saved = { index: 7, account: 'fixture-recovery-account', hash: 'pending swap hash' }
  vi.mocked(executePrivateSwap).mockImplementationOnce(async (_session, _prepared, report) => {
    mocks.pendingSwap.mockResolvedValue(saved)
    report('Waiting for two confirmations: pending swap hash')
    throw new Error('Confirmation pending. Check recovery before retrying.')
  })
  await wireWalletActions({} as WalletSession)
  await elements.quote.onclick?.()
  const reviewedAmount = elements.amount.value
  await elements.swap.onclick?.()
  expect(elements.amount.value).toBe(reviewedAmount)
  expect(elements.status.textContent).toBe('Waiting for two confirmations: pending swap hash')
  expect(elements['pending-details'].textContent).toContain(saved.hash)
  expect(elements.reconcile.hidden).toBe(false)
  expect(elements['recovery-index'].value).toBe('7')
  expect(mocks.sync).not.toHaveBeenCalled()
  expect(deletePrivateState).not.toHaveBeenCalled()
  expect(await mocks.pendingSwap()).toBe(saved)
})

it('keeps USDC withdrawal controls accessible when preparation fails after preserving the WETH proof', async () => {
  mocks.pilot = '0x0000000000000000000000000000000000001234'
  const saved = { token: 'WETH', recipient: mocks.pilot,
    transaction: { data: withdrawalData(1, 1, mocks.pilot, TOKENS.WETH.address) } }
  mocks.pendingWithdrawal.mockResolvedValue(saved)
  mocks.preserve.mockImplementation(async () => {
    mocks.pendingWithdrawal.mockResolvedValue(undefined)
    mocks.preserved.mockResolvedValue(saved)
  })
  mocks.prepareWithdrawal.mockRejectedValueOnce(new Error('Broadcaster unavailable'))
  const { wireWalletActions } = await import('./wallet-actions')
  const { showWalletView } = await import('./wallet-layout')
  await wireWalletActions({} as WalletSession)
  await elements['use-usdc-withdrawal'].onclick?.()
  expect(showWalletView).toHaveBeenCalledWith('withdrawal')
  expect(elements.withdraw.hidden).toBe(true)
  expect(elements['private-wallet-error'].textContent).toBe('Broadcaster unavailable')
  expect(elements['preserved-withdrawal-details'].textContent).toContain('WETH')
})

it('the normal quote button reserves fees for the exact full-balance amount and discloses the adjustment', async () => {
  const full = 9_975_000_000_000_000n
  const quote = { sell: 'WETH', buy: 'USDC', amount: full, minimum: 1000n, shieldFee: 25n, ophisFee: 1n }
  mocks.quoteSwap.mockResolvedValue(quote)
  mocks.prepareSwap.mockRejectedValueOnce(new SwapBalanceError('Insufficient fee reserve', full, 506_499_204_690_337n))
  mocks.prepareMax.mockResolvedValue({ quote: { ...quote, amount: 9_425_000_000_000_000n }, fee: { amount: 550_000_000_000_000n } })
  const { wireWalletActions } = await import('./wallet-actions')
  const session = {} as WalletSession
  await wireWalletActions(session)
  elements.amount.value = '0.009975'
  await elements.quote.onclick?.()
  expect(mocks.prepareMax).toHaveBeenCalledWith(session, 'WETH', undefined, full, 'USDC')
  expect(elements.amount.value).toBe('0.009425')
  expect(elements['quote-details'].textContent).toMatch(/^Broadcaster fee reserved/)
  expect(elements['quote-details'].textContent).toContain('Broadcaster fee: 0.00055 WETH')
  expect(elements['receive-amount'].textContent).toBe('0.000998')
  expect(elements.quote.className).toBe('')
  expect(elements.quote.textContent).toBe('Review swap')
  expect(elements.swap.hidden).toBe(false)
  expect(elements['private-wallet-error'].textContent).toBe('')
  const { executePrivateSwap } = await import('./private-swap')
  expect(executePrivateSwap).not.toHaveBeenCalled()
})

it('does not automatically reduce a fixed trade below the full balance or retry unrelated quote failures', async () => {
  const { wireWalletActions } = await import('./wallet-actions')
  await wireWalletActions({} as WalletSession)
  elements.amount.value = '0.0008'
  mocks.prepareSwap.mockRejectedValueOnce(new SwapBalanceError('Requested amount plus fee is too high', 2000n, 1500n))
  await elements.quote.onclick?.()
  expect(mocks.prepareMax).not.toHaveBeenCalled()
  expect(elements.amount.value).toBe('0.0008')
  expect(elements.swap.hidden).toBe(true)
  mocks.prepareSwap.mockRejectedValueOnce(new Error('Gas estimation unavailable'))
  await elements.quote.onclick?.()
  expect(mocks.prepareMax).not.toHaveBeenCalled()
  expect(elements['private-wallet-error'].textContent).toBe('Gas estimation unavailable')
})

it('opens review for a prepared quote and does not reopen it after an unrelated wallet action', async () => {
  const { setSwapReview } = await import('./wallet-layout')
  const { wireWalletActions } = await import('./wallet-actions')
  await wireWalletActions({} as WalletSession)
  await elements.quote.onclick?.()
  expect(setSwapReview).toHaveBeenLastCalledWith(true)
  vi.mocked(setSwapReview).mockClear()
  await elements.walletconnect.onclick?.()
  expect(setSwapReview).not.toHaveBeenCalledWith(true)
})

it('clears the swap quote when preparing a maximum withdrawal changes the shared amount', async () => {
  const { wireWalletActions } = await import('./wallet-actions')
  await wireWalletActions({} as WalletSession)
  await elements.quote.onclick?.()
  expect(elements['receive-amount'].textContent).not.toBe('—')
  await elements['withdraw-max'].onclick?.()
  expect(elements['receive-amount'].textContent).toBe('—')
  expect(elements['quote-details'].textContent).toBe('')
  expect(elements.swap.hidden).toBe(true)
  expect(elements.withdraw.hidden).toBe(false)
})

it('shows the Max amount and its committed fee for review without executing a swap', async () => {
  const quote = { sell: 'WETH', buy: 'USDC', amount: 200_000_000_000_000n, minimum: 500000n, shieldFee: 25n, ophisFee: 50n }
  mocks.prepareMax.mockResolvedValue({ quote, fee: { amount: 340_000_000_000_000n } })
  const { wireWalletActions } = await import('./wallet-actions')
  const session = {} as WalletSession
  await wireWalletActions(session)
  await elements['max-swap'].onclick?.()
  expect(mocks.prepareMax).toHaveBeenCalledWith(session, 'WETH', undefined, undefined, 'USDC')
  expect(elements.amount.value).toBe('0.0002')
  expect(elements['quote-details'].textContent).toContain('Max includes gas price headroom')
  expect(elements['quote-details'].textContent).toContain('Broadcaster fee: 0.00034 WETH')
  expect(elements.swap.hidden).toBe(false)
  const { executePrivateSwap } = await import('./private-swap')
  expect(executePrivateSwap).not.toHaveBeenCalled()
})

it('discloses a capped gas price while preserving the fixed trade amount for review', async () => {
  const quote = { sell: 'WETH', buy: 'USDC', amount: 500_000_000_000_000n, minimum: 1000n, shieldFee: 25n, ophisFee: 1n }
  mocks.quoteSwap.mockResolvedValue(quote)
  mocks.prepareSwap.mockResolvedValue({ quote, fee: { amount: 700_000_000_000_000n }, gas: { maxFeePerGas: 200_000_000n }, gasCapped: true })
  const { wireWalletActions } = await import('./wallet-actions')
  await wireWalletActions({} as WalletSession)
  elements.amount.value = '0.0005'
  await elements.quote.onclick?.()
  expect(elements.amount.value).toBe('0.0005')
  expect(elements['quote-details'].textContent).toContain('Gas price capped at 0.2 gwei')
  expect(elements['quote-details'].textContent).toContain('Rising gas prices can require a fresh quote')
  expect(elements.swap.hidden).toBe(false)
})

it('preserves the full-balance input and blocks submission when its fee-reserving quote fails', async () => {
  mocks.prepareSwap.mockRejectedValueOnce(new SwapBalanceError('Insufficient fee reserve', 1000n, 10n))
  mocks.prepareMax.mockRejectedValueOnce(new Error('No affordable quote'))
  const { wireWalletActions } = await import('./wallet-actions')
  await wireWalletActions({} as WalletSession)
  elements.amount.value = '0.009975'
  await elements.quote.onclick?.()
  expect(elements.amount.value).toBe('0.009975')
  expect(elements.swap.hidden).toBe(true)
  expect(elements['private-wallet-error'].textContent).toBe('No affordable quote')
})

it('shows only the meaningful wallet error beside the controls and in the global error', async () => {
  mocks.connect.mockRejectedValueOnce(makeError('could not coalesce error', 'UNKNOWN_ERROR', {
    error: { message: 'Wallet connection failed' }, payload: { data: 'transaction payload must not be shown' },
  }))
  const { wireWalletActions } = await import('./wallet-actions')
  await wireWalletActions({} as WalletSession)
  await elements.walletconnect.onclick?.()
  expect(elements['public-wallet-error'].textContent).toBe('Wallet connection failed')
  expect(elements.error.textContent).toBe('Wallet connection failed')
})

it('Max fills the fee-reserved amount and shows the quote without connecting a public signer', async () => {
  const quote = { sell: 'WETH', buy: 'USDC', amount: 9_345_000_000_000_000n, minimum: 1000n, shieldFee: 25n, ophisFee: 1n }
  mocks.prepareMax.mockResolvedValue({ quote, fee: { amount: 630_000_000_000_000n } })
  const { wireWalletActions } = await import('./wallet-actions')
  const session = {} as WalletSession
  await wireWalletActions(session)
  await elements['max-swap'].onclick?.()
  expect(elements.amount.value).toBe('0.009345')
  expect(elements['quote-details'].textContent).toContain('Broadcaster fee: 0.00063 WETH')
  expect(elements.swap.hidden).toBe(false)
  expect(mocks.prepareMax).toHaveBeenCalledWith(session, 'WETH', undefined, undefined, 'USDC')
  expect(mocks.signer).not.toHaveBeenCalled()
  expect(mocks.shield).not.toHaveBeenCalled()
})

it('a failed Max clears the old prepared swap and preserves the entered amount', async () => {
  mocks.prepareMax.mockRejectedValueOnce(new Error('Fee exceeds spendable balance'))
  const { wireWalletActions } = await import('./wallet-actions')
  await wireWalletActions({} as WalletSession)
  elements.amount.value = '0.009975'
  elements.swap.hidden = false
  await elements['max-swap'].onclick?.()
  expect(elements.swap.hidden).toBe(true)
  expect(elements.amount.value).toBe('0.009975')
  expect(elements['private-wallet-error'].textContent).toBe('Fee exceeds spendable balance')
})

it('clears the previous quote error when inputs change so old balance checks do not describe the new request', async () => {
  const { wireWalletActions } = await import('./wallet-actions')
  await wireWalletActions({} as WalletSession)
  elements['private-wallet-error'].textContent = 'Previous insufficient balance'
  elements.error.textContent = 'Previous insufficient balance'
  elements.amount.oninput?.()
  expect(elements['private-wallet-error'].textContent).toBe('')
  expect(elements.error.textContent).toBe('')
  expect(elements.swap.hidden).toBe(true)
  elements.error.textContent = 'Unrelated error'
  elements.amount.oninput?.()
  expect(elements.error.textContent).toBe('Unrelated error')
})

it('connects without an amount and requires a separate validated allowance check before showing approve or shield', async () => {
  elements['shield-amount'].value = ''
  const { wireWalletActions } = await import('./wallet-actions')
  await wireWalletActions({} as WalletSession)
  await elements.walletconnect.onclick?.()
  expect(mocks.connect).toHaveBeenCalledWith('walletconnect')
  expect(elements['public-wallet-status'].textContent).toMatch(/Public wallet connected/)
  expect(mocks.allowance).not.toHaveBeenCalled()
  expect(elements.approve.hidden).toBe(true)
  expect(elements.shield.hidden).toBe(true)
  expect(elements['review-shield'].hidden).toBe(false)
  await elements['review-shield'].onclick?.()
  expect(elements['public-wallet-error'].textContent).toMatch(/positive token amount/)
  expect(mocks.allowance).not.toHaveBeenCalled()
  elements['shield-amount'].value = '0.006'
  await elements['review-shield'].onclick?.()
  expect(mocks.network).toHaveBeenCalledTimes(1)
  expect(mocks.allowance).toHaveBeenCalledTimes(1)
  expect(elements['public-wallet-error'].textContent).toBe('')
  expect(elements.approve.hidden).toBe(false)
  expect(elements.shield.hidden).toBe(true)
})

it('shows a failed WalletConnect request beside its button', async () => {
  mocks.connect.mockRejectedValueOnce(new Error('Relay connection failed'))
  const { wireWalletActions } = await import('./wallet-actions')
  await wireWalletActions({} as WalletSession)
  await elements.walletconnect.onclick?.()
  expect(elements['public-wallet-error'].textContent).toBe('Relay connection failed')
  expect(elements.error.textContent).toBe('Relay connection failed')
})

it('explains insufficient public WETH beside the controls before exposing approval or shielding, including a failed recheck', async () => {
  const { wireWalletActions } = await import('./wallet-actions')
  await wireWalletActions({} as WalletSession)
  await elements.walletconnect.onclick?.()
  expect(elements.approve.hidden).toBe(false)
  mocks.balance.mockRejectedValueOnce(new Error('Public wallet balance: 0.0 WETH. Choose ETH as the deposit asset to use ETH directly.'))
  await elements['review-shield'].onclick?.()
  expect(elements['public-wallet-error'].textContent).toMatch(/Choose ETH as the deposit asset/)
  expect(elements.approve.hidden).toBe(true)
  expect(elements.shield.hidden).toBe(true)
  expect(elements['review-shield'].hidden).toBe(false)
  expect(mocks.allowance).toHaveBeenCalledTimes(1)
  expect(mocks.approve).not.toHaveBeenCalled()
})

it('deposits ETH with no token approval, independently of private swap inputs', async () => {
  elements['shield-token'].value = 'ETH'
  elements['shield-amount'].value = '0.001'
  elements.token.value = 'USDC'
  elements.amount.value = ''
  const { wireWalletActions } = await import('./wallet-actions')
  const session = {} as WalletSession
  await wireWalletActions(session)
  await elements.walletconnect.onclick?.()
  expect(elements['public-wallet-error'].textContent).toBe('')
  expect(mocks.balance).toHaveBeenCalledWith(expect.anything(), 'ETH', 1n)
  expect(mocks.allowance).not.toHaveBeenCalled()
  expect(elements.approve.hidden).toBe(true)
  expect(elements.shield.hidden).toBe(false)
  await elements.approve.onclick?.()
  expect(mocks.approve).not.toHaveBeenCalled()
  expect(elements['public-wallet-error'].textContent).toMatch(/Native deposits do not need token approval/)
  await elements.shield.onclick?.()
  expect(mocks.shield).toHaveBeenCalledWith(session, expect.anything(), 'ETH', 1n, expect.any(Function))
  expect(elements.status.textContent).toContain('Deposit confirmed')
  expect(elements.token.value).toBe('WETH')
  expect(elements.amount.value).toBe('')
  expect(elements['swap-direction'].textContent).toContain('Sell WETH → receive USDC')
})

it('clears an amount when the sell token changes so USDC units cannot become WETH units', async () => {
  const { wireWalletActions } = await import('./wallet-actions')
  await wireWalletActions({} as WalletSession)
  mocks.selectBroadcaster.mockResolvedValue({ tokenAddress: 'verified fee token' })
  await elements.quote.onclick?.()
  expect(elements.swap.hidden).toBe(false)
  elements.amount.value = '19'
  elements.token.value = 'USDC'
  elements.token.oninput?.()
  expect(elements.amount.value).toBe('')
  expect(elements.swap.hidden).toBe(true)
  expect(elements['quote-details'].textContent).toBe('')
  expect(elements['receive-amount'].textContent).toBe('—')
  expect(elements.quote.className).toBe('')
  expect(elements['swap-direction'].textContent).toBe('Sell USDC → receive WETH. Enter the amount of USDC to sell.')
})

it('keeps quote refresh accessible and clears the old minimum if refreshing fails', async () => {
  const { wireWalletActions } = await import('./wallet-actions')
  await wireWalletActions({} as WalletSession)
  await elements.quote.onclick?.()
  expect(elements.quote.hidden).toBe(false)
  expect(elements.quote.textContent).toBe('Review swap')
  expect(elements['receive-amount'].textContent).not.toBe('—')
  mocks.quoteSwap.mockRejectedValueOnce(new Error('No route available'))
  await elements.quote.onclick?.()
  expect(elements['receive-amount'].textContent).toBe('—')
  expect(elements.swap.hidden).toBe(true)
  expect(elements.quote.hidden).toBe(false)
  expect(elements.quote.textContent).toBe('Review swap')
  expect(elements.quote.className).toBe('')
})

it.each(['ETH', 'USDC', 'WETH'])('selects the funded private token and clears a stale trade amount after a confirmed %s deposit', async (asset) => {
  mocks.allowance.mockResolvedValue(1n)
  elements['shield-token'].value = asset
  elements.token.value = 'USDC'
  elements.amount.value = '19'
  const { wireWalletActions } = await import('./wallet-actions')
  await wireWalletActions({} as WalletSession)
  await elements.walletconnect.onclick?.()
  expect(elements.shield.hidden).toBe(false)
  await elements.shield.onclick?.()
  expect(elements.token.value).toBe(asset === 'ETH' ? 'WETH' : asset)
  expect(elements.amount.value).toBe('')
  expect(elements.swap.hidden).toBe(true)
})

it('keeps public transaction stages visible while balances sync and releases controls after a mined deposit', async () => {
  elements['shield-token'].value = 'ETH'
  mocks.shield.mockImplementationOnce(async (_session, _signer, _token, _amount, report) => {
    report('Deposit confirmed: receipt hash. Refresh balances after confirmation and synchronization. Ophis does not require PPOI verification.')
    return { hash: 'receipt hash' }
  })
  let failSync: ((error: Error) => void) | undefined
  mocks.sync.mockImplementationOnce(() => new Promise((_resolve, reject) => { failSync = reject }))
  const { wireWalletActions } = await import('./wallet-actions')
  await wireWalletActions({} as WalletSession)
  await elements.walletconnect.onclick?.()
  await elements.shield.onclick?.()
  expect(elements['public-transaction-status'].textContent).toContain('Deposit confirmed: receipt hash')
  expect(document.documentElement.dataset.busy).toBeUndefined()
  expect(elements.error.textContent).toBe('')
  failSync?.(new Error('Private history unavailable'))
  await Promise.resolve()
  expect(elements['private-wallet-error'].textContent).toBe('Private history unavailable')
  expect(elements['public-transaction-status'].textContent).toContain('Deposit confirmed')
})

it('preserves a submitted hash and blocks immediate resubmission when receipt confirmation fails', async () => {
  elements['shield-token'].value = 'ETH'
  mocks.shield.mockImplementationOnce(async (_session, _signer, _token, _amount, report) => {
    report('Deposit submitted: known hash. Waiting for Ethereum confirmation. Do not submit it again.')
    throw new Error('Receipt RPC unavailable')
  })
  const { wireWalletActions } = await import('./wallet-actions')
  await wireWalletActions({} as WalletSession)
  await elements.walletconnect.onclick?.()
  await elements.shield.onclick?.()
  expect(elements['public-transaction-status'].textContent).toContain('known hash')
  expect(elements['public-transaction-status'].textContent).toContain('Do not submit it again')
  expect(elements['public-wallet-error'].textContent).toBe('Receipt RPC unavailable')
  expect(elements.shield.hidden).toBe(true)
  expect(elements['review-shield'].hidden).toBe(false)
})

it('rejects a stale native ETH balance check when the wallet changes', async () => {
  elements['shield-token'].value = 'ETH'
  let finish: (() => void) | undefined
  mocks.balance.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
  const { wireWalletActions } = await import('./wallet-actions')
  await wireWalletActions({} as WalletSession)
  const connecting = elements.walletconnect.onclick?.()
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  provider.emit('accountsChanged', [])
  finish?.()
  await connecting
  expect(elements['public-wallet-error'].textContent).toMatch(/wallet changed/)
  expect(elements.approve.hidden).toBe(true)
  expect(elements.shield.hidden).toBe(true)
  expect(mocks.allowance).not.toHaveBeenCalled()
})

it('does not resurrect a signer when the wallet changes while account permission is pending', async () => {
  let finish: ((value: unknown) => void) | undefined
  mocks.signer.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
  const { wireWalletActions } = await import('./wallet-actions')
  await wireWalletActions({} as WalletSession)
  const connecting = elements.walletconnect.onclick?.()
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  provider.emit('accountsChanged', [])
  finish?.({ getAddress: async () => 'old-account' })
  await connecting
  expect(elements.error.textContent).toMatch(/wallet changed/)
  expect(elements.approve.hidden).toBe(true)
  expect(elements.shield.hidden).toBe(true)
  expect(mocks.allowance).not.toHaveBeenCalled()
})

it.each(['approval', 'allowance'])('does not re-enable shielding after a network change during %s confirmation', async (phase) => {
  const { wireWalletActions } = await import('./wallet-actions')
  await wireWalletActions({} as WalletSession)
  await elements.walletconnect.onclick?.()
  expect(elements.approve.hidden).toBe(false)
  let finish: ((value: unknown) => void) | undefined
  const pending = () => new Promise((resolve) => { finish = resolve })
  if (phase === 'approval') mocks.approve.mockImplementationOnce(pending)
  else mocks.allowance.mockImplementationOnce(pending)
  const approving = elements.approve.onclick?.()
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  provider.emit('chainChanged', '0xa')
  finish?.(1n)
  await approving
  expect(elements.error.textContent).toMatch(/wallet changed/)
  expect(elements.shield.hidden).toBe(true)
  expect(elements.approve.hidden).toBe(true)
  expect(elements.walletconnect.hidden).toBe(false)
})

it('switches the selected WalletConnect provider and keeps only one listener per event on reconnect', async () => {
  const { PublicNetworkError } = await import('./shield')
  mocks.signer.mockRejectedValueOnce(new PublicNetworkError())
  const { wireWalletActions } = await import('./wallet-actions')
  await wireWalletActions({} as WalletSession)
  await elements.walletconnect.onclick?.()
  expect(elements['switch-network'].hidden).toBe(false)
  await elements['switch-network'].onclick?.()
  expect(provider.request).toHaveBeenCalledWith({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] })
  await elements.walletconnect.onclick?.()
  for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) expect(provider.listenerCount(event)).toBe(1)
})

it.each(['quote', 'withdraw-quote'])('awaits broadcaster discovery before preparing %s, without requiring the separate Connect button', async (action) => {
  let finish: ((value: unknown) => void) | undefined
  mocks.selectBroadcaster.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
  const { wireWalletActions } = await import('./wallet-actions')
  await wireWalletActions({} as WalletSession)
  const preparing = elements[action].onclick?.()
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  expect(mocks.prepareSwap).not.toHaveBeenCalled()
  expect(mocks.prepareWithdrawal).not.toHaveBeenCalled()
  const selected = { tokenAddress: 'verified fee token' }
  finish?.(selected)
  await preparing
  expect(mocks.selectBroadcaster).toHaveBeenCalledWith(expect.any(String), action === 'quote', expect.any(Function))
  const args = (action === 'quote' ? mocks.prepareSwap : mocks.prepareWithdrawal).mock.calls[0]
  expect(action === 'quote' ? args.at(-1) : args[4]).toBe(selected)
  expect(elements.error.textContent).toBe('')
})

it('prepares Max withdrawal after fee without connecting or charging a public wallet', async () => {
  const selected = { tokenAddress: 'verified fee token' }
  mocks.selectBroadcaster.mockResolvedValue(selected)
  elements.token.value = 'USDC'
  elements.amount.value = ''
  const { wireWalletActions } = await import('./wallet-actions')
  await wireWalletActions({} as WalletSession)
  await elements['withdraw-max'].onclick?.()
  expect(mocks.prepareWithdrawal).toHaveBeenCalledWith(expect.anything(), 'USDC', '', elements.recipient.value, selected, true, false)
  expect(elements.amount.value).toBe('0.000999')
  expect(elements['withdraw-details'].textContent).toContain('You receive: 0.0009 USDC')
  expect(elements.withdraw.hidden).toBe(false)
  expect(mocks.connect).not.toHaveBeenCalled()
  expect(mocks.signer).not.toHaveBeenCalled()
})

it('removes an earlier prepared withdrawal and shows discovery failures beside the private controls', async () => {
  mocks.selectBroadcaster.mockResolvedValueOnce({ tokenAddress: 'verified fee token' })
  const { wireWalletActions } = await import('./wallet-actions')
  await wireWalletActions({} as WalletSession)
  await elements['withdraw-quote'].onclick?.()
  expect(elements.withdraw.hidden).toBe(false)
  mocks.selectBroadcaster.mockRejectedValueOnce(new Error('No verified compatible broadcaster fee arrived.'))
  await elements['withdraw-quote'].onclick?.()
  expect(elements.withdraw.hidden).toBe(true)
  expect(elements['withdraw-details'].textContent).toBe('')
  expect(elements['private-wallet-error'].textContent).toContain('No verified compatible broadcaster fee')
  expect(mocks.prepareWithdrawal).toHaveBeenCalledTimes(1)
})

it('blocks a mainnet deposit before approval when no compatible private-swap broadcaster is available', async () => {
  mocks.environment = 'ethereum'
  mocks.credit.mockRejectedValue(new Error('No compatible broadcaster is available.'))
  const { wireWalletActions } = await import('./wallet-actions')
  await wireWalletActions({} as WalletSession)
  await elements.connect.onclick?.()
  expect(elements.approve.hidden).toBe(true)
  expect(elements.shield.hidden).toBe(true)
  expect(elements['public-wallet-error'].textContent).toContain('No compatible broadcaster')
  expect(mocks.approve).not.toHaveBeenCalled()
  expect(mocks.shield).not.toHaveBeenCalled()
})

it('rechecks a mainnet broadcaster immediately before shielding without sending after discovery fails', async () => {
  mocks.environment = 'ethereum'
  mocks.allowance.mockResolvedValue(1n)
  const { wireWalletActions } = await import('./wallet-actions')
  await wireWalletActions({} as WalletSession)
  await elements.connect.onclick?.()
  expect(elements.shield.hidden).toBe(false)
  mocks.credit.mockRejectedValueOnce(new Error('Broadcaster disconnected.'))
  await elements.shield.onclick?.()
  expect(mocks.shield).not.toHaveBeenCalled()
  expect(elements['public-wallet-error'].textContent).toContain('Broadcaster disconnected')
})

it('blocks a deposit while history is incomplete, including after an earlier successful review', async () => {
  mocks.environment = 'ethereum'
  mocks.allowance.mockResolvedValue(1n)
  const { wireWalletActions } = await import('./wallet-actions')
  await wireWalletActions({} as WalletSession)
  mocks.requireSync.mockImplementation(() => { throw new Error('Private history is not synchronized.') })
  await elements.connect.onclick?.()
  expect(mocks.credit).not.toHaveBeenCalled()
  expect(elements.approve.hidden).toBe(true)
  expect(elements.shield.hidden).toBe(true)
  mocks.requireSync.mockReset()
  await elements['review-shield'].onclick?.()
  expect(elements.shield.hidden).toBe(false)
  mocks.requireSync.mockImplementation(() => { throw new Error('Private history is not synchronized.') })
  await elements.shield.onclick?.()
  expect(mocks.shield).not.toHaveBeenCalled()
  expect(elements['public-wallet-error'].textContent).toContain('not synchronized')
})

it.each(['quote', 'max-swap'])('blocks %s before preparing a proof without an approved prepaid quote', async (action) => {
  mocks.environment = 'ethereum'
  mocks.credit.mockRejectedValueOnce(new Error('Prepaid execution is not approved.'))
  const { wireWalletActions } = await import('./wallet-actions')
  await wireWalletActions({} as WalletSession)
  await elements[action].onclick?.()
  expect(mocks.prepareSwap).not.toHaveBeenCalled()
  expect(mocks.prepareMax).not.toHaveBeenCalled()
  expect(elements.swap.hidden).toBe(true)
  expect(elements['private-wallet-error'].textContent).toContain('not approved')
  expect(mocks.selectBroadcaster).not.toHaveBeenCalled()
})

it.each(['quote', 'max-swap', 'withdraw-quote'])('passes the explicit prepared credit to mainnet %s without legacy discovery', async (action) => {
  mocks.environment = 'ethereum'
  const credit = { selected: { tokenAddress: TOKENS.WETH.address }, feesID: 'reviewed-credit' }
  mocks.credit.mockResolvedValue(credit)
  mocks.prepareMax.mockResolvedValue({ quote: { sell: 'WETH', buy: 'USDC', amount: 1000n, minimum: 1000n, shieldFee: 25n, ophisFee: 1n }, fee: { amount: 1n }, prepaid: credit })
  const { wireWalletActions } = await import('./wallet-actions')
  await wireWalletActions({} as WalletSession)
  await elements[action].onclick?.()
  const prepare = action === 'quote' ? mocks.prepareSwap : action === 'max-swap' ? mocks.prepareMax : mocks.prepareWithdrawal
  expect(prepare.mock.calls[0].at(-1)).toBe(credit)
  expect(mocks.selectBroadcaster).not.toHaveBeenCalled()
  expect(mocks.connect).not.toHaveBeenCalled()
  expect(mocks.topUp).not.toHaveBeenCalled()
  expect(elements.error.textContent).toBe('')
})

it('requires separate top-up gas/privacy consent before requesting wallet access or transferring funds', async () => {
  mocks.environment = 'ethereum'
  const { wireWalletActions } = await import('./wallet-actions')
  await wireWalletActions({} as WalletSession)
  await elements['add-fee-credit'].onclick?.()
  expect(elements['private-wallet-error'].textContent).toContain('gas and privacy notice')
  expect(mocks.connect).not.toHaveBeenCalled()
  expect(mocks.signer).not.toHaveBeenCalled()
  expect(mocks.topUp).not.toHaveBeenCalled()
  expect(mocks.credit).not.toHaveBeenCalled()
})

it('keeps checking a saved top-up separate from its explicit consented retry', async () => {
  mocks.environment = 'ethereum'
  mocks.pendingCredit.mockResolvedValue({ topUpPending: true })
  mocks.claimCredit.mockRejectedValue(new Error('Top-up is not finalized.'))
  vi.stubGlobal('window', { ethereum: provider })
  const { wireWalletActions } = await import('./wallet-actions')
  const session = {} as WalletSession
  await wireWalletActions(session)
  expect(elements['add-fee-credit'].hidden).toBe(true)
  expect(elements['retry-fee-topup'].hidden).toBe(false)
  await elements['check-fee-topup'].onclick?.()
  expect(mocks.claimCredit).toHaveBeenCalledOnce()
  expect(mocks.retryTopUp).not.toHaveBeenCalled()
  await elements['retry-fee-topup'].onclick?.()
  expect(elements['private-wallet-error'].textContent).toContain('gas and privacy notice')
  expect(mocks.connect).not.toHaveBeenCalled()
  expect(mocks.retryTopUp).not.toHaveBeenCalled()
  elements['fee-credit-consent'].checked = true
  await elements['retry-fee-topup'].onclick?.()
  expect(mocks.retryTopUp).toHaveBeenCalledWith(session, expect.objectContaining({ getAddress: expect.any(Function) }), expect.any(Function))
  expect(mocks.topUp).not.toHaveBeenCalled()
  expect(mocks.credit).not.toHaveBeenCalled()
  expect(mocks.prepareSwap).not.toHaveBeenCalled()
  expect(elements['fee-credit-consent'].checked).toBe(false)
  expect(elements['fee-credit-status'].textContent).toContain('payment details were preserved')
})

it('does not resume a saved top-up when the public wallet changes during signer access', async () => {
  mocks.environment = 'ethereum'
  mocks.pendingCredit.mockResolvedValue({ topUpPending: true })
  vi.stubGlobal('window', { ethereum: provider })
  mocks.signer.mockImplementation(async () => {
    provider.emit('accountsChanged', [])
    return { getAddress: async () => '0x0000000000000000000000000000000000000001' }
  })
  const { wireWalletActions } = await import('./wallet-actions')
  await wireWalletActions({} as WalletSession)
  elements['fee-credit-consent'].checked = true
  await elements['retry-fee-topup'].onclick?.()
  expect(mocks.retryTopUp).not.toHaveBeenCalled()
  expect(elements['private-wallet-error'].textContent).toContain('Public wallet changed')
})

it('refreshes confirmed available/reserved credit without starting a transfer or retry', async () => {
  mocks.environment = 'ethereum'
  const { wireWalletActions } = await import('./wallet-actions')
  await wireWalletActions({} as WalletSession)
  await elements['refresh-fee-credit'].onclick?.()
  expect(elements['fee-credit-balance'].textContent).toContain('Available: 0.000000000000001 WETH')
  expect(elements['fee-credit-balance'].textContent).toContain('Reserved: 0.000000000000000002 WETH')
  expect(mocks.topUp).not.toHaveBeenCalled()
  expect(mocks.retryCredit).not.toHaveBeenCalled()
  expect(mocks.connect).not.toHaveBeenCalled()
})

it('reviews a private refund without reserving credit until the separate explicit request', async () => {
  mocks.environment = 'ethereum'
  mocks.credit.mockRejectedValue(new Error('The execution approval expired.'))
  const { amountFromInput } = await import('./recipe')
  vi.mocked(amountFromInput).mockReturnValueOnce(100n)
  const { wireWalletActions } = await import('./wallet-actions')
  await wireWalletActions({} as WalletSession)
  await elements['review-fee-refund'].onclick?.()
  expect(elements['fee-refund-review'].textContent).toContain('Net refund: 0.00000000000000009 WETH')
  expect(elements['fee-refund-review'].textContent).toContain('operator must process')
  expect(mocks.requestRefund).not.toHaveBeenCalled()
  expect(mocks.topUp).not.toHaveBeenCalled()
  expect(mocks.connect).not.toHaveBeenCalled()
  expect(mocks.refundCredit).toHaveBeenCalledOnce()
  expect(mocks.credit).not.toHaveBeenCalled()
  await elements['request-fee-refund'].onclick?.()
  expect(mocks.requestRefund).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ selected: expect.anything() }), 100n, undefined)
  expect(elements['fee-credit-status'].textContent).toContain('awaiting-owner-transfer')
})

it('reviews a native refund in ETH and binds the explicit public destination until confirmation', async () => {
  mocks.environment = 'ethereum'
  const recipient = '0x0000000000000000000000000000000000000123'
  mocks.refundCredit.mockResolvedValue({ scope: { funding: 'native' }, selected: { tokenAddress: TOKENS.WETH.address }, maximumRefundGross: 1000n })
  mocks.creditBalance.mockResolvedValue({ funding: 'native', available: 1000n, reserved: 2n })
  mocks.requestRefund.mockResolvedValue({ funding: 'native', state: 'submitted-or-unknown', net: 90n })
  const { amountFromInput } = await import('./recipe')
  vi.mocked(amountFromInput).mockReturnValueOnce(100n)
  const { wireWalletActions } = await import('./wallet-actions')
  await wireWalletActions({} as WalletSession)
  elements['fee-refund-recipient'].value = recipient
  await elements['review-fee-refund'].onclick?.()
  expect(elements['fee-refund-review'].textContent).toContain(`Destination: ${recipient}`)
  expect(elements['fee-refund-review'].textContent).toContain('Net refund: 0.00000000000000009 ETH')
  expect(elements['fee-refund-review'].textContent).toContain('This payment is public')
  expect(mocks.requestRefund).not.toHaveBeenCalled()
  await elements['request-fee-refund'].onclick?.()
  expect(mocks.requestRefund).toHaveBeenCalledWith(expect.anything(), expect.anything(), 100n, recipient)
  expect(elements['fee-credit-status'].textContent).toContain('submitted-or-unknown')
})

it('invalidates native refund consent when the public destination changes', async () => {
  mocks.environment = 'ethereum'
  mocks.refundCredit.mockResolvedValue({ scope: { funding: 'native' }, selected: {}, maximumRefundGross: 1000n })
  const { amountFromInput } = await import('./recipe')
  vi.mocked(amountFromInput).mockReturnValueOnce(100n)
  const { wireWalletActions } = await import('./wallet-actions')
  await wireWalletActions({} as WalletSession)
  elements['fee-refund-recipient'].value = '0x0000000000000000000000000000000000000123'
  await elements['review-fee-refund'].onclick?.()
  elements['fee-refund-recipient'].oninput?.()
  await elements['request-fee-refund'].onclick?.()
  expect(mocks.requestRefund).not.toHaveBeenCalled()
})


it('shows the payable refund limit before allowing an oversized request', async () => {
  mocks.environment = 'ethereum'
  mocks.refundCredit.mockResolvedValue({ scope: {}, selected: { tokenAddress: TOKENS.WETH.address }, maximumRefundGross: 50n })
  const { amountFromInput } = await import('./recipe')
  vi.mocked(amountFromInput).mockReturnValueOnce(100n)
  const { wireWalletActions } = await import('./wallet-actions')
  await wireWalletActions({} as WalletSession)
  await elements['review-fee-refund'].onclick?.()
  expect(elements['private-wallet-error'].textContent).toContain('Maximum refundable now: 0.00000000000000005 WETH')
  expect(elements['request-fee-refund'].hidden).toBe(true)
  expect(mocks.requestRefund).not.toHaveBeenCalled()
  expect(mocks.connect).not.toHaveBeenCalled()
})

it('invalidates a reviewed refund if its amount changes and never treats awaiting-owner status as paid', async () => {
  mocks.environment = 'ethereum'
  const { amountFromInput } = await import('./recipe')
  vi.mocked(amountFromInput).mockReturnValueOnce(100n)
  const { wireWalletActions } = await import('./wallet-actions')
  await wireWalletActions({} as WalletSession)
  await elements['review-fee-refund'].onclick?.()
  elements['fee-refund-amount'].oninput?.()
  await elements['request-fee-refund'].onclick?.()
  expect(mocks.requestRefund).not.toHaveBeenCalled()
  await elements['check-fee-refund'].onclick?.()
  expect(elements['fee-credit-status'].textContent).toContain('not confirmed yet')
  expect(mocks.sync).not.toHaveBeenCalled()
})

it('explains retired fee requests without clearing or cancelling the saved private swap', async () => {
  mocks.environment = 'ethereum'
  const saved = { account: '0x0000000000000000000000000000000000000001', index: 0, feeMode: 'prepaid' }
  mocks.pendingSwap.mockResolvedValue(saved)
  mocks.pendingCredit.mockResolvedValue({ key: 'saved fee key', completed: true, state: 'not-reserved' })
  mocks.checkCredit.mockResolvedValue({ state: 'not-reserved', charged: 0n, cancelled: false })
  const { wireWalletActions } = await import('./wallet-actions')
  await wireWalletActions({} as WalletSession)
  await elements['check-fee-attempt'].onclick?.()
  expect(elements['fee-credit-status'].textContent).toContain('No fee was charged for it')
  expect(elements['fee-credit-status'].textContent).toContain('signed private transaction remains saved')
  expect(elements['fee-credit-status'].textContent).not.toContain('cancelled')
  expect(elements['retry-fee-attempt'].hidden).toBe(true)
  expect(elements['reconcile'].hidden).toBe(false)
  expect(elements['cancel-swap'].hidden).toBe(false)
  expect(elements['review-fee-refund'].hidden).toBe(false)
  expect(mocks.retryCredit).not.toHaveBeenCalled()
  expect(mocks.connect).not.toHaveBeenCalled()
  const { deletePrivateState } = await import('./storage')
  const { cancelPendingSwap } = await import('./cancel')
  expect(deletePrivateState).not.toHaveBeenCalled()
  expect(cancelPendingSwap).not.toHaveBeenCalled()
})

it('reopens refund review after terminal retirement without calling it a completed payout', async () => {
  mocks.environment = 'ethereum'
  mocks.pendingCredit.mockResolvedValue({ refundPending: true })
  mocks.checkRefund.mockImplementation(async () => {
    mocks.pendingCredit.mockResolvedValue({ refundPending: false })
    return { state: 'not-reserved', net: 90n }
  })
  const { wireWalletActions } = await import('./wallet-actions')
  await wireWalletActions({} as WalletSession)
  expect(elements['review-fee-refund'].hidden).toBe(true)
  await elements['check-fee-refund'].onclick?.()
  expect(elements['fee-credit-status'].textContent).toContain('Review a new refund request')
  expect(elements['fee-credit-status'].textContent).not.toContain('refund verified')
  expect(elements['review-fee-refund'].hidden).toBe(false)
  expect(elements['check-fee-refund'].hidden).toBe(true)
  expect(mocks.sync).not.toHaveBeenCalled()
  expect(mocks.requestRefund).not.toHaveBeenCalled()
  expect(mocks.connect).not.toHaveBeenCalled()
})
