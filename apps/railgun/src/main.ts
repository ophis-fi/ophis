import './style.css'
import { formatUnits } from 'ethers'
import { newMnemonic, openWallet, startWalletEngine, syncWallet, type WalletSession } from './wallet'
import { CHAIN_NAME, ENVIRONMENT, TOKENS } from './config'
import { configurePrivateSelectors } from './network-ui'
import { reportEmbeddedLayout } from './embedded'
import { configurePickers } from './pickers'
import { readPreference } from './storage'
import { configureWalletLayout, showSetup, startFirstFunding, updateFirstFunding } from './wallet-layout'

import { element, run } from './ui'
import { wireWalletActions } from './wallet-actions'

const status = element('status')
element('environment').textContent =
  ENVIRONMENT === 'fork' ? `Local ${CHAIN_NAME} fork · Test wallets only` : 'Mainnet'
configurePrivateSelectors()
configurePickers()
configureWalletLayout()
reportEmbeddedLayout()
const password = element<HTMLInputElement>('password')
const mnemonic = element<HTMLTextAreaElement>('mnemonic')
const backup = element<HTMLInputElement>('backup')
const session: { current?: WalletSession } = {}
const buckets = new Map<string, string>()
const started: { provider?: ReturnType<typeof startWalletEngine> } = {}
const setup: { generated?: string; ready: boolean; hasWallet: boolean; hasFunds: boolean } = {
  ready: false, hasWallet: false, hasFunds: false,
}
void readPreference<unknown>('wallet').then((stored) => {
  setup.hasWallet = stored !== undefined
  showSetup(setup.hasWallet)
  element('restore-setup').hidden = false
}).catch(() => {
  element('error').textContent = 'Saved wallet metadata could not be read. Restore your private wallet in a fresh browser profile.'
})

function renderSelectedBalance(): void {
  const selected = element<HTMLSelectElement>('token').value
  const spendable = buckets.get('Spendable')?.split('\n').find((line) => line.startsWith(`${selected}:`))
  element('spendable-balance').textContent = setup.ready ? `${spendable?.slice(selected.length + 1).trim() || '0'} ${selected}` : 'Synchronizing…'
  element('pending-balances').textContent = [...buckets.entries()]
    .filter(([name]) => name !== 'Spendable')
    .map(([, value]) => value).join('\n\n') || 'No pending deposits.'
}
element<HTMLSelectElement>('token').addEventListener('input', renderSelectedBalance)

element<HTMLButtonElement>('generate').onclick = () => {
  setup.generated = newMnemonic()
  mnemonic.value = setup.generated
  backup.checked = false
  showSetup(setup.hasWallet, 'backup')
}
mnemonic.oninput = () => { setup.generated = undefined; backup.checked = false }
element('restore-setup').onclick = () => {
  setup.generated = undefined
  mnemonic.value = ''
  backup.checked = false
  showSetup(setup.hasWallet, 'backup', true)
}
element('setup-back').onclick = () => {
  mnemonic.value = password.value = ''
  setup.generated = undefined
  backup.checked = false
  showSetup(setup.hasWallet)
}

function startHistory(): ReturnType<typeof startWalletEngine> {
  started.provider ??= startWalletEngine(
        (event) => {
          if (session.current && event.railgunWalletID !== session.current.info.id) return
          let spendable = false
          const values = event.erc20Amounts.map((balance) => {
            const token = Object.entries(TOKENS).find(
              ([, value]) => value.address.toLowerCase() === balance.tokenAddress.toLowerCase(),
            )
            if (token && balance.amount > 0n) spendable = true
            return token
              ? `${token[0]}: ${formatUnits(balance.amount, token[1].decimals)}`
              : `${balance.tokenAddress}: ${balance.amount} units`
          })
          buckets.set(
            event.balanceBucket,
            `${event.balanceBucket}\n${values.join('\n') || 'No balance in this category.'}`,
          )
          if (event.balanceBucket === 'Spendable') setup.hasFunds = spendable
          updateFirstFunding(setup.hasFunds, setup.ready)
          element('balances').textContent = [...buckets.values()].join('\n\n')
          renderSelectedBalance()
        },
        (message, ready) => {
          setup.ready = ready
          updateFirstFunding(setup.hasFunds, ready)
          status.textContent = ready ? '' : message
          element('balance-sync').hidden = ready
          element<HTMLFieldSetElement>('ready-actions').disabled = !ready
          const progress = element<HTMLProgressElement>('history-progress')
          progress.hidden = ready
          const percentage = /(\d+)%/.exec(message)
          if (percentage) progress.value = Number(percentage[1])
          else progress.removeAttribute('value')
          renderSelectedBalance()
        },
      ).catch((error: unknown) => {
        started.provider = undefined
        throw error
      })
  return started.provider
}

// Cache and verify public history while the user creates or unlocks the private wallet.
void startHistory().catch((error: unknown) => {
  element('error').textContent = error instanceof Error ? error.message : 'Private history could not start. Unlock to retry.'
})

for (const id of ['open', 'unlock']) {
  const button = element<HTMLButtonElement>(id)
  button.onclick = () =>
    run(button, 'Opening wallet…', async () => {
      if (id === 'open' && !backup.checked)
        throw new Error('Save the recovery phrase before creating or restoring the wallet.')
      const fresh = id === 'open' && setup.generated === mnemonic.value.trim()
      const provider = await startHistory()
      session.current = await openWallet(provider, password.value, id === 'open' ? mnemonic.value.trim() : undefined,
        fresh)
      password.value = ''
      mnemonic.value = ''
      setup.generated = undefined
      element('setup').hidden = true
      element<HTMLSelectElement>('private-network').disabled = true
      element('private-network').title = 'Lock your private wallet to change networks.'
      element('private-network-help').textContent = 'Lock the private wallet to change networks. Pending transactions stay saved on their original network.'
      element('wallet').hidden = false
      element('address').textContent = session.current.info.railgunAddress
      await wireWalletActions(session.current)
      if (fresh) { startFirstFunding(); updateFirstFunding(setup.hasFunds, setup.ready) }
      void syncWallet(session.current).catch((error: unknown) => {
        element('error').textContent = error instanceof Error ? error.message : 'Private balance sync failed.'
      })
    }).finally(() => {
      if (session.current) element<HTMLSelectElement>('private-network').disabled = true
    })
}

element<HTMLButtonElement>('lock').onclick = () => location.reload()
const refresh = element<HTMLButtonElement>('refresh')
refresh.onclick = () =>
  run(refresh, 'Refreshing…', async () => {
    element('private-wallet-error').textContent = ''
    if (session.current) await syncWallet(session.current)
  })
