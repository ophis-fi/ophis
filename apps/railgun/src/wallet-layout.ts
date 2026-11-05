import { element } from './ui'

type WalletView = 'swap' | 'deposit-details' | 'withdrawal' | 'wallet-details' | 'recovery'
let view: WalletView = 'swap'
let review = false
let firstFunding = false
let pendingSeen = false
let refreshTokenControls = (): void => {}

function focusSwapAmount(): void {
  const amount = element<HTMLInputElement>('amount')
  ;(amount.matches(':disabled') ? element('wallet-menu-button') : amount).focus()
}

export function showWalletView(next: WalletView): void {
  view = next
  if (next !== 'swap') review = false
  renderWalletLayout()
  if (next !== 'swap') {
    const heading = element('wallet-view-title')
    heading.tabIndex = -1
    heading.focus()
  }
}

export function setSwapReview(visible: boolean): void {
  const changed = review !== visible
  review = visible
  renderWalletLayout()
  if (changed) {
    if (visible) element('swap-review-title').focus()
    else focusSwapAmount()
  }
}

export function renderWalletLayout(): void {
  element('trade-cards').hidden = !['swap', 'withdrawal'].includes(view) || (view === 'swap' && review)
  element('receive-card').hidden = view === 'withdrawal'
  element('trade-arrow').hidden = view === 'withdrawal'
  element('max-swap').hidden = view !== 'swap'
  const control = element('sell-token-control')
  element('token').setAttribute('aria-label', view === 'recovery' ? 'Token to recover' : view === 'withdrawal' ? 'Token to withdraw' : 'Token to sell')
  const tokenHome = element(view === 'recovery' ? 'recovery-token-target' : 'sell-token-home')
  if (control.parentElement !== tokenHome) { tokenHome.append(control); refreshTokenControls() }
  if (!document.documentElement.dataset.busy) element('recover').textContent = `Reshield ${element<HTMLSelectElement>('token').value}`
  element('sell-label').textContent = view === 'withdrawal' ? 'You withdraw' : 'You sell'
  element('amount').setAttribute('aria-label', view === 'withdrawal' ? 'Amount to withdraw' : 'Amount to sell')
  element('trade-actions').hidden = view !== 'swap' || review
  element('swap-review').hidden = view !== 'swap' || !review
  element('wallet-back').hidden = view === 'swap'
  element('wallet-view-title').textContent = ({ swap: '', 'deposit-details': 'Add funds', withdrawal: 'Withdraw',
    'wallet-details': 'Wallet & activity', recovery: 'Recovery' })[view]
  for (const id of ['deposit-details', 'withdrawal', 'wallet-details', 'recovery'] as const) {
    const panel = element<HTMLDetailsElement>(id)
    panel.hidden = view !== id
    panel.open = view === id
  }
  element('deposit-connect').hidden = element('connect').hidden && element('walletconnect').hidden
  element('withdraw-quote').classList.toggle('secondary-action', !element('withdraw').hidden)
}

export function showSetup(hasWallet: boolean, phase: 'welcome' | 'backup' = 'welcome', restore = false): void {
  element('setup-intro').hidden = phase === 'backup'
  element('setup-title').textContent = phase === 'backup' ? (restore ? 'Restore your private wallet' : 'Back up your private wallet')
    : hasWallet ? 'Welcome back' : 'Set up your private wallet'
  element('setup-help').textContent = phase === 'backup'
    ? 'Use a dedicated private-wallet phrase. Never enter your public-wallet or Ledger recovery phrase.'
    : hasWallet ? 'Unlock your saved private balance to continue.' : 'Create your private wallet once, then add funds when you are ready.'
  element('generate').hidden = hasWallet || phase === 'backup'
  element('unlock').hidden = !hasWallet || phase === 'backup'
  element('wallet-password').hidden = !hasWallet && phase !== 'backup'
  element('new-wallet-form').hidden = phase !== 'backup'
  element('restore-setup').hidden = hasWallet || phase === 'backup'
  element('setup-back').hidden = phase !== 'backup'
  element('open').textContent = restore ? 'Restore private wallet' : 'Save and continue'
  element<HTMLInputElement>('password').autocomplete = phase === 'backup' ? 'new-password' : 'current-password'
  if (phase === 'backup') element('setup-title').focus()
}

export function startFirstFunding(): void {
  firstFunding = true
  element('first-funding-guide').hidden = false
  showWalletView('deposit-details')
}

export function finishFirstFunding(): void {
  firstFunding = false
  element('first-funding-guide').hidden = true
  showWalletView('swap')
}

export function updateFirstFunding(hasFunds: boolean, ready: boolean): void {
  if (!firstFunding || !hasFunds || !ready) return
  const moveFocus = element('deposit-details').contains(document.activeElement) || element('first-funding-guide').contains(document.activeElement)
  firstFunding = false
  element('first-funding-guide').hidden = true
  if (view === 'deposit-details' && !document.documentElement.dataset.busy) showWalletView('swap')
  if (moveFocus) {
    if (view === 'swap') focusSwapAmount()
    else element('wallet-view-title').focus()
  }
}

export function setPendingNotice(pending: boolean): void {
  element('pending-notice').hidden = !pending
  if (pending && !pendingSeen) showWalletView('recovery')
  pendingSeen = pending
}

export function configureWalletLayout(refreshPickers: () => void): void {
  refreshTokenControls = refreshPickers
  const menu = element<HTMLDialogElement>('wallet-menu')
  const trigger = element<HTMLButtonElement>('wallet-menu-button')
  trigger.onclick = () => menu.showModal()
  element('wallet-menu-close').onclick = () => { menu.close(); trigger.focus() }
  menu.addEventListener('cancel', () => queueMicrotask(() => trigger.focus()))
  for (const id of ['deposit-shortcut', 'withdraw-shortcut', 'activity-shortcut', 'recovery-shortcut']) {
    const link = element<HTMLAnchorElement>(id)
    link.onclick = (event) => {
      event.preventDefault()
      if (document.documentElement.dataset.busy) return
      menu.close()
      showWalletView(link.hash.slice(1) as WalletView)
    }
  }
  element('wallet-back').onclick = () => {
    showWalletView('swap')
    focusSwapAmount()
  }
  element('edit-swap').onclick = () => { review = false; renderWalletLayout(); element('amount').focus() }
  element('skip-funding').onclick = () => {
    finishFirstFunding()
    focusSwapAmount()
  }
  element('continue-pending').onclick = () => showWalletView('recovery')
  const connection = element<HTMLDialogElement>('public-connect-options')
  element('deposit-connect').onclick = () => { if (!document.documentElement.dataset.busy) connection.showModal() }
  element('public-connect-close').onclick = () => { connection.close(); element('deposit-connect').focus() }
  connection.addEventListener('cancel', () => queueMicrotask(() => element('deposit-connect').focus()))
  for (const id of ['connect', 'walletconnect']) {
    const button = element(id)
    button.addEventListener('click', () => connection.close(), { capture: true })
    new MutationObserver(renderWalletLayout).observe(button, { attributes: true, attributeFilter: ['hidden'] })
  }
  // Existing controls keep their guarded handlers; views only change their presentation.
  renderWalletLayout()
}
