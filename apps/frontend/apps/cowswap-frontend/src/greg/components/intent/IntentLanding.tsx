/**
 * Ophis natural-language swap-intent landing page.
 *
 * Mounted at `/`. Replaces upstream cowswap's redirect to `/swap` so
 * the first surface is a chrome-less Ophis-branded hero with a
 * natural-language input. After submit, the user is routed into the
 * existing cowswap swap UI with the form pre-populated.
 *
 * Design: cosmic palette anchored on the mockup at
 * docs/development/specs/2026-05-08-ophis-intent-input-design.md (V2 visual).
 */
import { ReactNode, useCallback, useMemo, useState } from 'react'

import { Link, useNavigate } from 'react-router'
import styled from 'styled-components/macro'

import { OphisFooter } from '../OphisFooter'
import { OphisHeader } from '../OphisHeader'

import { ExampleChips } from './ExampleChips'
import { IntentInput } from './IntentInput'
import { intentToUrl } from './intentToUrl'
import type { ParsedIntent } from './types'
import { useIntentParse } from './useIntentParse'

const Page = styled.main`
  width: 100vw;
  margin-left: calc(50% - 50vw);
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background-color: #02000d;
  background-image: url('/ophis-hero-bg.jpg');
  background-size: cover;
  background-position: center top;
  background-repeat: no-repeat;
  background-attachment: scroll;
  color: #f5efe6;
  position: relative;

  &::before {
    /* Vignette to deepen the edges and improve text contrast over the
       cosmic backdrop. */
    content: '';
    position: absolute;
    inset: 0;
    pointer-events: none;
    background:
      radial-gradient(120% 80% at 50% 0%, transparent 0%, rgba(2, 0, 13, 0.55) 75%),
      linear-gradient(180deg, rgba(2, 0, 13, 0) 0%, rgba(2, 0, 13, 0.6) 75%, rgba(2, 0, 13, 0.95) 100%);
    z-index: 0;
  }

  & > * {
    position: relative;
    z-index: 1;
  }
`

const NavLink = styled(Link)`
  color: rgba(245, 239, 230, 0.78);
  font-family: 'Plus Jakarta Sans', var(--cow-font-family-primary, system-ui);
  font-size: 14px;
  font-weight: 500;
  text-decoration: none;
  &:hover {
    color: #ffffff;
  }
  @media (max-width: 600px) {
    display: none;
  }
`

const OpenSwapButton = styled(Link)`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 9px 18px;
  border-radius: 999px;
  font-family: 'Plus Jakarta Sans', var(--cow-font-family-primary, system-ui);
  font-weight: 600;
  font-size: 14px;
  background: rgba(245, 239, 230, 0.08);
  border: 1px solid rgba(245, 239, 230, 0.22);
  color: #f5efe6;
  text-decoration: none;
  backdrop-filter: blur(8px);
  transition: background 140ms ease-out, border-color 140ms ease-out;
  &:hover {
    background: rgba(242, 166, 62, 0.18);
    border-color: rgba(242, 166, 62, 0.55);
    color: #ffffff;
  }
`

const Hero = styled.section`
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 24px 80px;
  gap: 28px;
  width: min(720px, 100%);
  margin: 0 auto;
  text-align: center;
  @media (max-width: 600px) {
    padding: 32px 18px 60px;
  }
`

const Eyebrow = styled.span`
  text-transform: uppercase;
  font-family: 'Plus Jakarta Sans', var(--cow-font-family-primary, system-ui);
  font-size: 11px;
  letter-spacing: 0.18em;
  color: rgba(245, 239, 230, 0.6);
  font-weight: 600;
`

const Tagline = styled.h1`
  margin: 0;
  font-family: 'Fraunces', var(--cow-font-family-primary, system-ui);
  font-weight: 500;
  font-size: clamp(34px, 5vw, 56px);
  line-height: 1.05;
  letter-spacing: -0.02em;
  color: #f5efe6;
  & em {
    font-style: italic;
    color: #f2a63e;
    font-weight: 500;
  }
`

const Sub = styled.p`
  margin: 0;
  font-family: 'Plus Jakarta Sans', var(--cow-font-family-primary, system-ui);
  font-size: 16px;
  line-height: 1.55;
  color: rgba(245, 239, 230, 0.7);
  max-width: 520px;
`

const InputBlock = styled.div`
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 12px;
`

const Helper = styled.div<{ $variant: 'hint' | 'error' }>`
  font-family: 'Plus Jakarta Sans', var(--cow-font-family-primary, system-ui);
  font-size: 13px;
  text-align: center;
  color: ${({ $variant }) => ($variant === 'error' ? '#FFB7B7' : 'rgba(245, 239, 230, 0.6)')};
  min-height: 18px;
`

