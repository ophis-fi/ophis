import { CHAIN_ID, CHAIN_NAME, ENVIRONMENT, NATIVE_SYMBOL, PILOT_WITHDRAWAL_RECIPIENT, PRIVATE_SLIPPAGE_BPS, TOKENS, WRAPPED_SYMBOL, tokenIdFor } from './config'
import { PRIVATE_NETWORKS, privateNetwork } from './networks'
import { element } from './ui'
import { getAddress } from 'ethers'

export function refreshTokenSelectors(holdings: readonly string[] = []): void {
  for (const id of ['token', 'buy-token', 'shield-token']) {
    const select = element<HTMLSelectElement>(id)
    const selected = select.value
    const options = Object.entries(TOKENS).map(([key, token]) => {
      const option = new Option(`${token.symbol}${token.bridged ? ' (bridged)' : ''}${key.startsWith('0x') ? ` · ${token.address}` : ''}`, key)
      option.dataset.symbol = token.symbol
      option.dataset.address = token.address
      if (token.bridged) option.dataset.bridged = 'true'
      return option
    })
    for (const value of new Set(holdings.map(address => getAddress(address)))) {
      if (tokenIdFor(value)) continue
      const option = new Option(`Token in your private wallet · ${value}`, value.toLowerCase())
      option.dataset.address = value
      option.dataset.pendingMetadata = 'true'
      options.push(option)
    }
    if (id === 'shield-token') options.unshift(new Option(NATIVE_SYMBOL, NATIVE_SYMBOL))
    select.replaceChildren(...options)
    select.value = selected
    if (!select.value) select.value = id === 'token' ? (ENVIRONMENT === 'ethereum' && PILOT_WITHDRAWAL_RECIPIENT ? 'USDC' : WRAPPED_SYMBOL) : id === 'buy-token' ? 'USDC' : NATIVE_SYMBOL
  }
}

export function configurePrivateSelectors(): void {
  const network = element<HTMLSelectElement>('private-network')
  network.replaceChildren(...PRIVATE_NETWORKS.map((item) => new Option(item.name, String(item.chainId))))
  network.value = String(CHAIN_ID)
  network.onchange = () => {
    const selected = privateNetwork(Number(network.value))
    const url = new URL(location.href)
    url.searchParams.set('chainId', String(selected.chainId))
    location.assign(url.href)
  }
  refreshTokenSelectors()
  element<HTMLSelectElement>('token').value = ENVIRONMENT === 'ethereum' && PILOT_WITHDRAWAL_RECIPIENT ? 'USDC' : WRAPPED_SYMBOL
  element<HTMLSelectElement>('buy-token').value = 'USDC'
  element<HTMLSelectElement>('shield-token').value = NATIVE_SYMBOL
  element('native-shield-help').textContent = `${NATIVE_SYMBOL} is wrapped and shielded in one wallet transaction, without a separate wrapping step. Private holdings are ${WRAPPED_SYMBOL}. Keep ${NATIVE_SYMBOL} in your public wallet for gas.`
  element('switch-network').textContent = `Switch to ${CHAIN_NAME}`
  element('recovery-gas-help').textContent = `Recovery requires ${NATIVE_SYMBOL} for gas. Funding a temporary account from your public wallet creates a public link.`
  element('cancel-gas-symbol').textContent = NATIVE_SYMBOL
  element('swap-route-help').textContent = `Best supported pool route on ${CHAIN_NAME}. Slippage ${Number(PRIVATE_SLIPPAGE_BPS) / 100}%. Ophis, protocol and broadcaster fees are shown before confirmation.`
  element('private-submission-help').textContent = CHAIN_ID === 1
    ? 'Ethereum swaps use private submission to reduce frontrunning. Trade details are visible to the simulation node and block builders, and public after confirmation. Slippage still applies.'
    : 'Ophis protected swaps are not available on this network. Existing balances and recovery remain accessible.'
}
