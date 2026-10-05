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

it('preserves the external-funding form and selector sizing', () => {
  expect(isAssetSwapLayout({ isMarketOrderWidget: true, externalFunding: true }, { currencyFields })).toBe(false)
})

it('preserves forms with content between their amount fields', () => {
  expect(
    isAssetSwapLayout({ isMarketOrderWidget: true }, { currencyFields, middleContent: 'Custom trade controls' }),
  ).toBe(false)
})
