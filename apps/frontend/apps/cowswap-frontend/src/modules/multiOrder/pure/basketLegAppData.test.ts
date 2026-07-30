import { basketLegMarker, basketLegMarkers, buildBasketLegAppData } from './basketLegAppData'
import { BasketDraft, BasketLeg } from '../types'

const ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

const leg = (n: number): BasketLeg => ({
  sellToken: '0x000000000000000000000000000000000000000a',
  buyToken: '0x000000000000000000000000000000000000000b',
  sellAmount: 100n,
  sellIndex: 0,
  buyIndex: n - 1,
  leg: n,
  status: 'pending',
})

const draft = (n: number): BasketDraft => ({
  id: ID,
  owner: '0x1111111111111111111111111111111111111111',
  chainId: 10,
  validTo: 1_800_000_000,
  tier: 'stepped',
  legs: Array.from({ length: n }, (_v, i) => leg(i + 1)),
})

describe('basketLegMarker / basketLegMarkers', () => {
  it('builds the shared id, this leg index, and total legs', () => {
    const d = draft(3)
    expect(basketLegMarker(d, d.legs[1])).toEqual({ id: ID, leg: 2, legs: 3 })
  })

  it('gives each leg of the basket a distinct { id, leg, legs }', () => {
    const d = draft(3)
    expect(basketLegMarkers(d).map((m) => m.marker)).toEqual([
      { id: ID, leg: 1, legs: 3 },
      { id: ID, leg: 2, legs: 3 },
      { id: ID, leg: 3, legs: 3 },
    ])
  })

  it('throws on a malformed draft id', () => {
    const d = { ...draft(1), id: 'BAD' }
    expect(() => basketLegMarker(d, d.legs[0])).toThrow()
  })
})

describe('buildBasketLegAppData (marker reaches the built appData)', () => {
  it('a placed leg appData carries the correct metadata.ophisBasket { id, leg, legs }', async () => {
    const d = draft(3)
    // Stand-in for the real modules/appData buildAppData: echoes the params into
    // a doc whose metadata carries the merged ophisBasket, exactly as buildAppData
    // spreads `...(ophisBasket ? { ophisBasket } : {})` into metadata.
    const fakeBuild = async (params: { appCode: string; ophisBasket: unknown }) => ({
      doc: { appCode: params.appCode, metadata: { orderClass: { orderClass: 'market' }, ophisBasket: params.ophisBasket } },
      fullAppData: JSON.stringify({ ophisBasket: params.ophisBasket }),
      appDataKeccak256: '0xhash',
    })

    const base = { appCode: 'ophis', slippageBips: 50 }
    const legTwoAppData = await buildBasketLegAppData(fakeBuild, base, d, d.legs[1])
    // The submitted appData doc metadata carries this leg's basket marker.
    expect(legTwoAppData.doc.metadata.ophisBasket).toEqual({ id: ID, leg: 2, legs: 3 })

    // Every leg's built appData carries its own distinct marker.
    const all = await Promise.all(d.legs.map((l) => buildBasketLegAppData(fakeBuild, base, d, l)))
    expect(all.map((a) => a.doc.metadata.ophisBasket)).toEqual([
      { id: ID, leg: 1, legs: 3 },
      { id: ID, leg: 2, legs: 3 },
      { id: ID, leg: 3, legs: 3 },
    ])
  })
})
