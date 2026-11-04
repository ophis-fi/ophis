import { CHAIN_ID, CHAIN_NAME, ENVIRONMENT, NATIVE_SYMBOL, PILOT_WITHDRAWAL_RECIPIENT, PRIVATE_SLIPPAGE_BPS, TOKENS, WRAPPED_SYMBOL } from './config'
import { privateNetwork } from './networks'
import { element } from './ui'

export function configurePrivateSelectors(): void {
  const network = element<HTMLSelectElement>('private-network')
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
  element('swap-route-help').textContent = `Ophis selects the best supported pool route on ${CHAIN_NAME}. Price tolerance ${Number(PRIVATE_SLIPPAGE_BPS) / 100}%. Ophis charges 0.1%; protocol, pool and broadcaster fees are additional.`
}
