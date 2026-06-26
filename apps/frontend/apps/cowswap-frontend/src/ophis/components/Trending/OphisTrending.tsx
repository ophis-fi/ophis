/**
 * In-app "Trending" panel for the swap page.
 *
 * Shows the trending tokens for the CURRENT chain (1h movers, from useTrending →
 * GeckoTerminal directly in the browser; see geckoTerminal.ts). Every row taps to PRE-FILL the
 * swap with that token as the buy side — nothing links out of the app. Glassy,
 * dismissible, and hidden when there is nothing to show. Renders on every viewport
 * (side-float on wide, stacked below the widget on narrow); the swap page only
 * mounts it in the full app, never in injected-widget (partner iframe) mode.
 */
import { ReactNode, useMemo, useState } from 'react'

import { SupportedChainId } from '@cowprotocol/cow-sdk'

import { useParams } from 'react-router'
import styled from 'styled-components/macro'

import { useTradeNavigate } from 'modules/trade'

import { useTrending, type TrendingToken } from '../../hooks/useTrending'

const CHAIN_LABEL: Record<number, string> = {
  1: 'Ethereum', 10: 'Optimism', 56: 'BNB', 100: 'Gnosis', 137: 'Polygon',
  8453: 'Base', 42161: 'Arbitrum', 43114: 'Avalanche', 57073: 'Ink', 59144: 'Linea',
}

const Panel = styled.aside`
  width: 300px;
  flex: none;
  align-self: flex-start;
  margin-top: 8px;
  padding: 16px 14px 12px;
  border-radius: 20px;
  position: relative;
  background: rgba(255, 255, 255, 0.028);
  border: 1px solid rgba(255, 255, 255, 0.07);
  backdrop-filter: blur(16px);
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.04);
  color: ${({ theme }) => theme.text1};
`
const Head = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
`
const Title = styled.span`
  font-weight: 600;
  font-size: 13.5px;
  letter-spacing: 0.2px;
`
const Chip = styled.span`
  margin-left: auto;
  margin-right: 18px;
  font-size: 11px;
  color: ${({ theme }) => theme.text1};
  opacity: 0.6;
  background: rgba(255, 255, 255, 0.035);
  border: 1px solid rgba(255, 255, 255, 0.06);
  padding: 3px 9px;
  border-radius: 999px;
`
const Close = styled.button`
  position: absolute;
  top: 13px;
  right: 13px;
  background: none;
  border: none;
  cursor: pointer;
  color: ${({ theme }) => theme.text1};
  opacity: 0.4;
  font-size: 13px;
  line-height: 1;
  padding: 2px;
  &:hover {
    opacity: 0.8;
  }
`
const Sub = styled.div`
  font-size: 10.5px;
  letter-spacing: 0.3px;
  opacity: 0.42;
  margin: 7px 4px 4px;
  text-transform: uppercase;
`
const Row = styled.button`
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  text-align: left;
  padding: 11px 8px;
  border: none;
  background: none;
  cursor: pointer;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
  border-radius: 10px;
  color: inherit;
  &:last-of-type {
    border-bottom: none;
  }
  &:hover {
    background: rgba(255, 255, 255, 0.035);
  }
  &:hover .chg {
    display: none;
  }
  &:hover .ghost {
    display: inline-flex;
  }
