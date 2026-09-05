import { useCallback, useMemo, useState, type ReactNode } from 'react'

import { USDC_MAINNET, WETH_MAINNET } from '@cowprotocol/common-const'
import { useWalletInfo } from '@cowprotocol/wallet'

import { Badge, Callout, Section } from 'ophis/ds'
import { formatOtcAmount } from 'ophis/otc'

import { OtcActionControl } from './OtcActionControl.container'
import { OtcUsdValue } from './OtcUsdValue.pure'
import * as styledEl from './OtcWrite.styled'
import { OTC_REVIEWED_TOKENS, parseOtcCreateDraft, reviewedOtcToken, type OtcReviewedToken } from './otcWriteForm'
import { getOtcActionReviewKey } from './otcWriteOrder.utils'
import { useOtcUsdAmount } from './useOtcUsdAmount'

import type { OtcActionDefinition } from './useOtcActionController'
import type { Address, Hex } from 'viem'

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
  usdValueA: string | null
  usdValueB: string | null
  usdLoadingA: boolean
  usdLoadingB: boolean
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
        <OtcUsdValue amount={parsedAmountA} value={props.usdValueA} isLoading={props.usdLoadingA} />
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
        <OtcUsdValue amount={parsedAmountB} value={props.usdValueB} isLoading={props.usdLoadingB} />
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
  const [reviewedKey, setReviewedKey] = useState<string | null>(null)
  const tokenA = reviewedOtcToken(tokenAAddress) ?? OTC_REVIEWED_TOKENS[0]
  const tokenB = reviewedOtcToken(tokenBAddress) ?? OTC_REVIEWED_TOKENS[1]
  const draft = useMemo(
    () => parseOtcCreateDraft({ tokenA, amountA, tokenB, amountB }),
    [amountA, amountB, tokenA, tokenB],
  )
  const parsedAmountA = draft?.amountA ?? null
  const parsedAmountB = draft?.amountB ?? null
  const usdAmountA = useOtcUsdAmount(tokenA, parsedAmountA)
  const usdAmountB = useOtcUsdAmount(tokenB, parsedAmountB)
  const resetKey = getOtcActionReviewKey(account, [
    tokenA.address,
    draft?.amountA ?? amountA.trim(),
    tokenB.address,
    draft?.amountB ?? amountB.trim(),
  ])
  const reviewed = reviewedKey === resetKey
  const handleConfirmed = useCallback(
    (_transactionHash: Hex) => {
      onConfirmed?.()
    },
    [onConfirmed],
  )
  const definition = useMemo<OtcActionDefinition>(
    () => ({
      executeLabel: 'Create escrow order',
      ready: draft !== null,
      reviewed,
      resetKey,
      executeIntent: account && draft ? { kind: 'create', account, draft } : null,
      approvalIntent: account && draft ? { kind: 'approve-create', account, draft } : null,
      revokeIntent: account
        ? { kind: 'revoke-create', account, draft: { tokenA: tokenA.address, tokenB: tokenB.address } }
        : null,
      allowanceToken: tokenA.address,
      allowanceTokenDecimals: tokenA.decimals,
      allowanceTokenSymbol: tokenA.symbol,
      requiredAllowance: draft?.amountA ?? null,
    }),
    [account, draft, resetKey, reviewed, tokenA.address, tokenA.decimals, tokenA.symbol, tokenB.address],
  )
  const update = (setter: (value: string) => void, value: string): void => {
    setter(value)
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
        parsedAmountA={parsedAmountA}
        parsedAmountB={parsedAmountB}
        usdValueA={usdAmountA.value}
        usdValueB={usdAmountB.value}
        usdLoadingA={usdAmountA.isLoading}
        usdLoadingB={usdAmountB.isLoading}
      />
      <styledEl.WriteSummary>
        <Badge tone="audit">Exact approval only</Badge>
        <p>Escrow: {draft ? `${formatOtcAmount(draft.amountA, tokenA.decimals)} ${tokenA.symbol}` : '—'}</p>
        <p>Receive: {draft ? `${formatOtcAmount(draft.amountB, tokenB.decimals)} ${tokenB.symbol}` : '—'}</p>
        <p>Orders do not expire automatically and fills are all-or-nothing.</p>
      </styledEl.WriteSummary>
      <styledEl.ReviewLabel>
        <input
          type="checkbox"
          checked={reviewed}
          onChange={(event) => setReviewedKey(event.target.checked ? resetKey : null)}
        />
        I reviewed both exact token amounts, the escrow risks, and the absence of automatic expiry.
      </styledEl.ReviewLabel>
      <OtcActionControl definition={definition} onConfirmed={handleConfirmed} />
    </Section>
  )
}
