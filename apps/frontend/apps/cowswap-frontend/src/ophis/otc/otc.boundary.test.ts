import { getAddress, toFunctionSelector, type AbiFunction } from 'viem'

import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

import { OTC_EVENT_ABI, OTC_READ_ABI } from './otc.abi'
import { OPHIS_ETHEREUM_OTC_MANIFEST, OTC_ERC20_WRITE_SELECTORS, OTC_KNOWN_WRITE_SELECTORS } from './otc.const'

// Matched against module SPECIFIERS (the string after `from`) of production
// files. Named exports do not appear in specifiers, so entries must be
// package/path fragments — e.g. the signer-capable provider lib is
// '@cowprotocol/wallet-provider', matched by 'wallet-provider'.
const SHARED_FORBIDDEN_FRAGMENTS = [
  'modules/trade',
  'modules/swap',
  'modules/tokensList',
  'modules/limitOrders',
  'modules/twap',
  'modules/ethFlow',
  'tradeFlow',
  'allowance',
  'permit',
  'solver',
  'signing',
  'wallet-provider',
  'legacy/state',
  // Token-activation machinery: production OTC code renders only its own
  // curated metadata. (The policy drift-binding test imports this from a
  // test file, which the production scan below excludes.)
  '@cowprotocol/tokens',
  'boostedTokens',
]

// The read adapter must not touch the wallet at all. The page family may read
// the connected account, but signer access remains isolated in otcWrite.
const MODULE_FORBIDDEN_FRAGMENTS = [...SHARED_FORBIDDEN_FRAGMENTS, '@cowprotocol/wallet']
const PAGES_FORBIDDEN_FRAGMENTS = SHARED_FORBIDDEN_FRAGMENTS
const PAGES_DIR = join(__dirname, '..', '..', 'pages', 'Otc')

// Signer-capable APIs from otherwise-allowed packages (e.g. wagmi exports
// both usePublicClient and useWriteContract), plus dynamic import() which
// would evade the specifier scan entirely.
const SIGNER_API_PATTERN =
  /\b(useWriteContract|useSendTransaction|useSendTransactionSync|useSendCalls|useDeployContract|useSignMessage|useSignTypedData|useConnectorClient|useWalletClient|getWalletClient|walletClient|walletActions|writeContract|sendTransaction|sendRawTransaction|sendCalls|deployContract|signTransaction|signTypedData|signMessage|prepareTransactionRequest|requestAddresses|watchAsset)\b|import\(/g

// Denylists are inherently incomplete against a large package surface, so
// wagmi — the one signer-capable package production OTC code may touch —
// is additionally held to an ALLOWLIST: only these named imports may appear.
const WAGMI_ALLOWED_IMPORTS = new Set(['usePublicClient'])
const PAGE_WRITE_ALLOWED_IMPORTS = new Set([
  'OtcCreatePanel',
  'OtcOrderActionPanel',
  'isReviewedOtcOrder',
  'resolveOtcWriteAuthorization',
  'resolveOtcWriteFlag',
  'shouldMountOtcOrderAction',
  'useOtcWriteAuthorization',
])
function namedImportsFrom(source: string, specifier: string): string[] {
  const pattern = new RegExp(`import\\s*(?:type\\s*)?{([^}]*)}\\s*from\\s*['"]${specifier}['"]`, 'g')
  return Array.from(source.matchAll(pattern), (match) => match[1])
    .flatMap((group) => group.split(','))
    .map((name) =>
      name
        .replace(/\btype\b/, '')
        .trim()
        .split(/\s+as\s+/)[0]
        .trim(),
    )
    .filter((name) => name.length > 0)
}

interface ProductionSource {
  file: string
  source: string
}

function signerApisFrom(source: string): string[] {
  return source.match(SIGNER_API_PATTERN) ?? []
}

/** Recursive: a write path hidden in a nested directory must not escape the scan. */
function productionSources(directory: string): ProductionSource[] {
  const entries = readdirSync(directory, { withFileTypes: true })
  const sources: ProductionSource[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      sources.push(...productionSources(path))
    } else if ((entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) && !entry.name.includes('.test.')) {
      sources.push({ file: path, source: readFileSync(path, 'utf8') })
    }
  }
  return sources
}

function productionImports(directory: string): string[] {
  const sources = productionSources(directory)
  expect(sources.length).toBeGreaterThan(0)
  const importPattern = /from\s+['"]([^'"]+)['"]/g
  return sources.flatMap(({ source }) => Array.from(source.matchAll(importPattern), (match) => match[1] ?? ''))
}

// Independently pinned facts (verified 2026-08-19 via publicnode, drpc, and
// Sourcify exact_match). A drift here is a manifest edit that must not pass.
const PINNED_CONTRACT = '0x000000fF3D7A2d373615141d7489Ca66683DbecF'
const PINNED_RUNTIME_CODE_HASH = '0x8d9ad2a9d3b3d47aaa832ecc21de8775509764409ab07cdf097640396d10eda1'
const PINNED_WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const PINNED_DEPLOYMENT_BLOCK = 24_622_661n

