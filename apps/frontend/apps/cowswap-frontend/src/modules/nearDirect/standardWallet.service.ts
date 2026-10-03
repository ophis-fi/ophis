import { isSuiAddress } from '@cowprotocol/common-utils'
import { isSolanaAddress } from '@cowprotocol/cow-sdk'

import { NearTransfer } from './nearDirect.schemas'
import { assertFundingDeadline } from './sourceWallet.service'
import { SourceStandardWallet, StandardConnection, StandardSourceChain } from './standardWallet.atoms'

import type { Wallet, WalletAccount } from '@mysten/wallet-standard'

export const STANDARD_SOURCE_NETWORKS = { sol: 'solana:mainnet', sui: 'sui:mainnet' } as const
export const STANDARD_SEND_FEATURES = {
  sol: 'solana:signAndSendTransaction',
  sui: 'sui:signAndExecuteTransaction',
} as const

export function supportsSourceWallet(wallet: Wallet, chain: StandardSourceChain): wallet is SourceStandardWallet {
  return (
    wallet.chains.includes(STANDARD_SOURCE_NETWORKS[chain]) &&
    (['standard:connect', 'standard:events', STANDARD_SEND_FEATURES[chain]] as const).every(
      (feature) => !!wallet.features[feature],
    )
  )
}

export function sourceWalletAccounts(
  wallet: SourceStandardWallet,
  chain: StandardSourceChain,
): readonly WalletAccount[] {
  return wallet.accounts.filter(
    (account) =>
      account.chains.includes(STANDARD_SOURCE_NETWORKS[chain]) &&
      account.features.includes(STANDARD_SEND_FEATURES[chain]) &&
      (chain === 'sol' ? isSolanaAddress(account.address) : isSuiAddress(account.address)),
  )
}

export function assertStandardFundingWallet(
  connection: StandardConnection,
  transfer: NearTransfer,
  chain: StandardSourceChain,
): void {
  const { wallet, account } = connection
  const refund = transfer.response.quoteRequest.refundTo
  if (
    !supportsSourceWallet(wallet, chain) ||
    !sourceWalletAccounts(wallet, chain).includes(account) ||
    (chain === 'sui' ? BigInt(account.address) !== BigInt(refund) : account.address !== refund)
  )
    throw new Error('Reconnect the refund wallet on the sending network before sending.')
  assertFundingDeadline(transfer)
}
