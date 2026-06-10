import { useCallback } from 'react'

import { useWalletProvider } from '@cowprotocol/wallet-provider'

import {
  type AffiliateSignedAction,
  type SignedRequestBody,
  buildAffiliateSignMessage,
  nowIssuedSec,
} from '../lib/ophisAffiliateApi'

/**
 * useOphisAffiliateSign — produce a `{ wallet, issued, signature }` body for
 * the signature-gated Ophis affiliate endpoints (POST /ref/codes,
 * POST /partner).
 *
 * Uses ethers v5 `signer.signMessage` (EIP-191 personal_sign) so the
 * backend's viem `recoverMessageAddress` recovers the same address. The
 * `issued` second is generated here and echoed in the body so the server
 * can re-derive the exact signed string (valid 5 minutes server-side).
 */
export function useOphisAffiliateSign(account: string | undefined): (action: AffiliateSignedAction) => Promise<SignedRequestBody> {
  const provider = useWalletProvider()

  return useCallback(
    async (action: AffiliateSignedAction): Promise<SignedRequestBody> => {
      if (!account) throw new Error('No connected wallet')
      if (!provider) throw new Error('No wallet provider available')

      const issued = nowIssuedSec()
      const message = buildAffiliateSignMessage(action, account, issued)
      const signer = provider.getSigner()
      const signature = await signer.signMessage(message)

      return { wallet: account, issued, signature }
    },
    [account, provider],
  )
}
