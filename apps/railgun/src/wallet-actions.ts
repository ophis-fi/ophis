import { formatUnits, type JsonRpcSigner } from 'ethers'
import { selectBroadcaster, startBroadcasters, privateSubmitter } from './broadcaster'
import { pendingSwap, reconcilePendingSwap } from './journal'
import { cancelPendingSwap } from './cancel'
import { pendingWithdrawal, reconcilePendingWithdrawal, resumePendingWithdrawal, savedWithdrawalSummary,
  canPreserveWethWithdrawal, preserveWethWithdrawal, preservedWithdrawal, restorePreservedWithdrawal } from './withdrawal-journal'
import { CHAIN_ID, ENVIRONMENT, NATIVE_SYMBOL, PILOT_WITHDRAWAL_RECIPIENT, WRAPPED_SYMBOL, TOKENS, isTokenSymbol, tokenFor, type TokenSymbol } from './config'
import { executePrivateSwap, prepareMaxPrivateSwap, preparePrivateSwap, SwapBalanceError } from './private-swap'
import { amountFromInput, quoteSwap } from './recipe'
import { recoverToken, recoveryIndex, scanRecovery } from './recovery'
import { approveShield, assertPublicNetwork, publicSigner, requireShieldBalance, shield, shieldAllowance, PublicNetworkError, type ShieldToken } from './shield'
import { executeUnshield, prepareUnshield, retrySavedUnshield } from './unshield'
import { element, errorMessage, run } from './ui'
import { requireWalletSync, syncWallet, type WalletSession } from './wallet'
import { unusedSwapAccount } from './account'
import { connectPublicWallet, type PublicWalletProvider } from './public-connection'
import { renderWalletLayout, setPendingNotice, setSwapReview, showWalletView } from './wallet-layout'
import { feeTokenFor, usesBoundWithdrawal } from './fee-asset'

