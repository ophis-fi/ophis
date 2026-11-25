import { useAtom } from 'jotai'
import { useEffect } from 'react'

import { solanaConnectionAtom } from './solana.atoms'
import { OPHIS_SOLANA_CONFIG } from './solana.constants'

export function useSolanaWalletEvents(): void {
  const [connection, setConnection] = useAtom(solanaConnectionAtom)
  useEffect(() => {
    if (!connection) return undefined
    return connection.wallet.features['standard:events'].on('change', ({ accounts, chains }) => {
      // A change invalidates the quote and requires explicit account selection again.
      if (accounts || chains || !OPHIS_SOLANA_CONFIG) setConnection(null)
    })
  }, [connection, setConnection])
}
