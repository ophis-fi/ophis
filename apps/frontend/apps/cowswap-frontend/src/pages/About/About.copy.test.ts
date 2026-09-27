import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const copy = readFileSync(join(__dirname, 'index.tsx'), 'utf8').replace(/\s+/g, ' ')

describe('About page execution and security copy', () => {
  it('distinguishes app coverage, bridge availability, and scoped security reviews', () => {
    expect(copy).toContain('supports 14 EVM networks')
    expect(copy).toContain('not automatically a supported bridge source')
    expect(copy).toContain('Source settlement does not prove destination delivery')
    expect(copy).toContain('not an absolute MEV guarantee')
    expect(copy).toContain('Native-token deposits require an onchain refund')
    expect(copy).toContain('Soft cancellation can race an in-flight settlement')
    expect(copy).toContain('not every Ophis modification, deployment, or external route')
    expect(copy).toContain('Arc is currently app-only')
    expect(copy).not.toMatch(/any EVM chain|same bytecode|>Inherited<|>Clean<|No front-running, no sandwich/)
  })
})
