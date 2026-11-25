import { useAtomValue } from 'jotai'
import { useCallback } from 'react'

import { useWalletProvider } from '@cowprotocol/wallet-provider'

import { OPHIS_SOLANA_CONFIG, solanaConnectionAtom, type SolanaConnection } from 'entities/solana'
import { verifySolanaMessage } from 'entities/solana/verifySolanaMessage'
import { utils } from 'ethers'

import { isSolanaAffiliateAddress } from '../lib/affiliateAddress'
import {
  type AffiliateSignedAction,
  type SignedRequestBody,
  buildAffiliateSignMessage,
  nowIssuedSec,
} from '../lib/ophisAffiliateApi'

async function signSolanaAction(
  solana: SolanaConnection,
  action: AffiliateSignedAction,
  issued: number,
): Promise<SignedRequestBody> {
  const { wallet } = solana
  const account = solana.account.address
  const current = wallet.accounts.find(
    (candidate) => candidate.address === account && candidate.chains.includes('solana:mainnet'),
  )
  const signing = wallet.features['solana:signMessage']
  if (!current?.features.includes('solana:signMessage') || !signing)
    throw Error('Connect a Solana wallet that supports message signing.')
  const message = utils.toUtf8Bytes(buildAffiliateSignMessage(action, account, issued))
  const [signed] = await signing.signMessage({ account: current, message })
  if (
    signed?.signature?.length !== 64 ||
    !signed.signedMessage ||
    utils.hexlify(signed.signedMessage) !== utils.hexlify(message)
  )
    throw Error('The wallet returned an invalid signed message.')
  await verifySolanaMessage(account, signed.signature, message)
  return { wallet: account, issued, signature: utils.hexlify(signed.signature) }
}

export function useOphisAffiliateSign(
  account: string | undefined,
): (action: AffiliateSignedAction) => Promise<SignedRequestBody> {
  const provider = useWalletProvider()
  const solana = useAtomValue(solanaConnectionAtom)

  return useCallback(
    async (action: AffiliateSignedAction): Promise<SignedRequestBody> => {
      if (!account) throw new Error('No connected wallet')
      const issued = nowIssuedSec()
      if (isSolanaAffiliateAddress(account)) {
        if (OPHIS_SOLANA_CONFIG?.chain !== 'solana:mainnet' || solana?.account.address !== account)
          throw Error('Reconnect your Solana mainnet account.')
        return signSolanaAction(solana, action, issued)
      }
      if (!provider) throw new Error('No wallet provider available')

      const { chainId } = await provider.getNetwork()
      const message = buildAffiliateSignMessage(action, account, issued, chainId)
      const signer = provider.getSigner()
      const signature = await signer.signMessage(message)

      return { wallet: account, issued, signature, chainId }
    },
    [account, provider, solana],
  )
}
