import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { ReactNode, useEffect, useState } from 'react'

import { Trans } from '@lingui/react/macro'
import { OPHIS_SOLANA_CONFIG, solanaConnectionAtom } from 'entities/solana'
import { AssetSwapFieldsLayout } from 'ophis/components/AssetSwap/AssetSwapFields'

import { NetworkSelector } from 'modules/networkSelector'

import { BuyPanel, LocalTestFunds, SellPanel } from './SolanaTradePanels.container'
import { SolanaWalletAction } from './SolanaWalletAction.container'

import { AssetPicker } from '../pure/AssetPicker.pure'
import * as styledEl from '../pure/SwapForm.styled'
import { privateSettlementEnabled } from '../services/privateSettlement.service'
import {
  sellAmountStateAtom,
  solanaCachedCatalogAtom,
  solanaMainnetCatalogAtom,
  walletAssetListAtom,
  walletHoldingsMapAtom,
} from '../state/assets.atoms'
import { nativeSolanaBusyAtom, nativeSolanaFormAtom, requestNativeSolanaQuoteAtom } from '../state/trade.atoms'

export function NativeSolanaForm(): ReactNode {
  const [form, setForm] = useAtom(nativeSolanaFormAtom)
  const owner = useAtomValue(solanaConnectionAtom)
  const busy = useAtomValue(nativeSolanaBusyAtom)
  const request = useSetAtom(requestNativeSolanaQuoteAtom)
  const [picker, setPicker] = useState<'sell' | 'buy' | null>(null)
  useEffect(() => {
    const url = new URL(window.location.href)
    if (!privateSettlementEnabled || url.searchParams.get('pick') !== 'sell') return
    setPicker('sell')
    url.searchParams.delete('pick')
    window.history.replaceState(window.history.state, '', url)
  }, [])
  const catalog = useAtomValue(picker ? solanaMainnetCatalogAtom : solanaCachedCatalogAtom)
  const assets = useAtomValue(walletAssetListAtom)
  const holdings = useAtomValue(walletHoldingsMapAtom)
  const { valid, exceeds } = useAtomValue(sellAmountStateAtom)
  const canQuote = !!owner && !!form.buyMint && valid && !exceeds && !busy
  return (
    <styledEl.Swap
      aria-label="Solana swap"
      onSubmit={(event) => {
        event.preventDefault()
        if (canQuote) void request()
      }}
    >
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
        input={<SellPanel open={() => setPicker('sell')} />}
        output={<BuyPanel open={() => setPicker('buy')} />}
        reverse={{
          loading: false,
          disabled: !form.buyMint || busy,
          onClick: () => setForm({ ...form, sellMint: form.buyMint, buyMint: form.sellMint, amount: '' }),
        }}
      />
      <LocalTestFunds />
      <SolanaWalletAction canQuote={canQuote} busy={busy} />
      {picker && (
        <AssetPicker
          side={picker}
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
