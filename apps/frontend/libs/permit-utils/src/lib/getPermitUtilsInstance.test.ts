import type { JsonRpcProvider } from '@ethersproject/providers'

import { getPermitUtilsInstance } from './getPermitUtilsInstance'

import { PERMIT_SIGNER } from '../const'
import { PermitProviderConnector } from '../utils/PermitProviderConnector'

jest.mock('../const', () => ({ PERMIT_SIGNER: { address: 'static-quote-signer' } }))
jest.mock('../utils/PermitProviderConnector', () => ({ PermitProviderConnector: jest.fn() }))
jest.mock('../imports/1inchPermitUtils', () => ({ Eip2612PermitUtils: jest.fn() }))

beforeEach(() => jest.clearAllMocks())

it.each(['0x1111111111111111111111111111111111111111', undefined])(
  'binds cached permit utilities to the current provider for account %s',
  async (account) => {
    const oldProvider = {} as JsonRpcProvider
    const newProvider = {} as JsonRpcProvider

    const oldUtils = await getPermitUtilsInstance(5042, oldProvider, account)
    const newUtils = await getPermitUtilsInstance(5042, newProvider, account)

    expect(newUtils).not.toBe(oldUtils)
    await expect(getPermitUtilsInstance(5042, newProvider, account)).resolves.toBe(newUtils)
    expect(PermitProviderConnector).toHaveBeenCalledTimes(2)
    expect(PermitProviderConnector).toHaveBeenNthCalledWith(1, oldProvider, account ? undefined : PERMIT_SIGNER)
    expect(PermitProviderConnector).toHaveBeenNthCalledWith(2, newProvider, account ? undefined : PERMIT_SIGNER)
  },
)

it('keeps chain, account and static signer roles isolated on one provider', async () => {
  const provider = {} as JsonRpcProvider
  const params = [
    [5042, undefined],
    [5042, '0x1111111111111111111111111111111111111111'],
    [5042, '0x2222222222222222222222222222222222222222'],
    [10, '0x1111111111111111111111111111111111111111'],
  ] as const
  const utils = await Promise.all(params.map(([chain, account]) => getPermitUtilsInstance(chain, provider, account)))

  expect(new Set(utils).size).toBe(params.length)
  for (const [index, [chain, account]] of params.entries()) {
    await expect(getPermitUtilsInstance(chain, provider, account)).resolves.toBe(utils[index])
  }
  expect(PermitProviderConnector).toHaveBeenCalledTimes(params.length)
})
