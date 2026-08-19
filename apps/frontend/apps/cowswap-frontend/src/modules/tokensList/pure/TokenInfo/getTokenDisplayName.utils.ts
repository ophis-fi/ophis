import { TokenizedAssetProviderTag } from '../../types'

const ONDO_SUFFIXES = [/\s*\(Ondo Tokenized(?: Stock)?\)\s*$/i, /\s+Ondo Tokenized(?: Stock)?\s*$/i] as const
const XSTOCKS_SUFFIXES = [/\s+xStock\s*$/i, /\s+Tokenized by xStocks\s*$/i] as const

function stripSuffixes(name: string, suffixes: readonly RegExp[]): string {
  return suffixes.reduce((displayName, suffix) => displayName.replace(suffix, ''), name).trim()
}

export function getTokenDisplayName(
  name: string | undefined,
  tokenizedAssetProvider: TokenizedAssetProviderTag | undefined,
): string {
  if (!name) return ''

  if (tokenizedAssetProvider === 'ondo') return stripSuffixes(name, ONDO_SUFFIXES)
  if (tokenizedAssetProvider === 'xStocks') return stripSuffixes(name, XSTOCKS_SUFFIXES)

  return name
}
