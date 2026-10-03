import { useAtomValue } from 'jotai'
import { useCallback } from 'react'

import { useBridgeWallet } from 'modules/cctp'

import { NearTransfer } from '../nearDirect.schemas'
import { fundNearTransfer } from '../nearDirectWallet.service'
import { standardWalletsAtom } from '../standardWallet.atoms'
import { starknetWalletAtom } from '../starknetWallet.atoms'
import { fundStarknetTransfer } from '../starknetWallet.service'
import { tronWalletAtom } from '../tronWallet.atoms'

export function useNearFundingWallet(
  chain: string,
): ((transfer: NearTransfer, beforeSend: (nonce?: number) => Promise<void>) => Promise<string>) | undefined {
  const evm = useBridgeWallet()
  const starknet = useAtomValue(starknetWalletAtom)
  const standards = useAtomValue(standardWalletsAtom)
  const tron = useAtomValue(tronWalletAtom)
  const fund = useCallback(
    async (transfer: NearTransfer, beforeSend: (nonce?: number) => Promise<void>): Promise<string> => {
      if (chain === 'starknet' && starknet) return fundStarknetTransfer(starknet.wallet, transfer, beforeSend)
      if (chain === 'sol' && standards.sol)
        return (await import('../solanaWallet.service')).fundSolanaTransfer(standards.sol, transfer, beforeSend)
      if (chain === 'sui' && standards.sui)
        return (await import('../suiWallet.service')).fundSuiTransfer(standards.sui, transfer, beforeSend)
      if (chain === 'tron' && tron)
        return (await import('../tronWallet.service')).fundTronTransfer(tron, transfer, beforeSend)
      if (evm) return fundNearTransfer(evm, transfer, beforeSend)
      throw new Error('Reconnect your wallet before sending.')
    },
    [chain, evm, starknet, standards, tron],
  )
  const ready = {
    starknet: !!starknet,
    sol: !!standards.sol,
    sui: !!standards.sui,
    tron: !!tron,
    monad: !!evm,
    xlayer: !!evm,
  }
  return ready[chain as keyof typeof ready] ? fund : undefined
}
