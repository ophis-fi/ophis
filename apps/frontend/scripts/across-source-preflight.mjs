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
// SCOPE: only chains whose FULL source path is ready are listed here. Contract
// presence is necessary but NOT sufficient for the SOVEREIGN chains (Unichain
// 130, Robinhood 4663): those also require Ophis's own driver to execute the
// post-hook on the sovereign settlement, plus an E2E proof — none of which is
// on-chain-checkable here. They are deliberately absent until that work lands
// (see bridgeSourceChains.const.ts); this script must never green-light them.

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
}

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
