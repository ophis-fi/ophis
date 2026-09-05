import { readdirSync, readFileSync } from 'fs'
import { basename, join } from 'path'

const WRITE_DIR = __dirname
const WRITE_FORBIDDEN_FRAGMENTS = [
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
]
const SIGNER_API_PATTERN =
  /\b(useWriteContract|useSendTransaction|useSendTransactionSync|useSendCalls|useDeployContract|useSignMessage|useSignTypedData|useConnectorClient|useWalletClient|getWalletClient|walletClient|walletActions|writeContract|sendTransaction|sendRawTransaction|sendCalls|deployContract|signTransaction|signTypedData|signMessage|prepareTransactionRequest|requestAddresses|watchAsset)\b|import\(/g
const WRITE_SIGNER_APIS = new Map<string, ReadonlySet<string>>([
  ['OtcOrderActionPanel.container.tsx', new Set(['useWalletClient', 'walletClient'])],
  ['otcWrite.types.ts', new Set(['sendTransaction'])],
  ['otcWriteAdapters.ts', new Set(['sendTransaction', 'walletClient'])],
  ['prepareOtcTransaction.ts', new Set(['sendTransaction'])],
  ['useOtcActionController.ts', new Set(['useWalletClient', 'walletClient'])],
  ['useOtcNetworkReads.ts', new Set(['walletClient'])],
])
const WRITE_WAGMI_IMPORTS = new Map<string, ReadonlySet<string>>([
  ['OtcOrderActionPanel.container.tsx', new Set(['useWalletClient'])],
  ['otcWriteAdapters.ts', new Set(['usePublicClient'])],
  ['useOtcActionController.ts', new Set(['useWalletClient'])],
])
const WRITE_TOKEN_POLICY_FILES = new Set([
  'assertOtcTransactionRequest.ts',
  'buildOtcTransaction.ts',
  'readOtcAllowance.ts',
])
const WRITE_TOKEN_POLICY_IMPORTS = new Set(['assertTradeTokenPolicy', 'TokenPolicyProfile'])
const WRITE_WALLET_PROVIDER_FILES = new Set(['useOtcNetworkReads.ts'])
const WRITE_WALLET_PROVIDER_IMPORTS = new Set(['useWalletProvider'])

interface ProductionSource {
  file: string
  source: string
}

function productionSources(directory: string): ProductionSource[] {
  const sources: ProductionSource[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) sources.push(...productionSources(path))
    else if ((entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) && !entry.name.includes('.test.')) {
      sources.push({ file: path, source: readFileSync(path, 'utf8') })
    }
  }
  return sources
}

function productionImports(): string[] {
  const importPattern = /from\s+['"]([^'"]+)['"]/g
  return productionSources(WRITE_DIR).flatMap(({ source }) =>
    Array.from(source.matchAll(importPattern), (match) => match[1] ?? ''),
  )
}

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
    .filter(Boolean)
}

describe('Ophis OTC write boundary', () => {
  it('imports no trading, permit, signing, or solver internals', () => {
    const imports = productionImports()
    for (const fragment of WRITE_FORBIDDEN_FRAGMENTS) {
      expect(imports.filter((value) => value.includes(fragment))).toEqual([])
    }
  })

  it('isolates signer-capable APIs and wagmi imports to reviewed adapters', () => {
    for (const { file, source } of productionSources(WRITE_DIR)) {
      const fileName = basename(file)
      const allowedApis = WRITE_SIGNER_APIS.get(fileName) ?? new Set<string>()
      for (const api of new Set(source.match(SIGNER_API_PATTERN) ?? [])) {
        expect(allowedApis.has(api) ? null : `${file}: ${api}`).toBeNull()
      }
      const allowedImports = WRITE_WAGMI_IMPORTS.get(fileName) ?? new Set<string>()
      for (const name of namedImportsFrom(source, 'wagmi')) {
        expect(allowedImports.has(name) ? null : `${file}: ${name}`).toBeNull()
      }
    }
  })

  it('keeps one reviewed production caller of each wallet-submission layer', () => {
    const sources = productionSources(WRITE_DIR)
    const directSenderCounts = Object.fromEntries(
      sources
        .map(({ file, source }) => [basename(file), source.match(/\.sendTransaction\s*\(/g)?.length ?? 0] as const)
        .filter(([, count]) => count > 0),
    )
    expect(directSenderCounts).toEqual({ 'otcWriteAdapters.ts': 2, 'prepareOtcTransaction.ts': 1 })
    const submissionCallerCounts = Object.fromEntries(
      sources
        .map(({ file, source }) => [basename(file), source.match(/\bsubmitOtcTransaction\s*\(/g)?.length ?? 0] as const)
        .filter(([, count]) => count > 0),
    )
    expect(submissionCallerCounts).toEqual({ 'prepareOtcTransaction.ts': 1, 'useOtcSubmitCallback.ts': 1 })
  })

  it('sources rendered action terms from the active wallet-fork reader', () => {
    const source = readFileSync(join(WRITE_DIR, 'OtcOrderActionPanel.container.tsx'), 'utf8')
    expect(source).toContain('readOtcOrder(network.writeClient, orderId)')
    expect(source).toMatch(
      /queryKey:\s*\[\s*'ophis-otc-fork-order',\s*network\.transportId,\s*network\.localForkResponse\.data,\s*account,\s*orderId\.toString\(\),\s*mountId,?\s*\]/,
    )
    expect(source).toContain('refetchInterval: ORDER_REFRESH_INTERVAL_MS')
    expect(source).toContain('forkOrderQuery.error !== null')
    expect(source).toContain('void refetchForkOrder()')
  })

  it('starts the selected create-token allowance read before draft amounts become valid', () => {
    const source = readFileSync(join(WRITE_DIR, 'OtcCreatePanel.container.tsx'), 'utf8')
    expect(source).toContain('allowanceToken: tokenA.address')
    expect(source).not.toContain('allowanceToken: draft?.tokenA ?? null')
  })

  it('allows only the token-policy assertion API at write sinks', () => {
    for (const { file, source } of productionSources(WRITE_DIR)) {
      const fileName = basename(file)
      const names = namedImportsFrom(source, '@cowprotocol/tokens')
      if (names.length > 0) expect(WRITE_TOKEN_POLICY_FILES.has(fileName)).toBe(true)
      for (const name of names) expect(WRITE_TOKEN_POLICY_IMPORTS.has(name) ? null : `${file}: ${name}`).toBeNull()
    }
  })

  it('allows only the host wallet-provider hook at the compatibility boundary', () => {
    for (const { file, source } of productionSources(WRITE_DIR)) {
      const fileName = basename(file)
      const names = namedImportsFrom(source, '@cowprotocol/wallet-provider')
      if (names.length > 0) expect(WRITE_WALLET_PROVIDER_FILES.has(fileName)).toBe(true)
      for (const name of names) expect(WRITE_WALLET_PROVIDER_IMPORTS.has(name) ? null : `${file}: ${name}`).toBeNull()
    }
  })
})
