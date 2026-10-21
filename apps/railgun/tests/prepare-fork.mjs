import assert from 'node:assert/strict'
import { JsonRpcProvider } from 'ethers'
import { forkMarker } from '../src/fork-marker.ts'

const url = new URL(process.env.RAILGUN_FORK_RPC_URL || 'http://127.0.0.1:8549')
assert(
  ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname),
  'Fork preparation is loopback-only',
)
const provider = new JsonRpcProvider(url.href)
try {
  assert.equal((await provider.getNetwork()).chainId, 1n)
  const marker = forkMarker(await provider.send('anvil_metadata', []))
  await provider.send('anvil_setCode', [marker.address, marker.code])
  assert.equal(await provider.send('eth_getCode', [marker.address, 'latest']), marker.code)
  console.log('Prepared unique local fork marker:', marker.address)
} finally {
  provider.destroy()
}
