import { isAssetSwapLayout } from './assetSwapLayout.utils'

const currencyFields = (): null => null

it('uses the supplied paired fields for ordinary market swaps', () => {
  expect(isAssetSwapLayout({ isMarketOrderWidget: true }, { currencyFields })).toBe(true)
})

it.each([undefined, false])('preserves the layout for other trade widgets (%s)', (isMarketOrderWidget) => {
  expect(isAssetSwapLayout({ isMarketOrderWidget }, { currencyFields })).toBe(false)
})

it('preserves the unlocked Yield widget, which shares the market presentation flag', () => {
  expect(isAssetSwapLayout({ isMarketOrderWidget: true }, {})).toBe(false)
})

it('uses the supplied paired fields for external-funding swaps', () => {
  expect(isAssetSwapLayout({ isMarketOrderWidget: true, externalFunding: true }, { currencyFields })).toBe(true)
})

it('preserves forms with content between their amount fields', () => {
  expect(
    isAssetSwapLayout({ isMarketOrderWidget: true }, { currencyFields, middleContent: 'Custom trade controls' }),
  ).toBe(false)
})
