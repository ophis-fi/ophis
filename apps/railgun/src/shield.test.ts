import { expect, it, vi } from 'vitest'
import { makeError, type JsonRpcSigner } from 'ethers'
import type { WalletSession } from './wallet'
import { assertPublicNetwork } from './shield'
import { forkMarker } from './fork-marker'

it('rechecks the exact fork instance and rejects mainnet, other forks and wallet network changes', async () => {
  const metadata = { forkedNetwork: { chainId: 1 }, instanceId: 'same-local-instance' }
  const marker = forkMarker(metadata)
  const send = vi.fn().mockResolvedValue(marker.code)
  const network = vi.fn().mockResolvedValue({ chainId: 1n })
  const session = {
    provider: {
      send: async (method: string) => (method === 'anvil_metadata' ? metadata : marker.code),
    },
  } as unknown as WalletSession
  const signer = { provider: { send, getNetwork: network } } as unknown as JsonRpcSigner
  await expect(assertPublicNetwork(session, signer)).resolves.toBeUndefined()
  expect(send).toHaveBeenCalledWith('eth_getCode', [marker.address, 'latest'])
  send.mockResolvedValue(forkMarker({ ...metadata, instanceId: 'other-fork-instance' }).code)
  await expect(assertPublicNetwork(session, signer)).rejects.toThrow(/Other forks/)
  send.mockResolvedValue('0x')
  await expect(assertPublicNetwork(session, signer)).rejects.toThrow(/mainnet/)
  network.mockResolvedValue({ chainId: 10n })
  await expect(assertPublicNetwork(session, signer)).rejects.toThrow(/Ethereum/)
  network.mockRejectedValue(makeError('network changed', 'NETWORK_ERROR', { event: 'changed' }))
  await expect(assertPublicNetwork(session, signer)).rejects.toThrow('Switch your public wallet to Ethereum, then reconnect.')
})

it('requires fork metadata and changes the marker after a fork reset', () => {
  expect(() => forkMarker({ instanceId: 'mainnet' })).toThrow(/Anvil/)
  expect(forkMarker({ forkedNetwork: {}, instanceId: 'first' })).not.toEqual(
    forkMarker({ forkedNetwork: {}, instanceId: 'reset' }),
  )
})
