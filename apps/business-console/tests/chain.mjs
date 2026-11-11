// The one check against a real chain, run on demand: pnpm test:chain. Not part of "test": it needs the network.
// It starts anvil as a fork of a public OP Mainnet endpoint, creates a real Safe through every official proxy factory
// of the allow-list (chain.ts, SAFES) and compares code hash, slot 0 and fallback handler with that list; then it asks
// the server's own verifier and Safe reads about a real 2 of 3 Safe 1.4.1, and runs a whole last-Owner recovery on it.
// Keys: the public test accounts of anvil. If the public endpoint cannot be reached, it says so and checks nothing.
import { spawn } from 'node:child_process'
import { concat, createPublicClient, createWalletClient, encodeFunctionData, http, keccak256, parseAbi, zeroAddress } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { optimism } from 'viem/chains'
import { colour, SAFES, safeState, verify } from '../src/server/chain.ts'
import { typedLink } from '../src/server/typed.ts'

const FORK = 'https://mainnet.optimism.io'
const RPC = 'http://127.0.0.1:8546'
// The addresses come from chain.ts (SAFES), which took them from the package @safe-global/safe-deployments 1.37.67,
// never from memory. Each one is confirmed with eth_getCode on the fork before it is used. SignMessageLib 1.4.1: same package.
const V141 = SAFES.find((safe) => safe.version === '1.4.1')
const SAFE = { factory: V141.factory, singleton: V141.singletons[1], fallback: V141.handler, signLib: '0xd53cd0aB83D845Ac265BE939c57F53AD838012c9' }
const abi = parseAbi([
  'function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address proxy)',
  'function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)',
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
  'function nonce() view returns (uint256)', 'function signMessage(bytes data)', 'function enableModule(address module)',
])
const check = (what, ok) => {
  if (!ok && process.env.CHAIN_KEEP_GOING) return console.log(`FAILED  ${what}`)
  if (!ok) throw new Error(`FAILED: ${what}`)
  console.log(`ok  ${what}`)
}
const chainId = (url) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}', signal: AbortSignal.timeout(5000) })
  .then((response) => response.json()).then((answer) => answer.result, () => null)

