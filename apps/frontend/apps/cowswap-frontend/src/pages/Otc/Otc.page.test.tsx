import { fireEvent, screen } from '@testing-library/react'

import { OtcPageView } from './Otc.page'
import { emptyState, MAKER, NOW_MS, OTHER, readyState, renderView, USDC } from './Otc.page.test.utils'

describe('OtcPageView', () => {
  it('shows a loading state', () => {
    renderView(<OtcPageView state={emptyState('loading')} account={undefined} nowMs={NOW_MS} />)
    expect(screen.getByText(/Loading OTC orders/)).toBeTruthy()
  })

  it('fails closed visually when on-chain verification is unavailable', () => {
    const { container } = renderView(
      <OtcPageView state={emptyState('unavailable')} account={undefined} nowMs={NOW_MS} />,
    )
    expect(screen.getByText(/on-chain verification failed/i)).toBeTruthy()
    expect(container.querySelector('table')).toBeNull()
  })

  it('renders active allowlisted orders with verification, review, and rate information', () => {
    renderView(<OtcPageView state={readyState()} account={undefined} nowMs={NOW_MS} />)

    // browse is allowlisted-only: the unreviewed-token order (id 3) is
    // excluded from the official liquidity surface
    expect(screen.getByText('#2')).toBeTruthy()
    expect(screen.queryByText('#3')).toBeNull()
    expect(screen.queryByText('#1')).toBeNull()
    expect(screen.queryByText('#0')).toBeNull()
    expect(screen.queryByText('Unreviewed token')).toBeNull()

    // reviewed row: curated symbols + rate; the gated verification badge
    // renders exactly for reconciled rows
    expect(screen.getAllByText(/1 WETH/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/4000 USDC/).length).toBeGreaterThan(0)
    expect(screen.getAllByText('Verified on-chain')).toHaveLength(1)
    expect(screen.getAllByText('Escrowed')).toHaveLength(1)

    // ethereum-only surface, age rendering
    expect(screen.getAllByText('Ethereum').length).toBeGreaterThan(0)
    expect(screen.getAllByText('3h ago').length).toBeGreaterThan(0)

    // each row links to its detail route and offers copy + explorer actions
    const detailLink = screen.getByRole('link', { name: 'Order 2 details' })
    expect(detailLink.getAttribute('href')).toBe('/otc/2')
    expect(screen.getAllByRole('button', { name: /Copy maker address 0x/ }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('link', { name: /on Etherscan$/ }).length).toBeGreaterThan(0)
  })

  it('exposes the full disclosure hierarchy', () => {
    renderView(<OtcPageView state={readyState()} account={undefined} nowMs={NOW_MS} />)
    expect(screen.getByText(/external immutable escrow contract/i)).toBeTruthy()
    expect(screen.getByText(/costs Ethereum gas/i)).toBeTruthy()
    expect(screen.getByText(/orders do not expire on-chain/i)).toBeTruthy()
    expect(screen.getByText(/all-or-nothing/i)).toBeTruthy()
    expect(screen.getByText(/may be raced/i)).toBeTruthy()
    expect(screen.getByText(/Ophis-reviewed assets/i)).toBeTruthy()
  })

  it('keeps every transaction affordance unreachable', () => {
    const { container } = renderView(<OtcPageView state={readyState()} account={MAKER} nowMs={NOW_MS} />)

    fireEvent.click(screen.getByRole('button', { name: /Create/ }))
    const createButton = screen.getByRole('button', { name: 'Order creation is not yet enabled' })
    expect((createButton as HTMLButtonElement).disabled).toBe(true)

    const actionable = Array.from(container.querySelectorAll('button')).filter(
      (button) => /fill|cancel|approve|sign|submit/i.test(button.textContent ?? '') && !button.disabled,
    )
    expect(actionable).toEqual([])
  })

  it('shows the connected wallet orders including resolved ones under My orders', () => {
    renderView(<OtcPageView state={readyState()} account={MAKER.toLowerCase()} nowMs={NOW_MS} />)
    fireEvent.click(screen.getByRole('button', { name: /My orders/ }))

    expect(screen.getByText('#3')).toBeTruthy()
    expect(screen.getByText('#2')).toBeTruthy()
    expect(screen.getByText('#0')).toBeTruthy()
    expect(screen.queryByText('#1')).toBeNull() // other maker
    // lifecycle is an explicitly-labeled index claim, never an authoritative badge
    expect(screen.getByText('index: cancelled')).toBeTruthy()
    expect(screen.queryByText('Cancelled')).toBeNull()
    expect(screen.getAllByText('Inactive').length).toBeGreaterThan(0)
    // resolved rows are no longer escrowed: badge only on the two active rows
    expect(screen.getAllByText('Escrowed')).toHaveLength(2)
    // the maker's own unreviewed-token order stays visible here, read-only,
    // with honest raw-units rendering
    expect(screen.getByText('Unreviewed token')).toBeTruthy()
    expect(screen.getByText(/0xE9b1\.\.\.64ED/)).toBeTruthy()
    expect(screen.getAllByText(/raw units/).length).toBeGreaterThan(0)
    // all three rows reconciled in this fixture
    expect(screen.getAllByText('Verified on-chain')).toHaveLength(3)
  })

  it('asks for a wallet connection under My orders when disconnected', () => {
    renderView(<OtcPageView state={readyState()} account={undefined} nowMs={NOW_MS} />)
    fireEvent.click(screen.getByRole('button', { name: /My orders/ }))
    expect(screen.getByText(/Connect a wallet/)).toBeTruthy()
  })

  it('says index data is hidden only when it actually is (index unavailable)', () => {
    renderView(
      <OtcPageView
        state={readyState({
          status: 'degraded',
          degradedReason: 'index-unavailable',
          enrichment: null,
          reconciliation: null,
          indexLagBlocks: null,
        })}
        account={undefined}
        nowMs={NOW_MS}
      />,
    )
    expect(screen.getByText('Index data unavailable')).toBeTruthy()
    expect(screen.getByText(/Ages and history are hidden/)).toBeTruthy()
    expect(screen.getByText('#2')).toBeTruthy()
    // no reconciliation -> no verification badge anywhere
    expect(screen.queryByText('Verified on-chain')).toBeNull()
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
  })

  it('says index data may lag when it is stale but still shown', () => {
    renderView(
      <OtcPageView
        state={readyState({ status: 'degraded', degradedReason: 'index-stale', indexLagBlocks: 500n })}
        account={undefined}
        nowMs={NOW_MS}
      />,
    )
    expect(screen.getByText('Index data is stale')).toBeTruthy()
    expect(screen.getByText(/may lag behind the chain/)).toBeTruthy()
    // stale enrichment is still rendered, honestly labeled
    expect(screen.getAllByText('3h ago').length).toBeGreaterThan(0)
  })

  it('flags partially invalid index data without hiding on-chain state', () => {
    renderView(
      <OtcPageView
        state={readyState({ status: 'degraded', degradedReason: 'index-corrupt' })}
        account={undefined}
        nowMs={NOW_MS}
      />,
    )
    expect(screen.getByText('Index data partially invalid')).toBeTruthy()
    expect(screen.getByText('#2')).toBeTruthy()
  })

  it('warns when the RPC node itself is behind the network', () => {
    renderView(
      <OtcPageView
        state={readyState({ status: 'degraded', degradedReason: 'node-stale' })}
        account={undefined}
        nowMs={NOW_MS}
      />,
    )
    expect(screen.getByText('Network data may be outdated')).toBeTruthy()
    expect(screen.getByText('#2')).toBeTruthy()
  })

  it('filters browse rows by token, maker, and order id', () => {
    renderView(<OtcPageView state={readyState()} account={undefined} nowMs={NOW_MS} />)

    fireEvent.change(screen.getByLabelText('Filter by order id'), { target: { value: '2' } })
    expect(screen.getByText('#2')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Filter by order id'), { target: { value: '999' } })
    expect(screen.queryByText('#2')).toBeNull()

    fireEvent.change(screen.getByLabelText('Filter by order id'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('Filter by token'), { target: { value: USDC } })
    expect(screen.getByText('#2')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Filter by token'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('Filter by maker address'), { target: { value: OTHER } })
    expect(screen.queryByText('#2')).toBeNull()
  })
})