`
const Left = styled.span`
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  flex: 1;
`
// The circle: a gradient + token initials always sit underneath; when the (host
// allow-listed, see geckoTerminal.ts safeLogoUrl) logo loads, the <img> covers them, and on error
// it hides itself to reveal the fallback. The logo is rendered as an <img src> (a
// non-executable sink React escapes) — never interpolated into CSS — so an
// attacker-chosen image_url can't break out into a style.
const IconWrap = styled.span`
  position: relative;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  flex: none;
  overflow: hidden;
  box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.22);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 9px;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.85);
  background-image: linear-gradient(135deg, #6c5ce7, #3a8bff);
`
const IconImg = styled.img`
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
`
const Sym = styled.span`
  font-weight: 600;
  font-size: 13.5px;
  line-height: 1.15;
`
const Px = styled.span`
  display: block;
  opacity: 0.42;
  font-size: 10.5px;
  margin-top: 2px;
`
const Chg = styled.span<{ $up: boolean }>`
  font-size: 12.5px;
  font-weight: 600;
  width: 56px;
  text-align: right;
  color: ${({ $up }) => ($up ? '#6fe0ac' : '#ff8a93')};
`
const Ghost = styled.span`
  display: none;
  align-items: center;
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.2px;
  color: ${({ theme }) => theme.text1};
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(255, 255, 255, 0.05);
  padding: 5px 11px;
  border-radius: 999px;
`
const Foot = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 8px 6px 2px;
  font-size: 10px;
  letter-spacing: 0.3px;
  opacity: 0.42;
`
const LiveDot = styled.span`
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #6fe0ac;
  box-shadow: 0 0 6px #6fe0ac;
`

const TrendGlyph = (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
    <path d="M1.5 10 L5 6.5 L7.5 8.5 L12.5 3" stroke="#b9a8ff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M9.5 3 L12.5 3 L12.5 6" stroke="#b9a8ff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

function formatPrice(p: number): string {
  if (p >= 1) return `$${p.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
  if (p >= 0.01) return `$${p.toFixed(4)}`
  return `$${p.toPrecision(2)}`
}

export function OphisTrending(): ReactNode {
  const params = useParams()
  const chainId = Number(params.chainId)
  const inputCurrencyId = params.inputCurrencyId
  const tradeNavigate = useTradeNavigate()
  const [dismissed, setDismissed] = useState(false)
  // Poll only while the panel can be shown (not dismissed). It now renders on every
  // viewport (side-float on wide, stacked below the widget on narrow), so there is no
  // viewport gate.
  const { tokens } = useTrending(!dismissed && Number.isInteger(chainId) && chainId > 0 ? chainId : undefined)

  const visible = useMemo(
    // Don't show a row for the token already on the sell side.
    () => tokens.filter((t) => t.address.toLowerCase() !== (inputCurrencyId ?? '').toLowerCase()).slice(0, 6),
    [tokens, inputCurrencyId],
  )

  if (dismissed || visible.length === 0) return null

  const onPick = (t: TrendingToken): void => {
    // Keep the current sell token; set the buy token to the trending one.
    tradeNavigate(chainId as SupportedChainId, { inputCurrencyId: inputCurrencyId ?? null, outputCurrencyId: t.address })
  }

  return (
    <Panel>
      <Close aria-label="Hide trending" onClick={() => setDismissed(true)}>
        ✕
      </Close>
      <Head>
        {TrendGlyph}
        <Title>Trending</Title>
        {CHAIN_LABEL[chainId] && <Chip>{CHAIN_LABEL[chainId]}</Chip>}
      </Head>
      <Sub>Biggest movers · last 1h</Sub>

      {visible.map((t) => (
        <Row key={t.address} onClick={() => onPick(t)} title={`Swap into ${t.symbol}`}>
          <Left>
            <IconWrap>
              {t.symbol.slice(0, 3)}
              {t.logo && (
                <IconImg
                  src={t.logo}
                  alt=""
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  onError={(e) => {
                    e.currentTarget.style.display = 'none'
                  }}
                />
              )}
            </IconWrap>
            <span>
              <Sym>{t.symbol}</Sym>
              <Px>{formatPrice(t.priceUsd)}</Px>
            </span>
          </Left>
          <Chg className="chg" $up={t.change1h >= 0}>
            {t.change1h >= 0 ? '+' : ''}
            {t.change1h.toFixed(1)}%
          </Chg>
          <Ghost className="ghost">Swap ↗</Ghost>
        </Row>
      ))}

      <Foot>
        <LiveDot />
        Trending by 1h volume · not an endorsement
      </Foot>
    </Panel>
  )
}
