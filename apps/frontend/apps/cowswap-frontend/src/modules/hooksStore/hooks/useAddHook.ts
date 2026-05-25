import { useSetAtom } from 'jotai'
import { useCallback } from 'react'

import { CowHookDetails } from '@cowprotocol/hook-dapp-lib'
import { useAddSnackbar } from '@cowprotocol/snackbars'
import { useWalletInfo } from '@cowprotocol/wallet'

import { setHooksAtom } from 'entities/orderHooks/hookDetailsAtom'

import { AddHook, HookDapp } from '../types/hooks'
import { getForbiddenHookTargetError } from '../utils/validateHookTarget'

export function useAddHook(dapp: HookDapp, isPreHook: boolean): AddHook {
  const updateHooks = useSetAtom(setHooksAtom)
  const addSnackbar = useAddSnackbar()
  const { chainId } = useWalletInfo()

  return useCallback(
    (hookToAdd) => {
      // Ophis (2026-05-25): single add-hook chokepoint for both the
      // BuildHookApp form and iframe hook dapps. Block hooks targeting
      // protocol-critical contracts (Settlement/VaultRelayer) — never a
      // legitimate target, and a phishing/footgun vector. Defense-in-depth
      // over the HooksTrampoline contract isolation. Audit finding L3.
      const targetError = getForbiddenHookTargetError(hookToAdd.hook.target, chainId)
      if (targetError) {
        console.error('[hooks] Blocked hook targeting protocol contract:', hookToAdd.hook.target)
        addSnackbar({ id: 'hook-target-forbidden', icon: 'alert', content: targetError })
        return
      }

      console.log('[hooks] Add ' + (isPreHook ? 'pre-hook' : 'post-hook'), hookToAdd, isPreHook)

      const uuid = window.crypto.randomUUID()
      const hookDetails: CowHookDetails = {
        ...hookToAdd,
        uuid,
        hook: {
          ...hookToAdd.hook,
          dappId: dapp.id,
        },
      }

      updateHooks((hooks) => {
        if (isPreHook) {
          return { preHooks: [...hooks.preHooks, hookDetails], postHooks: hooks.postHooks }
        } else {
          return { preHooks: hooks.preHooks, postHooks: [...hooks.postHooks, hookDetails] }
        }
      })
    },
    [updateHooks, dapp, isPreHook, addSnackbar, chainId],
  )
}
