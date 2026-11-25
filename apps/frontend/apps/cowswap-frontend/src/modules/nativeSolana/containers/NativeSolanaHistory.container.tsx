import { useAtomValue } from 'jotai'
import { atomFamily } from 'jotai/utils'
import { ReactNode, useState } from 'react'

import { ButtonSecondary } from '@cowprotocol/ui'

import { Trans } from '@lingui/react/macro'
import { fetchOphisSolanaTrades, formatOphisSolanaAmount, solanaAddress } from '@ophis/solana-sdk'
import { OPHIS_SOLANA_CONFIG, solanaConnectionAtom } from 'entities/solana'
import { atomWithQuery } from 'jotai-tanstack-query'

import * as styledEl from '../pure/NativeSolana.styled'
import { walletMint } from '../services/assets.service'
import { walletAssetListAtom } from '../state/assets.atoms'

const pageSize = 10
const historyAtom = atomFamily((page: number) =>
  atomWithQuery((get) => {
    const owner = get(solanaConnectionAtom)?.account.address
    const config = OPHIS_SOLANA_CONFIG
    return {
      queryKey: ['ophisSolanaTrades', config?.api, config?.genesis, owner, page],
      queryFn: () => fetchOphisSolanaTrades(config?.api || '', solanaAddress(owner || ''), page * pageSize, pageSize),
      enabled: !!owner && !!config,
      retry: false,
      refetchOnWindowFocus: false,
    }
  }),
)

export function NativeSolanaHistory(): ReactNode {
  const [page, setPage] = useState(0)
  const { data, isFetching, isError, refetch } = useAtomValue(historyAtom(page))
  const assets = useAtomValue(walletAssetListAtom)
  function tradeAmount(amount: string, mint: string): ReactNode {
    const asset = assets.find((token) => token.mint === walletMint(mint))
    if (asset?.decimals === undefined)
      return (
        <>
          <Trans>{amount} base units</Trans> <code>{mint}</code>
        </>
      )
    return (
      <span title={mint}>
        {formatOphisSolanaAmount(BigInt(amount), asset.decimals)} {asset.symbol}
      </span>
    )
  }
  return (
    <styledEl.Card>
      <h3>
        <Trans>Settled trades</Trans>
      </h3>
      {isError && (
        <p role="alert">
          <Trans>Could not load wallet trades.</Trans>
        </p>
      )}
      {data?.length === 0 && (
        <p>
          <Trans>No trades on this page.</Trans>
        </p>
      )}
      {data?.map(({ txSignature, instructionIndex, orderUid, buyAmount, buyToken, protocolFee, feeMint }) => (
        <p key={txSignature + instructionIndex + orderUid}>
          <Trans>Received</Trans> {tradeAmount(buyAmount, buyToken)}
          <br />
          {protocolFee === null || feeMint === null ? (
            <Trans>Fee attribution unavailable</Trans>
          ) : (
            <>
              <Trans>Ophis fee</Trans> {tradeAmount(protocolFee, feeMint)}
            </>
          )}
          {OPHIS_SOLANA_CONFIG?.chain === 'solana:mainnet' && (
            <>
              <br />
              <a href={`https://explorer.solana.com/tx/${txSignature}`} target="_blank" rel="noopener noreferrer">
                <Trans>View settlement on Solana Explorer</Trans>
              </a>
            </>
          )}
        </p>
      ))}
      <styledEl.Row>
        <ButtonSecondary type="button" disabled={isFetching} onClick={() => void refetch()}>
          <Trans>Refresh trades</Trans>
        </ButtonSecondary>
        {page > 0 && (
          <ButtonSecondary type="button" onClick={() => setPage(page - 1)}>
            <Trans>Previous</Trans>
          </ButtonSecondary>
        )}
        {data?.length === pageSize && (
          <ButtonSecondary type="button" onClick={() => setPage(page + 1)}>
            <Trans>Next</Trans>
          </ButtonSecondary>
        )}
      </styledEl.Row>
    </styledEl.Card>
  )
}
