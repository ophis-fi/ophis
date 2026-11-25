import { getAddressKey } from '@cowprotocol/cow-sdk'

export function isSolanaAffiliateAddress(wallet: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)
}

export function affiliateAddressKey(wallet: string): string {
  return isSolanaAffiliateAddress(wallet) ? wallet : getAddressKey(wallet)
}

export function referralShareLink(code: string, solana: boolean): string {
  return `https://swap.ophis.fi/?ref=${encodeURIComponent(code)}${solana ? '#/swap?network=solana' : ''}`
}
