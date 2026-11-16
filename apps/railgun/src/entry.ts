import './style.css'
import { CHAIN_ID, CHAIN_NAME, ENVIRONMENT } from './config'
import { PRIVATE_NETWORKS } from './networks'
import { PRODUCTION_PRIVATE_CHAIN_IDS } from '../rpc-policy'

if (ENVIRONMENT === 'ethereum' && !PRODUCTION_PRIVATE_CHAIN_IDS.includes(CHAIN_ID)) {
  const title = document.createElement('h1')
  title.textContent = `${CHAIN_NAME} private swaps are unavailable`
  const help = document.createElement('p')
  help.textContent = 'Choose Ethereum, BNB Chain or Arbitrum. Your saved wallet and transaction data has not been changed.'
  const networks = document.createElement('nav')
  networks.className = 'wallet-menu-links'
  networks.setAttribute('aria-label', 'Available private networks')
  for (const network of PRIVATE_NETWORKS.filter(item => PRODUCTION_PRIVATE_CHAIN_IDS.includes(item.chainId))) {
    const link = document.createElement('a'), url = new URL(location.href)
    url.searchParams.set('chainId', String(network.chainId))
    link.href = url.href
    link.textContent = network.name
    networks.append(link)
  }
  document.querySelector('main')?.replaceChildren(title, help, networks)
} else {
  void import('./main')
}
