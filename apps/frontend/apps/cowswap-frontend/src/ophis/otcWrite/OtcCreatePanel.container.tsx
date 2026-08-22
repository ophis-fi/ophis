import { useCallback, useMemo, useState, type ReactNode } from 'react'

import { USDC_MAINNET, WETH_MAINNET } from '@cowprotocol/common-const'
import { useWalletInfo } from '@cowprotocol/wallet'

import { Badge, Callout, Section } from 'ophis/ds'
import { formatOtcAmount } from 'ophis/otc'

import { OtcActionControl } from './OtcActionControl.container'
import { OtcUsdValue } from './OtcUsdValue.pure'
import * as styledEl from './OtcWrite.styled'
import { OTC_REVIEWED_TOKENS, parseOtcCreateDraft, reviewedOtcToken, type OtcReviewedToken } from './otcWriteForm'

import type { OtcActionDefinition } from './useOtcActionController'
import type { Address } from 'viem'

interface OtcCreateFieldsProps {
  tokenA: OtcReviewedToken
  tokenB: OtcReviewedToken
  amountA: string
  amountB: string
  onTokenA(address: Address): void
  onTokenB(address: Address): void
  onAmountA(value: string): void
  onAmountB(value: string): void
  parsedAmountA: bigint | null
  parsedAmountB: bigint | null
}

function OtcCreateFields(props: OtcCreateFieldsProps): ReactNode {
  const { tokenA, tokenB, amountA, amountB, parsedAmountA, parsedAmountB } = props
  return (
    <styledEl.WriteGrid>
      <styledEl.WriteField>
        Maker escrows
        <select
          aria-label="Maker escrow token"
          value={tokenA.address}
          onChange={(event) => props.onTokenA(event.target.value as Address)}
        >
          {OTC_REVIEWED_TOKENS.map((token) => (
            <option key={token.address} value={token.address} disabled={token.address === tokenB.address}>
              {token.symbol} — {token.name}
            </option>
          ))}
        </select>
        <input
          aria-label="Maker escrow amount"
          inputMode="decimal"
          autoComplete="off"
          placeholder={`Amount in ${tokenA.symbol}`}
          value={amountA}
          onChange={(event) => props.onAmountA(event.target.value)}
        />
        <OtcUsdValue token={tokenA} amount={parsedAmountA} />
      </styledEl.WriteField>
      <styledEl.WriteField>
        Maker requests
        <select
          aria-label="Requested token"
          value={tokenB.address}
          onChange={(event) => props.onTokenB(event.target.value as Address)}
        >
          {OTC_REVIEWED_TOKENS.map((token) => (
            <option key={token.address} value={token.address} disabled={token.address === tokenA.address}>
              {token.symbol} — {token.name}
            </option>
          ))}
        </select>
        <input
          aria-label="Requested amount"
          inputMode="decimal"
          autoComplete="off"
          placeholder={`Amount in ${tokenB.symbol}`}
          value={amountB}
          onChange={(event) => props.onAmountB(event.target.value)}
        />
        <OtcUsdValue token={tokenB} amount={parsedAmountB} />
      </styledEl.WriteField>
    </styledEl.WriteGrid>
  )
}

export function OtcCreatePanel({ onConfirmed }: { onConfirmed?: () => void }): ReactNode {
  const { account } = useWalletInfo()
  const [tokenAAddress, setTokenAAddress] = useState<Address>(WETH_MAINNET.address)
  const [tokenBAddress, setTokenBAddress] = useState<Address>(USDC_MAINNET.address)
  const [amountA, setAmountA] = useState('')
  const [amountB, setAmountB] = useState('')
  const [reviewed, setReviewed] = useState(false)
  const tokenA = reviewedOtcToken(tokenAAddress) ?? OTC_REVIEWED_TOKENS[0]
  const tokenB = reviewedOtcToken(tokenBAddress) ?? OTC_REVIEWED_TOKENS[1]
  const draft = useMemo(
    () => parseOtcCreateDraft({ tokenA, amountA, tokenB, amountB }),
    [amountA, amountB, tokenA, tokenB],
  )
  const resetKey = `${tokenA.address}:${amountA}:${tokenB.address}:${amountB}`
  const handleConfirmed = useCallback(() => {
    onConfirmed?.()
  }, [onConfirmed])
  const definition = useMemo<OtcActionDefinition>(
    () => ({
      executeLabel: 'Create escrow order',
      ready: draft !== null,
      reviewed,
      resetKey,
      executeIntent: account && draft ? { kind: 'create', account, draft } : null,
      approvalIntent: account && draft ? { kind: 'approve-create', account, draft } : null,
      revokeIntent: account && draft ? { kind: 'revoke-create', account, draft } : null,
      allowanceToken: draft?.tokenA ?? null,
      allowanceTokenDecimals: tokenA.decimals,
      allowanceTokenSymbol: tokenA.symbol,
      requiredAllowance: draft?.amountA ?? null,
    }),
    [account, draft, resetKey, reviewed, tokenA.decimals, tokenA.symbol],
  )
  const update = (setter: (value: string) => void, value: string): void => {
    setter(value)
    setReviewed(false)
  }

  return (
    <Section id="otc-create" title="Create on local Ethereum fork">
      <Callout tone="warning" title="Fork-only transaction mode">
        <p>
          These wallet prompts target the pinned Ethereum escrow through your configured local fork. Production writes
          remain disabled.
        </p>
      </Callout>
      <OtcCreateFields
        tokenA={tokenA}
        tokenB={tokenB}
        amountA={amountA}
        amountB={amountB}
        onTokenA={(value) => update((address) => setTokenAAddress(address as Address), value)}
        onTokenB={(value) => update((address) => setTokenBAddress(address as Address), value)}
        onAmountA={(value) => update(setAmountA, value)}
        onAmountB={(value) => update(setAmountB, value)}
        parsedAmountA={draft?.amountA ?? null}
        parsedAmountB={draft?.amountB ?? null}
      />
      <styledEl.WriteSummary>
        <Badge tone="audit">Exact approval only</Badge>
        <p>Escrow: {draft ? `${formatOtcAmount(draft.amountA, tokenA.decimals)} ${tokenA.symbol}` : '—'}</p>
        <p>Receive: {draft ? `${formatOtcAmount(draft.amountB, tokenB.decimals)} ${tokenB.symbol}` : '—'}</p>
        <p>Orders do not expire automatically and fills are all-or-nothing.</p>
      </styledEl.WriteSummary>
      <styledEl.ReviewLabel>
        <input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} />I reviewed
        both exact token amounts, the escrow risks, and the absence of automatic expiry.
      </styledEl.ReviewLabel>
      <OtcActionControl definition={definition} onConfirmed={handleConfirmed} />
    </Section>
  )
}
