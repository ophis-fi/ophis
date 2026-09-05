#!/usr/bin/env node
// Across bridge-SOURCE preflight — the fail-closed guard whose absence caused
// the 2026-08-13 incident (Ink/Linea enabled as sources while the weiroll VM
// was undeployed there → the Across deposit hook DELEGATECALLed a codeless
// address, which returns success, so the deposit silently no-op'd and funds
// stranded in the user's CoW Shed).
//
// It verifies every on-chain contract the Across deposit flow touches on a
// source chain has code:
//   settlement -> HooksTrampoline -> CoW Shed proxy (factory+impl) -> weiroll VM
//                                                     -> Across SpokePool + math
// Run it for the exact chains a REACT_APP_ACROSS_*_SOURCE flag is about to
// enable, BEFORE flipping the flag:
//   node apps/frontend/scripts/across-source-preflight.mjs 57073 59144
// Exit 0 = all deps present on all requested chains; 1 = a dep is codeless;
// 2 = bad usage. Any invalid or unknown chain fails the whole invocation.
//
// SCOPE: only chains whose FULL source path is ready are listed here; an unknown
// chain is rejected (fail closed).
//
// Contract presence alone is NOT sufficient for a SOVEREIGN chain (Ophis runs its
// own settlement + driver there, so OUR driver must execute the post-hook rather
// than upstream CoW's). A sovereign row therefore also carries `orderbookApi`,
// and this script performs two extra checks that presence cannot give:
//   1. the deployed HooksTrampoline's settlement() actually returns THAT chain's
//      settlement — a trampoline is settlement-bound, so a canonical/foreign one
//      would silently never be callable by our settlement;
//   2. the LIVE orderbook advertises the same trampoline + settlement it is
//      running with (/api/v1/info/contracts), catching config drift between the
//      deployed contracts and the running services.
// Even then, the flag must not be flipped until a real bridge FROM the chain has
// produced a SpokePool FundsDeposited event: the trampoline discards each hook's
// success flag, so a broken post-hook is invisible on-chain (2026-08-13).
// Unichain 130 stays absent until its own readiness is done.

// Chain-independent deps (same CREATE2 address on every chain).
const CHAIN_INDEPENDENT = {
  'CoW Shed factory': '0x312f92fe5f1710408B20D52A374fa29e099cFA86',
  'CoW Shed impl': '0xa2704cF562AD418Bf0453F4B662ebf6A2489eD88',
  'weiroll VM': '0x9585c3062Df1C247d5E373Cfca9167F7dC2b5963',
}

// Per-chain deps. `settlement`/`hooksTrampoline` are the upstream CoW contracts
// on non-sovereign chains (canonical settlement 0x9008D19f, current-version
// trampoline 0x60Bf7823, both verified bound + present). rpc is a keyless
// endpoint used only to read code. A chain absent here is rejected (fail closed);
// add a row ONLY when the chain's full source path — including driver execution
// for sovereign chains — is actually wired.
const PER_CHAIN = {
  57073: {
    name: 'Ink',
    rpc: 'https://rpc-gel.inkonchain.com',
    settlement: '0x9008D19f58AAbD9eD0D60971565AA8510560ab41',
    hooksTrampoline: '0x60Bf78233f48eC42eE3F101b9a05eC7878728006',
    spokePool: '0xeF684C38F94F48775959ECf2012D7E864ffb9dd4',
    mathHelper: '0xEdE97D044d4C8aAA682968bee10284521B9f311a',
  },
  59144: {
    name: 'Linea',
    rpc: 'https://rpc.linea.build',
    settlement: '0x9008D19f58AAbD9eD0D60971565AA8510560ab41',
    hooksTrampoline: '0x60Bf78233f48eC42eE3F101b9a05eC7878728006',
    spokePool: '0x7E63A5f1a8F0B4d0934B2f2327DAED3F6bb2ee75',
    mathHelper: '0xEdE97D044d4C8aAA682968bee10284521B9f311a',
  },
  4663: {
    name: 'Robinhood Chain',
    // SOVEREIGN: Ophis settlement + Ophis-bound trampoline, and our own driver
    // executes the post-hook. `sovereign` turns on the binding + live-config
    // checks below.
    sovereign: true,
    rpc: 'https://rpc.mainnet.chain.robinhood.com',
    orderbookApi: 'https://robinhood-mainnet.ophis.fi',
    settlement: '0x886d9fd312F442C4E1f3cdeAE7b4AB73493e57cD',
    hooksTrampoline: '0x68593257dfD7F392AbfbB410b212Be0b6242aC0E',
    spokePool: '0xD29C85F15DF544bA632C9E25829fd29d767d7978',
    mathHelper: '0xEdE97D044d4C8aAA682968bee10284521B9f311a',
  },
}

// keccak256("settlement()")[0:4] — the HooksTrampoline's bound-settlement getter.
const SETTLEMENT_SELECTOR = '0x51160630'

const RPC_TIMEOUT_MS = 10_000

async function getCode(rpc, address) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS)
  try {
    const res = await fetch(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'ophis-across-source-preflight' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [address, 'latest'] }),
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`RPC ${res.status}`)
    const json = await res.json()
    if (json.error) throw new Error(json.error.message)
    return json.result
  } finally {
    clearTimeout(timer)
  }
}

// Generic JSON-RPC POST with the same timeout + fail-closed contract as getCode.
async function rpcCall(rpc, method, params) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS)
  try {
    const res = await fetch(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'ophis-across-source-preflight' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`RPC ${res.status}`)
    const json = await res.json()
    if (json.error) throw new Error(json.error.message)
    return json.result
  } finally {
    clearTimeout(timer)
  }
}

