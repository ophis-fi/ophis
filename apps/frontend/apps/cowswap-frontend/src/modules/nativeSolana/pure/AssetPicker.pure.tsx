import { ReactNode, useEffect, useRef, useState } from 'react'

import { Trans } from '@lingui/react/macro'
import { formatOphisSolanaAmount, SOLANA_NATIVE_ASSET, solanaAddress, type OphisWalletHolding } from '@ophis/solana-sdk'

import * as styledEl from './SwapForm.styled'

import { nativeAsset, shortMint, unknownAsset, type SolanaAsset } from '../services/assets.service'

export function AssetIcon({ asset }: { asset: SolanaAsset }): ReactNode {
  const [failedIcon, setFailedIcon] = useState<string>()
  return asset.icon && asset.icon !== failedIcon ? (
    <styledEl.Coin
      src={asset.icon}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailedIcon(asset.icon)}
    />
  ) : (
    <styledEl.CoinLetter aria-hidden="true">{asset.symbol.slice(0, 1).toUpperCase()}</styledEl.CoinLetter>
  )
}

const maxRowsPerGroup = 50

interface AssetPickerProps {
  catalogLoading: boolean
  catalogUnavailable: boolean
  side: 'sell' | 'buy'
  assets: SolanaAsset[]
  holdings: Map<string, OphisWalletHolding>
  other: string
  select(asset: SolanaAsset): void
  close(): void
}

function matchingAssets(assets: SolanaAsset[], other: string, term: string): SolanaAsset[] {
  if (term.length >= 32 && term.length <= 44) {
    try {
      const mint = solanaAddress(term)
      if (mint === other || mint === SOLANA_NATIVE_ASSET) return []
      return [assets.find((asset) => asset.mint === mint) ?? unknownAsset(mint)]
    } catch {
      // Long names or partial mints can still match the catalog.
    }
  }
  const text = term.toLowerCase()
  const matches = assets.filter(
    (asset) =>
      asset.mint !== other &&
      (!term ||
        asset.symbol.toLowerCase().includes(text) ||
        asset.name.toLowerCase().includes(text) ||
        asset.mint.includes(term)),
  )
  if (term) {
    const exact = (asset: SolanaAsset): number =>
      Number(asset.symbol.toLowerCase() === text || asset.name.toLowerCase() === text)
    matches.sort((a, b) => exact(b) - exact(a))
  }
  return matches
}

export function AssetPicker({
  side,
  assets,
  holdings,
  other,
  select,
  close,
  catalogLoading,
  catalogUnavailable,
}: AssetPickerProps): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null)
  const [query, setQuery] = useState('')
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  const filtered = matchingAssets(assets, other, query.trim())
  const held: SolanaAsset[] = []
  const others: SolanaAsset[] = []
  for (const asset of filtered) {
    const rows = (holdings.get(asset.mint)?.atoms ?? 0n) > 0n ? held : others
    rows.push(asset)
  }
  return (
    <styledEl.Dialog ref={dialog} aria-labelledby="asset-title" onCancel={close}>
      <styledEl.Line>
        <h2 id="asset-title">
          {side === 'sell' ? <Trans>Choose a token to sell</Trans> : <Trans>Choose a token to buy</Trans>}
        </h2>
        <styledEl.SmallButton type="button" onClick={close} aria-label="Close token picker">
          ×
        </styledEl.SmallButton>
      </styledEl.Line>
      <styledEl.Search
        aria-label="Search tokens"
        placeholder="Search symbol, name or mint address"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
      {[
        { label: <Trans>In your wallet</Trans>, rows: held },
        { label: <Trans>Tokens on this network</Trans>, rows: others },
      ].map(
        ({ label, rows }, i) =>
          rows.length > 0 && (
            <section key={i}>
              <styledEl.Caption>{label}</styledEl.Caption>
              {rows.slice(0, maxRowsPerGroup).map((asset) => {
                const holding = holdings.get(asset.mint)
                return (
                  <styledEl.Option key={asset.mint} type="button" title={asset.mint} onClick={() => select(asset)}>
                    <AssetIcon asset={asset} />
                    <span>
                      <strong>{asset.symbol}</strong>
                      <small>
                        {asset.name}
                        {asset.mint !== nativeAsset.mint && ' · ' + shortMint(asset.mint)}
                      </small>
                    </span>
                    {holding && <b>{formatOphisSolanaAmount(holding.atoms, holding.decimals)}</b>}
                  </styledEl.Option>
                )
              })}
            </section>
          ),
      )}
      {(held.length > maxRowsPerGroup || others.length > maxRowsPerGroup) && (
        <p>
          <Trans>Search to narrow the list.</Trans>
        </p>
      )}
      {catalogLoading && (
        <p role="status">
          <Trans>Loading more Solana tokens…</Trans>
        </p>
      )}
      {catalogUnavailable && (
        <p role="status">
          <Trans>The full token list is unavailable. You can still paste a mint address.</Trans>
        </p>
      )}
      {!catalogLoading && !filtered.length && (
        <p role="status">
          <Trans>No matching token. Try its full mint address.</Trans>
        </p>
      )}
    </styledEl.Dialog>
  )
}
