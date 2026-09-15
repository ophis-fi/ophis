import { setupI18n, type Messages } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render, screen } from '@testing-library/react'

import { execFileSync } from 'child_process'
import { join } from 'path'

import { OtcWriteNotice } from './OtcWriteNotice.pure'

jest.mock('./otcCanary.const', () => {
  const { USDC_MAINNET, WETH_MAINNET } =
    jest.requireActual<typeof import('@cowprotocol/common-const')>('@cowprotocol/common-const')
  return {
    OTC_CANARY_POLICY: {
      expiresAt: 0n,
      pairs: [
        {
          tokenA: WETH_MAINNET.address,
          tokenB: USDC_MAINNET.address,
          maxAmountA: 10n ** 18n,
          maxAmountB: 2_000_000_000n,
        },
      ],
    },
  }
})

const originalMode = process.env.REACT_APP_OTC_WRITE_MODE
afterEach(() => {
  if (originalMode === undefined) delete process.env.REACT_APP_OTC_WRITE_MODE
  else process.env.REACT_APP_OTC_WRITE_MODE = originalMode
})

it.each([
  [
    'es-ES',
    'activos reales de Ethereum',
    'Máximo por orden:',
    'siguen activas',
    'No limitan tu exposición total',
    'fork local de Ethereum',
  ],
  [
    'ru-RU',
    'реальные активы Ethereum',
    'Максимум на ордер:',
    'остаются активными',
    'не ограничивают общий объём',
    'локальный форк Ethereum',
  ],
])(
  'renders the actual %s safety catalog and interpolates limits and expiry',
  async (locale, assets, maximum, orders, limits, fork) => {
    // Lingui's PO loader uses native imports; compile in Node outside Jest's VM.
    const source = execFileSync(
      process.execPath,
      [
        '-e',
        `
      const {getFormat, createCompiledCatalog} = require(process.argv[1]);
      (async () => {
        const format = await getFormat('po', {}, 'en-US');
        const catalog = await format.read(process.argv[2], process.argv[3]);
        if (!catalog) throw new Error('Translation catalog unavailable');
        const messages = Object.fromEntries(Object.entries(catalog).map(([id, entry]) => [id, entry.translation]));
        const compiled = createCompiledCatalog(process.argv[3], messages, {namespace: 'json', strict: true});
        if (compiled.errors.length) throw new Error('Translation compilation failed');
        process.stdout.write(compiled.source);
      })().catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });
    `,
        require.resolve('@lingui/cli/api'),
        join(__dirname, '../../locales', `${locale}.po`),
        locale,
      ],
      { encoding: 'utf8' },
    )
    const parsed: { messages: Messages } = JSON.parse(source)
    const i18n = setupI18n({ locale, messages: { [locale]: parsed.messages } })
    process.env.REACT_APP_OTC_WRITE_MODE = 'canary'
    const { rerender } = render(
      <I18nProvider i18n={i18n}>
        <OtcWriteNotice />
      </I18nProvider>,
    )
    expect(screen.getByText(new RegExp(assets))).toBeTruthy()
    expect(screen.getByText(new RegExp(orders)).textContent).toContain('1970-01-01T00:00:00.000Z')
    expect(screen.getByText(new RegExp(limits))).toBeTruthy()
    expect(screen.getByRole('listitem').textContent).toContain(maximum)
    expect(screen.getByRole('listitem').textContent).toMatch(/1 WETH.+2000 USDC/)
    process.env.REACT_APP_OTC_WRITE_MODE = 'fork'
    rerender(
      <I18nProvider i18n={i18n}>
        <OtcWriteNotice />
      </I18nProvider>,
    )
    expect(screen.getByText(new RegExp(fork))).toBeTruthy()
    expect(screen.queryByRole('listitem')).toBeNull()
    process.env.REACT_APP_OTC_WRITE_MODE = 'public'
    rerender(
      <I18nProvider i18n={i18n}>
        <OtcWriteNotice />
      </I18nProvider>,
    )
    expect(screen.getByText(new RegExp(assets))).toBeTruthy()
    expect(screen.queryByRole('listitem')).toBeNull()
    expect(screen.queryByText(/1970-01-01/)).toBeNull()
  },
)
