import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

const FORBIDDEN_IMPORT_FRAGMENTS = [
  'boostedTokens',
  'modules/trade',
  'modules/swap',
  '@cowprotocol/tokens',
  'allowance',
  'permit',
  'solver',
]

describe('Ophis discovery boundary', () => {
  it('does not import token activation, trading, allowance, or solver modules', () => {
    const sourceFiles = readdirSync(__dirname).filter((file) => file.endsWith('.ts') || file.endsWith('.tsx'))
    const importPattern = /from\s+['"]([^'"]+)['"]/g
    const imports = sourceFiles.flatMap((file) => {
      const source = readFileSync(join(__dirname, file), 'utf8')
      return Array.from(source.matchAll(importPattern), (match) => match[1] ?? '')
    })

    for (const fragment of FORBIDDEN_IMPORT_FRAGMENTS) {
      expect(imports.filter((value) => value.includes(fragment))).toEqual([])
    }
  })
})
