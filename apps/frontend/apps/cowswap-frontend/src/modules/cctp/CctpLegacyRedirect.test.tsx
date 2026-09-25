import { ReactNode } from 'react'

import { NATIVE_CURRENCY_ADDRESS } from '@cowprotocol/common-const'

import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'

import { cctpToken } from './cctpAssets.const'
import { CctpLegacyRedirect } from './CctpLegacyRedirect.container'

jest.mock('@cowprotocol/wallet', () => ({ useWalletInfo: () => ({ chainId: 1 }) }))
jest.mock('modules/trade', () => jest.requireActual('../trade/utils/parameterizeTradeRoute'))

function CurrentLocation(): ReactNode {
  const { pathname, search } = useLocation()
  return <output data-testid="location">{pathname + search}</output>
}

it.each([
  ['cirBTC', cctpToken(1, 'cirBTC'), cctpToken(5042, 'cirBTC')],
  ['0xdac17f958d2ee523a2206206994597c13d831ec7', '0xdac17f958d2ee523a2206206994597c13d831ec7', cctpToken(5042, 'USDC')],
  ['ETH', NATIVE_CURRENCY_ADDRESS, cctpToken(5042, 'USDC')],
])('preserves the destination bridge leg for legacy token %s', async (token, input, output) => {
  render(
    <MemoryRouter initialEntries={[`/bridge?source=1&token=${token}`]}>
      <Routes>
        <Route path="/bridge" element={<CctpLegacyRedirect />} />
        <Route path="*" element={<CurrentLocation />} />
      </Routes>
    </MemoryRouter>,
  )
  await waitFor(() =>
    expect(screen.getByTestId('location').textContent).toBe(`/1/swap/${input}/${output}?targetChainId=5042`),
  )
})
