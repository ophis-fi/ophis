import { render, screen } from '@testing-library/react'
import { shouldMountOtcOrderAction } from 'ophis/otcWrite'

import { OtcOrderDetailView } from './OtcOrderDetailView.pure'

import type { OtcIndexedOrder, OtcOrder } from 'ophis/otc'

const MAKER = '0x9a50A078d80F36E38EDfAE85AfFa2B8aB458e2C9'
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const CONTRACT = '0x000000fF3D7A2d373615141d7489Ca66683DbecF'
const NOW_MS = 1_755_010_800_000

function order(overrides: Partial<OtcOrder> = {}): OtcOrder {
  return {
    orderId: 130n,
    maker: MAKER,
    active: true,
    tokenA: WETH,
    amountA: 1_000_000_000_000_000_000n,
    tokenB: USDC,
    amountB: 4_000_000_000n,
    ...overrides,
  }
}

function indexed(overrides: Partial<OtcIndexedOrder> = {}): OtcIndexedOrder {
  return {
    ...order(),
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

function renderDetail(props: Partial<Parameters<typeof OtcOrderDetailView>[0]> = {}): ReturnType<typeof render> {
  return render(
    <OtcOrderDetailView
      orderId={130n}
      loading={false}
      failed={false}
      freshness="fresh"
      order={order()}
      blockNumber={25_787_579n}
      indexed={indexed()}
      nowMs={NOW_MS}
      {...props}
    />,
  )
}

describe('OtcOrderDetailView', () => {
  it('renders exact on-chain terms with full addresses and explorer links', () => {
    const { container } = renderDetail()

    expect(screen.getByText(/Order #130/)).toBeTruthy()
    expect(screen.getAllByText(MAKER).length).toBeGreaterThan(0)
    expect(screen.getAllByText(WETH).length).toBeGreaterThan(0)
    expect(screen.getAllByText(USDC).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/1 WETH/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/4000 USDC/).length).toBeGreaterThan(0)
    expect(screen.getByText(/Verified on-chain at block 25,?787,?579/)).toBeTruthy()
    expect(screen.getByText(CONTRACT)).toBeTruthy()

    const explorerLinks = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href') ?? '')
    expect(explorerLinks.some((href) => href === `https://etherscan.io/address/${CONTRACT}`)).toBe(true)
    expect(explorerLinks.some((href) => href === `https://etherscan.io/address/${MAKER}`)).toBe(true)
  })

  it('warns on the detail view when the RPC node is behind the network', () => {
    renderDetail({ freshness: 'stale' })
    expect(screen.getByText('Network data may be outdated')).toBeTruthy()
  })

  it('warns when the freshness assessment itself is unavailable', () => {
    renderDetail({ freshness: 'unknown' })
    expect(screen.getByText('Freshness could not be assessed')).toBeTruthy()
    // terms still render, with the caveat, because the direct read passed
    expect(screen.getByText(/Order #130/)).toBeTruthy()
  })

  it('shows the escrow badge only while the order is active', () => {
    renderDetail()
    expect(screen.getByText('Escrowed')).toBeTruthy()
  })

  it('hides the escrow badge for resolved orders', () => {
    renderDetail({ order: order({ active: false }), indexed: null })
    expect(screen.queryByText('Escrowed')).toBeNull()
  })

  it('flags USDC escrow lock risks', () => {
    renderDetail()
    expect(screen.getByText(/upgradeable/)).toBeTruthy()
    expect(screen.getByText(/blacklistable/)).toBeTruthy()
  })

  it('requires a refresh when indexed data disagrees with the chain', () => {
    renderDetail({ indexed: indexed({ amountB: 999n }) })
    expect(screen.getByText(/Order data changed — refresh required/)).toBeTruthy()
  })

  it('shows a loading state', () => {
    renderDetail({ loading: true, order: null, blockNumber: null })
    expect(screen.getByText(/Verifying order #130 on Ethereum/)).toBeTruthy()
  })

  it('fails closed when verification fails', () => {
    const { container } = renderDetail({ failed: true, order: null, blockNumber: null })
    expect(screen.getByText(/on-chain verification failed/i)).toBeTruthy()
    expect(container.querySelectorAll('table')).toHaveLength(0)
  })

  it('reports a non-existent order', () => {
    renderDetail({ order: null })
    expect(screen.getByText(/No order exists with id 130/)).toBeTruthy()
  })

  it('exposes no enabled transaction affordance', () => {
    const { container } = renderDetail()
    const actionable = Array.from(container.querySelectorAll('button')).filter(
      (button) => /fill|cancel|approve|sign|submit|create/i.test(button.textContent ?? '') && !button.disabled,
    )
    expect(actionable).toEqual([])
  })

  it('renders a guarded local action only when supplied by the controller', () => {
    renderDetail({ writeEnabled: true, actionPanel: <button type="button">Guarded local fill</button> })
    expect(screen.getByRole('button', { name: 'Guarded local fill' })).toBeTruthy()
    expect(screen.getByText(/Fork-only action detail/)).toBeTruthy()
  })

  it('suppresses a read-only supplied action when indexed terms disagree', () => {
    renderDetail({
      writeEnabled: false,
      indexed: indexed({ amountB: 999n }),
      actionPanel: <button type="button">Guarded local fill</button>,
    })
    expect(screen.queryByRole('button', { name: 'Guarded local fill' })).toBeNull()
  })

  it('keeps only nonmaker allowance recovery mountable after the order becomes inactive', () => {
    const inactive = order({ active: false })
    expect(shouldMountOtcOrderAction(true, inactive, '0x1111111111111111111111111111111111111111')).toBe(true)
    expect(shouldMountOtcOrderAction(true, inactive, MAKER)).toBe(false)
    expect(shouldMountOtcOrderAction(true, inactive, undefined)).toBe(true)
  })

  it('does not use the canonical index checkpoint to gate active fork actions', () => {
    expect(shouldMountOtcOrderAction(true, order(), undefined)).toBe(true)
  })

  it('does not let index lag hide a supplied zero-only recovery action for an inactive order', () => {
    renderDetail({
      writeEnabled: true,
      order: order({ active: false }),
      indexed: indexed({ active: true }),
      actionPanel: <button type="button">Revoke unused allowance</button>,
    })
    expect(screen.getByRole('button', { name: 'Revoke unused allowance' })).toBeTruthy()
  })

  it('does not let canonical index disagreement hide a fork-verified active action', () => {
    renderDetail({
      writeEnabled: true,
      indexed: indexed({ amountB: 999n }),
      actionPanel: <button type="button">Guarded local fill</button>,
    })
    expect(screen.getByRole('button', { name: 'Guarded local fill' })).toBeTruthy()
  })
})
