import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'

import { OtcPageView } from './Otc.page'

import type { OtcDataState, OtcIndexedOrder, OtcOrder, OtcSnapshot } from 'ophis/otc'

function renderView(ui: Parameters<typeof render>[0]): ReturnType<typeof render> {
  return render(ui, { wrapper: MemoryRouter })
}

const MAKER = '0x9a50A078d80F36E38EDfAE85AfFa2B8aB458e2C9'
const OTHER = '0x2eDecb91091324e0138EBBBaEd48ce1B2A050428'
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const ZAMM = '0xE9b1cFEA55BAA219e34301f2F31b9FD0921664ED'
const NOW_MS = 1_755_010_800_000 // three hours after the fixture createdAt

function order(orderId: bigint, overrides: Partial<OtcOrder> = {}): OtcOrder {
  return {
    orderId,
    maker: MAKER,
    active: true,
    tokenA: WETH,
    amountA: 1_000_000_000_000_000_000n,
    tokenB: USDC,
    amountB: 4_000_000_000n,
    ...overrides,
  }
}

function indexedRow(orderId: bigint, overrides: Partial<OtcIndexedOrder> = {}): OtcIndexedOrder {
  return {
    ...order(orderId),
    createdAt: 1_755_000_000,
    createdTx: '0xc074a1fe0000000000000000000000000000000000000000000000000000000000004cad',
    taker: null,
    filledAt: null,
    filledTx: null,
    cancelledAt: null,
    cancelledTx: null,
    ...overrides,
  }
}

function emptyState(status: OtcDataState['status']): OtcDataState {
  return { status, degradedReason: null, snapshot: null, enrichment: null, reconciliation: null, indexLagBlocks: null }
}

function readyState(overrides: Partial<OtcDataState> = {}): OtcDataState {
  const orders = [
    order(3n, { tokenA: ZAMM, amountA: 100_000_000_000_000_000_000n, tokenB: WETH, amountB: 10n ** 18n }),
    order(2n),
    order(1n, { maker: OTHER, active: false }),
    order(0n, { active: false }),
  ]
  const snapshot: OtcSnapshot = {
    chainId: 1,
    blockNumber: 1_000n,
    blockHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
    nextOrderId: 4n,
    orders,
    truncated: false,
  }
  const indexed = [
    indexedRow(3n, { tokenA: ZAMM, amountA: 100_000_000_000_000_000_000n, tokenB: WETH, amountB: 10n ** 18n }),
    indexedRow(2n),
    indexedRow(1n, { maker: OTHER, active: false, filledAt: 1_755_100_000, taker: OTHER }),
    indexedRow(0n, { active: false, cancelledAt: 1_755_200_000 }),
  ]
  return {
    status: 'ready',
    degradedReason: null,
    snapshot,
    enrichment: { byOrderId: new Map(indexed.map((row) => [row.orderId.toString(), row])), indexedBlock: 999n },
    reconciliation: {
      verifiedIds: [0n, 1n, 2n, 3n],
      mismatches: [],
      missingOnchain: [],
      notIndexed: [],
      unknownIds: [],
      activeLagIds: [],
    },
    indexLagBlocks: 1n,
    ...overrides,
  }
}

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

  it('renders active orders with verification, review, and rate information', () => {
    renderView(<OtcPageView state={readyState()} account={undefined} nowMs={NOW_MS} />)

    // browse shows the two active orders only
    expect(screen.getByText('#3')).toBeTruthy()
    expect(screen.getByText('#2')).toBeTruthy()
    expect(screen.queryByText('#1')).toBeNull()
    expect(screen.queryByText('#0')).toBeNull()

    // reviewed row: curated symbols + rate; verified badge present
    expect(screen.getAllByText(/1 WETH/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/4000 USDC/).length).toBeGreaterThan(0)
    expect(screen.getAllByText('Escrowed').length).toBeGreaterThan(0)

    // unreviewed row: truncated address, no invented symbol, raw units label
    expect(screen.getByText(/0xE9b1\.\.\.64ED/)).toBeTruthy()
    expect(screen.getByText('Unreviewed token')).toBeTruthy()
    expect(screen.getAllByText(/raw units/).length).toBeGreaterThan(0)

    // ethereum-only surface, age rendering
    expect(screen.getAllByText('Ethereum').length).toBeGreaterThan(0)
    expect(screen.getAllByText('3h ago').length).toBeGreaterThan(0)

    // each row links to its detail route and offers copy + explorer actions
    const detailLink = screen.getByRole('link', { name: 'Order 3 details' })
    expect(detailLink.getAttribute('href')).toBe('/otc/3')
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
    expect(screen.getByText('Cancelled')).toBeTruthy()
    // resolved rows are no longer escrowed: badge only on the two active rows
    expect(screen.getAllByText('Escrowed')).toHaveLength(2)
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
    expect(screen.getByText('#3')).toBeTruthy()
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

  it('filters browse rows by token, maker, and order id', () => {
    renderView(<OtcPageView state={readyState()} account={undefined} nowMs={NOW_MS} />)

    fireEvent.change(screen.getByLabelText('Filter by order id'), { target: { value: '2' } })
    expect(screen.getByText('#2')).toBeTruthy()
    expect(screen.queryByText('#3')).toBeNull()

    fireEvent.change(screen.getByLabelText('Filter by order id'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('Filter by token'), { target: { value: USDC } })
    expect(screen.getByText('#2')).toBeTruthy()
    expect(screen.queryByText('#3')).toBeNull()

    fireEvent.change(screen.getByLabelText('Filter by token'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('Filter by maker address'), { target: { value: OTHER } })
    expect(screen.queryByText('#2')).toBeNull()
    expect(screen.queryByText('#3')).toBeNull()
  })
})
