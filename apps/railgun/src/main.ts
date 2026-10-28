import './style.css'
import { formatUnits } from 'ethers'
import { newMnemonic, openWallet, startWalletEngine, syncWallet, type WalletSession } from './wallet'
import { CHAIN_NAME, ENVIRONMENT, TOKENS } from './config'
import { configurePrivateSelectors } from './network-ui'
import { reportEmbeddedLayout } from './embedded'

import { element, run } from './ui'
import { wireWalletActions } from './wallet-actions'

const status = element('status')
element('environment').textContent =
  ENVIRONMENT === 'fork' ? `Local ${CHAIN_NAME} fork · Test wallets only` : `${CHAIN_NAME} mainnet`
configurePrivateSelectors()
reportEmbeddedLayout()
const password = element<HTMLInputElement>('password')
const mnemonic = element<HTMLTextAreaElement>('mnemonic')
const backup = element<HTMLInputElement>('backup')
const session: { current?: WalletSession } = {}
const buckets = new Map<string, string>()
const started: { provider?: ReturnType<typeof startWalletEngine> } = {}

function renderSelectedBalance(): void {
  const selected = element<HTMLSelectElement>('token').value
  const spendable = buckets.get('Spendable')?.split('\n').find((line) => line.startsWith(`${selected}:`))
  element('spendable-balance').textContent = spendable || `0 ${selected}`
  element('pending-balances').textContent = [...buckets.entries()]
    .filter(([name]) => name !== 'Spendable')
    .map(([, value]) => value).join('\n\n') || 'No pending deposits.'
}
element<HTMLSelectElement>('token').addEventListener('input', renderSelectedBalance)

element<HTMLButtonElement>('generate').onclick = () => {
  mnemonic.value = newMnemonic()
  backup.checked = false
}

for (const id of ['open', 'unlock']) {
  const button = element<HTMLButtonElement>(id)
  button.onclick = () =>
    run(button, 'Opening wallet…', async () => {
      if (id === 'open' && !backup.checked)
        throw new Error('Save the recovery phrase before creating or restoring the wallet.')
      started.provider ??= startWalletEngine(
        (event) => {
          if (session.current && event.railgunWalletID !== session.current.info.id) return
          const values = event.erc20Amounts.map((balance) => {
            const token = Object.entries(TOKENS).find(
              ([, value]) => value.address.toLowerCase() === balance.tokenAddress.toLowerCase(),
            )
            return token
              ? `${token[0]}: ${formatUnits(balance.amount, token[1].decimals)}`
              : `${balance.tokenAddress}: ${balance.amount} units`
          })
          buckets.set(
            event.balanceBucket,
            `${event.balanceBucket}\n${values.join('\n') || 'No balance in this category.'}`,
          )
          element('balances').textContent = [...buckets.values()].join('\n\n')
          renderSelectedBalance()
        },
        (message, ready) => {
          status.textContent = message
          element('balance-sync').hidden = ready
        },
      ).catch((error: unknown) => {
        started.provider = undefined
        throw error
      })
      const provider = await started.provider
      session.current = await openWallet(provider, password.value, id === 'open' ? mnemonic.value.trim() : undefined)
      password.value = ''
      mnemonic.value = ''
      element('setup').hidden = true
      element<HTMLSelectElement>('private-network').disabled = true
      element('private-network-help').textContent = 'Lock the private wallet to change networks. Pending transactions stay saved on their original network.'
      element('wallet').hidden = false
      element('address').textContent = session.current.info.railgunAddress
      await wireWalletActions(session.current)
      status.textContent = 'Wallet unlocked. Synchronizing private balances.'
      void syncWallet(session.current).catch((error: unknown) => {
        element('error').textContent = error instanceof Error ? error.message : 'Private balance sync failed.'
      })
    })
}

element<HTMLButtonElement>('lock').onclick = () => location.reload()
const refresh = element<HTMLButtonElement>('refresh')
refresh.onclick = () =>
  run(refresh, 'Refreshing…', async () => {
    element('private-wallet-error').textContent = ''
    if (session.current) await syncWallet(session.current)
  })
