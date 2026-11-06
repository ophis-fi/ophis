import { CHAIN_ID, WRAPPED_SYMBOL, tokenFor, tokenIdFor, type TokenSymbol } from './config'
import { formatUnits } from 'ethers'

export function feeTokenFor(principal: TokenSymbol): TokenSymbol {
  return CHAIN_ID === 56 || principal.startsWith('0x') ? WRAPPED_SYMBOL : principal
}

export function usesBoundWithdrawal(token: TokenSymbol, nativeOutput = false): boolean {
  return nativeOutput || tokenFor(token).address.toLowerCase() !== tokenFor(feeTokenFor(token)).address.toLowerCase()
}

export function feeAddressFor(principalAddress: string): string {
  const principal = tokenIdFor(principalAddress)
  return tokenFor(principal ? feeTokenFor(principal) : WRAPPED_SYMBOL).address
}

export function requireFeeBalance(spendable: bigint, required: bigint, token: TokenSymbol): void {
  if (spendable >= required) return
  const asset = tokenFor(token)
  throw new Error(`Insufficient spendable private ${asset.symbol} for the broadcaster fee. Available: ${formatUnits(spendable, asset.decimals)} ${asset.symbol}; required: ${formatUnits(required, asset.decimals)} ${asset.symbol}. Add ${token === 'WBNB' ? 'BNB or WBNB' : asset.symbol} to your private wallet for fees. Your swap or withdrawal amount is separate.`)
}
