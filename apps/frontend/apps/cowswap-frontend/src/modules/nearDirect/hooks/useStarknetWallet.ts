import { atom, useAtom } from 'jotai'
import { useEffect } from 'react'

import { getStarknetAccount, StarknetWallet } from '../starknetWallet.service'

interface StarknetConnection {
  wallet: StarknetWallet
  address: string
}
const connectionAtom = atom<StarknetConnection | null>(null)

export function useStarknetWallet(): {
  connection: StarknetConnection | null
  setConnection(value: StarknetConnection | null): void
} {
  const [connection, setConnection] = useAtom(connectionAtom)
  const wallet = connection?.wallet
  useEffect(() => {
    if (!wallet || !connection) return
    // A changed account/network requires a new explicit connection; never reuse
    // an old refund address or silently switch the signer for a reviewed quote.
    const invalidate = (): void => setConnection((current) => (current?.wallet === wallet ? null : current))
    let active = true
    void getStarknetAccount(wallet, true)
      .then((address) => {
        if (active && BigInt(address) !== BigInt(connection.address)) invalidate()
      })
      .catch(() => {
        if (active) invalidate()
      })
    wallet.on('accountsChanged', invalidate)
    wallet.on('networkChanged', invalidate)
    return () => {
      active = false
      wallet.off('accountsChanged', invalidate)
      wallet.off('networkChanged', invalidate)
    }
  }, [wallet, connection, setConnection])
  return { connection, setConnection }
}
