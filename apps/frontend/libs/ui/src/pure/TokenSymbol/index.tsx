import { ReactNode } from 'react'

import { CircleTokenIdentity, isCircleToken } from '@cowprotocol/common-const'
import { formatSymbol } from '@cowprotocol/common-utils'
import { Currency } from '@cowprotocol/currency'
import { Nullish } from '@cowprotocol/types'

import { t } from '@lingui/core/macro'
import { CheckCircle } from 'react-feather'

export type TokenNameAndSymbol = Pick<Currency, 'symbol' | 'name'>

export type TokenSymbolProps = {
  token: Nullish<TokenNameAndSymbol & CircleTokenIdentity>
  length?: number
  className?: string
}

export function formatTokenSymbol(props: Omit<TokenSymbolProps, 'className'>): string | null {
  const abbreviatedSymbol = getAbbreviatedSymbol(props)
  if (!abbreviatedSymbol) return null

  return abbreviatedSymbol.abbreviateSymbol || null
}

export function TokenSymbol(props: TokenSymbolProps): ReactNode {
  const abbreviatedSymbol = getAbbreviatedSymbol(props)
  if (!abbreviatedSymbol) return null

  const { abbreviateSymbol, title } = abbreviatedSymbol
  const verified = isCircleToken(props.token)
  const verificationLabel = verified
    ? t`Circle-issued token: contract address matches Circle's official records`
    : undefined

  return (
    <span className={props.className} title={title}>
      {abbreviateSymbol}
      {verified && (
        <span title={verificationLabel}>
          <CheckCircle
            size={14}
            role="img"
            aria-label={verificationLabel}
            style={{ marginLeft: 4, verticalAlign: -2 }}
          />
        </span>
      )}
    </span>
  )
}

// TODO: Add proper return type annotation
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function getAbbreviatedSymbol(props: Omit<TokenSymbolProps, 'className'>) {
  const { token, length } = props
  const { symbol, name } = token || {}

  if (!symbol && !name) return null

  const fullSymbol = symbol || name
  const abbreviateSymbol = formatSymbol(fullSymbol, length)
  const title = fullSymbol === abbreviateSymbol ? undefined : fullSymbol

  return {
    abbreviateSymbol,
    title,
  }
}
