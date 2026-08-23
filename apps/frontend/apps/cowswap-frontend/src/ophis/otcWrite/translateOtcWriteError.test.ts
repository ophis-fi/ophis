import { translateOtcWriteError } from './translateOtcWriteError'

describe('translateOtcWriteError', () => {
  it.each([
    [{ code: 4001 }, 'Transaction rejected in your wallet. No funds moved.'],
    [new Error('insufficient funds for gas'), 'This wallet does not have enough ETH to pay Ethereum gas.'],
    [
      new Error('wrong chain'),
      'Connect the wallet to the configured local Anvil or Hardhat mainnet fork and try again.',
    ],
    [new Error('DeadlineExpired'), 'The fill deadline expired. Refresh the order and try again.'],
    [
      new Error('OrderNotActive'),
      'This order was filled, cancelled, or changed before submission. Refresh before trying again.',
    ],
    [new Error('Ophis OTC source mismatch'), 'Escrow contract verification failed. Transactions remain disabled.'],
  ])('maps %# without exposing raw provider data', (error, expected) => {
    expect(translateOtcWriteError(error)).toBe(expected)
  })

  it('uses a safe fallback instead of leaking unknown RPC text', () => {
    expect(translateOtcWriteError(new Error('internal rpc host detail'))).toBe(
      'The transaction could not be completed. No unconfirmed action will be retried automatically.',
    )
  })

  it('remains total for cyclic causes and hostile provider properties', () => {
    const cyclic: { message: string; cause?: unknown } = { message: 'OrderNotActive' }
    cyclic.cause = cyclic
    expect(translateOtcWriteError(cyclic)).toMatch(/filled, cancelled, or changed/)

    const hostile = Object.defineProperty({}, 'message', {
      get: () => {
        throw new Error('provider getter failed')
      },
    })
    expect(translateOtcWriteError(hostile)).toBe(
      'The transaction could not be completed. No unconfirmed action will be retried automatically.',
    )
  })
})
