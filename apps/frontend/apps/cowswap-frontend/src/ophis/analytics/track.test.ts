import { trackGa4Event } from './track'

const trackedWindow = window as unknown as { gtag?: (...args: unknown[]) => void }

describe('trackGa4Event', () => {
  afterEach(() => {
    delete trackedWindow.gtag
  })

  it('forwards an event to gtag', () => {
    const gtag = jest.fn()
    trackedWindow.gtag = gtag

    trackGa4Event('order_submitted', { chainId: 1 })

    expect(gtag).toHaveBeenCalledWith('event', 'order_submitted', { chainId: 1 })
  })

  it('does not let an analytics failure interrupt the caller', () => {
    trackedWindow.gtag = () => {
      throw new Error('analytics unavailable')
    }

    expect(() => trackGa4Event('order_filled')).not.toThrow()
  })
})
