import { render, screen } from '@testing-library/react'

import { OtcUsdValue } from './OtcUsdValue.pure'

describe('OtcUsdValue', () => {
  it('keeps amount, loading, unavailable, and quoted states explicit', () => {
    const { rerender } = render(<OtcUsdValue amount={null} value={null} isLoading={false} />)
    expect(screen.getByText('Enter a positive amount.')).toBeTruthy()

    rerender(<OtcUsdValue amount={1n} value={null} isLoading />)
    expect(screen.getByText('Loading USD estimate...')).toBeTruthy()

    rerender(<OtcUsdValue amount={1n} value={null} isLoading={false} />)
    expect(screen.getByText('USD estimate unavailable')).toBeTruthy()

    rerender(<OtcUsdValue amount={1n} value="123.45" isLoading={false} />)
    expect(screen.getByText('Approximately $123.45')).toBeTruthy()
  })
})