describe('Ophis OTC boundary', () => {
  it('adapter module imports no trading, token-activation, allowance, signing, wallet, or solver modules', () => {
    const imports = productionImports(__dirname)
    for (const fragment of MODULE_FORBIDDEN_FRAGMENTS) {
      expect(imports.filter((value) => value.includes(fragment))).toEqual([])
    }
  })

  it('page surface imports no trading, allowance, signing, or solver modules', () => {
    const imports = productionImports(PAGES_DIR)
    for (const fragment of PAGES_FORBIDDEN_FRAGMENTS) {
      expect(imports.filter((value) => value.includes(fragment))).toEqual([])
    }
  })

  it('keeps touched OTC reads on Jotai Query instead of SWR', () => {
    for (const directory of [__dirname, PAGES_DIR]) {
      expect(productionImports(directory).filter((value) => value === 'swr')).toEqual([])
    }
  })

  it('references no signer-capable API and no dynamic import in any production source', () => {
    for (const directory of [__dirname, PAGES_DIR]) {
      for (const { file, source } of productionSources(directory)) {
        const matches = signerApisFrom(source)
        expect(matches.length > 0 ? `${file}: ${matches.join(', ')}` : null).toBeNull()
      }
    }
  })

  it('imports nothing from wagmi outside the read-only allowlist', () => {
    for (const directory of [__dirname, PAGES_DIR]) {
      for (const { file, source } of productionSources(directory)) {
        for (const name of namedImportsFrom(source, 'wagmi')) {
          expect(WAGMI_ALLOWED_IMPORTS.has(name) ? null : `${file}: ${name}`).toBeNull()
        }
      }
    }
  })

  it('lets pages reach only the guarded write surface and authorization boundary', () => {
    for (const { file, source } of productionSources(PAGES_DIR)) {
      for (const name of namedImportsFrom(source, 'ophis/otcWrite')) {
        expect(PAGE_WRITE_ALLOWED_IMPORTS.has(name) ? null : `${file}: ${name}`).toBeNull()
      }
    }
  })

  it('exposes only view functions in the read ABI', () => {
    const functions = OTC_READ_ABI.filter((entry): entry is AbiFunction => entry.type === 'function')
    expect(functions.length).toBeGreaterThan(0)
    for (const fn of functions) {
      expect(fn.stateMutability).toBe('view')
    }
  })

  it('cannot encode any known write selector from the read ABI', () => {
    expect(OTC_KNOWN_WRITE_SELECTORS).toHaveLength(7)
    const readSelectors = OTC_READ_ABI.filter((entry): entry is AbiFunction => entry.type === 'function').map((fn) =>
      toFunctionSelector(fn),
    )
    for (const selector of readSelectors) {
      expect(OTC_KNOWN_WRITE_SELECTORS).not.toContain(selector)
    }
  })

  it('computes the exact read selectors present in the deployed dispatcher', () => {
    const selectorByName = Object.fromEntries(
      OTC_READ_ABI.filter((entry): entry is AbiFunction => entry.type === 'function').map((fn) => [
        fn.name,
        toFunctionSelector(fn),
      ]),
    )
    // Verified against the deployed bytecode dispatcher on 2026-08-19.
    expect(selectorByName).toEqual({
      getOrder: '0xd09ef241',
      getOrders: '0x03652027',
      canFill: '0xfb4ca3b6',
      weth: '0x3fc8cef3',
      nextOrderId: '0x2a58b330',
    })
  })

  it('enables exactly the three ERC-20 selectors for Milestone C', () => {
    expect(OPHIS_ETHEREUM_OTC_MANIFEST.enabledTransactionSelectors).toEqual(OTC_ERC20_WRITE_SELECTORS)
    expect(OPHIS_ETHEREUM_OTC_MANIFEST.enabledTransactionSelectors).toEqual(['0xfc05ca31', '0xc37dfc5b', '0x514fcac7'])
    expect(OPHIS_ETHEREUM_OTC_MANIFEST.enabledTransactionSelectors).not.toContain('0x97bfdd2f')
    expect(OPHIS_ETHEREUM_OTC_MANIFEST.enabledTransactionSelectors).not.toContain('0x9fe63676')
    expect(OPHIS_ETHEREUM_OTC_MANIFEST.enabledTransactionSelectors).not.toContain('0x21dd76f9')
    expect(OPHIS_ETHEREUM_OTC_MANIFEST.enabledTransactionSelectors).not.toContain('0xb50430d8')
  })

  it('pins the independently verified contract identity', () => {
    const manifest = OPHIS_ETHEREUM_OTC_MANIFEST
    expect(manifest.chainId).toBe(1)
    expect(manifest.contract.address).toBe(PINNED_CONTRACT)
    expect(getAddress(manifest.contract.address)).toBe(PINNED_CONTRACT)
    expect(manifest.contract.runtimeCodeHash).toBe(PINNED_RUNTIME_CODE_HASH)
    expect(manifest.wethAddress).toBe(PINNED_WETH)
    expect(getAddress(manifest.wethAddress)).toBe(PINNED_WETH)
    expect(manifest.deploymentBlock).toBe(PINNED_DEPLOYMENT_BLOCK)
  })

  it('declares only order lifecycle events', () => {
    const eventNames = OTC_EVENT_ABI.map((entry) => entry.name)
    expect(eventNames).toEqual(['OrderCreated', 'OrderFilled', 'OrderCanceled'])
    for (const entry of OTC_EVENT_ABI) {
      expect(entry.type).toBe('event')
    }
  })
})
