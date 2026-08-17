import {
  ETHEREUM_ENS_REGISTRY,
  ETHEREUM_ENS_REGISTRY_CODE_HASH,
  ETHEREUM_WEI_REGISTRY,
  ETHEREUM_WEI_REGISTRY_CODE_HASH,
  NameRegistryIntegrityError,
  type NameContractRead,
  type OphisNameReader,
  parseOphisName,
  resolveOphisNameOrAddress,
  verifyOphisNameResolution,
} from './ophisNameResolution'

import type { Address } from 'viem'

const RECIPIENT = '0x1111111111111111111111111111111111111111'
const RESOLVER = '0x2222222222222222222222222222222222222222'

function createReader(
  overrides: {
    readonly codeHashes?: Readonly<Record<string, string | null>>
    readonly readContract?: (request: NameContractRead) => Promise<unknown>
  } = {},
): OphisNameReader {
  const codeHashes: Readonly<Record<string, string | null>> = {
    [ETHEREUM_ENS_REGISTRY]: ETHEREUM_ENS_REGISTRY_CODE_HASH,
    [ETHEREUM_WEI_REGISTRY]: ETHEREUM_WEI_REGISTRY_CODE_HASH,
    [RESOLVER]: '0xresolver',
    ...overrides.codeHashes,
  }

  return {
    getCodeHash: async (address: Address) => codeHashes[address] ?? null,
    readContract:
      overrides.readContract ??
      (async ({ functionName }) => {
        if (functionName === 'resolver') return RESOLVER
        if (functionName === 'addr' || functionName === 'resolve') return RECIPIENT
        if (functionName === 'computeId') return 1n
        return null
      }),
  }
}

describe('Ophis Ethereum name resolution', () => {
  it('accepts only explicit, ENSIP-15-normalized ENS and .wei names', () => {
    expect(parseOphisName('alice.eth')).toEqual({ normalized: 'alice.eth', system: 'ens' })
    expect(parseOphisName('alice.wei')).toEqual({ normalized: 'alice.wei', system: 'wei' })
    expect(parseOphisName('alice')).toBeNull()
    expect(parseOphisName('alice.gwei')).toBeNull()
    expect(parseOphisName('sub.alice.wei')).toBeNull()
    expect(parseOphisName(' alice.eth')).toBeNull()
    expect(parseOphisName('a..eth')).toBeNull()
  })

  it('returns a checksummed direct address without a registry read', async () => {
    const reader = createReader({ readContract: async () => Promise.reject(new Error('must not read')) })

    await expect(resolveOphisNameOrAddress(reader, RECIPIENT)).resolves.toEqual({
      input: RECIPIENT,
      name: null,
      address: RECIPIENT,
      system: null,
    })
  })

  it('resolves ENS and .wei through their pinned Ethereum registries', async () => {
    const reader = createReader()

    await expect(resolveOphisNameOrAddress(reader, 'alice.eth')).resolves.toMatchObject({
      address: RECIPIENT,
      system: 'ens',
    })
    await expect(resolveOphisNameOrAddress(reader, 'alice.wei')).resolves.toMatchObject({
      address: RECIPIENT,
      system: 'wei',
    })
  })

  it('fails closed when registry bytecode does not match', async () => {
    const reader = createReader({ codeHashes: { [ETHEREUM_WEI_REGISTRY]: '0xchanged' } })

    await expect(resolveOphisNameOrAddress(reader, 'alice.wei')).rejects.toBeInstanceOf(NameRegistryIntegrityError)
  })

  it('requires the same forward resolution immediately before signing', async () => {
    const reader = createReader()

    await expect(verifyOphisNameResolution(reader, 'alice.eth', RECIPIENT)).resolves.toBeUndefined()
    await expect(
      verifyOphisNameResolution(reader, 'alice.eth', '0x3333333333333333333333333333333333333333'),
    ).rejects.toThrow('changed before signing')
  })
})
