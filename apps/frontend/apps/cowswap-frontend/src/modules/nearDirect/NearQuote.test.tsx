import { ButtonPrimary, baseTheme } from '@cowprotocol/ui'

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render, screen } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ServerStyleSheet, ThemeProvider } from 'styled-components/macro'

import { writeFileSync } from 'node:fs'

import fixture from './fixtures/monadDeposit.json'
import { nearTransferSchema } from './nearDirect.schemas'
import { Stack } from './nearDirect.styled'
import { NearQuote } from './NearQuote.pure'

jest.mock('modules/bridge', () => jest.requireActual('../bridge/pure/TokenAmountDisplay'))
jest.mock('@cowprotocol/tokens', () => ({ TokenLogo: () => <span aria-hidden>●</span> }))

const refundTo = '0x03eb86302fdee6226716d4689b0d2fd1618f34b46453b37559f2765f03d33d1f'
const transfer = nearTransferSchema.parse({
  ...fixture,
  source: {
    ...fixture.source,
    blockchain: 'starknet',
    assetId: 'nep141:starknet.omft.near',
    symbol: 'STRK',
    decimals: 18,
    contractAddress: undefined,
  },
  destination: { ...fixture.destination, blockchain: 'base' },
  response: {
    ...fixture.response,
    quoteRequest: { ...fixture.response.quoteRequest, refundTo },
    quote: {
      ...fixture.response.quote,
      amountIn: '90000000000000000000',
      amountInUsd: '4.04',
      amountOut: '4041600',
      amountOutUsd: '4.0416',
      minAmountOut: '4001219',
      refundFee: '834909845136565295',
      withdrawFee: '2400',
    },
  },
})

it('keeps token blocks outside paragraphs and preserves the complete Starknet refund address', () => {
  const view = (
    <I18nProvider i18n={i18n}>
      <ThemeProvider theme={baseTheme('light')}>
        <Stack>
          <NearQuote transfer={transfer} />
          <ButtonPrimary>Confirm swap</ButtonPrimary>
        </Stack>
      </ThemeProvider>
    </I18nProvider>
  )
  const { container } = render(view)
  expect(container.querySelector('p div')).toBeNull()
  expect(screen.getByText(refundTo).textContent).toBe(refundTo)
  expect(screen.getByText('Send on Starknet')).toBeTruthy()
  expect(screen.getByText('Receive on Base (estimated)')).toBeTruthy()
  // Optional browser artifact uses the actual component and generated CSS.
  if (process.env.OPHIS_QUOTE_LAYOUT_HTML) {
    const sheet = new ServerStyleSheet()
    try {
      const html = renderToStaticMarkup(sheet.collectStyles(view))
      writeFileSync(
        process.env.OPHIS_QUOTE_LAYOUT_HTML,
        `<html><head><meta name="viewport" content="width=device-width,initial-scale=1">${sheet.getStyleTags()}<style>*{box-sizing:border-box}body{margin:0;padding:16px;font:16px Arial}main{width:100%;max-width:480px;margin:auto;padding:16px;border:1px solid #ddd;border-radius:24px}</style></head><body><main>${html}</main></body></html>`,
      )
    } finally {
      sheet.seal()
    }
  }
})
