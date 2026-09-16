import { COW_PROTOCOL_VAULT_RELAYER_ADDRESS } from '@cowprotocol/common-utils'
import { areAddressesEqual } from '@cowprotocol/cow-sdk'
import { PERMIT_HOOK_DAPP_ID } from '@cowprotocol/hook-dapp-lib'
import { Interface } from '@ethersproject/abi'

import type { CowHook } from 'modules/appData'

import { USDC } from './router.service'

const permit = new Interface(['function permit(address,address,uint256,uint256,uint8,bytes32,bytes32)'])

/** CoW's input approval is replaced by the direct route's own approval flow. */
export function isReplaceableCowPermit(hook: CowHook, inputToken: string | undefined): boolean {
  if (!areAddressesEqual(inputToken, USDC) || !areAddressesEqual(hook.target, USDC)) return false
  if (hook.dappId !== PERMIT_HOOK_DAPP_ID) return false
  try {
    const decoded = permit.decodeFunctionData('permit', hook.callData)
    return areAddressesEqual(String(decoded[1]), COW_PROTOCOL_VAULT_RELAYER_ADDRESS[1])
  } catch {
    return false
  }
}
