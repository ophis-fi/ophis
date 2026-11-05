import { CHAIN_ID, tokenFor, type TokenSymbol } from './config'
import { formatUnits } from 'ethers'

export function feeTokenFor(principal: TokenSymbol): TokenSymbol {
  return CHAIN_ID === 56 ? 'WBNB' : principal
}

export function usesBoundWithdrawal(token: TokenSymbol): boolean {
  return CHAIN_ID === 56 && (token === 'USDC' || token === 'USDT')
}

export function feeAddressFor(principalAddress: string): string {
  return CHAIN_ID === 56 ? tokenFor('WBNB').address : principalAddress
}

export function requireFeeBalance(spendable: bigint, required: bigint, token: TokenSymbol): void {
  if (spendable >= required) return
  const asset = tokenFor(token)
  throw new Error(`Insufficient spendable private ${token} for the broadcaster fee. Available: ${formatUnits(spendable, asset.decimals)} ${token}; required: ${formatUnits(required, asset.decimals)} ${token}. Add ${token === 'WBNB' ? 'BNB or WBNB' : token} to your private wallet for fees. Your swap or withdrawal amount is separate.`)
}