export async function wireWalletActions(session: WalletSession): Promise<void> {
  const state: {
    publicEpoch: number
    provider?: PublicWalletProvider
    signer?: JsonRpcSigner
    swap?: Awaited<ReturnType<typeof preparePrivateSwap>>
    withdrawal?: Awaited<ReturnType<typeof prepareUnshield>>
    pendingIdentity?: string
  } = { publicEpoch: 0 }
  const token = element<HTMLSelectElement>('token')
  const buyToken = element<HTMLSelectElement>('buy-token')
  const amount = element<HTMLInputElement>('amount')
  const shieldToken = element<HTMLSelectElement>('shield-token')
  const shieldAmount = element<HTMLInputElement>('shield-amount')
  const recipient = element<HTMLInputElement>('recipient')
  const status = (message: string): void => {
    element('status').textContent = message
  }
  const broadcasterStatus = (message: string): void => {
    element('broadcaster-status').textContent = message
  }
  const publicTransactionStatus = (message: string): void => {
    element('public-transaction-status').textContent = message
  }
  if (CHAIN_ID === 56) {
    element('swap-fee-help').textContent = 'Broadcaster fees are paid automatically from your private WBNB balance. Keep private WBNB for fees when swapping or withdrawing other tokens.'
    element('withdraw-fee-help').textContent = 'Choose the token and amount above. The broadcaster fee is paid separately in private WBNB.'
  }
  const refreshPending = async (): Promise<void> => {
    const pending = await pendingSwap(session)
    const withdrawal = await pendingWithdrawal(session)
    const preserved = await preservedWithdrawal(session)
    const unsupportedWeth = !!withdrawal && canPreserveWethWithdrawal(withdrawal)
    const boundWithdrawal = withdrawal?.execution
    const identity = pending?.account || withdrawal?.recipient
    setPendingNotice(!!identity)
    const shortcut = element<HTMLAnchorElement>('withdraw-shortcut')
    shortcut.href = identity ? '#recovery' : '#withdrawal'
    shortcut.textContent = pending ? 'Check saved swap' : withdrawal ? 'Continue saved withdrawal' : 'Withdraw'
    element<HTMLDetailsElement>('recovery').open = !!identity
    element('reconcile').hidden = !pending
    element('cancel-swap').hidden = !pending && !boundWithdrawal
    element('leftovers-consent').hidden = !pending && !boundWithdrawal
    element('cancel-swap').textContent = boundWithdrawal ? 'Invalidate saved withdrawal authorization' : 'Cancel pending swap using temporary account gas'
    for (const id of ['withdraw-max', 'withdraw-quote']) element(id).hidden = !!identity
    element('reconcile-withdrawal').hidden = !withdrawal
    for (const id of ['retry-withdrawal', 'resume-withdrawal']) element(id).hidden = !withdrawal || unsupportedWeth
    element('use-usdc-withdrawal').hidden = !unsupportedWeth || !!pending
    element('restore-preserved-withdrawal').hidden = !preserved || !!identity
    element('preserved-withdrawal-details').textContent = preserved
      ? `${savedWithdrawalSummary(preserved)}\nThis proof is retained in encrypted recovery storage. Setting it aside does not revoke it, and it is never retried automatically.` : ''
    const help = element('withdraw-pending-help')
    help.hidden = !identity
    help.textContent = pending
      ? 'A swap is already saved. Use Check saved swap above before preparing a withdrawal.'
      : unsupportedWeth ? 'The saved proof withdraws WETH. This pilot relays USDC. Keep the WETH proof and prepare a USDC withdrawal below.'
      : 'A withdrawal is already saved. Use Continue saved withdrawal above to retry that proof.'
    if (state.pendingIdentity !== identity) {
      element<HTMLInputElement>('accept-leftovers').checked = false
      if (pending) element<HTMLInputElement>('recovery-index').value = String(pending.index)
      else if (boundWithdrawal) element<HTMLInputElement>('recovery-index').value = String(boundWithdrawal.index)
    }
    state.pendingIdentity = identity
    element('pending-details').textContent = pending
      ? `Pending swap: account ${pending.index}, ${pending.account}\n${pending.hash || 'Submission outcome unknown'}`
      : withdrawal
        ? `${savedWithdrawalSummary(withdrawal)}\n${withdrawal.hash || 'Submission outcome unknown'}`
        : 'No pending private transaction.'
  }
  await refreshPending()
  const symbol = (): TokenSymbol => {
    if (!isTokenSymbol(token.value)) throw new Error('Unsupported token.')
    return token.value
  }
  const buySymbol = (): TokenSymbol => {
    if (!isTokenSymbol(buyToken.value) || buyToken.value === symbol()) throw new Error('Choose a different receive token.')
    return buyToken.value
  }
  const assetLabel = (id: TokenSymbol): string => `${tokenFor(id).symbol}${id.startsWith('0x') ? ` (${tokenFor(id).address})` : ''}`
  const updateSwapDirection = (): void => {
    const sell = symbol()
    if (buyToken.value === sell || !isTokenSymbol(buyToken.value)) buyToken.value = sell === 'USDC' ? WRAPPED_SYMBOL : 'USDC'
    element('swap-direction').textContent = `Sell ${assetLabel(sell)} → receive ${assetLabel(buySymbol())}. Enter the amount of ${tokenFor(sell).symbol} to sell.`
    element('native-withdrawal-option').hidden = CHAIN_ID !== 56 || sell !== 'WBNB'
  }
  updateSwapDirection()
  const depositToken = (): ShieldToken => {
    const asset = shieldToken.value
    if (asset !== NATIVE_SYMBOL && !isTokenSymbol(asset)) throw new Error('Unsupported deposit asset.')
    return asset
  }
  const depositAmount = (): bigint => {
    const asset = depositToken()
    const underlying = asset === NATIVE_SYMBOL ? WRAPPED_SYMBOL : asset
    if (!isTokenSymbol(underlying)) throw new Error('Unsupported deposit asset.')
    return amountFromInput(shieldAmount.value, underlying)
  }
  const requireDepositBroadcaster = async (asset: ShieldToken): Promise<void> => {
    requireWalletSync()
    if (ENVIRONMENT === 'fork') return
    publicTransactionStatus('Checking private-swap broadcaster availability before depositing…')
    const principal = asset === NATIVE_SYMBOL ? WRAPPED_SYMBOL : asset
    if (!isTokenSymbol(principal)) throw new Error('Unsupported deposit asset.')
    await selectBroadcaster(tokenFor(feeTokenFor(principal)).address, true, broadcasterStatus)
    publicTransactionStatus('A compatible private-swap broadcaster is available. Review the deposit amount and fees.')
  }
  const renderQuoteAction = (): void => {
    const quote = element<HTMLButtonElement>('quote')
    quote.className = ''
    quote.textContent = 'Review swap'
    renderWalletLayout()
  }
  const button = (id: string, label: string, action: () => Promise<void>): void => {
    const target = element<HTMLButtonElement>(id)
    target.onclick = () =>
      run(target, label, async () => {
        const publicAction = ['connect', 'walletconnect', 'review-shield', 'switch-network', 'approve', 'shield', 'disconnect-public'].includes(id)
        const errorTarget = element(publicAction ? 'public-wallet-error' : 'private-wallet-error')
        errorTarget.textContent = ''
        if (publicAction) publicTransactionStatus('')
        try {
          await action()
        } catch (error) {
          if (id === 'shield') invalidate()
          errorTarget.textContent = errorMessage(error)
          if (error instanceof PublicNetworkError) {
            state.signer = undefined
            invalidate()
            element('connect').hidden = true
            element('walletconnect').hidden = true
            element('switch-network').hidden = false
          }
          throw error
        } finally {
          await refreshPending()
        }
      }).finally(renderQuoteAction)
  }
  const invalidate = (): void => {
    const previousError = element('private-wallet-error').textContent
    if (element('error').textContent === previousError) element('error').textContent = ''
    element('private-wallet-error').textContent = ''
    state.swap = undefined
    state.withdrawal = undefined
    element('swap').hidden = true
    element('withdraw').hidden = true
    element('shield').hidden = true
    element('approve').hidden = true
    element('connect').hidden = !!state.signer
    element('walletconnect').hidden = !!state.signer
    element('review-shield').hidden = !state.signer
    element('switch-network').hidden = true
    element('quote-details').textContent = ''
    element('receive-amount').textContent = '—'
    renderQuoteAction()
    element('withdraw-details').textContent = ''
    setSwapReview(false)
  }
  const publicWalletChanged = (): void => {
    state.publicEpoch += 1
    state.signer = undefined
    invalidate()
    element('public-wallet-status').textContent = 'Public wallet changed or disconnected. Reconnect before shielding.'
  }
  const selectProvider = (provider?: PublicWalletProvider): void => {
    state.publicEpoch += 1
    for (const event of ['accountsChanged', 'chainChanged', 'disconnect'] as const) {
      state.provider?.removeListener?.(event, publicWalletChanged)
      provider?.on?.(event, publicWalletChanged)
    }
    state.provider = provider
    state.signer = undefined
    element('disconnect-public').hidden = !provider
  }
  const assertPublicEpoch = (epoch: number): void => {
    if (state.publicEpoch !== epoch) throw new Error('Public wallet changed. Reconnect before shielding.')
  }
  for (const input of [token, buyToken, amount, recipient, shieldToken, shieldAmount, element<HTMLInputElement>('withdraw-native')]) input.oninput = invalidate
  buyToken.oninput = () => { invalidate(); updateSwapDirection() }
  token.oninput = () => {
    amount.value = ''
    invalidate()
    updateSwapDirection()
  }
  button('switch-network', 'Switching network…', async () => {
    if (!state.provider) throw new Error('Connect your public wallet first.')
    await state.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: `0x${CHAIN_ID.toString(16)}` }] })
    invalidate()
  })
  const reviewShieldAmount = async (): Promise<void> => {
    element('approve').hidden = true
    element('shield').hidden = true
    element('review-shield').hidden = false
    const signer = state.signer
    const epoch = state.publicEpoch
    if (!signer) throw new Error('Connect your public wallet first.')
    const asset = depositToken()
    const required = depositAmount()
    await assertPublicNetwork(session, signer)
    await requireShieldBalance(signer, asset, required)
    await requireDepositBroadcaster(asset)
    const approved = !isTokenSymbol(asset) || (await shieldAllowance(signer, asset)) >= required
    assertPublicEpoch(epoch)
    element('review-shield').hidden = true
    element('approve').hidden = approved
    element('shield').hidden = !approved
  }
  const connect = async (kind: 'browser' | 'walletconnect'): Promise<void> => {
    selectProvider(await connectPublicWallet(kind))
    const epoch = state.publicEpoch
    const signer = await publicSigner(state.provider!, session)
    assertPublicEpoch(epoch)
    const address = await signer.getAddress()
    assertPublicEpoch(epoch)
    state.signer = signer
    element('connect').hidden = true
    element('walletconnect').hidden = true
    element('review-shield').hidden = false
    element('public-wallet-status').textContent = `Public wallet connected: ${address}`
    if (shieldAmount.value.trim()) await reviewShieldAmount()
  }
  button('connect', 'Connecting…', () => connect('browser'))
  button('walletconnect', 'Connecting…', () => connect('walletconnect'))
  button('review-shield', 'Checking amount…', reviewShieldAmount)
  button('disconnect-public', 'Disconnecting…', async () => {
    await state.provider?.disconnect?.()
    selectProvider()
    invalidate()
    element('public-wallet-status').textContent = 'Public wallet disconnected.'
  })
  button('approve', 'Approving…', async () => {
    const signer = state.signer
    const epoch = state.publicEpoch
    if (!signer) throw new Error('Connect your public wallet first.')
    const asset = depositToken()
    if (!isTokenSymbol(asset)) throw new Error('Native deposits do not need token approval.')
    const required = depositAmount()
    await approveShield(session, signer, asset, required, publicTransactionStatus)
    assertPublicEpoch(epoch)
    const approved = (await shieldAllowance(signer, asset)) >= required
    assertPublicEpoch(epoch)
    element('approve').hidden = approved
    element('shield').hidden = !approved
    status('Approval confirmed. Next: click Shield amount and confirm the deposit in your wallet.')
  })
  button('shield', 'Shielding…', async () => {
    if (!state.signer) throw new Error('Connect your public wallet first.')
    const asset = depositToken()
    await requireDepositBroadcaster(asset)
    const receipt = await shield(session, state.signer, asset, depositAmount(), publicTransactionStatus)
    token.value = asset === NATIVE_SYMBOL ? WRAPPED_SYMBOL : asset
    amount.value = ''
    updateSwapDirection()
    invalidate()
    status(`Deposit confirmed: ${receipt.hash}. Updating your private balance automatically.`)
    void syncWallet(session).catch((error: unknown) => {
      element('private-wallet-error').textContent = error instanceof Error ? error.message : 'Private balance sync failed. The deposit is already confirmed.'
    })
  })
  button('broadcasters', 'Connecting…', async () => {
    await startBroadcasters(broadcasterStatus)
  })
  const showSwapQuote = (prepared: Awaited<ReturnType<typeof preparePrivateSwap>>): void => {
    state.swap = prepared
    const { quote } = prepared
    amount.value = formatUnits(quote.amount, TOKENS[quote.sell].decimals)
    const minimumAfterShield = quote.minimum - (quote.minimum * quote.shieldFee) / 10_000n
    element('receive-amount').textContent = formatUnits(minimumAfterShield, TOKENS[quote.buy].decimals)
    element('quote-details').textContent =
      `Amount to swap: ${formatUnits(quote.amount, TOKENS[quote.sell].decimals)} ${tokenFor(quote.sell).symbol}\nMinimum private output: ${formatUnits(minimumAfterShield, TOKENS[quote.buy].decimals)} ${tokenFor(quote.buy).symbol}\nOphis fee: ${formatUnits(quote.ophisFee, TOKENS[quote.buy].decimals)} ${tokenFor(quote.buy).symbol}\nBroadcaster fee: ${formatUnits(prepared.fee.amount, TOKENS[feeTokenFor(quote.sell)].decimals)} ${tokenFor(feeTokenFor(quote.sell)).symbol}\nProtocol unshield / reshield: ${quote.unshieldFee} / ${quote.shieldFee} bp`
    if (quote.sell.startsWith('0x')) element('quote-details').textContent += `\nSell token contract: ${tokenFor(quote.sell).address}`
    if (quote.buy.startsWith('0x')) element('quote-details').textContent += `\nReceive token contract: ${tokenFor(quote.buy).address}`
    if (prepared.gasCapped)
      element('quote-details').textContent += `\nGas price capped at ${formatUnits(prepared.gas.maxFeePerGas, 9)} gwei to fit your private balance. Rising gas prices can require a fresh quote.`
    if (quote.route)
      element('quote-details').textContent += `\nUniswap v3: ${quote.route.tokens.join(' → ')}; pool fees ${quote.route.fees.map((fee) => `${fee / 10_000}%`).join(' + ')}. ${quote.availableRoutes} routes returned positive quotes.`
    renderQuoteAction()
    element('swap').hidden = false
    setSwapReview(true)
  }
  button('max-swap', 'Reserving broadcaster fee…', async () => {
    invalidate()
    requireWalletSync()
    const sell = symbol()
    const selected = await selectBroadcaster(TOKENS[feeTokenFor(sell)].address, true, broadcasterStatus)
    if (ENVIRONMENT === 'ethereum' && feeTokenFor(buySymbol()) !== feeTokenFor(sell)) await selectBroadcaster(TOKENS[feeTokenFor(buySymbol())].address, true, broadcasterStatus)
    const prepared = await prepareMaxPrivateSwap(session, sell, selected, undefined, buySymbol())
    showSwapQuote(prepared)
    element('quote-details').textContent = 'Max includes gas price headroom in the fee budget. Review the trade and committed fee below.\n' + element('quote-details').textContent
  })
  button('quote', 'Preparing quote…', async () => {
    invalidate()
    requireWalletSync()
    amountFromInput(amount.value, symbol())
    const selected = await selectBroadcaster(TOKENS[feeTokenFor(symbol())].address, true, broadcasterStatus)
    if (ENVIRONMENT === 'ethereum' && feeTokenFor(buySymbol()) !== feeTokenFor(symbol())) await selectBroadcaster(TOKENS[feeTokenFor(buySymbol())].address, true, broadcasterStatus)
    const account = await unusedSwapAccount(session)
    const quote = await quoteSwap(session.provider, symbol(), amount.value, account.address, buySymbol())
    let prepared: Awaited<ReturnType<typeof preparePrivateSwap>>
    try {
      prepared = await preparePrivateSwap(session, quote, selected)
    } catch (error) {
      if (!(error instanceof SwapBalanceError) || error.spendable !== quote.amount) throw error
      prepared = await prepareMaxPrivateSwap(session, quote.sell, selected, quote.amount, quote.buy)
    }
    showSwapQuote(prepared)
    if (prepared.quote.amount < quote.amount)
      element('quote-details').textContent = 'Broadcaster fee reserved from your full-balance amount. Review the adjusted trade below.\n' + element('quote-details').textContent
  })
  button('swap', 'Preparing private swap…', async () => {
    const prepared = state.swap
    invalidate()
    if (!prepared) throw new Error('Get a fresh private swap quote first.')
    const hash = await executePrivateSwap(session, prepared, status, privateSubmitter)
    status(`Swap mined: ${hash}. Confirming private balance.`)
    await syncWallet(session)
  })
  const reviewWithdrawal = async (maximum: boolean): Promise<void> => {
    invalidate()
    requireWalletSync()
    if (!maximum) amountFromInput(amount.value, symbol())
    const nativeOutput = CHAIN_ID === 56 && symbol() === 'WBNB' && element<HTMLInputElement>('withdraw-native').checked
    const selected = await selectBroadcaster(TOKENS[feeTokenFor(symbol())].address, usesBoundWithdrawal(symbol(), nativeOutput), broadcasterStatus)
    state.withdrawal = await prepareUnshield(
      session,
      symbol(),
      amount.value,
      recipient.value,
      selected,
      maximum,
      nativeOutput,
    )
    if (maximum) amount.value = formatUnits(state.withdrawal.amounts[0].amount, TOKENS[symbol()].decimals)
    element('withdraw-details').textContent =
      `Withdraw ${amount.value} ${tokenFor(symbol()).symbol} to ${recipient.value}\nBroadcaster fee: ${formatUnits(state.withdrawal.fee.amount, TOKENS[feeTokenFor(symbol())].decimals)} ${tokenFor(feeTokenFor(symbol())).symbol}\nThe broadcaster fee is paid from your private balance. The protocol withdrawal fee is deducted from the amount.\nYou receive: ${formatUnits(state.withdrawal.minimum, TOKENS[symbol()].decimals)} ${nativeOutput ? 'BNB' : tokenFor(symbol()).symbol}`
    if (symbol().startsWith('0x')) element('withdraw-details').textContent += `\nToken contract: ${tokenFor(symbol()).address}`
    element('withdraw').hidden = false
  }
  button('withdraw-quote', 'Calculating fee…', () => reviewWithdrawal(false))
  button('withdraw-max', 'Reserving withdrawal fee…', () => reviewWithdrawal(true))
  button('withdraw', 'Proving withdrawal…', async () => {
    const prepared = state.withdrawal
    invalidate()
    if (!prepared) throw new Error('Review the withdrawal fee first.')
    const hash = await executeUnshield(session, prepared, status, privateSubmitter)
    status(`Withdrawal confirmed: ${hash}`)
    await syncWallet(session)
  })
  button('scan', 'Scanning…', async () => {
    const index = recoveryIndex(element<HTMLInputElement>('recovery-index').value)
    const swap = await pendingSwap(session), withdrawal = await pendingWithdrawal(session)
    const related = [symbol(), ...(swap?.index === index ? swap.recoveryTokens ?? [swap.token, ...(swap.feeToken ? [swap.feeToken] : [])] : []),
      ...(withdrawal?.execution?.index === index ? [withdrawal.token, ...(withdrawal.feeToken ? [withdrawal.feeToken] : [])] : [])]
    element('recovery-details').textContent = await scanRecovery(
      session,
      index,
      [...new Set(related)],
    )
  })
  button('reconcile', 'Checking pending swap…', async () => {
    status(await reconcilePendingSwap(session, true, element<HTMLInputElement>('accept-leftovers').checked))
    await syncWallet(session)
  })
  button('cancel-swap', 'Invalidating old authorization…', async () => {
    const withdrawal = await pendingWithdrawal(session)
    status(withdrawal?.execution
      ? await cancelPendingSwap(session, element<HTMLInputElement>('accept-leftovers').checked, true)
      : await cancelPendingSwap(session, element<HTMLInputElement>('accept-leftovers').checked))
    await syncWallet(session)
  })
  button('reconcile-withdrawal', 'Checking withdrawal…', async () => {
    status(await reconcilePendingWithdrawal(session))
    await syncWallet(session)
  })
  button('retry-withdrawal', 'Retrying saved withdrawal…', async () => {
    invalidate()
    status(`Withdrawal confirmed: ${await retrySavedUnshield(session, status, privateSubmitter)}`)
    await syncWallet(session)
  })
  button('use-usdc-withdrawal', 'Preserving WETH proof…', async () => {
    requireWalletSync()
    if (await pendingSwap(session)) throw new Error('Resolve the pending swap first.')
    await preserveWethWithdrawal(session)
    invalidate()
    token.value = 'USDC'
    token.dispatchEvent(new Event('input', { bubbles: true }))
    amount.value = ''
    recipient.value = PILOT_WITHDRAWAL_RECIPIENT!
    status('WETH proof preserved. Preparing the USDC withdrawal for review.')
    showWalletView('withdrawal')
    await reviewWithdrawal(true)
    status('WETH proof preserved. Review the USDC amount and fee, then choose Confirm withdrawal.')
    element('withdraw-details').scrollIntoView({ block: 'center' })
  })
  button('restore-preserved-withdrawal', 'Restoring saved proof…', async () => {
    if (await pendingSwap(session)) throw new Error('Resolve the pending swap first.')
    await restorePreservedWithdrawal(session)
    invalidate()
    status('The preserved withdrawal is active again. Check its status before retrying.')
  })
  button('resume-withdrawal', 'Resuming saved withdrawal…', async () => {
    if (!state.provider) selectProvider(await connectPublicWallet(window.ethereum ? 'browser' : 'walletconnect'))
    const epoch = state.publicEpoch
    const signer = await publicSigner(state.provider!, session)
    assertPublicEpoch(epoch)
    status(await resumePendingWithdrawal(session, signer))
    await syncWallet(session)
  })
  button('recover', 'Recovering…', async () => {
    const hash = await recoverToken(session, recoveryIndex(element<HTMLInputElement>('recovery-index').value), symbol())
    status(`Recovery shield confirmed: ${hash}`)
    await syncWallet(session)
  })
}
