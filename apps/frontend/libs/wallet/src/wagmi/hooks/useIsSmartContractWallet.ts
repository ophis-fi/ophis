import { SWR_NO_REFRESH_OPTIONS } from '@cowprotocol/common-const'
import { AccountType } from '@cowprotocol/types'

import useSWR from 'swr'
import { useConnection, usePublicClient } from 'wagmi'

import { useIsSafeWallet } from './useWalletMetadata'

import { useWalletInfo } from '../../api/hooks'

export function useIsSmartContractWallet(): boolean | undefined {
  const accountType = useAccountType()
  const isSafeWallet = useIsSafeWallet()

  return isSafeWallet || accountType === AccountType.SMART_CONTRACT
}

export function useAccountType(): AccountType | undefined {
  const { chainId } = useConnection()
  const publicClient = usePublicClient({ chainId })
  const { account } = useWalletInfo()

  // Gate on publicClient (matching the web3-react impl's `account && provider`
  // gate): without it, a temporarily-undefined client would make the fetcher
  // return EOA for `!code` even though bytecode was never checked, mis-
  // classifying a contract wallet as an EOA. With the gate, no client means no
  // SWR run, so `data` stays undefined (unresolved) until the client is ready.
  const { data } = useSWR(
    account && publicClient ? ['isSmartContract', account, chainId] : null,
    async ([, _account]) => {
      try {
        // publicClient is guaranteed defined here by the SWR key gate above;
        // the optional chain only satisfies the closure's widened type.
        const code = await publicClient?.getCode({ address: _account })

        if (!code) {
          return AccountType.EOA
        }

        if (isEip7702EOA(code, _account)) {
          return AccountType.EIP7702EOA
        }

        return AccountType.SMART_CONTRACT
      } catch (e) {
        console.debug(`checkIsSmartContractWallet: failed to check address ${_account}`, e.message)
        // If we cannot determine yet, return undefined to avoid false negatives during init
        return undefined
      }
    },
    SWR_NO_REFRESH_OPTIONS,
  )

  return data
}

// https://eips.ethereum.org/EIPS/eip-7702#abstract
function isEip7702EOA(code: string, account: string): boolean {
  return code.startsWith('0xef0100') || code.toLowerCase() === account.toLowerCase()
}
