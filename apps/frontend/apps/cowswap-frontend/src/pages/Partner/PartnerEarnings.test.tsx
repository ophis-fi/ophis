import { render, screen } from '@testing-library/react'

import { PartnerEarnings } from './PartnerDashboardCards'

jest.mock('ophis/ds', () => ({
  Section: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MetricCard: ({ label, value, sublabel }: { label: string; value: string; sublabel: string }) => (
    <div>
      {label}: {value} {sublabel}
    </div>
  ),
}))
jest.mock('modules/affiliate', () => ({}))

it('keeps earnings visible while payouts are disabled, without promising a date', () => {
  render(
    <PartnerEarnings
      estimatedCurrentCycleEarningsUsd={0.12}
      paidToDateUsd={0}
      payoutStatus="disabled"
      nextPayoutAt="2026-10-01T02:00:00Z"
    />,
  )
  expect(screen.getByText(/~\$0.12/)).toBeTruthy()
  expect(screen.getByText(/Disabled/)).toBeTruthy()
  expect(screen.queryByText(/Oct 1/)).toBeNull()
})

it('does not round positive sub-cent earnings to zero', () => {
  render(<PartnerEarnings estimatedCurrentCycleEarningsUsd={0.001} payoutStatus="not-configured" />)
  expect(screen.getByText(/<\$0.01/)).toBeTruthy()
})

it('labels a scheduled cycle without guaranteeing its payment date', () => {
  render(<PartnerEarnings payoutStatus="scheduled" nextPayoutAt="2026-10-01T12:00:00Z" />)
  expect(screen.getByText(/Scheduled/)).toBeTruthy()
  expect(screen.getByText(/Next cycle: Oct 1, 2026/)).toBeTruthy()
  expect(screen.getByText(/not a guaranteed payment date/)).toBeTruthy()
})

it('never shows a payout date during a dry run', () => {
  render(<PartnerEarnings payoutStatus="dry-run" nextPayoutAt="2026-10-01T12:00:00Z" />)
  expect(screen.getByText(/Dry run/)).toBeTruthy()
  expect(screen.getByText(/No payout date confirmed/)).toBeTruthy()
  expect(screen.queryByText(/Oct 1/)).toBeNull()
})
