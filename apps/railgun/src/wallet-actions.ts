import { formatUnits, type Eip1193Provider, type JsonRpcSigner } from 'ethers'
import { selectBroadcaster, startBroadcasters, privateSubmitter } from './broadcaster'
import { pendingSwap, reconcilePendingSwap } from './journal'
import { cancelPendingSwap } from './cancel'
import { pendingWithdrawal, reconcilePendingWithdrawal, resumePendingWithdrawal } from './withdrawal-journal'
import { TOKENS, type TokenSymbol } from './config'
import { executePrivateSwap, preparePrivateSwap } from './private-swap'
import { amountFromInput, quoteSwap } from './recipe'
import { recoverToken, recoveryIndex, scanRecovery } from './recovery'
import { approveShield, publicSigner, shield, shieldAllowance, PublicNetworkError } from './shield'
import { executeUnshield, prepareUnshield } from './unshield'
import { element, run } from './ui'
import { requireWalletSync, syncWallet, type WalletSession } from './wallet'
import { unusedSwapAccount } from './account'

declare global {
  interface Window {
    ethereum?: Eip1193Provider
  }
}

export async function wireWalletActions(session: WalletSession): Promise<void> {
  const state: {
    signer?: JsonRpcSigner
    swap?: Awaited<ReturnType<typeof preparePrivateSwap>>
    withdrawal?: Awaited<ReturnType<typeof prepareUnshield>>
    pendingIdentity?: string
  } = {}
  const token = element<HTMLSelectElement>('token')
  const amount = element<HTMLInputElement>('amount')
  const recipient = element<HTMLInputElement>('recipient')
  const status = (message: string): void => {
    element('status').textContent = message
  }
  const refreshPending = async (): Promise<void> => {
    const pending = await pendingSwap(session)
    const withdrawal = await pendingWithdrawal(session)
    const identity = pending?.account || withdrawal?.recipient
    if (state.pendingIdentity !== identity) element<HTMLInputElement>('accept-leftovers').checked = false
    state.pendingIdentity = identity
    element('pending-details').textContent = pending
      ? `Pending swap: account ${pending.index}, ${pending.account}\n${pending.hash || 'Submission outcome unknown'}`
      : withdrawal
        ? `Pending withdrawal to ${withdrawal.recipient}\n${withdrawal.hash || 'Submission outcome unknown'}`
        : 'No pending private transaction.'
  }
  await refreshPending()
  const initialPending = await pendingSwap(session)
  if (initialPending) element<HTMLInputElement>('recovery-index').value = String(initialPending.index)
  const symbol = (): TokenSymbol => {
    if (token.value !== 'USDC' && token.value !== 'WETH') throw new Error('Unsupported token.')
    return token.value
  }
  const button = (id: string, label: string, action: () => Promise<void>): void => {
    const target = element<HTMLButtonElement>(id)
    target.onclick = () =>
      run(target, label, async () => {
        try {
          await action()
        } catch (error) {
          if (error instanceof PublicNetworkError) {
            state.signer = undefined
            invalidate()
            element('connect').hidden = true
            element('switch-network').hidden = false
          }
          throw error
        } finally {
          await refreshPending()
        }
      })
  }
  const invalidate = (): void => {
    state.swap = undefined
    state.withdrawal = undefined
    element('swap').hidden = true
    element('withdraw').hidden = true
    element('shield').hidden = true
    element('approve').hidden = true
    element('connect').hidden = false
    element('switch-network').hidden = true
    element('quote-details').textContent = ''
    element('withdraw-details').textContent = ''
  }
  for (const input of [token, amount, recipient]) input.oninput = invalidate
  button('switch-network', 'Switching network…', async () => {
    if (!window.ethereum) throw new Error('Enable your Ethereum browser wallet first.')
    await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] })
    invalidate()
  })
  button('connect', 'Connecting…', async () => {
    if (!window.ethereum) throw new Error('Install or enable your Ethereum browser wallet to shield funds.')
    state.signer = await publicSigner(window.ethereum, session)
    const allowance = await shieldAllowance(state.signer, symbol())
    const approved = allowance >= amountFromInput(amount.value, symbol())
    element('connect').hidden = true
    element('approve').hidden = approved
    element('shield').hidden = !approved
    status(`Public wallet connected: ${await state.signer.getAddress()}`)
  })
  button('approve', 'Approving…', async () => {
    if (!state.signer) throw new Error('Connect your public wallet first.')
    await approveShield(session, state.signer, symbol(), amountFromInput(amount.value, symbol()))
    const approved = (await shieldAllowance(state.signer, symbol())) >= amountFromInput(amount.value, symbol())
    element('approve').hidden = approved
    element('shield').hidden = !approved
    status('Approval confirmed.')
  })
  button('shield', 'Shielding…', async () => {
    if (!state.signer) throw new Error('Connect your public wallet first.')
    const receipt = await shield(session, state.signer, symbol(), amountFromInput(amount.value, symbol()))
    invalidate()
    status(`Shield confirmed: ${receipt.hash}. Private funds may still be pending.`)
    await syncWallet(session)
  })
  button('broadcasters', 'Connecting…', async () => {
    await startBroadcasters(status)
  })
  button('quote', 'Preparing quote…', async () => {
    state.swap = undefined
    element('swap').hidden = true
    requireWalletSync()
    const account = await unusedSwapAccount(session)
    const quote = await quoteSwap(session.provider, symbol(), amount.value, account.address)
    state.swap = await preparePrivateSwap(session, quote, selectBroadcaster(TOKENS[quote.sell].address, true))
    const minimumAfterShield = quote.minimum - (quote.minimum * quote.shieldFee) / 10_000n
    element('quote-details').textContent =
      `Minimum private output: ${formatUnits(minimumAfterShield, TOKENS[quote.buy].decimals)} ${quote.buy}\nOphis fee: ${formatUnits(quote.ophisFee, TOKENS[quote.buy].decimals)} ${quote.buy}\nBroadcaster fee: ${formatUnits(state.swap.fee.amount, TOKENS[quote.sell].decimals)} ${quote.sell}\nRailgun unshield / reshield: ${quote.unshieldFee} / ${quote.shieldFee} bp`
    element('swap').hidden = false
  })
  button('swap', 'Proving and submitting…', async () => {
    const prepared = state.swap
    invalidate()
    if (!prepared) throw new Error('Get a fresh private swap quote first.')
    const hash = await executePrivateSwap(session, prepared, status, privateSubmitter)
    status(`Swap mined: ${hash}. Confirming private balance.`)
    await syncWallet(session)
  })
  button('withdraw-quote', 'Calculating fee…', async () => {
    state.withdrawal = await prepareUnshield(
      session,
      symbol(),
      amount.value,
      recipient.value,
      selectBroadcaster(TOKENS[symbol()].address, false),
    )
    element('withdraw-details').textContent =
      `Withdraw ${amount.value} ${symbol()} to ${recipient.value}\nBroadcaster fee: ${formatUnits(state.withdrawal.fee.amount, TOKENS[symbol()].decimals)} ${symbol()}\nRailgun's withdrawal fee is deducted from the amount.`
    element('withdraw').hidden = false
  })
  button('withdraw', 'Proving withdrawal…', async () => {
    const prepared = state.withdrawal
    invalidate()
    if (!prepared) throw new Error('Review the withdrawal fee first.')
    const hash = await executeUnshield(session, prepared, status, privateSubmitter)
    status(`Withdrawal confirmed: ${hash}`)
    await syncWallet(session)
  })
  button('scan', 'Scanning…', async () => {
    element('recovery-details').textContent = await scanRecovery(
      session,
      recoveryIndex(element<HTMLInputElement>('recovery-index').value),
    )
  })
  button('reconcile', 'Checking pending swap…', async () => {
    status(await reconcilePendingSwap(session, true, element<HTMLInputElement>('accept-leftovers').checked))
    await syncWallet(session)
  })
  button('cancel-swap', 'Invalidating old authorization…', async () => {
    status(await cancelPendingSwap(session, element<HTMLInputElement>('accept-leftovers').checked))
    await syncWallet(session)
  })
  button('reconcile-withdrawal', 'Checking withdrawal…', async () => {
    status(await reconcilePendingWithdrawal(session))
    await syncWallet(session)
  })
  button('resume-withdrawal', 'Resuming saved withdrawal…', async () => {
    if (!window.ethereum) throw new Error('Connect a public wallet for resubmission gas.')
    status(await resumePendingWithdrawal(session, await publicSigner(window.ethereum, session)))
    await syncWallet(session)
  })
  button('recover', 'Recovering…', async () => {
    const hash = await recoverToken(session, recoveryIndex(element<HTMLInputElement>('recovery-index').value), symbol())
    status(`Recovery shield confirmed: ${hash}`)
    await syncWallet(session)
  })
}
