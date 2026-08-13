#!/usr/bin/env node
// Across bridge-SOURCE preflight — the guard whose absence caused the
// 2026-08-13 incident (Ink/Linea enabled as sources while the weiroll VM was
// undeployed there → the Across deposit hook DELEGATECALLed a codeless address,
// which returns success, so the deposit silently no-op'd and funds stranded in
// the user's CoW Shed).
//
// Enabling a chain as an Across source requires FOUR chain-local contracts, all
// hardcoded (chain-independent) or SDK-registered (per-chain). This script
// refuses to green-light a chain unless every one of them has code on-chain.
//
// Run it for the exact chains a REACT_APP_ACROSS_*_SOURCE flag is about to
// enable, BEFORE flipping the flag:
//   node apps/frontend/scripts/across-source-preflight.mjs 57073 59144
// Exit 0 = all deps present on all chains; exit 1 = at least one is codeless.

// Chain-independent deps (same address on every chain).
const CHAIN_INDEPENDENT = {
  'CoW Shed factory': '0x312f92fe5f1710408B20D52A374fa29e099cFA86',
  'CoW Shed impl': '0xa2704cF562AD418Bf0453F4B662ebf6A2489eD88',
  'weiroll VM': '0x9585c3062Df1C247d5E373Cfca9167F7dC2b5963',
}

// Per-chain deps: the Across SpokePool and the AcrossMathHelper. rpc is a
// keyless endpoint used only to read code. Extend this table when a new source
// chain is added — a chain absent here fails closed.
const PER_CHAIN = {
  57073: { name: 'Ink', rpc: 'https://rpc-gel.inkonchain.com', spokePool: '0xeF684C38F94F48775959ECf2012D7E864ffb9dd4', mathHelper: '0xEdE97D044d4C8aAA682968bee10284521B9f311a' },
  59144: { name: 'Linea', rpc: 'https://rpc.linea.build', spokePool: '0x7E63A5f1a8F0B4d0934B2f2327DAED3F6bb2ee75', mathHelper: '0xEdE97D044d4C8aAA682968bee10284521B9f311a' },
  130: { name: 'Unichain', rpc: 'https://mainnet.unichain.org', spokePool: '0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64', mathHelper: '0xEdE97D044d4C8aAA682968bee10284521B9f311a' },
  4663: { name: 'Robinhood Chain', rpc: 'https://rpc.mainnet.chain.robinhood.com', spokePool: '0xD29C85F15DF544bA632C9E25829fd29d767d7978', mathHelper: '0xEdE97D044d4C8aAA682968bee10284521B9f311a' },
}

async function getCode(rpc, address) {
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'ophis-across-source-preflight' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [address, 'latest'] }),
  })
  if (!res.ok) throw new Error(`RPC ${res.status}`)
  const json = await res.json()
  if (json.error) throw new Error(json.error.message)
  return json.result
}

async function checkChain(chainId) {
  const chain = PER_CHAIN[chainId]
  if (!chain) return { chainId, ok: false, lines: [`  chain ${chainId}: NOT in the preflight table — add its deps before enabling (fail closed)`] }

  const deps = {
    ...CHAIN_INDEPENDENT,
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
      lines.push(`  ${chain.name} ${label} ${address}: RPC ERROR (${e.message}) — treat as MISSING`)
      ok = false
      continue
    }
    lines.push(`  ${chain.name} ${label} ${address}: ${has ? 'ok' : 'MISSING (no code)'}`)
    if (!has) ok = false
  }
  return { chainId, ok, lines }
}

const chainIds = process.argv.slice(2).map(Number).filter((n) => Number.isInteger(n))
if (chainIds.length === 0) {
  console.error('usage: across-source-preflight.mjs <chainId> [chainId ...]')
  process.exit(2)
}

const results = await Promise.all(chainIds.map(checkChain))
let allOk = true
for (const r of results) {
  console.log(`\nchain ${r.chainId}: ${r.ok ? 'PASS' : 'FAIL'}`)
  r.lines.forEach((l) => console.log(l))
  if (!r.ok) allOk = false
}
console.log(`\n${allOk ? 'PREFLIGHT PASS — every dependency has code on every chain.' : 'PREFLIGHT FAIL — do NOT enable these chains as Across sources.'}`)
process.exit(allOk ? 0 : 1)
