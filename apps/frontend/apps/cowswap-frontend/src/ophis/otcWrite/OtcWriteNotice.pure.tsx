import type { ReactNode } from 'react'

import { Trans, useLingui } from '@lingui/react/macro'
import { Callout } from 'ophis/ds'
import { formatOtcAmount, getOtcTokenMeta } from 'ophis/otc'

import { OTC_CANARY_POLICY } from './otcCanary.const'

export function OtcWriteNotice(): ReactNode {
  const { t } = useLingui()
  if (process.env.REACT_APP_OTC_WRITE_MODE !== 'canary') {
    return (
      <Callout tone="warning" title={t`Fork-only transaction mode`}>
        <p>
          <Trans>
            These wallet prompts use your local Ethereum fork. Every action re-reads the pinned escrow and simulates the
            exact transaction.
          </Trans>
        </p>
      </Callout>
    )
  }
  const expiresAt = new Date(Number(OTC_CANARY_POLICY.expiresAt) * 1_000).toJSON()
  return (
    <Callout tone="warning" title={t`Restricted Ethereum canary`}>
      <p>
        <Trans>
          These transactions use real Ethereum assets and cost gas. Only admitted wallets and reviewed pairs can trade
          within the limits below. Cancellation and allowance revocation remain available after trading closes.
        </Trans>
      </p>
      <p>
        <Trans>
          New approval and trade requests close at {expiresAt}. Existing orders remain active until filled or cancelled.
          Wallet prompts already opened can still execute later.
        </Trans>
      </p>
      <ul>
        {OTC_CANARY_POLICY.pairs.map((pair) => {
          const tokenA = getOtcTokenMeta(pair.tokenA)
          const tokenB = getOtcTokenMeta(pair.tokenB)
          if (!tokenA || !tokenB) return null
          const amountA = `${formatOtcAmount(pair.maxAmountA, tokenA.decimals)} ${tokenA.symbol}`
          const amountB = `${formatOtcAmount(pair.maxAmountB, tokenB.decimals)} ${tokenB.symbol}`
          return (
            <li key={`${pair.tokenA}:${pair.tokenB}`}>
              <Trans>
                Per-order maximum: {amountA} and {amountB}, in either direction.
              </Trans>
            </li>
          )
        })}
      </ul>
      <p>
        <Trans>
          Limits apply through this interface. They do not cap your total escrow exposure or protect an order from
          market moves.
        </Trans>
      </p>
    </Callout>
  )
}
