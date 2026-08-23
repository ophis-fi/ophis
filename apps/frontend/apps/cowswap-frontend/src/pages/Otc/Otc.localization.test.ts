import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const LOCALES_DIRECTORY = join(__dirname, '../../locales')
const OTC_SOURCE_REFERENCE = 'apps/cowswap-frontend/src/pages/Otc/'

type OtcTestLocale = 'en-US' | 'es-ES' | 'ru-RU'

function readCatalog(locale: OtcTestLocale): string {
  return readFileSync(join(LOCALES_DIRECTORY, `${locale}.po`), 'utf8')
}

function catalogEntries(catalog: string): string[] {
  return catalog.split(/\n{2,}/)
}

function messageId(entry: string): string | null {
  return entry.match(/(?:^|\n)msgid "(.+)"(?:\n|$)/)?.[1] ?? null
}

function messageTranslation(entry: string): string | null {
  return entry.match(/(?:^|\n)msgstr "(.+)"(?:\n|$)/)?.[1] ?? null
}

function placeholders(message: string): string[] {
  return [...message.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].flatMap((match) => (match[1] ? [match[1]] : [])).sort()
}

function otcMessageIds(): string[] {
  return catalogEntries(readCatalog('en-US'))
    .filter((entry) => entry.includes(OTC_SOURCE_REFERENCE))
    .map(messageId)
    .filter((id): id is string => id !== null)
}

function untranslatedOtcMessageIds(locale: 'es-ES' | 'ru-RU'): string[] {
  const entriesById = new Map(
    catalogEntries(readCatalog(locale))
      .map((entry) => [messageId(entry), entry] as const)
      .filter((entry): entry is readonly [string, string] => entry[0] !== null),
  )
  return otcMessageIds().filter((id) => {
    const localizedEntry = entriesById.get(id)
    return !localizedEntry || /(?:^|\n)msgstr ""(?:\n|$)/.test(localizedEntry)
  })
}

function mismatchedOtcPlaceholders(locale: 'es-ES' | 'ru-RU'): string[] {
  const entriesById = new Map(
    catalogEntries(readCatalog(locale))
      .map((entry) => [messageId(entry), entry] as const)
      .filter((entry): entry is readonly [string, string] => entry[0] !== null),
  )
  return otcMessageIds().filter((id) => {
    const translation = messageTranslation(entriesById.get(id) ?? '')
    return translation !== null && placeholders(id).join() !== placeholders(translation).join()
  })
}

describe('OTC localization catalogs', () => {
  it.each(['es-ES', 'ru-RU'] as const)('translates every enabled OTC read-surface message in %s', (locale) => {
    expect(otcMessageIds().length).toBeGreaterThan(0)
    expect(untranslatedOtcMessageIds(locale)).toEqual([])
    expect(mismatchedOtcPlaceholders(locale)).toEqual([])
  })

  it('contains representative Spanish and Russian browse/detail translations', () => {
    expect(readCatalog('es-ES')).toContain('msgstr "Órdenes entre pares a precio fijo."')
    expect(readCatalog('ru-RU')).toContain('msgstr "Ордер недоступен"')
  })
})
