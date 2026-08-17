import { getAddress, isAddress, isAddressEqual, type Address, zeroAddress } from 'viem'
import { namehash, normalize } from 'viem/ens'

export const ETHEREUM_ENS_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e'
export const ETHEREUM_ENS_REGISTRY_CODE_HASH = '0xd6bfd5d6f1384a1f6ea57b8a8412de5552f138d42021cf7c4941e33206f529e4'
export const ETHEREUM_WEI_REGISTRY = '0x0000000000696760E15f265e828DB644A0c242EB'
export const ETHEREUM_WEI_REGISTRY_CODE_HASH = '0x5b791c832d4373a8d4f977c37d6973a5dbe0924c6d287a2effaa549be31c0221'

export type OphisNameSystem = 'ens' | 'wei'

export interface OphisNameResolution {
  readonly input: string
  readonly name: string | null
  readonly address: Address
  readonly system: OphisNameSystem | null
}

export interface NameContractRead {
  readonly address: Address
  readonly abi: readonly unknown[]
  readonly functionName: string
  readonly args: readonly unknown[]
}

export interface OphisNameReader {
  readonly getCodeHash: (address: Address) => Promise<string | null>
  readonly readContract: (request: NameContractRead) => Promise<unknown>
}

interface ParsedName {
  readonly normalized: string
  readonly system: OphisNameSystem
}

const ENS_REGISTRY_ABI = [
  {
    type: 'function',
    name: 'resolver',
    stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }],
    outputs: [{ type: 'address' }],
  },
] as const

const ENS_RESOLVER_ABI = [
  {
    type: 'function',
    name: 'addr',
    stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }],
    outputs: [{ type: 'address' }],
  },
] as const

const WEI_REGISTRY_ABI = [
  {
    type: 'function',
    name: 'computeId',
    stateMutability: 'pure',
    inputs: [{ name: 'fullName', type: 'string' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'resolve',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ type: 'address' }],
  },
] as const

export class NameRegistryIntegrityError extends Error {
  constructor(readonly system: OphisNameSystem) {
    super(`Ophis ${system} registry integrity check failed`)
  }
}

export function parseOphisName(value: string): ParsedName | null {
  if (!value || value !== value.trim()) return null

  const lowerValue = value.toLowerCase()
  const system = lowerValue.endsWith('.wei') ? 'wei' : lowerValue.endsWith('.eth') ? 'ens' : null

  if (!system) return null

  try {
    const normalized = normalize(value)
    const labels = normalized.split('.')

    // The .wei parent owner can reclaim subdomains at any time. Ophis accepts
    // only independently owned second-level names for recipient resolution.
    if (!labels.every(Boolean) || (system === 'wei' && labels.length !== 2)) return null

    return { normalized, system }
  } catch {
    return null
  }
}

async function assertRegistryIntegrity(
  reader: OphisNameReader,
  system: OphisNameSystem,
  address: Address,
  expectedHash: string,
): Promise<void> {
  const codeHash = await reader.getCodeHash(address)

  if (codeHash?.toLowerCase() !== expectedHash) throw new NameRegistryIntegrityError(system)
}

function getResolvedAddress(value: unknown): Address | null {
  return typeof value === 'string' && isAddress(value) && !isAddressEqual(value, zeroAddress) ? getAddress(value) : null
}

async function resolveEns(reader: OphisNameReader, name: string): Promise<Address | null> {
  await assertRegistryIntegrity(reader, 'ens', ETHEREUM_ENS_REGISTRY, ETHEREUM_ENS_REGISTRY_CODE_HASH)
  const node = namehash(name)
  const resolver = getResolvedAddress(
    await reader.readContract({
      address: ETHEREUM_ENS_REGISTRY,
      abi: ENS_REGISTRY_ABI,
      functionName: 'resolver',
      args: [node],
    }),
  )

  if (!resolver || !(await reader.getCodeHash(resolver))) return null

  return getResolvedAddress(
    await reader.readContract({ address: resolver, abi: ENS_RESOLVER_ABI, functionName: 'addr', args: [node] }),
  )
}

async function resolveWei(reader: OphisNameReader, name: string): Promise<Address | null> {
  await assertRegistryIntegrity(reader, 'wei', ETHEREUM_WEI_REGISTRY, ETHEREUM_WEI_REGISTRY_CODE_HASH)
  const tokenId = await reader.readContract({
    address: ETHEREUM_WEI_REGISTRY,
    abi: WEI_REGISTRY_ABI,
    functionName: 'computeId',
    args: [name],
  })

  if (typeof tokenId !== 'bigint' || tokenId === 0n) return null

  return getResolvedAddress(
    await reader.readContract({
      address: ETHEREUM_WEI_REGISTRY,
      abi: WEI_REGISTRY_ABI,
      functionName: 'resolve',
      args: [tokenId],
    }),
  )
}

export async function resolveOphisNameOrAddress(
  reader: OphisNameReader,
  input: string,
): Promise<OphisNameResolution | null> {
  if (isAddress(input)) return { input, name: null, address: getAddress(input), system: null }

  const parsed = parseOphisName(input)
  if (!parsed) return null

  const address =
    parsed.system === 'ens' ? await resolveEns(reader, parsed.normalized) : await resolveWei(reader, parsed.normalized)

  return address ? { input, name: parsed.normalized, address, system: parsed.system } : null
}

export async function verifyOphisNameResolution(
  reader: OphisNameReader,
  name: string,
  expectedAddress: string,
): Promise<void> {
  const resolution = await resolveOphisNameOrAddress(reader, name)

  if (
    !resolution ||
    resolution.system === null ||
    !isAddress(expectedAddress) ||
    !isAddressEqual(resolution.address, expectedAddress)
  ) {
    throw new Error('Recipient name resolution changed before signing')
  }
}
