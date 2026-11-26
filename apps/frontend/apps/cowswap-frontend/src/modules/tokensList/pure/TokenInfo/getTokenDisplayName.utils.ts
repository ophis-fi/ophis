import type { StockIssuer } from 'entities/verifiedAsset'

const ONDO_SUFFIXES = [/\s*\(Ondo Tokenized(?: Stock)?\)\s*$/i, /\s+Ondo Tokenized(?: Stock)?\s*$/i] as const
const XSTOCKS_SUFFIXES = [/\s+xStock\s*$/i, /\s+Tokenized by xStocks\s*$/i] as const

function stripSuffixes(name: string, suffixes: readonly RegExp[]): string {
  return suffixes.reduce((displayName, suffix) => displayName.replace(suffix, ''), name).trim()
}

export function getTokenDisplayName(name: string | undefined, tokenizedAssetProvider: StockIssuer | undefined): string {
  if (!name) return ''

  if (tokenizedAssetProvider === 'ondo' || tokenizedAssetProvider === 'bridgedOndo')
    return stripSuffixes(name, ONDO_SUFFIXES)
  if (tokenizedAssetProvider === 'xStocks' || tokenizedAssetProvider === 'wrappedXStocks')
    return stripSuffixes(name, XSTOCKS_SUFFIXES)

  if (tokenizedAssetProvider === 'bStocks') return stripSuffixes(name, [/\s+\(bStocks Tokenized (?:Stock|ETF)\)\s*$/i])
  if (tokenizedAssetProvider === 'reality')
    return stripSuffixes(name, [/\s+(?:Tokenized (?:Stock|ETF) )?\(Reality(?: Protocol)?\)\s*$/i, /\s+rStock\s*$/i])
  if (tokenizedAssetProvider === 'robinhood') return stripSuffixes(name, [/\s*[•·]\s*Robinhood Token\s*$/i])

  return name
}