const ContinueButton = styled.button<{ $active: boolean }>`
  appearance: none;
  border: none;
  border-radius: 999px;
  padding: 16px 36px;
  font-family: 'Plus Jakarta Sans', var(--cow-font-family-primary, system-ui);
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.01em;
  cursor: ${({ $active }) => ($active ? 'pointer' : 'not-allowed')};
  background: ${({ $active }) =>
    $active
      ? 'linear-gradient(135deg, #F2A63E 0%, #D960B5 60%, #4F1DCA 100%)'
      : 'rgba(245, 239, 230, 0.08)'};
  color: ${({ $active }) => ($active ? '#0a0414' : 'rgba(245, 239, 230, 0.4)')};
  transition: transform 80ms ease-out, box-shadow 160ms ease-out, filter 160ms ease-out;
  box-shadow: ${({ $active }) =>
    $active ? '0 12px 36px rgba(242, 166, 62, 0.32), 0 0 0 1px rgba(242, 166, 62, 0.4)' : 'none'};
  &:hover {
    filter: ${({ $active }) => ($active ? 'brightness(1.06)' : 'none')};
  }
  &:active {
    transform: ${({ $active }) => ($active ? 'translateY(1px)' : 'none')};
  }
  &:focus-visible {
    outline: 2px solid #f2a63e;
    outline-offset: 3px;
  }
`

const SkipLink = styled(Link)`
  font-family: 'Plus Jakarta Sans', var(--cow-font-family-primary, system-ui);
  font-size: 13px;
  color: rgba(245, 239, 230, 0.55);
  text-decoration: none;
  border-bottom: 1px solid transparent;
  padding-bottom: 1px;
  &:hover {
    color: rgba(245, 239, 230, 0.9);
    border-bottom-color: currentColor;
  }
`

function isReadyToSubmit(parsed: ParsedIntent | null): boolean {
  if (!parsed || parsed.intent !== 'swap') return false
  return parsed.entities.some((e) => e.type === 'sellToken' || e.type === 'buyToken')
}

function helperText(
  text: string,
  status: string,
  parsed: ParsedIntent | null,
  errorCode: string | null,
  errorMessage: string | null,
): { variant: 'hint' | 'error'; message: string } {
  if (errorCode) {
    if (errorMessage && /key not configured/i.test(errorMessage)) {
      return { variant: 'error', message: 'Search not enabled yet — operator setup pending.' }
    }
    if (errorCode === 'RATE_LIMITED') {
      return { variant: 'error', message: 'Slow down — wait a moment before searching again.' }
    }
    if (errorCode === 'FORBIDDEN') {
      return { variant: 'error', message: 'Origin not allowed.' }
    }
    if (errorCode === 'TIMEOUT') return { variant: 'error', message: 'Took too long — try the manual swap.' }
    if (errorCode === 'INVALID_JSON') return { variant: 'error', message: "Couldn't read that — try the manual swap." }
    return { variant: 'error', message: "Couldn't reach the parser — try the manual swap." }
  }
  if (text.trim().length === 0) {
    return { variant: 'hint', message: 'Try: "swap 100 USDC for ETH on Base"' }
  }
  if (status === 'pending' || status === 'idle') return { variant: 'hint', message: '' }
  if (parsed && parsed.intent === 'unknown') {
    return { variant: 'hint', message: 'Try: "swap [amount] [token] for [token] on [chain]"' }
  }
  return { variant: 'hint', message: '' }
}

export function IntentLanding(): ReactNode {
  const [text, setText] = useState('')
  const navigate = useNavigate()
  const parseState = useIntentParse(text)
  const ready = isReadyToSubmit(parseState.parsed)

  const handleSubmit = useCallback(() => {
    if (!ready || !parseState.parsed) return
    navigate(intentToUrl(parseState.parsed))
  }, [navigate, parseState.parsed, ready])

  const helper = useMemo(
    () => helperText(text, parseState.status, parseState.parsed, parseState.errorCode, parseState.errorMessage),
    [text, parseState.status, parseState.parsed, parseState.errorCode, parseState.errorMessage],
  )

  const entities = parseState.parsed?.entities ?? []

  return (
    <Page>
      <OphisHeader transparent>
        <NavLink to="/1/swap/_/_">Manual swap</NavLink>
        <OpenSwapButton to="/1/swap/_/_">Open Swap →</OpenSwapButton>
      </OphisHeader>

      <Hero>
        <Eyebrow>Intent-based DEX aggregator</Eyebrow>
        <Tagline>
          Tell us what to <em>swap.</em>
        </Tagline>
        <Sub>
          Describe your trade in plain English. Ophis identifies the tokens, the chain, and the amount,
          then takes you to a pre-filled swap.
        </Sub>

        <InputBlock>
          <IntentInput
            value={text}
            onChange={setText}
            onSubmit={handleSubmit}
            entities={entities}
            pending={parseState.status === 'pending'}
            placeholder="e.g. swap 100 USDC for ETH on Base"
          />
          <Helper $variant={helper.variant}>{helper.message || ' '}</Helper>
        </InputBlock>

        <ExampleChips onPick={(t) => setText(t)} />

        <ContinueButton type="button" onClick={handleSubmit} disabled={!ready} $active={ready}>
          Continue →
        </ContinueButton>

        <SkipLink to="/1/swap/_/_">Skip to manual swap</SkipLink>
      </Hero>

      <OphisFooter borderless />
    </Page>
  )
}
