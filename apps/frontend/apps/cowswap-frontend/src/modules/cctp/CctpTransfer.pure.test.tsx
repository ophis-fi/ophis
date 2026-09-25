import { fireEvent, render, screen } from '@testing-library/react'

import { type CctpTransfer } from './cctp.service'
import { CctpTransferDetails } from './CctpTransfer.pure'

it('shows the source nonce and accepts a cancellation hash when the wallet returned no burn hash', () => {
  const transfer: CctpTransfer = {
    source: 1,
    destination: 5042,
    owner: '0x0000000000000000000000000000000000000001',
    amount: '1000000',
    maxFee: '1000',
    quotedAt: 1,
    sourceNonce: 0,
  }
  const onResume = jest.fn()
  render(
    <CctpTransferDetails
      transfer={transfer}
      status={null}
      busy={false}
      canClaim={false}
      onClaim={jest.fn()}
      onResume={onResume}
      onResumeClaim={jest.fn()}
      onFinish={jest.fn()}
    />,
  )
  const instructions = screen.getByText(/Saved source nonce: 0/)
  expect(instructions.textContent).toContain('cancel this nonce on Ethereum')
  expect(instructions.textContent).toContain('confirmed cancellation hash')
  const hash = `0x${'ab'.repeat(32)}`
  fireEvent.change(screen.getByLabelText('Source transaction hash'), { target: { value: hash } })
  fireEvent.click(screen.getByRole('button', { name: 'Resume transfer' }))
  expect(onResume).toHaveBeenCalledWith(hash)
})
