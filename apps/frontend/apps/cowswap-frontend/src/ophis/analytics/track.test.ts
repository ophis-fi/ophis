import { trackGa4Event } from './track'

const trackedWindow = window as unknown as { gtag?: (...args: unknown[]) => void }

describe('trackGa4Event', () => {
  afterEach(() => {
    delete trackedWindow.gtag
    window.history.replaceState({}, '', '/')
  })

  it('forwards an event to gtag', () => {
    const gtag = jest.fn()
    trackedWindow.gtag = gtag

    trackGa4Event('order_submitted', { chainId: 1 })

    expect(gtag).toHaveBeenCalledWith('event', 'order_submitted', {
      chainId: 1,
      page_location: `${window.location.origin}/`,
    })
  })

  it('removes addresses and route query parameters from the attached page location', () => {
    const gtag = jest.fn()
    trackedWindow.gtag = gtag
    window.history.replaceState(
      {},
      '',
      '/?outside=secret#/1/swap/0x0000000000000000000000000000000000000001/USDC?recipient=private',
    )

    trackGa4Event('quote_received')

    expect(gtag).toHaveBeenCalledWith('event', 'quote_received', {
      page_location: `${window.location.origin}/#/1/swap/0x_addr/USDC`,
    })
  })

  it('does not let an analytics failure interrupt the caller', () => {
    trackedWindow.gtag = () => {
      throw new Error('analytics unavailable')
    }

    expect(() => trackGa4Event('order_filled')).not.toThrow()
  })
})
