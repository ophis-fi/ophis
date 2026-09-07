import type { ReactNode } from 'react'

import { Callout } from 'ophis/ds'
import { formatOtcAmount, getOtcTokenMeta } from 'ophis/otc'

import { OTC_CANARY_POLICY } from './otcCanary.const'

export function OtcWriteNotice(): ReactNode {
  if (process.env.REACT_APP_OTC_WRITE_MODE !== 'canary') {
    return (
      <Callout tone="warning" title="Fork-only transaction mode">
        <p>
          These wallet prompts use your local Ethereum fork. Every action re-reads the pinned escrow and simulates the
          exact transaction.
        </p>
      </Callout>
    )
  }
  return (
    <Callout tone="warning" title="Restricted Ethereum canary">
      <p>
        These transactions use real Ethereum assets and cost gas. Only admitted wallets and reviewed pairs can trade
        within the limits below. Cancellation and allowance revocation remain available after trading closes.
      </p>
      <p>
        New approval and trade requests close at {new Date(Number(OTC_CANARY_POLICY.expiresAt) * 1_000).toJSON()}.
        Existing orders remain active until filled or cancelled. Wallet prompts already opened can still execute later.
      </p>
      <ul>
        {OTC_CANARY_POLICY.pairs.map((pair) => {
          const tokenA = getOtcTokenMeta(pair.tokenA)
          const tokenB = getOtcTokenMeta(pair.tokenB)
          if (!tokenA || !tokenB) return null
          return (
            <li key={`${pair.tokenA}:${pair.tokenB}`}>
              Per-order maximum: {formatOtcAmount(pair.maxAmountA, tokenA.decimals)} {tokenA.symbol} and{' '}
              {formatOtcAmount(pair.maxAmountB, tokenB.decimals)} {tokenB.symbol}, in either direction.
            </li>
          )
        })}
      </ul>
      <p>
        Limits apply through this interface. They do not cap your total escrow exposure or protect an order from market
        moves.
      </p>
    </Callout>
  )
}
