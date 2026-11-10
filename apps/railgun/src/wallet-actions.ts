import { formatUnits, getAddress, type JsonRpcSigner } from 'ethers'
import { selectBroadcaster, startBroadcasters, privateSubmitter } from './broadcaster'
import { pendingSwap, reconcilePendingSwap, savePendingSwap } from './journal'
import { cancelPendingSwap } from './cancel'
import { pendingWithdrawal, reconcilePendingWithdrawal, resumePendingWithdrawal, savedWithdrawalSummary, savePendingWithdrawal,
  canPreserveWethWithdrawal, preserveWethWithdrawal, preservedWithdrawal, restorePreservedWithdrawal } from './withdrawal-journal'
import { CHAIN_ID, ENVIRONMENT, NATIVE_SYMBOL, PILOT_WITHDRAWAL_RECIPIENT, PREPAID_BROADCASTERS, WRAPPED_SYMBOL, TOKENS, isTokenSymbol, tokenFor, type TokenSymbol } from './config'
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
import { preparePrepaid, preparePrepaidRefund, prepaidBalance, pendingPrepaid, topUpPrepaid, retryPrepaidTopUp, claimPrepaidTopUp, checkPrepaid,
  retryPrepaid, prepaidRefundFee, requestPrepaidRefund, checkPrepaidRefund, deferPrepaidTopUp, type PreparedCredit, type CreditBalance, type CreditFunding } from './prepaid'
import { ADAPT } from './execution'

