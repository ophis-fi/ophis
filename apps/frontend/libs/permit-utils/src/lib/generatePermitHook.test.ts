import { BigNumber } from '@ethersproject/bignumber'

import { generatePermitHook } from './generatePermitHook'

import { DEFAULT_PERMIT_VALUE } from '../const'
import { PermitHookParams } from '../types'
import { buildDaiLikePermitCallData, buildEip2612PermitCallData } from '../utils/buildPermitCallData'

jest.mock('@cowprotocol/hook-dapp-lib', () => ({ PERMIT_HOOK_DAPP_ID: 'permit' }))
jest.mock('../const', () => ({
  DEFAULT_PERMIT_GAS_LIMIT: '80000',
  DEFAULT_PERMIT_VALUE: (1n << 256n) - 1n,
  PERMIT_SIGNER: { address: '0x1111111111111111111111111111111111111111' },
}))
jest.mock('../utils/getPermitDeadline', () => ({ getPermitDeadline: () => 2000000000 }))
jest.mock('../utils/buildPermitCallData', () => ({
  buildEip2612PermitCallData: jest.fn().mockResolvedValue('0x00'),
  buildDaiLikePermitCallData: jest.fn().mockResolvedValue('0x00'),
}))

const params = {
  inputToken: { address: '0x2222222222222222222222222222222222222222', name: 'USDC' },
  spender: '0x3333333333333333333333333333333333333333',
  chainId: 1,
  account: '0x1111111111111111111111111111111111111111',
  permitInfo: { type: 'eip-2612' },
  nonce: 0,
  eip2612Utils: {},
  provider: { estimateGas: jest.fn().mockResolvedValue(BigNumber.from(80000)) },
} as unknown as PermitHookParams

beforeEach(() => jest.clearAllMocks())

it.each([0n, 10000000n, undefined])(
  'preserves explicit permit value %s and defaults only when omitted',
  async (amount) => {
    await generatePermitHook({ ...params, amount })

    expect(jest.mocked(buildEip2612PermitCallData).mock.lastCall?.[0].callDataParams[0].value).toBe(
      (amount ?? DEFAULT_PERMIT_VALUE).toString(),
    )
  },
)

it('does not share concurrent permits across different spending limits, spenders, or nonces', async () => {
  const build = jest.mocked(buildEip2612PermitCallData)
  build.mockClear()
  const requests = [
    { ...params, amount: undefined },
    { ...params, amount: 0n },
    { ...params, amount: 0n, spender: '0x4444444444444444444444444444444444444444' },
    { ...params, amount: 0n, nonce: 1 },
  ]

  await Promise.all(requests.map(generatePermitHook))

  expect(build).toHaveBeenCalledTimes(4)
  expect(
    build.mock.calls.map(
      ([
        {
          callDataParams: [permit],
        },
      ]) => [permit.value, permit.spender, permit.nonce],
    ),
  ).toEqual(requests.map(({ amount, spender, nonce }) => [(amount ?? DEFAULT_PERMIT_VALUE).toString(), spender, nonce]))
})

it.each([0n, 10000000n])(
  'rejects DAI-like amount %s before signing for real and account-agnostic users',
  async (amount) => {
    for (const account of [params.account, undefined]) {
      const result = await generatePermitHook({ ...params, account, amount, permitInfo: { type: 'dai-like' } })
      expect(result).toBeUndefined()
    }
    expect(buildDaiLikePermitCallData).not.toHaveBeenCalled()
    expect(buildEip2612PermitCallData).not.toHaveBeenCalled()
    expect(params.provider.estimateGas).not.toHaveBeenCalled()
  },
)

it.each([undefined, DEFAULT_PERMIT_VALUE])('allows DAI-like unlimited amount %s', async (amount) => {
  expect(await generatePermitHook({ ...params, amount, permitInfo: { type: 'dai-like' } })).toBeDefined()
  expect(jest.mocked(buildDaiLikePermitCallData).mock.lastCall?.[0].callDataParams[0]).toMatchObject({
    allowed: true,
    value: DEFAULT_PERMIT_VALUE.toString(),
  })
})
