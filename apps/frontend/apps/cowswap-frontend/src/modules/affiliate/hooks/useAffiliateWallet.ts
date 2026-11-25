import { useAtomValue } from 'jotai'

import { useWalletInfo } from '@cowprotocol/wallet'

import { OPHIS_SOLANA_CONFIG, solanaConnectionAtom, type SolanaConnection } from 'entities/solana'
import { useLocation } from 'react-router'

interface AffiliateWallet {
  account: string | undefined
  isSolana: boolean
  requestedNetwork: string | null
  solana: SolanaConnection | null
  enabled: boolean
  needsMessageSigning: boolean
}

function needsSolanaMessageSigning(solana: SolanaConnection | null): boolean {
  return Boolean(
    solana &&
      (!solana.account.features.includes('solana:signMessage') || !solana.wallet.features['solana:signMessage']),
  )
}

export function useAffiliateWallet(): AffiliateWallet {
  const { account: evm } = useWalletInfo()
  const solana = useAtomValue(solanaConnectionAtom)
  const { search } = useLocation()
  const network = new URLSearchParams(search).get('network')
  const enabled = OPHIS_SOLANA_CONFIG?.chain === 'solana:mainnet'
  const isSolana = enabled && (network === 'solana' || (!evm && !!solana && network !== 'evm'))
  const account = isSolana ? solana?.account.address : network === 'solana' ? undefined : evm
  return {
    needsMessageSigning: isSolana && needsSolanaMessageSigning(solana),
    account,
    isSolana,
    requestedNetwork: network,
    solana,
    enabled,
  }
}
