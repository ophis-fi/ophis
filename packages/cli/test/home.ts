import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.OPHIS_HOME = mkdtempSync(join(tmpdir(), 'ophis-test-'))
