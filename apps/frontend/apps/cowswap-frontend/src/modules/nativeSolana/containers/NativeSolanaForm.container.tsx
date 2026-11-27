import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { ReactNode, useEffect, useRef, useState } from 'react'

import { Trans } from '@lingui/react/macro'
import { OPHIS_SOLANA_CONFIG, solanaConnectionAtom } from 'entities/solana'
import { useAssetVerificationResolver } from 'entities/verifiedAsset'
import { queryClientAtom } from 'jotai-tanstack-query'
import { AssetSwapFieldsLayout } from 'ophis/components/AssetSwap/AssetSwapFields'

import { NetworkSelector } from 'modules/networkSelector'

import { BuyPanel, LocalTestFunds, SellPanel } from './SolanaTradePanels.container'
import { SolanaWalletAction } from './SolanaWalletAction.container'

import { useAutomaticSolanaQuote } from '../hooks/useAutomaticSolanaQuote'
import { AssetPicker } from '../pure/AssetPicker.pure'
import * as styledEl from '../pure/SwapForm.styled'
import { solanaAssetIdentity } from '../services/assets.service'
import { privateSettlementEnabled } from '../services/privateSettlement.service'
import {
  marketSellMintsKey,
  solanaCachedCatalogAtom,
  solanaMainnetCatalogAtom,
  solanaMarketSellMintsAtom,
  solanaSellStateAtom,
  walletAssetListAtom,
  walletHoldingsMapAtom,
} from '../state/assets.atoms'
import {
  clearNativeSolanaReviewAtom,
  nativeSolanaBusyAtom,
  nativeSolanaFormAtom,
  nativeSolanaQuoteErrorAtom,
  nativeSolanaReviewAtom,
} from '../state/trade.atoms'

import type { NativeSolanaReview } from '../services/trade.service'

export function NativeSolanaForm({ onReview }: { onReview(review: NativeSolanaReview): void }): ReactNode {
  const [form, setForm] = useAtom(nativeSolanaFormAtom)
  const owner = useAtomValue(solanaConnectionAtom)
  const busy = useAtomValue(nativeSolanaBusyAtom)
  const clearQuote = useSetAtom(clearNativeSolanaReviewAtom)
  const review = useAtomValue(nativeSolanaReviewAtom)
  const quoteError = useAtomValue(nativeSolanaQuoteErrorAtom)
  const [picker, setPicker] = useState<'sell' | 'buy' | null>(null)
  const pickerTrigger = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (!picker && pickerTrigger.current) {
      pickerTrigger.current.focus()
      pickerTrigger.current = null
    }
  }, [picker])
  function openPicker(side: 'sell' | 'buy', trigger: HTMLButtonElement): void {
    pickerTrigger.current = trigger
    setPicker(side)
  }
  useEffect(() => {
    const url = new URL(window.location.href)
    if (!privateSettlementEnabled || url.searchParams.get('pick') !== 'sell') return
    setPicker('sell')
    url.searchParams.delete('pick')
    window.history.replaceState(window.history.state, '', url)
  }, [])
  const verifyAsset = useAssetVerificationResolver(!!picker && OPHIS_SOLANA_CONFIG?.chain === 'solana:mainnet')
  const catalog = useAtomValue(picker ? solanaMainnetCatalogAtom : solanaCachedCatalogAtom)
  const assets = useAtomValue(walletAssetListAtom)
  const holdings = useAtomValue(walletHoldingsMapAtom)
  const { readyToSell, sellUnavailable, solShortfall } = useAtomValue(solanaSellStateAtom)
  const canQuote = !!owner && !!form.buyMint && readyToSell && !busy
  useAutomaticSolanaQuote(canQuote)
  return (
    <styledEl.Swap
      aria-label="Solana swap"
      onSubmit={(event) => {
        event.preventDefault()
        if (picker || !canQuote) return
        if (review && Date.parse(review.quote.expiration) > Date.now()) onReview(review)
        else clearQuote()
      }}
    >
      <SolanaNetworkHeader busy={busy} />
      <styledEl.Fields hidden={!!picker}>
        <styledEl.Settings>
          <Trans>Slippage limit</Trans>
          <select
            aria-label="Slippage limit"
            disabled={busy}
            value={form.slippageBps}
            onChange={(event) => setForm({ ...form, slippageBps: Number(event.target.value) })}
          >
            <option value={10}>0.1%</option>
            <option value={50}>0.5%</option>
            <option value={100}>1%</option>
          </select>
        </styledEl.Settings>
        <AssetSwapFieldsLayout
          input={<SellPanel open={(event) => openPicker('sell', event.currentTarget)} />}
          output={<BuyPanel open={(event) => openPicker('buy', event.currentTarget)} />}
          reverse={{
            loading: false,
            disabled: !form.buyMint || busy,
            onClick: () => setForm({ ...form, sellMint: form.buyMint, buyMint: form.sellMint, amount: '' }),
          }}
        />
        <SellAvailabilityNotice mint={form.sellMint} unavailable={sellUnavailable} />
        <LocalTestFunds />
        {!solShortfall && quoteError && <p role="alert">{quoteError}</p>}
        <SolanaWalletAction canQuote={canQuote} busy={busy} reviewReady={!!review} quoteFailed={!!quoteError} />
      </styledEl.Fields>
      {picker && (
        <AssetPicker
          side={picker}
          verifyAsset={(asset) => verifyAsset(solanaAssetIdentity(asset))}
          catalogLoading={catalog.isFetching}
          catalogUnavailable={catalog.isError && !catalog.data}
          assets={assets}
          holdings={holdings}
          other={picker === 'sell' ? form.buyMint : form.sellMint}
          close={() => setPicker(null)}
          select={(asset) => {
            setForm(
              picker === 'sell' ? { ...form, sellMint: asset.mint, amount: '' } : { ...form, buyMint: asset.mint },
            )
            setPicker(null)
          }}
        />
      )}
    </styledEl.Swap>
  )
}

