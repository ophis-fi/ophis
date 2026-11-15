// The one check against a real chain, run on demand: pnpm test:chain. Not part of "test": it needs the network.
// It starts anvil as a fork of a public OP Mainnet endpoint, creates a real Safe through every official proxy factory
// of the allow-list (chain.ts, SAFES) and compares code hash, slot 0 and fallback handler with that list; then it asks
// the server's own verifier and Safe reads about a real 2 of 3 Safe 1.4.1, and runs a whole last-Owner recovery on it.
// Keys: the public test accounts of anvil. If the public endpoint cannot be reached, it says so and checks nothing.
// The real desk, last: on an anvil fork of each wallet chain (1, 10, 8453, 42161), the settlement and the vault relayer
// of orders.ts against the contracts themselves, the order id of a signed order as the settlement derives it in a real
// settle, a presignature for the order id the server computed, Multicall3, and Overview's balances read through it.
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import { concat, createPublicClient, createTestClient, createWalletClient, decodeEventLog, domainSeparator, encodeAbiParameters, encodeFunctionData, hashTypedData, http, keccak256, parseAbi, zeroAddress } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { arbitrum, base, mainnet, optimism } from 'viem/chains'
import * as orders from '../src/server/orders.ts'
import { balancesOf, colour, SAFES, safeState, verify } from '../src/server/chain.ts'
import { typedLink, typedProof } from '../src/server/typed.ts'
import { getPlatformProxy } from 'wrangler'
import * as data from '../src/server/data.ts'
import { handle } from '../src/server/index.ts'
import { configFor, fromBase64Url } from '../src/server/passkeys.ts'
import { softwareAuthenticator } from './authenticator.ts'
import { DUMMY as HUMAN_OK, PORT as TURNSTILE_PORT, start as startTurnstile, TEST_SECRET as TURNSTILE_TEST } from '../scripts/turnstile-stub.mjs'

process.chdir(new URL('..', import.meta.url).pathname)

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
  'function nonce() view returns (uint256)', 'function signMessage(bytes data)', 'function enableModule(address module)', 'function addOwnerWithThreshold(address owner, uint256 threshold)',
])
const check = (what, ok) => {
  if (!ok && process.env.CHAIN_KEEP_GOING) return console.log(`FAILED  ${what}`)
  if (!ok) throw new Error(`FAILED: ${what}`)
  console.log(`ok  ${what}`)
}
const chainId_ = (url) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}', signal: AbortSignal.timeout(5000) })
  .then((response) => response.json()).then((answer) => answer.result, () => null)

