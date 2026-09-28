import { SORTED_CHAIN_IDS } from '@cowprotocol/common-const'
import { useWalletInfo } from '@cowprotocol/wallet'

import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'

import { useNavigate } from 'common/hooks/useNavigate'

import { IntentLanding } from './IntentLanding'
import { IntentRestoreUpdater } from './IntentRestoreUpdater'
import { readIntentStash, writeIntentStash } from './intentStash'
import { useIntentParse } from './useIntentParse'

import type { ParsedIntent } from './types'

jest.mock('@cowprotocol/common-const', () => ({ SORTED_CHAIN_IDS: [10] }))
jest.mock('@cowprotocol/common-hooks', () => ({ usePrevious: () => undefined }))
jest.mock('@cowprotocol/wallet', () => ({ useWalletInfo: jest.fn() }))
jest.mock('@cowprotocol/tokens', () => ({
  useTokenForChainMapBySymbol: () => ({}),
  symbolToAddressResolver: () => () => null,
}))
jest.mock('common/hooks/useNavigate', () => ({ useNavigate: jest.fn() }))
jest.mock('common/hooks/useWarmTargetChainLists', () => ({ useWarmTargetChainLists: jest.fn() }))
jest.mock('./useIntentParse', () => ({ useIntentParse: jest.fn() }))
jest.mock('./IntentCarousel', () => ({ IntentCarousel: () => null }))
jest.mock('../CosmicStarfield', () => ({ CosmicStarfield: () => null }))
jest.mock('../OphisFooter', () => ({ OphisFooter: () => null }))
jest.mock('../OphisHeader', () => ({ OphisHeader: () => null }))

const navigate = jest.fn()
const tokens: ParsedIntent['entities'] = [
  { type: 'sellToken', value: 'USDC', raw: 'USDC', start: 5, end: 9 },
  { type: 'buyToken', value: 'EURC', raw: 'EURC', start: 14, end: 18 },
]

function parseChain(chain?: string): void {
  jest.mocked(useIntentParse).mockReturnValue({
    status: 'ok',
    parsed: {
      intent: 'swap',
      entities: [
        ...tokens,
        ...(chain ? [{ type: 'chain' as const, value: chain, raw: chain, start: 21, end: 24 }] : []),
      ],
    },
    errorCode: null,
    errorMessage: null,
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  sessionStorage.clear()
  SORTED_CHAIN_IDS.splice(0, SORTED_CHAIN_IDS.length, 10)
  jest.mocked(useNavigate).mockReturnValue(navigate)
  jest.mocked(useWalletInfo).mockReturnValue({ chainId: 10 } as ReturnType<typeof useWalletInfo>)
})

afterEach(() => jest.useRealTimers())

it.each(['arc', 'unknown-chain'])(
  'blocks unavailable explicit %s on Continue and Enter without stashing a fallback',
  (chain) => {
    parseChain(chain)
    render(
      <MemoryRouter>
        <IntentLanding />
      </MemoryRouter>,
    )
    expect(screen.getByRole('alert').textContent).toContain('This network is not available')
    const button = screen.getByRole('button', { name: 'Continue →' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(navigate).not.toHaveBeenCalled()
    expect(readIntentStash()).toBeNull()
  },
)

it.each([true, false])('preserves enabled Arc and no-chain fallback (explicit Arc: %s)', (explicitArc) => {
  if (explicitArc) SORTED_CHAIN_IDS.push(5042)
  parseChain(explicitArc ? 'arc' : undefined)
  render(
    <MemoryRouter>
      <IntentLanding />
    </MemoryRouter>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Continue →' }))
  expect(navigate).toHaveBeenCalledWith(`/${explicitArc ? 5042 : 10}/swap/USDC/EURC`)
  expect(readIntentStash()?.chainId).toBe(explicitArc ? 5042 : undefined)
})

it.each([
  { chainId: undefined, arcEnabled: false, expectedChain: 10 },
  { chainId: 5042, arcEnabled: false, expectedChain: undefined },
  { chainId: 5042, arcEnabled: true, expectedChain: 5042 },
  { chainId: 99999, arcEnabled: false, expectedChain: undefined },
])(
  'restores chain $chainId only when available (Arc enabled: $arcEnabled)',
  ({ chainId, arcEnabled, expectedChain }) => {
    jest.useFakeTimers()
    if (arcEnabled) SORTED_CHAIN_IDS.push(5042)
    jest.mocked(useWalletInfo).mockReturnValue({
      account: '0x0000000000000000000000000000000000000123',
      chainId: 10,
    } as ReturnType<typeof useWalletInfo>)
    writeIntentStash({ chainId, sellToken: 'USDC', buyToken: 'EURC', field: 'sell' })
    render(
      <MemoryRouter>
        <IntentRestoreUpdater />
      </MemoryRouter>,
    )
    act(() => {
      jest.runOnlyPendingTimers()
    })
    if (expectedChain !== undefined)
      expect(navigate).toHaveBeenCalledWith(`/${expectedChain}/swap/USDC/EURC`, { replace: true })
    else expect(navigate).not.toHaveBeenCalled()
    expect(readIntentStash()).toBeNull()
  },
)