function SellAvailabilityNotice({ mint, unavailable }: { mint: string; unavailable: boolean }): ReactNode {
  const market = useAtomValue(solanaMarketSellMintsAtom)
  const client = useAtomValue(queryClientAtom)
  useEffect(() => {
    void client.refetchQueries({ queryKey: marketSellMintsKey, type: 'active', stale: true }, { cancelRefetch: false })
  }, [client, mint])
  if (market.isLoading)
    return (
      <styledEl.Helper role="status">
        <Trans>Checking sell availability…</Trans>
      </styledEl.Helper>
    )
  if (!unavailable && !market.isError) return null
  return (
    <styledEl.Helper role="status">
      {unavailable ? (
        <Trans>This token is currently unavailable to sell. Choose another sell token.</Trans>
      ) : (
        <Trans>Sell availability could not be checked. You can still get a quote.</Trans>
      )}
      <styledEl.SmallButton type="button" disabled={market.isFetching} onClick={() => void market.refetch()}>
        <Trans>Check again</Trans>
      </styledEl.SmallButton>
    </styledEl.Helper>
  )
}

function SolanaNetworkHeader({ busy }: { busy: boolean }): ReactNode {
  return (
    <styledEl.Line>
      <NetworkSelector nativeSolanaSelected disabled={busy} />
      {OPHIS_SOLANA_CONFIG?.chain === 'solana:localnet' && (
        <span>
          <Trans>Local test network</Trans>
        </span>
      )}
      {OPHIS_SOLANA_CONFIG?.chain === 'solana:devnet' && (
        <span>
          <Trans>Solana devnet · Test tokens</Trans>
        </span>
      )}
      {privateSettlementEnabled && (
        <span>
          <Trans>Private mainnet test · Real funds</Trans>
        </span>
      )}
    </styledEl.Line>
  )
}