const chainId = chainId_
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
  const under = (types, primaryType, message, of = safe) => ({ domain: { chainId: 10, verifyingContract: of }, types, primaryType, message })
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
  const exec = async (to, data, operation, of = safe) => {
    const tx = { to, value: 0n, data, operation, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: zeroAddress, refundReceiver: zeroAddress, nonce: await pub.readContract({ address: of, abi, functionName: 'nonce' }) }
    const types = { SafeTx: Object.keys(tx).map((name) => ({ name, type: name === 'data' ? 'bytes' : name === 'operation' ? 'uint8' : typeof tx[name] === 'bigint' ? 'uint256' : 'address' })) }
    const signatures = await signed(owners.slice(0, 2), under(types, 'SafeTx', tx, of))
    await mined(await wallet.writeContract({ address: of, abi, functionName: 'execTransaction', args: [to, 0n, data, operation, 0n, 0n, 0n, zeroAddress, zeroAddress, signatures] }))
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

  // ---- a whole last-Owner recovery through the Worker's own routes, against a real Safe ----
  // The Worker runs here in Node (24 or later: it needs URLPattern) on a throwaway local D1. Its two OP Mainnet
  // endpoints are answered by the fork. The clock is the server's own: the chain's time is never moved.
  check('this Node has URLPattern, which the Worker\'s router needs', typeof URLPattern === 'function')
  const STATE = '.wrangler/chain'
  rmSync(STATE, { recursive: true, force: true })
  execFileSync('node_modules/.bin/wrangler', ['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', STATE], { env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: 'ignore' })
  const proxy = await getPlatformProxy({ configPath: 'wrangler.jsonc', remoteBindings: false, persist: { path: `${STATE}/v3` } })
  const realFetch = globalThis.fetch
  const stopTurnstile = startTurnstile() // the bot check of the recovery forms, the local stand-in
  try {
    const config = configFor('local')
    globalThis.fetch = (input, init) => realFetch(config.chains[10].includes(String(input)) ? RPC : input, init)
    const env = { DB: proxy.env.DB, ASSETS: { fetch: async () => new Response('') }, ENVIRONMENT: 'local', CHALLENGE_KEY: randomBytes(32).toString('base64url'), TURNSTILE_URL: `http://127.0.0.1:${TURNSTILE_PORT}`, TURNSTILE_SECRET: TURNSTILE_TEST }
    const site = { origin: config.origin, rpId: config.rpId }
    let clock = Date.now()
    const HOURS72 = 72 * 60 * 60_000
    const call = async (path, body, { cookie, sign } = {}) => {
      const origin = sign ? config.signOrigin : config.origin
      const headers = { 'sec-fetch-site': 'same-origin', origin, 'content-type': 'application/json', ...(cookie && { cookie }) }
      const response = await handle(new Request(origin + path, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, () => clock)
      return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '' }
    }
    const signIn = async (key) => (await call('/api/signin/finish', { response: await key.authenticate((await call('/api/signin/start', {})).body.options) })).cookie
    const fieldsOf = (sealed) => JSON.parse(new TextDecoder().decode(fromBase64Url(sealed.split('.')[0])))
    // Two owners sign the Safe's wrapping of the digest, as the Safe interface does offchain.
    const safeSignature = (of, typedData) => signed(owners.slice(0, 2), under({ SafeMessage: [{ name: 'message', type: 'bytes' }] }, 'SafeMessage', { message: hashTypedData(typedData) }, of))

    // One Owner with two keys, whose recovery wallet is a new 2 of 3 Safe.
    const ticket = data.randomToken()
    const { orgId } = await data.seedOrganisation(env.DB, { name: 'Fork Vaults', kind: 'partner', ownerName: 'Fork Owner', ticketHash: await data.sha256Hex(ticket), now: clock })
    const key1 = await softwareAuthenticator(site)
    await call('/api/enrol/finish', { ticket, label: 'Key 1', response: await key1.register((await call('/api/enrol/start', { ticket })).body.options) })
    await data.devActivatePending(env.DB, 'local', clock)
    let cookie = await signIn(key1)
    const key2 = await softwareAuthenticator(site)
    check('an Owner with two keys exists in the Worker', (await call('/api/passkeys/finish', { label: 'Key 2', response: await key2.register((await call('/api/passkeys/start', {}, { cookie })).body.options) }, { cookie })).status === 200)
    const vault = await create(SAFE.factory, SAFE.singleton, SAFE.fallback)
    const asked = (await call('/api/wallets/intent', { chainId: 10, address: vault, label: 'Vault', custodian: false }, { cookie })).body.intent
    const i = fieldsOf(asked)
    const linked = await call('/api/proof', { intent: asked, signature: await safeSignature(vault, typedLink({ chainId: 10, site: i.site, organisationId: i.org, wallet: i.wallet, nonce: i.nonce, issuedAt: i.issuedAt, expiresAt: i.expiresAt })) }, { sign: true })
    const [listed] = (await call('/api/org', undefined, { cookie })).body.wallets
    check('two owners of the real Safe signed the link, and the Worker stored it as a genuine Safe, 2 of 3', linked.body.state === 'linked' && listed.kind === 'safe' && listed.threshold === 2 && listed.owners === 3)
    check('it is set as the recovery wallet', (await call(`/api/wallets/${listed.id}/anchor`, {}, { cookie })).body.state === 'applied')
    clock += HOURS72
    check('72 hours later, by the server\'s clock, it is in force and green', (await call('/api/readiness', undefined, { cookie: await signIn(key1) })).body.wallet.level === 'green')

    // The request: a new passkey, the Proof signed by two owners, the wait, the completion.
    const recover = async () => {
      const key = await softwareAuthenticator(site)
      const start = (await call('/api/recover/intent', { organisationId: orgId })).body
      const { intent } = (await call('/api/recover/intent', { organisationId: orgId, seat: start.seat, response: await key.register(start.options), turnstile: HUMAN_OK })).body
      const f = fieldsOf(intent)
      const typedData = typedProof({ kind: f.kind, chainId: 10, site: f.site, organisationId: f.org, wallet: vault, credentialHash: f.credentialHash, nonce: f.nonce, issuedAt: f.issuedAt, expiresAt: f.expiresAt })
      const one = await call('/api/proof', { intent, signature: await signed(owners.slice(0, 1), under({ SafeMessage: [{ name: 'message', type: 'bytes' }] }, 'SafeMessage', { message: hashTypedData(typedData) }, vault)) }, { sign: true })
      return { key, one: one.body.error, opened: (await call('/api/proof', { intent, signature: await safeSignature(vault, typedData) }, { sign: true })).body }
    }
    const resume = async (key) => call('/api/recover/continue/finish', { response: await key.authenticate((await call('/api/recover/continue/start', {})).body.options) })
    const first = await recover()
    check('one owner of the Safe opens nothing; two owners open the request, which waits 72 hours', first.one === 'proof_rejected' && first.opened.state === 'waiting' && first.opened.until === clock + HOURS72)
    clock += HOURS72 - 60_000
    check('at 71 h 59 min the completion is refused', (await resume(first.key)).body.error === 'too_early')
    clock += 60_000
    const done = await resume(first.key)
    const me = (await call('/api/me', undefined, { cookie: done.cookie })).body
    check('at 72 hours the Worker verifies the proof again on the Safe, finds its owners unchanged, and the new passkey is an Owner in a session',
      done.status === 200 && me.seat.role === 'owner' && me.organisation.id === orgId && me.organisation.quarantineUntil === clock + 7 * 24 * 60 * 60_000)
    check('the old Owner passkey opens no session and is told it can stop the recovery', (await call('/api/signin/finish', { response: await key1.authenticate((await call('/api/signin/start', {})).body.options) })).body.recovery === true)

    // A second request: refused while the first can still be stopped, open once those 7 days are over. During its
    // wait an owner is added to the Safe on the fork: the completion lapses.
    check('while the first recovery can still be stopped, a second request opens nothing', (await recover()).opened.error === 'proof_rejected')
    clock += 7 * 24 * 60 * 60_000
    const second = await recover()
    check('a second request opens', second.opened.state === 'waiting')
    await exec(vault, encodeFunctionData({ abi, functionName: 'addOwnerWithThreshold', args: [accounts[3].address, 2n] }), 0, vault)
    check('the Safe on the fork now has four owners', (await safeState(ends, 10, vault)).owners.length === 4)
    clock += HOURS72
    const lapsed = await resume(second.key)
    check('after an owner was added on the fork, the completion lapses: the Safe is not the one that signed', lapsed.status === 410 && lapsed.body.error === 'recovery_lapsed')
    check('and the pending passkey is worth nothing any more', (await resume(second.key)).status === 401)
  } finally {
    globalThis.fetch = realFetch
    stopTurnstile()
    await proxy.dispose()
    rmSync(STATE, { recursive: true, force: true })
  }
} finally {
  anvil.kill()
}

