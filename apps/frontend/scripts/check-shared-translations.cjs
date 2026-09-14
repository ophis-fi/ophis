// Run from apps/frontend: node scripts/check-shared-translations.cjs
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const { resolve } = require('node:path')
const { setupI18n } = createRequire(resolve(__dirname, '../apps/cowswap-frontend/package.json'))('@lingui/core')
const { getCatalogs, createCompiledCatalog } = require('@lingui/cli/api')
const { getConfig } = createRequire(require.resolve('@lingui/cli'))('@lingui/conf')

async function check() {
  const config = await getConfig({ cwd: resolve(__dirname, '..') })
  const [catalog] = await getCatalogs(config)
  assert.ok(catalog.sourcePaths.some((path) => path.endsWith('/libs/common-const/src/common.ts')))
  const entries = await catalog.read('en-US')
  const translations = Object.fromEntries(Object.entries(entries).map(([id, entry]) => [id, entry.translation]))
  const { source, errors } = createCompiledCatalog('en-US', translations, { namespace: 'json' })
  assert.deepEqual(errors, [])
  const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': JSON.parse(source).messages } })
  assert.equal(i18n._('MNcnd5'), 'Account Proxy')
  console.log('Shared message extraction and compiled Account Proxy label passed.')
}

check().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
