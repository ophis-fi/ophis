import { getAddress, keccak256, toUtf8Bytes } from 'ethers'

export function forkMarker(metadata: unknown): { address: string; code: string } {
  if (
    !metadata ||
    typeof metadata !== 'object' ||
    !('forkedNetwork' in metadata) ||
    !metadata.forkedNetwork ||
    !('instanceId' in metadata) ||
    typeof metadata.instanceId !== 'string' ||
    !metadata.instanceId
  )
    throw new Error('A local Anvil fork is required.')
  const marker = keccak256(toUtf8Bytes(`ophisRailgunFork:${metadata.instanceId}`))
  return {
    address: getAddress(`0x${marker.slice(-40)}`),
    code: `0x7f${marker.slice(2)}60005260206000f3`,
  }
}
