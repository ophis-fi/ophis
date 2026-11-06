import { configurePickers } from '../src/pickers'
import { configureWalletLayout, showSetup, showWalletView, setSwapReview, setPendingNotice,
  startFirstFunding, updateFirstFunding, finishFirstFunding } from '../src/wallet-layout'
import { run } from '../src/ui'

// DOM-only fixture: no wallet engine, storage, RPC or transaction handlers.
const fixture = { showSetup, showWalletView, setSwapReview, setPendingNotice, startFirstFunding,
  updateFirstFunding, finishFirstFunding, run }
declare global { interface Window { ophisUiFixture: typeof fixture } }
window.ophisUiFixture = fixture
configureWalletLayout(configurePickers(async address => {
  for (const id of ['token', 'buy-token', 'shield-token']) {
    const select = document.getElementById(id) as HTMLSelectElement
    for (const existing of [...select.options]) if (existing.value === address.toLowerCase()) existing.remove()
    const option = new Option(`CUSTOM · ${address}`, address.toLowerCase())
    option.dataset.symbol = 'CUSTOM'
    option.dataset.address = address
    select.append(option)
  }
  return address.toLowerCase()
}))
document.getElementById('setup')!.hidden = true
document.getElementById('wallet')!.hidden = false
for (const id of ['history-progress', 'balance-sync']) document.getElementById(id)!.hidden = true
document.getElementById('status')!.textContent = ''
document.getElementById('environment')!.textContent = 'UI fixture'
document.getElementById('spendable-balance')!.textContent = '0 WETH'
;(document.getElementById('ready-actions') as HTMLFieldSetElement).disabled = false
