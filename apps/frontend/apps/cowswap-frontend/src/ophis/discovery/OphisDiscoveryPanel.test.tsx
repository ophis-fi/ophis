import { render, screen } from '@testing-library/react'

import { OphisDiscoveryPanelView } from './OphisDiscoveryPanel'

import type { OphisDiscoverySnapshot } from './ophisDiscovery.types'
import type { Address, Hex } from 'viem'

const snapshot: OphisDiscoverySnapshot = {
  chainId: 1,
  chainLabel: 'Ethereum',
  blockNumber: 25_700_123n,
  blockHash: `0x${'ab'.repeat(32)}` as Hex,
  tokens: [
    {
      id: '1',
      address: '0x1111111111111111111111111111111111111111' as Address,
      chainId: 1,
      decimals: 18,
      name: 'Token Alpha',
      symbol: 'ALPHA',
      rank: 1_000,
    },
  ],
}

describe('OphisDiscoveryPanelView', () => {
  it('renders provenance and disclaimer without any interactive route affordance', () => {
    const { container } = render(<OphisDiscoveryPanelView snapshot={snapshot} />)

    expect(screen.getByRole('heading', { name: 'Ophis Discovery' })).toBeTruthy()
    expect(screen.getByText(/Ethereum, pinned to block 25,700,123/)).toBeTruthy()
    expect(screen.getByText('ALPHA')).toBeTruthy()
    expect(screen.getByText(/not an Ophis endorsement/)).toBeTruthy()
    expect(container.querySelector('button')).toBeNull()
    expect(container.querySelector('a')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
  })
})
