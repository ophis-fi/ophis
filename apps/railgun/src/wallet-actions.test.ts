import { EventEmitter } from 'node:events'
import { makeError } from 'ethers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { WalletSession } from './wallet'
import { SwapBalanceError } from './private-swap'

const mocks = vi.hoisted(() => ({
  environment: 'fork',
  connect: vi.fn(), signer: vi.fn(), allowance: vi.fn(), approve: vi.fn(), network: vi.fn(), balance: vi.fn(),
  shield: vi.fn(),
  sync: vi.fn(),
  selectBroadcaster: vi.fn(), prepareSwap: vi.fn(), prepareMax: vi.fn(), prepareWithdrawal: vi.fn(), quoteSwap: vi.fn(), unused: vi.fn(),
}))
vi.mock('./config', async (original) => ({
  ...await original<typeof import('./config')>(),
  get ENVIRONMENT() { return mocks.environment },
}))
vi.mock('./public-connection', () => ({ connectPublicWallet: mocks.connect }))
vi.mock('./shield', () => ({
  publicSigner: mocks.signer, shieldAllowance: mocks.allowance, approveShield: mocks.approve,
  assertPublicNetwork: mocks.network,
  requireShieldBalance: mocks.balance,
  shield: mocks.shield, PublicNetworkError: class extends Error {},
}))
vi.mock('./journal', () => ({ pendingSwap: async () => undefined, reconcilePendingSwap: vi.fn() }))
vi.mock('./withdrawal-journal', () => ({ pendingWithdrawal: async () => undefined, reconcilePendingWithdrawal: vi.fn(), resumePendingWithdrawal: vi.fn() }))
vi.mock('./broadcaster', () => ({ selectBroadcaster: mocks.selectBroadcaster, startBroadcasters: vi.fn(), privateSubmitter: vi.fn() }))
vi.mock('./private-swap', async (original) => ({ ...await original<typeof import('./private-swap')>(), executePrivateSwap: vi.fn(), preparePrivateSwap: mocks.prepareSwap, prepareMaxPrivateSwap: mocks.prepareMax }))
vi.mock('./recipe', () => ({
  amountFromInput: (value: string) => {
    if (!value.trim()) throw new Error('Enter a positive token amount.')
    return 1n
  },
  quoteSwap: mocks.quoteSwap,
}))
vi.mock('./recovery', () => ({ recoverToken: vi.fn(), recoveryIndex: vi.fn(), scanRecovery: vi.fn() }))
vi.mock('./unshield', () => ({ executeUnshield: vi.fn(), prepareUnshield: mocks.prepareWithdrawal }))
vi.mock('./wallet', () => ({ requireWalletSync: vi.fn(), syncWallet: mocks.sync }))
vi.mock('./account', () => ({ unusedSwapAccount: mocks.unused }))
vi.mock('./cancel', () => ({ cancelPendingSwap: vi.fn() }))

let elements: Record<string, { value: string, hidden: boolean, textContent: string, checked: boolean, onclick?: () => Promise<void>, oninput?: () => void }>
let provider: EventEmitter & { request: ReturnType<typeof vi.fn> }
beforeEach(() => {
  mocks.environment = 'fork'
  elements = new Proxy({} as typeof elements, { get: (values, id: string) => values[id] ??= {
    value: ['token', 'shield-token'].includes(id) ? 'WETH' : '1', hidden: ['approve', 'shield', 'switch-network', 'review-shield'].includes(id),
    textContent: '', checked: false,
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
  mocks.selectBroadcaster.mockReset()
  mocks.prepareSwap.mockReset().mockImplementation(async (_session, quote) => ({ quote, fee: { amount: 1n } }))
  mocks.prepareMax.mockReset()
  mocks.prepareWithdrawal.mockReset().mockResolvedValue({ fee: { amount: 1n } })
  mocks.quoteSwap.mockReset().mockResolvedValue({ sell: 'WETH', buy: 'USDC', amount: 1000n, minimum: 1000n, shieldFee: 25n, ophisFee: 1n })
  mocks.unused.mockReset().mockResolvedValue({ address: '0x0000000000000000000000000000000000000001' })
})
afterEach(() => vi.unstubAllGlobals())

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
  expect(elements.status.textContent).toContain('Shield confirmed')
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
  expect(elements['swap-direction'].textContent).toBe('Sell USDC → receive WETH. Enter the amount of USDC to sell.')
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
    report('Deposit confirmed: receipt hash. Railgun validation usually takes about one hour. Use Refresh balances afterward and wait for Spendable before a private swap.')
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
  expect(args.at(-1)).toBe(selected)
  expect(elements.error.textContent).toBe('')
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
  mocks.selectBroadcaster.mockRejectedValue(new Error('No compatible broadcaster is available.'))
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
  mocks.selectBroadcaster.mockResolvedValue({ tokenAddress: 'fresh fee token' })
  const { wireWalletActions } = await import('./wallet-actions')
  await wireWalletActions({} as WalletSession)
  await elements.connect.onclick?.()
  expect(elements.shield.hidden).toBe(false)
  mocks.selectBroadcaster.mockRejectedValueOnce(new Error('Broadcaster disconnected.'))
  await elements.shield.onclick?.()
  expect(mocks.shield).not.toHaveBeenCalled()
  expect(elements['public-wallet-error'].textContent).toContain('Broadcaster disconnected')
})

it.each(['quote', 'max-swap'])('blocks %s before preparing a private output without a compatible broadcaster', async (action) => {
  mocks.environment = 'ethereum'
  mocks.selectBroadcaster.mockResolvedValueOnce({ tokenAddress: 'input fee token' })
    .mockRejectedValueOnce(new Error('No compatible broadcaster for the receive token.'))
  const { wireWalletActions } = await import('./wallet-actions')
  await wireWalletActions({} as WalletSession)
  await elements[action].onclick?.()
  expect(mocks.prepareSwap).not.toHaveBeenCalled()
  expect(mocks.prepareMax).not.toHaveBeenCalled()
  expect(elements.swap.hidden).toBe(true)
  expect(elements['private-wallet-error'].textContent).toContain('receive token')
})
