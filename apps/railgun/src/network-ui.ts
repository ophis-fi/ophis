import { CHAIN_ID, CHAIN_NAME, ENVIRONMENT, NATIVE_SYMBOL, PILOT_WITHDRAWAL_RECIPIENT, PRIVATE_SLIPPAGE_BPS, TOKENS, WRAPPED_SYMBOL } from './config'
import { PRIVATE_NETWORKS, privateNetwork } from './networks'
import { element } from './ui'

export function configurePrivateSelectors(): void {
  const network = element<HTMLSelectElement>('private-network')
  network.replaceChildren(...PRIVATE_NETWORKS.map((item) => new Option(`${item.name} · ${item.nativeSymbol}`, String(item.chainId))))
  network.value = String(CHAIN_ID)
  network.onchange = () => {
    const selected = privateNetwork(Number(network.value))
    const url = new URL(location.href)
    url.searchParams.set('chainId', String(selected.chainId))
    location.assign(url.href)
  }
  for (const id of ['token', 'buy-token', 'shield-token']) {
    const select = element<HTMLSelectElement>(id)
    const options = Object.values(TOKENS).map((token) => new Option(
      `${token.symbol}${token.bridged ? ' (bridged)' : ''}`, token.symbol,
    ))
    if (id === 'shield-token') options.unshift(new Option(NATIVE_SYMBOL, NATIVE_SYMBOL))
    select.replaceChildren(...options)
    select.value = id === 'token' ? (ENVIRONMENT === 'ethereum' && PILOT_WITHDRAWAL_RECIPIENT ? 'USDC' : WRAPPED_SYMBOL) : id === 'buy-token' ? 'USDC' : NATIVE_SYMBOL
  }
  element('native-shield-help').textContent = `${NATIVE_SYMBOL} is wrapped and shielded in one wallet transaction, without a separate wrapping step. Private holdings are ${WRAPPED_SYMBOL}. Keep ${NATIVE_SYMBOL} in your public wallet for gas.`
  element('switch-network').textContent = `Switch to ${CHAIN_NAME}`
  element('recovery-gas-help').textContent = `Recovery requires ${NATIVE_SYMBOL} for gas. Funding a temporary account from your public wallet creates a public link.`
  element('cancel-gas-symbol').textContent = NATIVE_SYMBOL
  element('swap-route-help').textContent = `Best supported pool route on ${CHAIN_NAME}. Slippage ${Number(PRIVATE_SLIPPAGE_BPS) / 100}%. Ophis, protocol and broadcaster fees are shown before confirmation.`
  element('private-submission-help').textContent = CHAIN_ID === 1
    ? 'Ethereum swaps use private submission to reduce frontrunning. Trade details are visible to the simulation node and block builders, and public after confirmation. Slippage still applies.'
    : 'Ophis protected swaps are not available on this network. Existing balances and recovery remain accessible.'
}
