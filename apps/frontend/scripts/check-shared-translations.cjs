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
  for (const locale of config.locales.filter((locale) => locale !== config.pseudoLocale)) {
    const entries = await catalog.read(locale)
    assert.ok(entries.MNcnd5, `${locale}: Account Proxy message has not been extracted`)
    const { messages: translations } = await catalog.getTranslations(locale, config)
    const { source, errors } = createCompiledCatalog(locale, translations, { namespace: 'json' })
    assert.deepEqual(errors, [])
    const i18n = setupI18n({ locale, messages: { [locale]: JSON.parse(source).messages } })
    const label = i18n._('MNcnd5')
    assert.notEqual(label, 'MNcnd5', `${locale}: Account Proxy message is missing`)
    assert.ok(label.trim(), `${locale}: Account Proxy message is empty`)
    if (locale === config.sourceLocale) assert.equal(label, 'Account Proxy')
    for (const message of ['Unknown solver', 'Solver identity unavailable ({solverId}).']) {
      const id = Object.keys(entries).find((id) => entries[id].message === message)
      assert.ok(id && entries[id].translation, `${locale}: untranslated solver fallback: ${message}`)
      const translated = i18n._(id, { solverId: 'unregistered' })
      assert.equal(translated, entries[id].translation.replace('{solverId}', 'unregistered'))
      if (locale !== config.sourceLocale) assert.notEqual(translated, message.replace('{solverId}', 'unregistered'))
    }
    console.log(`${locale}: compiled Account Proxy and solver fallback labels passed.`)
  }
}

check().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