// ---- the real desk, on a fork of each wallet chain ----
const GPV2 = parseAbi([
  'function domainSeparator() view returns (bytes32)', 'function vaultRelayer() view returns (address)', 'function authenticator() view returns (address)',
  'function setPreSignature(bytes orderUid, bool signed)', 'function preSignature(bytes orderUid) view returns (uint256)',
  'function settle(address[] tokens, uint256[] clearingPrices, (uint256 sellTokenIndex, uint256 buyTokenIndex, address receiver, uint256 sellAmount, uint256 buyAmount, uint32 validTo, bytes32 appData, uint256 feeAmount, uint256 flags, uint256 executedAmount, bytes signature)[] trades, (address target, uint256 value, bytes callData)[][3] interactions)',
  'event Trade(address indexed owner, address sellToken, address buyToken, uint256 sellAmount, uint256 buyAmount, uint256 feeAmount, bytes orderUid)',
  'function manager() view returns (address)', 'function addSolver(address solver)',
  'function deposit() payable', 'function approve(address spender, uint256 amount) returns (bool)', 'function balanceOf(address owner) view returns (uint256)',
])
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'
const PRE_SIGNED = BigInt(keccak256(new TextEncoder().encode('GPv2Signing.Scheme.PreSign')))
const FORKS = { 1: [mainnet, 'https://ethereum-rpc.publicnode.com'], 10: [optimism, 'https://mainnet.optimism.io'], 8453: [base, 'https://mainnet.base.org'], 42161: [arbitrum, 'https://arb1.arbitrum.io/rpc'] }
for (let i = 0; i < 20 && (await chainId_(RPC)); i++) await new Promise((resolve) => setTimeout(resolve, 250)) // the fork of OP Mainnet has stopped
const [owner, solver] = [1, 2].map((addressIndex) => mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex }))
for (const [id, [viemChain, fork]] of Object.entries(FORKS)) {
  const chainId = Number(id)
  const hex = `0x${chainId.toString(16)}`
  if ((await chainId_(fork)) !== hex) {
    console.error(`The public endpoint ${fork} could not be reached. Nothing more was checked.`)
    process.exit(1)
  }
  const node = spawn('anvil', ['--fork-url', fork, '--port', '8546', '--silent', '--compute-units-per-second', '60', '--retries', '10', '--fork-retry-backoff', '1500', '--no-storage-caching'], { stdio: 'ignore' })
  try {
    for (let i = 0; i < 60 && (await chainId_(RPC)) !== hex; i++) await new Promise((resolve) => setTimeout(resolve, 500))
    const name = viemChain.name
    check(`${name}: anvil runs as a fork`, (await chainId_(RPC)) === hex)
    const pub = createPublicClient({ chain: viemChain, transport: http(RPC) })
    const test = createTestClient({ chain: viemChain, mode: 'anvil', transport: http(RPC) })
    const { settlement, relayer } = orders.CHAINS[chainId]
    const read = (functionName, args = [], address = settlement) => pub.readContract({ address, abi: GPV2, functionName, args })
    check(`${name}: the server's domain separator is the settlement's domainSeparator()`, (await read('domainSeparator')) === domainSeparator({ domain: orders.domainOf(chainId) }))
    check(`${name}: the vault relayer is the settlement's vaultRelayer()`, (await read('vaultRelayer')) === relayer)
    check(`${name}: Multicall3 has code at ${MULTICALL3}`, ((await pub.getCode({ address: MULTICALL3 })) ?? '0x').length > 2)

    // A limit order of the server's own terms: 0.01 WETH for at least 1 unit of USDC, signed by an anvil key.
    const { WETH, USDC } = orders.ASSETS[chainId]
    const atTime = Number((await pub.getBlock()).timestamp)
    const ticket = orders.ticket({ type: 'limit', chainId, walletId: 'w', sell: 'WETH', buy: 'USDC', amount: '0.01', limitPrice: '0.0001', validFor: 1800 })
    const terms = orders.terms(ticket, { id: 'w', label: 'Key wallet', address: owner.address, kind: 'custodian' }, 1n)
    const built = orders.gpv2(terms, atTime + 1800)
    const signature = await owner.signTypedData(built.typed)
    // The owner wraps and approves exactly the amount sold, as the signing page does; a solver is added; the settlement gets 1 unit of USDC.
    const as = (account) => createWalletClient({ account, chain: viemChain, transport: http(RPC) })
    for (const a of [owner, solver]) await test.setBalance({ address: a.address, value: 10n ** 20n })
    const mined = async (hash) => (await pub.waitForTransactionReceipt({ hash })).status === 'success'
    check(`${name}: the owner wraps and approves the exact amount to the vault relayer`, await mined(await as(owner).writeContract({ address: WETH.token, abi: GPV2, functionName: 'deposit', value: 10n ** 16n }))
      && await mined(await as(owner).writeContract({ address: WETH.token, abi: GPV2, functionName: 'approve', args: [relayer, 10n ** 16n] })))
    const manager = await read('manager', [], await read('authenticator'))
    await test.impersonateAccount({ address: manager })
    await test.setBalance({ address: manager, value: 10n ** 20n })
    await mined(await createWalletClient({ account: manager, chain: viemChain, transport: http(RPC) }).writeContract({ address: await read('authenticator'), abi: GPV2, functionName: 'addSolver', args: [solver.address] }))
    // A balance of 1 unit: the slot of the token's balance map is found by trying the first 20.
    for (let slot = 0n; slot < 20n && (await read('balanceOf', [settlement], USDC.token)) === 0n; slot++) {
      await test.setStorageAt({ address: USDC.token, index: keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [settlement, slot])), value: `0x${'1'.padStart(64, '0')}` })
    }
    const m = built.message
    const trade = { sellTokenIndex: 0n, buyTokenIndex: 1n, receiver: m.receiver, sellAmount: BigInt(m.sellAmount), buyAmount: BigInt(m.buyAmount), validTo: m.validTo, appData: m.appData, feeAmount: 0n, flags: 0n, executedAmount: 0n, signature }
    const receipt = await pub.waitForTransactionReceipt({ hash: await as(solver).writeContract({ address: settlement, abi: GPV2, functionName: 'settle', args: [[WETH.token, USDC.token], [1n, 10n ** 16n], [trade], [[], [], []]] }) })
    const traded = receipt.logs.filter((l) => l.address.toLowerCase() === settlement.toLowerCase()).map((l) => { try { return decodeEventLog({ abi: GPV2, ...l }) } catch { return null } }).find((e) => e?.eventName === 'Trade')
    check(`${name}: a real settle of the order an anvil key signed derives the order id the server computed`, receipt.status === 'success' && traded?.args.orderUid === built.uid)

    // A presign order (a Safe's terms; here an anvil key is its owner): setPreSignature from the owner, for the server's order id.
    const safeTerms = orders.terms({ ...ticket, limitPrice: '0.0002' }, { id: 'w', label: 'Safe', address: owner.address, kind: 'safe' }, 2n)
    const presigned = orders.gpv2(safeTerms, atTime + 1800)
    check(`${name}: setPreSignature from the owner sets preSignature for the order id the server computed`, safeTerms.scheme === 'presign'
      && await mined(await as(owner).writeContract({ address: settlement, abi: GPV2, functionName: 'setPreSignature', args: [presigned.uid, true] })) && (await read('preSignature', [presigned.uid])) === PRE_SIGNED)

    // Overview's balances: the server's one aggregate3 on the real Multicall3 gives what balanceOf gives, for every asset of the chain.
    const pairs = Object.values(orders.ASSETS[chainId]).flatMap((a) => [[settlement, a.token], [owner.address, a.token]])
    const direct = await Promise.all(pairs.map(([who, token]) => read('balanceOf', [who], token)))
    check(`${name}: the server's balances through Multicall3 aggregate3 equal balanceOf of each asset (${pairs.length} reads)`, JSON.stringify(await balancesOf([RPC, RPC], chainId, pairs), (_, v) => (typeof v === 'bigint' ? String(v) : v)) === JSON.stringify(direct.map(String)))
  } finally {
    node.kill()
    for (let i = 0; i < 20 && (await chainId_(RPC)); i++) await new Promise((resolve) => setTimeout(resolve, 250))
  }
}
console.log('The real-chain check passed.')
