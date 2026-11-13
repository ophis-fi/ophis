import React, { ReactNode } from 'react'

import { BridgeStatus, CrossChainOrder } from '@cowprotocol/sdk-bridging'

import { render, screen } from '@testing-library/react'

import { crossChainOrderMock } from '../../OrderDetails/crossChainOrder.mock'

import { BridgeDetailsContent } from '.'

jest.mock('modules/bridge', () => ({
  useCrossChainTokens: () => ({
    sourceToken: { chainId: 8453, address: '0x1111111111111111111111111111111111111111', decimals: 6, symbol: 'USDC' },
    destinationToken: {
      chainId: 10,
      address: '0x2222222222222222222222222222222222222222',
      decimals: 6,
      symbol: 'USDC',
    },
  }),
}))
jest.mock('components/common/DetailRow', () => ({
  DetailRow: ({ label, children }: { label: string; children: ReactNode }) => (
    <div>
      {label}
      {children}
    </div>
  ),
}))
jest.mock('components/common/AddressLink', () => ({ AddressLink: () => null }))
jest.mock('components/common/RowWithCopyButton', () => ({ RowWithCopyButton: () => null }))
jest.mock('../BridgeAmountDisplay', () => ({
  BridgeAmountDisplay: ({ labelPrefix }: { labelPrefix: string }) => <span>{labelPrefix}</span>,
}))
jest.mock('../BridgeReceiveAmount', () => ({ BridgeReceiveAmount: () => <span>destination minimum</span> }))
jest.mock('../../StatusLabel', () => ({ StatusLabel: () => null }))

function relayOrder(status: BridgeStatus): CrossChainOrder {
  const statusResult = { status, relayRecoveryRequired: false }
  return {
    ...crossChainOrderMock,
    statusResult,
    explorerUrl: 'https://relay.link/transaction/123',
  }
}

it('shows a generic Relay refund confirmation and provider link', () => {
  render(<BridgeDetailsContent crossChainOrder={relayOrder(BridgeStatus.REFUND)} />)
  expect(screen.getByText(/Relay refund completed/)).toBeTruthy()
  expect(screen.queryByText('destination minimum')).toBeNull()
  expect(screen.queryByText(/Refunded to/)).toBeNull()
  expect(screen.getByRole('link', { name: /View Relay transaction/ }).getAttribute('href')).toBe(
    'https://relay.link/transaction/123',
  )
})

it('labels Relay output as a minimum even after execution', () => {
  render(<BridgeDetailsContent crossChainOrder={relayOrder(BridgeStatus.EXECUTED)} />)
  expect(screen.getByText('Minimum received')).toBeTruthy()
  expect(screen.getByText('To (minimum):')).toBeTruthy()
  expect(screen.getByText('destination minimum')).toBeTruthy()
  expect(screen.queryByText('You received')).toBeNull()
})