if ((await chainId(FORK)) !== '0xa') {
  console.error(`The public endpoint ${FORK} could not be reached. Nothing was checked.`)
  process.exit(1)
}
const anvil = spawn('anvil', ['--fork-url', FORK, '--port', '8546', '--silent', '--compute-units-per-second', '60', '--retries', '10', '--fork-retry-backoff', '1500', '--no-storage-caching'], { stdio: 'ignore' })
try {
  for (let i = 0; i < 60 && (await chainId(RPC)) !== '0xa'; i++) await new Promise((resolve) => setTimeout(resolve, 500))
  check('anvil runs as a fork of OP Mainnet', (await chainId(RPC)) === '0xa')
  const accounts = [0, 1, 2, 5].map((addressIndex) => mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex }))
  const owners = accounts.slice(0, 3)
  const pub = createPublicClient({ chain: optimism, transport: http(RPC) })
  const wallet = createWalletClient({ account: owners[0], chain: optimism, transport: http(RPC) })
  const mined = async (hash) => check('  the transaction succeeded', (await pub.waitForTransactionReceipt({ hash })).status === 'success')
  for (const [name, address] of Object.entries(SAFE)) check(`${name} ${address} has code on the fork`, ((await pub.getCode({ address })) ?? '0x').length > 2)

  const ends = [RPC, RPC]
  const sorted = owners.map((o) => o.address.toLowerCase()).sort()
  const create = async (factory, singleton, handler) => {
    const initializer = encodeFunctionData({ abi, functionName: 'setup', args: [owners.map((o) => o.address), 2n, zeroAddress, '0x', handler, zeroAddress, 0n, zeroAddress] })
    const created = await pub.simulateContract({ account: owners[0], address: factory, abi, functionName: 'createProxyWithNonce', args: [singleton, initializer, BigInt(Date.now())] })
    await mined(await wallet.writeContract(created.request))
    return created.result
  }
  // The genuine-Safe proof: every line of the allow-list, against a Safe made by that line's own factory.
  for (const official of SAFES) {
    for (const address of [official.factory, ...official.singletons, official.handler]) check(`${official.version}: ${address} has code on the fork`, ((await pub.getCode({ address })) ?? '0x').length > 2)
    for (const singleton of official.singletons) {
      const made = await create(official.factory, singleton, official.handler)
      const hash = keccak256(await pub.getCode({ address: made }))
      check(`${official.version}: a Safe made by the factory has the listed proxy code hash (read ${hash})`, hash === official.proxy)
      check(`${official.version}: its slot 0 holds the singleton ${singleton}`, `0x${(await pub.getStorageAt({ address: made, slot: '0x0' })).slice(26)}` === singleton.toLowerCase())
      check(`${official.version}: the server reads it as a genuine Safe with the official fallback handler`, JSON.stringify(await safeState(ends, 10, made)) === JSON.stringify({ threshold: 2, owners: sorted, modules: [], handler: true }))
    }
  }
  const odd = await create(SAFE.factory, SAFE.singleton, accounts[3].address)
  check('a genuine Safe with another fallback handler is read as a Safe, and is not green', (await safeState(ends, 10, odd))?.handler === false && colour({ kind: 'safe', snapshot: null, inForce: true }, await safeState(ends, 10, odd)).why === 'handler')
  check('an official singleton itself (other code, no proxy) is not a Safe', (await safeState(ends, 10, SAFE.singleton)) === null)

  const safe = await create(SAFE.factory, SAFE.singleton, SAFE.fallback)
  const first = await safeState(ends, 10, safe)
  check(`a 2 of 3 Safe 1.4.1 exists at ${safe}: the server reads its owners, threshold and no module`, JSON.stringify(first) === JSON.stringify({ threshold: 2, owners: sorted, modules: [], handler: true }))

  // The message a wallet signs to be linked, and its digest as the server builds it.
  const now = Math.floor(Date.now() / 1000)
  const typed = typedLink({ chainId: 10, site: 'localhost', organisationId: '0'.repeat(32), wallet: safe, nonce: `0x${'ab'.repeat(32)}`, issuedAt: now, expiresAt: now + 7 * 86400 })
  // Owners sign the Safe's own wrapping of that digest (SafeMessage under the Safe's domain), in the order of their addresses.
  const under = (types, primaryType, message) => ({ domain: { chainId: 10, verifyingContract: safe }, types, primaryType, message })
  const signed = async (signers, data) => concat(await Promise.all([...signers].sort((a, b) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1)).map((signer) => signer.signTypedData(data))))
  const { digest } = (await verify(ends, typed, owners[0].address, await owners[0].signTypedData(typed))) ?? {}
  check('the same verifier accepts a key wallet with no chain call (the digest is the EIP-712 hash)', /^0x[0-9a-f]{64}$/.test(digest ?? ''))
  const message = under({ SafeMessage: [{ name: 'message', type: 'bytes' }] }, 'SafeMessage', { message: digest })
  check('two owner signatures are valid', (await verify(ends, typed, safe, await signed(owners.slice(0, 2), message)))?.by === 'contract')
  check('two other owners are valid too', (await verify(ends, typed, safe, await signed(owners.slice(1), message)))?.by === 'contract')
  check('one owner signature is refused', (await verify(ends, typed, safe, await signed(owners.slice(0, 1), message))) === null)
  check('an owner\'s signature of the message itself is refused for the Safe', (await verify(ends, typed, safe, await owners[0].signTypedData(typed))) === null)
  check('two signatures of someone who is not an owner are refused', (await verify(ends, typed, safe, await signed([owners[0], accounts[3]], message))) === null)
  check('the empty signature is refused before the Safe signed onchain', (await verify(ends, typed, safe, '0x')) === null)
  check('a pin on another chain is refused: the endpoints say chain 10', (await verify(ends, { ...typed, domain: { ...typed.domain, chainId: 1 } }, safe, await signed(owners.slice(0, 2), message))) === null)

  // A Safe transaction, signed by two owners and executed by the first.
  const exec = async (to, data, operation) => {
    const tx = { to, value: 0n, data, operation, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: zeroAddress, refundReceiver: zeroAddress, nonce: await pub.readContract({ address: safe, abi, functionName: 'nonce' }) }
    const types = { SafeTx: Object.keys(tx).map((name) => ({ name, type: name === 'data' ? 'bytes' : name === 'operation' ? 'uint8' : typeof tx[name] === 'bigint' ? 'uint256' : 'address' })) }
    const signatures = await signed(owners.slice(0, 2), under(types, 'SafeTx', tx))
    await mined(await wallet.writeContract({ address: safe, abi, functionName: 'execTransaction', args: [to, 0n, data, operation, 0n, 0n, 0n, zeroAddress, zeroAddress, signatures] }))
  }
  await exec(SAFE.signLib, encodeFunctionData({ abi, functionName: 'signMessage', args: [digest] }), 1)
  check('the onchain route: after SignMessageLib.signMessage, the empty signature is valid', (await verify(ends, typed, safe, '0x'))?.by === 'contract')
  const other = { ...typed, message: { ...typed.message, nonce: `0x${'cd'.repeat(32)}` } }
  check('and only for that message: another nonce is refused', (await verify(ends, other, safe, '0x')) === null)

  const snapshot = JSON.stringify(first)
  check('kind "safe", threshold 2, no module, in force, owners as in the snapshot: green', JSON.stringify(colour({ kind: 'safe', snapshot, inForce: true }, await safeState(ends, 10, safe))) === '{"level":"green","why":null}')
  await exec(safe, encodeFunctionData({ abi, functionName: 'enableModule', args: [accounts[3].address] }), 0)
  const after = await safeState(ends, 10, safe)
  check('after enableModule the server reads the module, and the colour is amber', after.modules.length === 1 && after.modules[0] === accounts[3].address.toLowerCase() && JSON.stringify(colour({ kind: 'safe', snapshot, inForce: true }, after)) === '{"level":"amber","why":"module"}')
  check('an address with no code is not a Safe', (await safeState(ends, 10, accounts[3].address)) === null)
  console.log('The real-chain check passed.')
} finally {
  anvil.kill()
}
