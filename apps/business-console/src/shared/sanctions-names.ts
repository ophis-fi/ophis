export type ListedName = [list: string, reference: string, name: string]
export type ListHashes = Record<string, string>
export interface NameReport {
  checkedAt: number
  names: string[]
  signatory: string | null
  lists: ListHashes | null
  updatedAt: number | null
  matches: { subject: string; entries: ListedName[] }[]
  status: 'clear' | 'review' | 'incomplete'
  problem: string | null
  revision: string
}

export function nameKeys(name: string): string[] {
  const folded = name.normalize('NFKD').toLowerCase().replace(/\p{M}/gu, '').replace(/ß/g, 'ss')
    .replace(/[.'’]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  if (!folded) return []
  const words = folded.split(' ')
  const key = [...words].sort().join(' ')
  // Company registers often omit the legal suffix, or punctuate it differently.
  if (words.length > 1 && /^(?:sa|sarl|ltd|limited|llc|plc|inc|gmbh|corp|corporation)$/.test(words.at(-1)!)) {
    return [key, words.slice(0, -1).sort().join(' ')]
  }
  return [key]
}

export function shardOf(key: string) {
  let hash = 5381
  for (let i = 0; i < key.length; i++) hash = (Math.imul(hash, 33) ^ key.charCodeAt(i)) >>> 0
  return (hash % 128).toString()
}