export async function wireWalletActions(session: WalletSession): Promise<void> {
  const state: {
    publicEpoch: number
    provider?: PublicWalletProvider
    signer?: JsonRpcSigner
    swap?: Awaited<ReturnType<typeof preparePrivateSwap>>
    withdrawal?: Awaited<ReturnType<typeof prepareUnshield>>
    refund?: { credit: PreparedCredit; gross: bigint; net: bigint; recipient?: string }
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
  const usesPrepaid = ENVIRONMENT === 'ethereum' && [1, 56].includes(CHAIN_ID)
  const nativePrepaid = PREPAID_BROADCASTERS[CHAIN_ID]?.funding === 'native'
  const fundingSelect = element<HTMLSelectElement>('fee-credit-funding')
  fundingSelect.value = nativePrepaid ? 'native' : 'private'
  const selectedFunding = (): CreditFunding => fundingSelect.value === 'private' ? 'private' : 'native'
  const creditSymbol = nativePrepaid ? NATIVE_SYMBOL : WRAPPED_SYMBOL
  const creditStatus = (message: string): void => { element('fee-credit-status').textContent = message }
  const showCredit = (balance: CreditBalance): void => {
    const creditSymbol = balance.funding === 'native' ? NATIVE_SYMBOL : WRAPPED_SYMBOL
    element('fee-credit-balance').textContent = `Available: ${formatUnits(balance.available, 18)} ${creditSymbol} · Reserved: ${formatUnits(balance.reserved, 18)} ${creditSymbol}`
  }
  element('fee-credit-panel').hidden = !usesPrepaid
  element('fee-credit-shortcut').hidden = !usesPrepaid
  if (usesPrepaid) {
    element('fee-caption').textContent = 'Ophis uses prepaid fee credit. Review the maximum attempt charge before confirming.'
    element('swap-fee-help').textContent = 'Your swap uses confirmed fee credit separately from its principal. Up to the reviewed maximum attempt fee can be charged even if execution fails.'
    element('withdraw-fee-help').textContent = 'Choose the token and amount above. Ophis fees use prepaid credit; the protocol fee is deducted from the withdrawal amount.'
    element('fee-credit-help').textContent = nativePrepaid
      ? `Add reusable fee credit with a public ${NATIVE_SYMBOL} payment to Ophis. Use an ordinary account without smart-account delegation. The sender, recipient and amount are public; your wallet also pays this payment's gas. Ophis holds the credit and can link requests using it. Later attempts, including failed or cancelled attempts, charge their gas and the reviewed margin from this credit.`
      : `Add a small reusable balance with a separate private ${WRAPPED_SYMBOL} transfer. Your connected public wallet pays ${NATIVE_SYMBOL} gas for that top-up, linking it to the transfer. Ophis can link requests using the same credit balance. Later attempts use confirmed credit and may incur fees even on failure.`
    element('fee-credit-timing').textContent = (CHAIN_ID === 1
      ? 'Ethereum final confirmation normally takes 13–19 minutes after inclusion.'
      : 'BNB final confirmation normally takes seconds after inclusion.') +
      (nativePrepaid ? ' This public payment has no PPOI waiting period.' : ' Wallet synchronization can add time.') +
      ' Top-ups must finish confirming before use. This wallet also waits for each attempt’s final fee settlement before starting another swap or withdrawal.'
    element('fee-credit-amount').setAttribute('aria-label', `Fee credit to add in ${creditSymbol}`)
    element('fee-credit-amount-text').textContent = `Add ${creditSymbol} fee credit`
    element('fee-refund-recipient-label').hidden = !nativePrepaid
    element('fee-refund-help').textContent = nativePrepaid
      ? 'Unused credit stays available. Refunds send native currency to your public address and charge network gas plus the reviewed margin. Small balances below the refund allowance remain usable as credit.'
      : 'Unused credit stays available. Private refunds require operator processing.'
    element('fee-refund-timing').textContent = nativePrepaid
      ? 'A refund reserves the reviewed amount. Unused gas allowance returns to credit after final confirmation. Failed or cancelled refunds charge only gas plus the reviewed margin.'
      : 'A refund reserves credit until the operator processes the private transfer.'
    element('withdraw-max').textContent = 'Max withdrawal'
  } else if (CHAIN_ID === 56) {
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
    if (usesPrepaid) {
      const legacy = nativePrepaid && await pendingPrepaid(session, 'private')
      element('fee-credit-funding-label').hidden = !legacy
      const legacySelected = nativePrepaid && selectedFunding() === 'private'
      const credit = await pendingPrepaid(session, selectedFunding())
      element('legacy-fee-credit-help').hidden = !legacySelected
      for (const id of ['fee-credit-help', 'fee-credit-timing', 'fee-credit-amount-label', 'fee-refund-help', 'fee-refund-timing'])
        element(id).hidden = legacySelected
      element('fee-credit-consent-label').hidden = legacySelected && !credit?.topUpPending
      element('fee-refund-recipient-label').hidden = selectedFunding() !== 'native'
      const deferred = credit?.deferredTopUpCount ?? 0
      element('check-fee-topup').hidden = !credit?.topUpPending && !deferred
      element('retry-fee-topup').hidden = !credit?.topUpPending
      element('fee-topup-hash-label').hidden = credit?.funding !== 'native' || (!credit.topUpPending && !deferred)
      element('defer-fee-topup').hidden = credit?.funding !== 'native' || !credit.topUpPending
      element('deferred-fee-topups').hidden = !deferred
      element('deferred-fee-topups').textContent = `${deferred} payment(s) kept for recovery. Paste a transaction hash above to claim a confirmed payment.`
      element('check-fee-attempt').hidden = !credit?.key
      element('retry-fee-attempt').hidden = !credit?.key || !!credit.hash || !!credit.completed
      element('add-fee-credit').hidden = legacySelected || !!credit?.topUpPending || (!!credit?.key && !credit.completed)
      element('check-fee-refund').hidden = !credit?.refundPending
      element('review-fee-refund').hidden = !!credit?.refundPending
    }
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
    if (withdrawal?.feeMode === 'prepaid') element('retry-withdrawal').hidden = true
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
    if (usesPrepaid) await preparePrepaid(session, broadcasterStatus)
    else await selectBroadcaster(tokenFor(feeTokenFor(principal)).address, true, broadcasterStatus)
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
    await approveShield(session, signer, asset, required, publicTransactionStatus, () => assertPublicEpoch(epoch))
    assertPublicEpoch(epoch)
    const approved = (await shieldAllowance(signer, asset)) >= required
    assertPublicEpoch(epoch)
    element('approve').hidden = approved
    element('shield').hidden = !approved
    status('Approval confirmed. Next: click Shield amount and confirm the deposit in your wallet.')
  })
  button('shield', 'Shielding…', async () => {
    const signer = state.signer, epoch = state.publicEpoch
    if (!signer) throw new Error('Connect your public wallet first.')
    const asset = depositToken()
    await requireDepositBroadcaster(asset)
    assertPublicEpoch(epoch)
    const receipt = await shield(session, signer, asset, depositAmount(), publicTransactionStatus, () => assertPublicEpoch(epoch))
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
  button('refresh-fee-credit', 'Checking credit…', async () => {
    showCredit(await prepaidBalance(session, selectedFunding()))
    creditStatus(nativePrepaid && selectedFunding() === 'private'
      ? 'Earlier private credit is available for recovery or refund through its original ledger. New swaps use public fee credit.'
      : 'Confirmed credit is reusable on this network. Reserved credit is unavailable until the attempt is reconciled.')
  })
  fundingSelect.onchange = () => {
    state.refund = undefined
    element('request-fee-refund').hidden = true
    element('fee-refund-review').textContent = ''
    element('fee-credit-balance').textContent = 'Check the selected fee credit balance.'
    element('fee-credit-status').textContent = ''
    element<HTMLInputElement>('fee-topup-hash').value = ''
    element<HTMLInputElement>('fee-credit-consent').checked = false
    void run(element<HTMLButtonElement>('refresh-fee-credit'), 'Loading saved credit…', refreshPending)
  }
  button('add-fee-credit', 'Preparing fee credit…', async () => {
    if (nativePrepaid && selectedFunding() === 'private') throw new Error('Earlier private credit is available for recovery only. Select public fee credit to add a new payment.')
    requireWalletSync()
    if (!element<HTMLInputElement>('fee-credit-consent').checked)
      throw new Error('Review and accept the top-up gas and privacy notice first.')
    const value = amountFromInput(element<HTMLInputElement>('fee-credit-amount').value, WRAPPED_SYMBOL)
    const credit = await preparePrepaid(session, creditStatus)
    if (!state.provider) selectProvider(await connectPublicWallet(window.ethereum ? 'browser' : 'walletconnect'))
    const epoch = state.publicEpoch
    const signer = await publicSigner(state.provider!, session)
    assertPublicEpoch(epoch)
    const hash = await topUpPrepaid(session, signer, value, creditStatus, credit)
    invalidate()
    element<HTMLInputElement>('fee-credit-consent').checked = false
    creditStatus(`Top-up submitted: ${hash}. Wait for finality, then choose Check top-up. Do not send another top-up while this one is pending.`)
  })
  button('check-fee-topup', 'Checking top-up…', async () => {
    showCredit(await claimPrepaidTopUp(session, element<HTMLInputElement>('fee-topup-hash').value.trim() || undefined, selectedFunding()))
    element<HTMLInputElement>('fee-topup-hash').value = ''
    creditStatus(nativePrepaid && selectedFunding() === 'private'
      ? 'Earlier payment confirmed in its original private-credit ledger. You can review its refund here.'
      : 'Top-up confirmed and credited. This balance can pay for later Ophis attempts.')
    await syncWallet(session)
  })
  button('retry-fee-topup', 'Resuming saved top-up…', async () => {
    if (!element<HTMLInputElement>('fee-credit-consent').checked)
      throw new Error('Review and accept the top-up gas and privacy notice first.')
    if (!state.provider) selectProvider(await connectPublicWallet(window.ethereum ? 'browser' : 'walletconnect'))
    const epoch = state.publicEpoch
    const signer = await publicSigner(state.provider!, session)
    assertPublicEpoch(epoch)
    const hash = await retryPrepaidTopUp(session, signer, creditStatus, selectedFunding())
    invalidate()
    element<HTMLInputElement>('fee-credit-consent').checked = false
    creditStatus(`Saved top-up transaction: ${hash}. Its payment details were preserved. Use Check top-up after finality.`)
  })
  button('defer-fee-topup-action', 'Preserving payment…', async () => {
    if (!element<HTMLInputElement>('defer-fee-topup-consent').checked)
      throw new Error('Review the saved-payment notice and confirm before setting it aside.')
    await deferPrepaidTopUp(session, selectedFunding())
    element<HTMLInputElement>('defer-fee-topup-consent').checked = false
    element<HTMLInputElement>('fee-credit-consent').checked = false
    invalidate()
    creditStatus('Payment kept for later recovery. This does not cancel a public transaction. You can use existing credit and claim this payment later with its transaction hash.')
  })
  button('check-fee-attempt', 'Checking prepaid transaction…', async () => {
    const saved = await pendingPrepaid(session, selectedFunding())
    const result = await checkPrepaid(session, selectedFunding())
    if (result.hash && !result.cancelled && saved?.request) await attachCreditHash(saved.request, result.hash)
    creditStatus(result.state === 'not-reserved'
      ? 'This fee request was not accepted. No fee was charged for it. The signed private transaction remains saved; use its recovery controls before starting another swap or withdrawal.'
      : `Fee-credit transaction: ${result.state}${result.hash ? ` · ${result.hash}` : ''}${result.cancelled ? ' · original attempt cancelled' : ''}. Check recovery for the private transaction outcome.`)
    showCredit(await prepaidBalance(session, selectedFunding()))
  })
  const attachCreditHash = async (request: { to: string; data: string }, hash: string): Promise<void> => {
    const withdrawal = await pendingWithdrawal(session)
    if (withdrawal?.feeMode === 'prepaid' && getAddress(withdrawal.transaction.to) === getAddress(request.to) &&
      withdrawal.transaction.data.toLowerCase() === request.data.toLowerCase()) {
      if (withdrawal.hash && withdrawal.hash !== hash) throw new Error('The saved withdrawal hash changed. Keep both records for recovery.')
      await savePendingWithdrawal(session, { ...withdrawal, hash })
      return
    }
    const swap = await pendingSwap(session)
    if (swap?.feeMode === 'prepaid' && getAddress(swap.account) === getAddress(request.to)) {
      const [transactions] = ADAPT.decodeFunctionData('execute', request.data)
      const inputs = transactions.flatMap((tx: { boundParams: { treeNumber: bigint }; nullifiers: string[] }) =>
        tx.nullifiers.map((nullifier) => `${tx.boundParams.treeNumber}:${nullifier.toLowerCase()}`)).sort()
      const expected = swap.inputs?.map((input) => `${input.tree}:${input.nullifier.toLowerCase()}`).sort()
      if (!expected?.length || JSON.stringify(inputs) !== JSON.stringify(expected) || (swap.hash && swap.hash !== hash))
        throw new Error('The saved swap differs from the prepaid request. Keep both records for recovery.')
      await savePendingSwap(session, { ...swap, hash })
    }
  }
  button('retry-fee-attempt', 'Retrying exact saved request…', async () => {
    const saved = await pendingPrepaid(session, selectedFunding())
    if (!saved?.request) throw new Error('No complete prepaid request is saved. Keep the private proof for recovery.')
    const hash = await retryPrepaid(session, selectedFunding())
    await attachCreditHash(saved.request, hash)
    creditStatus(`Saved request acknowledged: ${hash}. Check its status and the private recovery record; no proof was rebuilt.`)
  })
  for (const id of ['fee-refund-amount', 'fee-refund-recipient']) element<HTMLInputElement>(id).oninput = () => {
    state.refund = undefined
    element('fee-refund-review').textContent = ''
    element('request-fee-refund').hidden = true
  }
  button('review-fee-refund', 'Reviewing refund…', async () => {
    state.refund = undefined
    element('request-fee-refund').hidden = true
    const gross = amountFromInput(element<HTMLInputElement>('fee-refund-amount').value, WRAPPED_SYMBOL)
    const credit = await preparePrepaidRefund(session, creditStatus, selectedFunding())
    const nativePrepaid = credit.scope.funding === 'native'
    const creditSymbol = nativePrepaid ? NATIVE_SYMBOL : WRAPPED_SYMBOL
    const fee = prepaidRefundFee(credit), net = gross - fee
    const balance = await prepaidBalance(session, selectedFunding())
    showCredit(balance)
    if (gross > balance.available) throw new Error('The refund exceeds your available credit; reserved credit cannot be refunded.')
    if (net <= 0n) throw new Error('This refund would not cover its network fee allowance. The credit remains available for later attempts.')
    if (credit.maximumRefundGross === undefined) throw new Error('Refresh the refund quote before continuing.')
    if (gross > credit.maximumRefundGross) throw new Error(`Maximum refundable now: ${formatUnits(credit.maximumRefundGross, 18)} ${creditSymbol}, including the refund fee. Choose a smaller amount or try again later. Your credit remains available.`)
    const destination = nativePrepaid ? getAddress(element<HTMLInputElement>('fee-refund-recipient').value.trim()) : undefined
    state.refund = { credit, gross, net, recipient: destination }
    element('fee-refund-review').textContent = `Reserve ${formatUnits(gross, 18)} ${creditSymbol} credit\nMaximum processing fee: ${formatUnits(fee, 18)} ${creditSymbol}\nNet refund: ${formatUnits(net, 18)} ${creditSymbol}\nDestination: ${destination ?? 'this private wallet'}. ` +
      (nativePrepaid ? 'This payment is public. Unused gas allowance returns to credit; a failed or cancelled refund charges gas plus the reviewed margin only.' : 'The operator must process the private transfer.')
    element('request-fee-refund').hidden = false
  })
  button('request-fee-refund', 'Requesting refund…', async () => {
    const reviewed = state.refund
    state.refund = undefined
    element('request-fee-refund').hidden = true
    if (!reviewed) throw new Error('Review the refund amount and fee first.')
    const result = await requestPrepaidRefund(session, reviewed.credit, reviewed.gross, reviewed.recipient)
    const creditSymbol = result.funding === 'native' ? NATIVE_SYMBOL : WRAPPED_SYMBOL
    creditStatus(`Refund ${result.state}: ${formatUnits(result.net, 18)} ${creditSymbol} net to ${reviewed.recipient ?? 'this private wallet'}. Use Check or resume refund for confirmation.`)
    showCredit(await prepaidBalance(session, selectedFunding()))
  })
  button('check-fee-refund', 'Checking refund…', async () => {
    const result = await checkPrepaidRefund(session, selectedFunding())
    const creditSymbol = result.funding === 'native' ? NATIVE_SYMBOL : WRAPPED_SYMBOL
    creditStatus(result.state === 'not-reserved'
      ? 'The refund request was not accepted and no credit was reserved for it. Review a new refund request to continue.'
      : result.state === 'refunded'
      ? `Refund verified: ${formatUnits(result.net, 18)} ${creditSymbol} · ${result.transactionHash}`
      : result.state === 'failed' ? `Refund failed or was cancelled. No refund amount was paid. Processing charge: ${formatUnits(result.charged ?? 0n, 18)} ${creditSymbol}; the remaining hold is available as credit.`
      : 'The refund is not confirmed yet; its credit remains reserved. Check again without creating another request.')
    showCredit(await prepaidBalance(session, selectedFunding()))
    if (result.state === 'refunded') await syncWallet(session)
  })
  const showSwapQuote = (prepared: Awaited<ReturnType<typeof preparePrivateSwap>>): void => {
    state.swap = prepared
    const { quote } = prepared
    amount.value = formatUnits(quote.amount, TOKENS[quote.sell].decimals)
    const minimumAfterShield = quote.minimum - (quote.minimum * quote.shieldFee) / 10_000n
    element('receive-amount').textContent = formatUnits(minimumAfterShield, TOKENS[quote.buy].decimals)
    element('quote-details').textContent =
      `Amount to swap: ${formatUnits(quote.amount, TOKENS[quote.sell].decimals)} ${tokenFor(quote.sell).symbol}\nMinimum private output: ${formatUnits(minimumAfterShield, TOKENS[quote.buy].decimals)} ${tokenFor(quote.buy).symbol}\nOphis fee: ${formatUnits(quote.ophisFee, TOKENS[quote.buy].decimals)} ${tokenFor(quote.buy).symbol}\n${prepared.prepaid ? 'Maximum attempt charge from prepaid credit' : 'Broadcaster fee'}: ${formatUnits(prepared.fee.amount, tokenFor(prepared.prepaid ? WRAPPED_SYMBOL : feeTokenFor(quote.sell)).decimals)} ${prepared.prepaid ? creditSymbol : tokenFor(feeTokenFor(quote.sell)).symbol}\nProtocol unshield / reshield: ${quote.unshieldFee} / ${quote.shieldFee} bp`
    if (prepared.prepaid) element('quote-details').textContent += '\nThe attempt fee can be charged even if the swap fails. Unused credit remains available; refunds have a separate network fee.'
    if (quote.sell.startsWith('0x')) element('quote-details').textContent += `\nSell token contract: ${tokenFor(quote.sell).address}`
    if (quote.buy.startsWith('0x')) element('quote-details').textContent += `\nReceive token contract: ${tokenFor(quote.buy).address}`
    if (prepared.gasCapped)
      element('quote-details').textContent += `\nGas price capped at ${formatUnits(prepared.gas.maxFeePerGas, 9)} gwei to fit ${prepared.prepaid ? 'the prepaid operator limits' : 'your private balance'}. Rising gas prices can require a fresh quote.`
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
    const prepaid = usesPrepaid ? await preparePrepaid(session, broadcasterStatus) : undefined
    const selected = prepaid?.selected ?? await selectBroadcaster(TOKENS[feeTokenFor(sell)].address, true, broadcasterStatus)
    if (!prepaid && ENVIRONMENT === 'ethereum' && feeTokenFor(buySymbol()) !== feeTokenFor(sell)) await selectBroadcaster(TOKENS[feeTokenFor(buySymbol())].address, true, broadcasterStatus)
    const prepared = prepaid ? await prepareMaxPrivateSwap(session, sell, selected, undefined, buySymbol(), prepaid)
      : await prepareMaxPrivateSwap(session, sell, selected, undefined, buySymbol())
    showSwapQuote(prepared)
    element('quote-details').textContent = (prepaid ? 'Max uses the principal balance; the attempt fee uses prepaid credit.\n' : 'Max includes gas price headroom in the fee budget. Review the trade and committed fee below.\n') + element('quote-details').textContent
  })
  button('quote', 'Preparing quote…', async () => {
    invalidate()
    requireWalletSync()
    amountFromInput(amount.value, symbol())
    const prepaid = usesPrepaid ? await preparePrepaid(session, broadcasterStatus) : undefined
    const selected = prepaid?.selected ?? await selectBroadcaster(TOKENS[feeTokenFor(symbol())].address, true, broadcasterStatus)
    if (!prepaid && ENVIRONMENT === 'ethereum' && feeTokenFor(buySymbol()) !== feeTokenFor(symbol())) await selectBroadcaster(TOKENS[feeTokenFor(buySymbol())].address, true, broadcasterStatus)
    const account = await unusedSwapAccount(session)
    const quote = await quoteSwap(session.provider, symbol(), amount.value, account.address, buySymbol())
    let prepared: Awaited<ReturnType<typeof preparePrivateSwap>>
    try {
      prepared = prepaid ? await preparePrivateSwap(session, quote, selected, prepaid) : await preparePrivateSwap(session, quote, selected)
    } catch (error) {
      if (prepaid || !(error instanceof SwapBalanceError) || error.spendable !== quote.amount) throw error
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
    amount.value = ''
    status(`Swap confirmed: ${hash}. Updating private balance.`)
    try {
      await syncWallet(session)
    } catch (error) {
      status(`Swap confirmed: ${hash}. Private balance refresh is incomplete. Refresh balances to retry.`)
      throw error
    }
    status(`Swap confirmed: ${hash}. Private balance updated.`)
  })
  const reviewWithdrawal = async (maximum: boolean): Promise<void> => {
    invalidate()
    requireWalletSync()
    if (!maximum) amountFromInput(amount.value, symbol())
    const nativeOutput = CHAIN_ID === 56 && symbol() === 'WBNB' && element<HTMLInputElement>('withdraw-native').checked
    const prepaid = usesPrepaid ? await preparePrepaid(session, broadcasterStatus) : undefined
    const selected = prepaid?.selected ?? await selectBroadcaster(TOKENS[feeTokenFor(symbol())].address, usesBoundWithdrawal(symbol(), nativeOutput), broadcasterStatus)
    state.withdrawal = await prepareUnshield(
      session,
      symbol(),
      amount.value,
      recipient.value,
      selected,
      maximum,
      nativeOutput,
      ...(prepaid ? [prepaid] as const : []),
    )
    if (maximum) amount.value = formatUnits(state.withdrawal.amounts[0].amount, TOKENS[symbol()].decimals)
    element('withdraw-details').textContent =
      `Withdraw ${amount.value} ${tokenFor(symbol()).symbol} to ${recipient.value}\n${prepaid ? 'Maximum attempt charge from prepaid credit' : 'Broadcaster fee'}: ${formatUnits(state.withdrawal.fee.amount, tokenFor(prepaid ? WRAPPED_SYMBOL : feeTokenFor(symbol())).decimals)} ${prepaid ? creditSymbol : tokenFor(feeTokenFor(symbol())).symbol}\n${prepaid ? 'The attempt fee can be charged even if the withdrawal fails.' : 'The broadcaster fee is paid from your private balance.'} The protocol withdrawal fee is deducted from the amount.\nYou receive: ${formatUnits(state.withdrawal.minimum, TOKENS[symbol()].decimals)} ${nativeOutput ? 'BNB' : tokenFor(symbol()).symbol}`
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
    status(await resumePendingWithdrawal(session, signer, () => assertPublicEpoch(epoch)))
    await syncWallet(session)
  })
  button('recover', 'Recovering…', async () => {
    const hash = await recoverToken(session, recoveryIndex(element<HTMLInputElement>('recovery-index').value), symbol())
    status(`Recovery shield confirmed: ${hash}`)
    await syncWallet(session)
  })
}