const sameAddress = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()

// The orderbook's /info/contracts returns some entries as bare address strings
// and others as { address, abi } objects — normalize before comparing.
const toAddress = (v) => (typeof v === 'string' ? v : v && typeof v === 'object' ? v.address : undefined)

// SOVEREIGN-only checks. Presence proves code exists; these prove it is the RIGHT
// code, wired to the services that must drive it.
async function checkSovereign(chain) {
  const lines = []
  let ok = true

  // 1. The trampoline is settlement-bound: settlement() must return THIS chain's
  //    settlement, or our settlement could never call it.
  try {
    const raw = await rpcCall(chain.rpc, 'eth_call', [{ to: chain.hooksTrampoline, data: SETTLEMENT_SELECTOR }, 'latest'])
    const bound = raw && raw.length >= 66 ? `0x${raw.slice(-40)}` : undefined
    const good = sameAddress(bound, chain.settlement)
    lines.push(`  ${chain.name} trampoline.settlement() -> ${bound ?? 'unreadable'}: ${good ? 'ok (bound to this chain)' : 'MISMATCH (expected ' + chain.settlement + ')'}`)
    if (!good) ok = false
  } catch (e) {
    lines.push(`  ${chain.name} trampoline.settlement(): RPC ERROR (${e.message}) — treat as MISSING`)
    ok = false
  }

  // 2. The LIVE orderbook must be running with the same trampoline + settlement.
  //    Contracts can be perfect while the service points somewhere else.
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS)
    let info
    try {
      const res = await fetch(`${chain.orderbookApi}/api/v1/info/contracts`, {
        headers: { 'User-Agent': 'ophis-across-source-preflight' },
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      info = await res.json()
    } finally {
      clearTimeout(timer)
    }
    const checks = [
      ['hooksTrampoline', toAddress(info?.hooksTrampoline), chain.hooksTrampoline],
      ['settlement', toAddress(info?.settlement), chain.settlement],
    ]
    for (const [label, live, expected] of checks) {
      const good = sameAddress(live, expected)
      lines.push(`  ${chain.name} orderbook ${label} -> ${live ?? 'absent'}: ${good ? 'ok (matches deployed)' : 'MISMATCH (expected ' + expected + ')'}`)
      if (!good) ok = false
    }
    const chainOk = Number(info?.chainId) === Number(chain.chainId ?? info?.chainId)
    if (!chainOk) {
      lines.push(`  ${chain.name} orderbook chainId -> ${info?.chainId}: MISMATCH`)
      ok = false
    }
  } catch (e) {
    lines.push(`  ${chain.name} orderbook /info/contracts: ERROR (${e.message}) — cannot confirm the running config`)
    ok = false
  }

  return { ok, lines }
}

async function checkChain(chainId) {
  const chain = PER_CHAIN[chainId]
  // Fail closed on an unknown chain: not being in the table means its source
  // path was never verified as complete.
  if (!chain) return { chainId, ok: false, lines: [`  chain ${chainId}: NOT a verified Across source chain — refuse to enable`] }

  const deps = {
    ...CHAIN_INDEPENDENT,
    'CoW settlement': chain.settlement,
    'HooksTrampoline': chain.hooksTrampoline,
    'Across SpokePool': chain.spokePool,
    'AcrossMathHelper': chain.mathHelper,
  }
  const lines = []
  let ok = true
  for (const [label, address] of Object.entries(deps)) {
    let has
    try {
      const code = await getCode(chain.rpc, address)
      has = typeof code === 'string' && code !== '0x' && code.length > 2
    } catch (e) {
      // A timeout or RPC error is treated as MISSING — the guard stays fail-closed.
      lines.push(`  ${chain.name} ${label} ${address}: RPC ERROR (${e.message}) — treat as MISSING`)
      ok = false
      continue
    }
    lines.push(`  ${chain.name} ${label} ${address}: ${has ? 'ok' : 'MISSING (no code)'}`)
    if (!has) ok = false
  }

  // Sovereign chains need more than presence: the trampoline must be bound to
  // this chain's settlement, and the running services must be configured with
  // the same addresses we just verified.
  if (chain.sovereign) {
    const sov = await checkSovereign({ ...chain, chainId })
    lines.push(...sov.lines)
    if (!sov.ok) ok = false
  }

  return { chainId, ok, lines }
}

const rawArgs = process.argv.slice(2)
if (rawArgs.length === 0) {
  console.error('usage: across-source-preflight.mjs <chainId> [chainId ...]')
  process.exit(2)
}
// Validate EVERY argument up front: a mistyped id (e.g. "5914x") must fail the
// whole invocation, never be silently dropped while the others report PASS.
const chainIds = []
for (const raw of rawArgs) {
  if (!/^[0-9]+$/.test(raw)) {
    console.error(`invalid chain id argument: "${raw}" — must be a positive integer`)
    process.exit(2)
  }
  chainIds.push(Number(raw))
}

const results = await Promise.all(chainIds.map(checkChain))
let allOk = true
for (const r of results) {
  console.log(`\nchain ${r.chainId}: ${r.ok ? 'PASS' : 'FAIL'}`)
  r.lines.forEach((l) => console.log(l))
  if (!r.ok) allOk = false
}
console.log(`\n${allOk ? 'PREFLIGHT PASS — every dependency has code on every requested chain.' : 'PREFLIGHT FAIL — do NOT enable these chains as Across sources.'}`)
process.exit(allOk ? 0 : 1)
