import { isSellOrder } from '@cowprotocol/common-utils'
import { OrderKind } from '@cowprotocol/cow-sdk'

import { t } from '@lingui/core/macro'

import { Order } from 'legacy/state/orders/actions'

import { SurplusData } from 'common/hooks/useGetSurplusFiatValue'
import { safeToSignificant } from 'common/utils/safeCurrencyAmount'

export function truncateWithEllipsis(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str
  return str.slice(0, maxLength - 3) + '...'
}

// The bare Ophis swap origin that the share copy links to. Kept identical to the
// literal inside the translatable strings below (and their es/ru catalog
// entries) so appendRefToShareText can find and enrich it in every locale.
export const OPHIS_SWAP_ORIGIN = 'https://swap.ophis.fi'

/**
 * If the sharer has their own referral code, rewrite the Ophis swap link in an
 * already-built (and possibly translated) share message to carry it as `?ref=`,
 * so anyone who opens the shared post binds to the sharer. Runs BEFORE
 * encodeURIComponent. No-op without a code, or if the message doesn't contain
 * the swap origin (e.g. a future translation drops the URL) — the link then
 * stays the plain origin, never broken. Deliberately does NOT touch the
 * translatable strings, so no catalog churn.
 */
export function appendRefToShareText(text: string, refCode: string | undefined): string {
  if (!refCode) return text
  return text.replace(OPHIS_SWAP_ORIGIN, `${OPHIS_SWAP_ORIGIN}/?ref=${encodeURIComponent(refCode)}`)
}

// TODO: Add proper return type annotation
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function getTwitterText(surplusAmount: string, surplusToken: string, orderKind: OrderKind, refCode?: string) {
  const actionWord = isSellOrder(orderKind) ? t`got` : t`saved`
  const surplus = `${surplusAmount} ${surplusToken}`
  return encodeURIComponent(
    appendRefToShareText(
      t`I just ${actionWord} an extra ${surplus} on Ophis.\n\nIntent-based swaps with MEV protection. https://swap.ophis.fi`,
      refCode,
    ),
  )
}

export function getTwitterShareUrl(
  surplusData: SurplusData | undefined,
  order: Order | undefined,
  refCode?: string,
): string {
  // Defensive: `.toSignificant()` also reads `.currency.decimals` internally
  // and throws on a hydrated-from-stale-atom amount with undefined currency.
  // `safeToSignificant` swallows the throw → fall back to '0'. The symbol
  // path was already nullish-guarded.
  const surplusAmount = safeToSignificant(surplusData?.surplusAmount)
  const surplusToken = surplusData?.surplusAmount?.currency?.symbol || t`Unknown token`
  const orderKind = order?.kind || OrderKind.SELL

  const twitterText = getTwitterText(surplusAmount, surplusToken, orderKind, refCode)
  return `https://x.com/intent/tweet?text=${twitterText}`
}

export function getTwitterTextForBenefit(benefit: string, refCode?: string): string {
  return encodeURIComponent(
    appendRefToShareText(t`Did you know? ${benefit}\n\nStart swapping on Ophis: https://swap.ophis.fi`, refCode),
  )
}

export function getTwitterShareUrlForBenefit(benefit: string, refCode?: string): string {
  const twitterText = getTwitterTextForBenefit(benefit, refCode)
  return `https://x.com/intent/tweet?text=${twitterText}`
}

export function getSurplusText(isSell: boolean | undefined, isCustomRecipient: boolean | undefined): string {
  if (isSell) {
    return isCustomRecipient ? t`including an extra ` : t`and got an extra `
  }
  return t`and saved `
}
