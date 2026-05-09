/**
 * Ophis landing page — natural-language swap intent surface.
 *
 * Mounted at `/`. Replaces the upstream cowswap behavior where `/`
 * redirects directly to `/swap`. The "Skip to manual swap →" link
 * preserves the legacy path for users who already know what they want.
 *
 * See docs/development/specs/2026-05-08-ophis-intent-input-design.md.
 */
import { ReactNode, useCallback, useMemo, useState } from 'react'

import { useNavigate } from 'react-router'
import styled from 'styled-components/macro'

import { OphieMark } from '../OphieMark'
import { ChipRow, EntityChip } from './EntityChip'
import { ExampleChips } from './ExampleChips'
import { IntentInput } from './IntentInput'
import { intentToUrl } from './intentToUrl'
import type { ParsedIntent } from './types'
import { useIntentParse } from './useIntentParse'

const Page = styled.main`
  /* Cover the full viewport even though the cowswap AppWrapper has its
     own width constraints (we bypass the chrome but the wrapper still
     wraps us). 100vw avoids relying on parent layout. */
  width: 100vw;
  margin-left: calc(50% - 50vw);
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 64px 24px 88px;
  gap: 28px;
  background: ${({ theme }) =>
    theme.darkMode
      ? 'radial-gradient(140% 110% at 30% 0%, #2a0b07 0%, #1f2224 65%, #131214 100%)'
      : 'radial-gradient(140% 110% at 30% 0%, #fff3ee 0%, #ffe1d4 55%, #fff8f4 100%)'};
`

const Hero = styled.section`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 24px;
  width: min(620px, 100%);
`

const Mascot = styled.div`
  width: 120px;
  height: 120px;
  display: flex;
  align-items: center;
  justify-content: center;
`

const Tagline = styled.h1`
  margin: 0;
  font-family: 'Fraunces', var(--cow-font-family-primary);
  font-weight: 500;
  font-size: clamp(28px, 4vw, 40px);
  line-height: 1.1;
  letter-spacing: -0.015em;
  color: var(--greg-color-text-primary, #1f2224);
  text-align: center;
`

const Sub = styled.p`
  margin: 0;
  font-family: var(--cow-font-family-primary);
  font-size: 15px;
  color: var(--greg-color-text-secondary, #53575a);
  text-align: center;
  max-width: 480px;
`

const SubmitRow = styled.div`
  display: flex;
  gap: 12px;
  justify-content: center;
  align-items: center;
  padding-top: 4px;
`

const ContinueButton = styled.button<{ $active: boolean }>`
  appearance: none;
  border: none;
  border-radius: 999px;
  padding: 14px 28px;
  font-family: var(--cow-font-family-primary);
  font-size: 15px;
  font-weight: 600;
  cursor: ${({ $active }) => ($active ? 'pointer' : 'not-allowed')};
  background: ${({ $active }) => ($active ? '#e66a55' : 'rgba(110, 115, 117, 0.18)')};
  color: ${({ $active }) => ($active ? '#ffffff' : '#898d8f')};
  transition: transform 80ms ease-out, background 140ms ease-out, box-shadow 140ms ease-out;
  box-shadow: ${({ $active }) => ($active ? '0 8px 22px rgba(230, 106, 85, 0.32)' : 'none')};

  &:hover {
    background: ${({ $active }) => ($active ? '#c2503d' : 'rgba(110, 115, 117, 0.18)')};
  }

  &:active {
    transform: ${({ $active }) => ($active ? 'translateY(1px)' : 'none')};
  }

  &:focus-visible {
    outline: 2px solid #e66a55;
    outline-offset: 3px;
  }
`

const SkipLink = styled.a`
  font-family: var(--cow-font-family-primary);
  font-size: 13px;
  color: var(--greg-color-text-tertiary, #898d8f);
  text-decoration: none;
  border-bottom: 1px solid transparent;
  padding-bottom: 1px;

  &:hover {
    color: var(--greg-color-text-secondary, #53575a);
    border-bottom-color: currentColor;
  }
`

const Helper = styled.div<{ $variant: 'hint' | 'error' }>`
  font-family: var(--cow-font-family-primary);
  font-size: 13px;
  text-align: center;
  color: ${({ $variant }) => ($variant === 'error' ? '#993627' : 'var(--greg-color-text-tertiary, #898d8f)')};
  min-height: 18px;
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
): {
  variant: 'hint' | 'error'
  message: string
} {
  if (errorCode) {
    // Surface "key not configured" verbatim so operators see exactly
    // what's missing instead of a generic "couldn't read that".
    if (errorMessage && /key not configured/i.test(errorMessage)) {
      return { variant: 'error', message: 'Search not enabled yet — operator setup pending.' }
    }
    if (errorCode === 'TIMEOUT') return { variant: 'error', message: 'Took too long — try the manual swap.' }
    if (errorCode === 'INVALID_JSON') return { variant: 'error', message: 'Couldn’t read that — try the manual swap.' }
    return { variant: 'error', message: 'Couldn’t reach the parser — try the manual swap.' }
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
      <Hero>
        <Mascot>
          <OphieMark size={120} fill="sunset" animate="pulse" ariaLabel="Ophis" />
        </Mascot>
        <Tagline>Tell us what to swap.</Tagline>
        <Sub>
          Describe your trade in plain English. Ophis figures out the tokens, the chain, and the
          amount, then takes you to a pre-filled swap.
        </Sub>

        <IntentInput
          value={text}
          onChange={setText}
          onSubmit={handleSubmit}
          entities={entities}
          pending={parseState.status === 'pending'}
          placeholder="e.g. swap 100 USDC for ETH on Base"
        />

        <ChipRow>
          {entities.map((e, i) => (
            <EntityChip key={`${e.type}-${e.start}-${i}`} entity={e} />
          ))}
        </ChipRow>

        <Helper $variant={helper.variant}>{helper.message || ' '}</Helper>

        <ExampleChips onPick={(t) => setText(t)} />

        <SubmitRow>
          <ContinueButton type="button" onClick={handleSubmit} disabled={!ready} $active={ready}>
            Continue →
          </ContinueButton>
        </SubmitRow>

        <SkipLink href="#/swap">Skip to manual swap →</SkipLink>
      </Hero>
    </Page>
  )
}
