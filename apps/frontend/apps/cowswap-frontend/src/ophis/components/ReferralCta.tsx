/**
 * Referral call-to-action shown above the swap form (SwapWidget topContent).
 *
 * Growth surface: the referral program is fully built (/profile) but was
 * only reachable through a footer link. This banner puts it in front of
 * every trader until dismissed; after dismissal the slot falls back to
 * whatever secondary promo the page passes in (currently the DCA banner),
 * so the two never stack.
 */
import { useAtom } from 'jotai'
import { ReactNode, useEffect, useState } from 'react'

import { UI, closableBannersStateAtom } from '@cowprotocol/ui'

import { X } from 'react-feather'
import { NavLink } from 'react-router'
import styled from 'styled-components/macro'

import { BANNER_IDS } from 'common/constants/banners'

import { OphieMark } from './OphieMark'

const Pill = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 14px;
  border-radius: 16px;
  font-size: 13px;
  color: var(${UI.COLOR_TEXT});
  /* 1px sunset-gradient border, theme-safe: paper fill in the padding box,
     brand gradient in the border box. */
  border: 1px solid transparent;
  background:
    linear-gradient(var(${UI.COLOR_PAPER}), var(${UI.COLOR_PAPER})) padding-box,
    linear-gradient(90deg, #f2a63e, #d960b5, #7a6ee0) border-box;
`

const Copy = styled.div`
  flex: 1;
  min-width: 0;

  > strong {
    font-weight: 600;
  }
`

const MintLink = styled(NavLink)`
  color: inherit;
  display: inline;
  font-weight: 600;
  text-decoration: underline;
  white-space: nowrap;

  &:hover {
    text-decoration: none;
  }
`

const Dismiss = styled.button`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  padding: 2px;
  border: 0;
  background: none;
  border-radius: 8px;
  color: var(${UI.COLOR_TEXT_OPACITY_50});
  cursor: pointer;

  &:hover,
  &:focus-visible {
    color: var(${UI.COLOR_TEXT});
  }
`

interface ReferralCtaProps {
  /** Rendered instead of the CTA once the user dismisses it. */
  fallback?: ReactNode
}

export function ReferralCta({ fallback = null }: ReferralCtaProps): ReactNode {
  const [banners, setBanners] = useAtom(closableBannersStateAtom)
  // The banners atom hydrates from localStorage after mount; render nothing
  // for that first pass so users who dismissed the CTA never see it flash.
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => setHydrated(true), [])

  if (!hydrated) return null

  if (banners[BANNER_IDS.OPHIS_REFERRAL_CTA]) {
    return <>{fallback}</>
  }

  return (
    <Pill>
      <OphieMark size={22} fill="saffron" ariaLabel="" />
      <Copy>
        <strong>Refer friends, earn WETH.</strong> You get 8% of the fee on every trade they make, paid monthly.{' '}
        <MintLink to="/profile">Mint your link &rarr;</MintLink>
      </Copy>
      <Dismiss
        type="button"
        aria-label="Dismiss referral banner"
        onClick={() => setBanners((prev) => ({ ...prev, [BANNER_IDS.OPHIS_REFERRAL_CTA]: true }))}
      >
        <X size={16} />
      </Dismiss>
    </Pill>
  )
}
