import { fetchPathViz, PATH_VIZ_CHAIN_ID } from './fetchPathViz'

const ORDER_UID = '0x' + '01'.repeat(56)
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'

const okResponse = (body: string): Response =>
  ({ ok: true, text: async () => body }) as unknown as Response

describe('fetchPathViz', () => {
  it('returns null off Optimism without touching the network', async () => {
    const fetchImpl = jest.fn()
    const result = await fetchPathViz({ orderUid: ORDER_UID, chainId: 1, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(result).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('base64-encodes the SVG on Optimism', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(okResponse(SVG))
    const result = await fetchPathViz({
      orderUid: ORDER_UID,
      chainId: PATH_VIZ_CHAIN_ID,
      baseUrl: 'https://example.test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result).not.toBeNull()
    expect(atob(result as string)).toBe(SVG)
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://example.test/api/v1/orders/${ORDER_UID}/pathviz.svg`,
      expect.objectContaining({ headers: { accept: 'image/svg+xml' } }),
    )
  })

  it('returns null on a non-ok response', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false } as Response)
    const result = await fetchPathViz({ orderUid: ORDER_UID, chainId: 10, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(result).toBeNull()
  })

  it('returns null when the body is not an SVG', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(okResponse('not svg'))
    const result = await fetchPathViz({ orderUid: ORDER_UID, chainId: 10, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(result).toBeNull()
  })

  it('swallows network errors (best-effort, never throws)', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('offline'))
    await expect(
      fetchPathViz({ orderUid: ORDER_UID, chainId: 10, fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toBeNull()
  })
})
