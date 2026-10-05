import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import fixture from './fixtures/monadDeposit.json'
import { NearTransfer, nearTransferSchema } from './nearDirect.schemas'
import { NearWalletSend } from './NearWalletSend.container'
import { StarknetDepositNotSentError, StarknetWalletChangedError } from './starknetWallet.service'

let mockTransfer: NearTransfer
let mockFailure: Error
const mockSubmit = jest.fn()
const mockSave = jest.fn(async (update: (items: NearTransfer[]) => NearTransfer[]) => {
  mockTransfer = update([mockTransfer])[0] as NearTransfer
})
jest.mock('jotai', () => ({ useSetAtom: () => mockSave }))
jest.mock('@cowprotocol/wallet', () => ({ useWalletInfo: () => ({}) }))
jest.mock('modules/cctp', () => ({ useBridgeWallet: () => null }))
jest.mock('./hooks/useStarknetWallet', () => ({ useStarknetWallet: () => ({ connection: { wallet: {} } }) }))
jest.mock('./nearDirect.atoms', () => ({ nearTransfersAtom: 'transfers', readStoredNearTransfer: () => mockTransfer }))
jest.mock('./nearDirect.service', () => ({ submitNearDeposit: (...args: unknown[]) => mockSubmit(...args) }))
jest.mock('./nearDirectWallet.service', () => ({ fundNearTransfer: jest.fn() }))
jest.mock('./StarknetWalletConnect.container', () => ({ StarknetWalletConnect: () => null }))
jest.mock('./starknetWallet.service', () => ({
  ...jest.requireActual('./starknetWallet.service'),
  fundNearStarknetTransfer: async (_wallet: unknown, _transfer: unknown, beforeSend: () => Promise<void>) => {
    await beforeSend()
    throw mockFailure
  },
}))

beforeEach(() => {
  jest.clearAllMocks()
  mockTransfer = { ...nearTransferSchema.parse(fixture), source: { ...fixture.source, blockchain: 'starknet' } }
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: async (_name: string, _options: unknown, run: (lock: object) => Promise<void>) => run({}),
    },
  })
})

it.each(['changed', 'uncertain', 'not sent'])(
  'preserves the correct funding journal after %s wallet failure',
  async (kind) => {
    const hash = '0x' + 'ab'.repeat(32)
    mockFailure =
      kind === 'changed'
        ? new StarknetWalletChangedError(hash)
        : kind === 'not sent'
          ? new StarknetDepositNotSentError('Not sent')
          : new Error('Transport failed')
    render(<NearWalletSend transfer={mockTransfer} />)
    fireEvent.click(screen.getByRole('button', { name: 'Send with Starknet wallet' }))
    await waitFor(() => expect(mockTransfer.fundingError).toBe(mockFailure.message))
    expect(mockTransfer.fundingStarted).toBe(kind !== 'not sent')
    expect(mockTransfer.transactionHash).toBe(kind === 'changed' ? hash : undefined)
    expect(mockSubmit).not.toHaveBeenCalled()
  },
)
