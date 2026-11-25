import { ReactNode, useEffect, useRef, useState } from 'react'

import { Trans } from '@lingui/react/macro'
import { formatOphisSolanaAmount, solanaAddress, type OphisWalletHolding } from '@ophis/solana-sdk'

import * as styledEl from './SwapForm.styled'

import { nativeAsset, shortMint, unknownAsset, type SolanaAsset } from '../services/assets.service'

export function AssetIcon({ asset }: { asset: SolanaAsset }): ReactNode {
  return asset.icon ? (
    <styledEl.Coin src={asset.icon} alt="" />
  ) : (
    <styledEl.CoinLetter aria-hidden="true">{asset.symbol === 'TEST' ? 'T' : '◎'}</styledEl.CoinLetter>
  )
}

interface Props {
  side: 'sell' | 'buy'
  assets: SolanaAsset[]
  holdings: Map<string, OphisWalletHolding>
  other: string
  select(asset: SolanaAsset): void
  close(): void
}

export function AssetPicker({ side, assets, holdings, other, select, close }: Props): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null)
  const [query, setQuery] = useState('')
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  const term = query.trim()
  const filtered = assets.filter(
    (asset) =>
      asset.mint !== other &&
      ([asset.symbol, asset.name].some((text) => text.toLowerCase().includes(term.toLowerCase())) ||
        asset.mint.includes(term)),
  )
  if (term && !filtered.length) {
    try {
      const mint = solanaAddress(term)
      if (
        mint !== other &&
        !assets.some((asset) => asset.mint === mint) &&
        mint !== '11111111111111111111111111111111'
      ) {
        filtered.push(unknownAsset(mint))
      }
    } catch {
      /* Incomplete search or mint address. */
    }
  }
  const held = filtered.filter((asset) => (holdings.get(asset.mint)?.atoms ?? 0n) > 0n)
  const others = filtered.filter((asset) => !held.includes(asset))
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
        placeholder="Search name or paste mint address"
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
              {rows.map((asset) => {
                const holding = holdings.get(asset.mint)
                return (
                  <styledEl.Option key={asset.mint} type="button" title={asset.mint} onClick={() => select(asset)}>
                    <AssetIcon asset={asset} />
                    <span>
                      <strong>{asset.symbol}</strong>
                      <small>
                        {asset.name}
                        {asset !== nativeAsset && ' · ' + shortMint(asset.mint)}
                      </small>
                    </span>
                    {holding && <b>{formatOphisSolanaAmount(holding.atoms, holding.decimals)}</b>}
                  </styledEl.Option>
                )
              })}
            </section>
          ),
      )}
      {!filtered.length && (
        <p role="status">
          <Trans>No matching token. Try its full mint address.</Trans>
        </p>
      )}
    </styledEl.Dialog>
  )
}
