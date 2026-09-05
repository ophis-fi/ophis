import { fireEvent, screen } from '@testing-library/react'

import { OtcPageView } from './Otc.page'
import { emptyState, MAKER, NOW_MS, readyState, renderView } from './Otc.page.test.utils'

describe('OtcPageView guarded write panels', () => {
  it('mounts a write panel only when the guarded controller supplies one', () => {
    renderView(
      <OtcPageView
        state={readyState()}
        account={MAKER}
        nowMs={NOW_MS}
        writeEnabled
        createPanel={<button type="button">Guarded local create</button>}
      />,
    )
    expect(screen.getByText('Local fork writes')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Create/ }))
    expect(screen.getByRole('button', { name: 'Guarded local create' })).toBeTruthy()
  })

  it('keeps fork create available while list verification is unavailable', () => {
    renderView(
      <OtcPageView
        state={emptyState('unavailable')}
        account={MAKER}
        nowMs={NOW_MS}
        writeEnabled
        createPanel={<button type="button">Guarded local create</button>}
      />,
    )
    expect(screen.getByText(/on-chain verification failed/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Guarded local create' })).toBeTruthy()
  })
})
