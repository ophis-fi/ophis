import { ComponentProps, ReactNode, useState } from 'react'

import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import fixture from './fixtures/monadDeposit.json'
import { NearTransfer, nearTransferSchema } from './nearDirect.schemas'
import { requestNearQuote } from './nearDirect.service'
import { NearSwapDetails } from './NearSwapDetails.container'

jest.mock('jotai', () => ({ useSetAtom: () => jest.fn() }))
jest.mock('./nearDirect.atoms', () => ({ nearTransfersAtom: 'transfers' }))
jest.mock('./nearDirect.service', () => ({
  requestNearQuote: jest.fn(),
  nearErrorMessage: (error: Error) => error.message,
}))
jest.mock('./nearDirect.styled', () => ({ Stack: ({ children }: { children: ReactNode }) => <>{children}</> }))
jest.mock('./NearQuote.pure', () => ({ NearQuote: () => <p>Quoted amounts</p> }))
jest.mock('./StarknetWalletConnect.container', () => ({ StarknetWalletConnect: () => null }))
jest.mock('common/pure/AddressInputPanel', () => ({ AddressInputPanel: () => null }))
jest.mock('./hooks/useNearSwapAddresses', () => ({
  useNearSwapAddresses: (_source: unknown, _destination: unknown, refundTo: string, recipient: string) => ({
    refundTo,
    recipient,
  }),
}))
jest.mock('@cowprotocol/ui', () => ({
  ButtonPrimary: (props: ComponentProps<'button'>) => <button {...props} />,
  ButtonSecondary: (props: ComponentProps<'button'>) => <button {...props} />,
}))

const transfer = nearTransferSchema.parse(fixture)
const defaults = {
  source: transfer.source,
  destination: transfer.destination,
  amount: '90',
  recipient: transfer.response.quoteRequest.recipient,
  refundTo: transfer.response.quoteRequest.refundTo,
}

function Form({ source, destination, amount, recipient, refundTo }: typeof defaults): ReactNode {
  const [preview, setPreview] = useState<NearTransfer>()
  const [busy, setBusy] = useState(false)
  return (
    <NearSwapDetails
      {...{ source, destination, amount, recipient, refundTo, preview, setPreview, busy, setBusy }}
      setRefundTo={jest.fn()}
      isPending={false}
      tokenError={false}
      refetch={jest.fn()}
    />
  )
}

beforeEach(() => jest.mocked(requestNearQuote).mockReset())

it('retries with the same inputs and replaces the error with the successful quote', async () => {
  jest.mocked(requestNearQuote).mockRejectedValueOnce(new Error('Quote unavailable')).mockResolvedValueOnce(transfer)
  render(<Form {...defaults} />)
  fireEvent.click(screen.getByRole('button', { name: 'Review swap' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Retry quote' }))
  await screen.findByRole('button', { name: 'Confirm swap' })
  expect(requestNearQuote).toHaveBeenNthCalledWith(
    1,
    defaults.source,
    defaults.destination,
    defaults.amount,
    defaults.recipient,
    defaults.refundTo,
  )
  expect(jest.mocked(requestNearQuote).mock.calls[1]).toEqual(jest.mocked(requestNearQuote).mock.calls[0])
  expect(screen.queryByRole('alert')).toBeNull()
})

it.each([
  { amount: '100' },
  { source: defaults.destination },
  { destination: defaults.source },
  { recipient: 'changed recipient' },
  { refundTo: 'changed refund address' },
])('clears the previous quote error when inputs change: %j', async (change) => {
  jest.mocked(requestNearQuote).mockRejectedValueOnce(new Error('Quote unavailable'))
  const view = render(<Form {...defaults} />)
  fireEvent.click(screen.getByRole('button', { name: 'Review swap' }))
  await screen.findByRole('button', { name: 'Retry quote' })
  view.rerender(<Form {...defaults} {...change} />)
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  expect(screen.getByRole('button', { name: 'Review swap' })).toBeTruthy()
})
