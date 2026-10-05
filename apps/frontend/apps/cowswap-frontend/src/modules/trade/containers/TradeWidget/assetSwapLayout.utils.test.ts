import { isAssetSwapLayout } from './assetSwapLayout.utils'

it('uses the asset slabs for ordinary market swaps', () => {
  expect(isAssetSwapLayout({ isMarketOrderWidget: true }, undefined)).toBe(true)
})

it.each([undefined, false])('preserves the layout for other trade widgets (%s)', (isMarketOrderWidget) => {
  expect(isAssetSwapLayout({ isMarketOrderWidget }, undefined)).toBe(false)
})

it('preserves the external-funding form and selector sizing', () => {
  expect(isAssetSwapLayout({ isMarketOrderWidget: true, externalFunding: true }, undefined)).toBe(false)
})

it('preserves forms with content between their amount fields', () => {
  expect(isAssetSwapLayout({ isMarketOrderWidget: true }, 'Custom trade controls')).toBe(false)
})
