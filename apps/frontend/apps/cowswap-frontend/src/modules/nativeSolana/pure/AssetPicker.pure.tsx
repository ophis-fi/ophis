import { ReactNode, useEffect, useId, useRef, useState } from 'react'

import { Trans } from '@lingui/react/macro'
import { formatOphisSolanaAmount, SOLANA_NATIVE_ASSET, solanaAddress, type OphisWalletHolding } from '@ophis/solana-sdk'
import { VerifiedAssetBadge, type Verification } from 'entities/verifiedAsset'
import { ArrowLeft } from 'react-feather'

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

const pageSize = 50

interface AssetPickerProps {
  verifyAsset(asset: SolanaAsset): Verification | undefined
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

function TokenGroup({
  label,
  rows,
  holdings,
  verifyAsset,
  select,
}: Pick<AssetPickerProps, 'holdings' | 'verifyAsset' | 'select'> & {
  label: ReactNode
  rows: SolanaAsset[]
}): ReactNode {
  const [visible, setVisible] = useState(pageSize)
  if (!rows.length) return null
  return (
    <section>
      <styledEl.Caption>{label}</styledEl.Caption>
      {rows.slice(0, visible).map((asset) => {
        const holding = holdings.get(asset.mint)
        return (
          <styledEl.Option key={asset.mint} type="button" title={asset.mint} onClick={() => select(asset)}>
            <AssetIcon asset={asset} />
            <span>
              <strong>
                {asset.symbol}
                <VerifiedAssetBadge verified={verifyAsset(asset)} />
              </strong>
              <small>
                {asset.name}
                {asset.mint !== nativeAsset.mint && ' · ' + shortMint(asset.mint)}
              </small>
            </span>
            {holding && <b>{formatOphisSolanaAmount(holding.atoms, holding.decimals)}</b>}
          </styledEl.Option>
        )
      })}
      {rows.length > visible && (
        <styledEl.SmallButton type="button" onClick={() => setVisible((count) => count + pageSize)}>
          <Trans>Show more tokens</Trans>
        </styledEl.SmallButton>
      )}
    </section>
  )
}

export function AssetPicker(props: AssetPickerProps): ReactNode {
  const { side, assets, holdings, other, select, close, verifyAsset } = props
  const search = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const [query, setQuery] = useState('')
  useEffect(() => {
    search.current?.focus({ preventScroll: true })
  }, [])
  const filtered = matchingAssets(assets, other, query.trim())
  const held: SolanaAsset[] = []
  const others: SolanaAsset[] = []
  for (const asset of filtered) {
    const rows = (holdings.get(asset.mint)?.atoms ?? 0n) > 0n ? held : others
    rows.push(asset)
  }
  return (
    <section
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          close()
        }
      }}
    >
      <styledEl.PickerHeading>
        <styledEl.Back type="button" onClick={close} aria-label="Close token picker">
          <ArrowLeft size={20} aria-hidden="true" />
        </styledEl.Back>
        <h2 id={titleId}>{side === 'sell' ? <Trans>You sell</Trans> : <Trans>You buy</Trans>}</h2>
      </styledEl.PickerHeading>
      <styledEl.Search
        ref={search}
        aria-label="Search tokens"
        placeholder="Search symbol, name or mint address"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
      <styledEl.TokenList>
        <TokenGroup
          key={'held-' + query}
          label={<Trans>In your wallet</Trans>}
          rows={held}
          holdings={holdings}
          select={select}
          verifyAsset={verifyAsset}
        />
        <TokenGroup
          key={'network-' + query}
          label={<Trans>Tokens on this network</Trans>}
          rows={others}
          holdings={holdings}
          select={select}
          verifyAsset={verifyAsset}
        />
        {props.catalogLoading && (
          <p role="status">
            <Trans>Loading more Solana tokens…</Trans>
          </p>
        )}
        {props.catalogUnavailable && (
          <p role="status">
            <Trans>The full token list is unavailable. You can still paste a mint address.</Trans>
          </p>
        )}
        {!props.catalogLoading && !filtered.length && (
          <p role="status">
            <Trans>No matching token. Try its full mint address.</Trans>
          </p>
        )}
      </styledEl.TokenList>
    </section>
  )
}
