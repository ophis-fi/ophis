import { render as rtlRender } from '@testing-library/react'
import { ThemeProvider } from 'styled-components/macro'

import { SettlementRoute } from './SettlementRoute.container'
import { parsePathVizResponse } from './types'
import { usePathVizGraph } from './usePathVizGraph'

jest.mock('./usePathVizGraph', () => ({
  usePathVizGraph: jest.fn(),
}))

// The lingui macro compiles Trans AND useLingui into the '@lingui/react'
// runtime; mocking the macro path intercepts neither.
jest.mock('@lingui/react', () => ({
  ...jest.requireActual('@lingui/react'),
  useLingui: () => ({
    i18n: {
      _: (d: { message?: string; id?: string } | string) => (typeof d === 'string' ? d : (d.message ?? d.id ?? '')),
    },
    _: (d: { message?: string; id?: string } | string) => (typeof d === 'string' ? d : (d.message ?? d.id ?? '')),
  }),
  Trans: ({ message, id }: { message?: string; id?: string }) => <>{message ?? id ?? ''}</>,
}))

const usePathVizGraphMock = usePathVizGraph as jest.MockedFunction<typeof usePathVizGraph>

const render = (ui: React.ReactElement): ReturnType<typeof rtlRender> =>
  rtlRender(<ThemeProvider theme={{ text1: '#fff' }}>{ui}</ThemeProvider>)

const UID = `0x${'ab'.repeat(56)}`
// btoa of a tiny valid SVG; content is irrelevant, the component never decodes it.
const SVG_B64 = 'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4='

const traded = (over: Record<string, unknown> = {}): ReturnType<typeof parsePathVizResponse> =>
  ({
    context: 'traded',
    graph: {
      nodes: [
        { id: 't:in', label: 'USDC', kind: 'token' },
        { id: 'v:1', label: 'Velodrome', kind: 'venue' },
        { id: 'v:2', label: 'Uniswap V3', kind: 'venue' },
      ],
    },
    svgBase64: SVG_B64,
    ...over,
  }) as never

describe('SettlementRoute', () => {
  beforeEach(() => jest.clearAllMocks())

  it('renders nothing while the endpoint 404s (the pre-deploy steady state)', () => {
    usePathVizGraphMock.mockReturnValue({ response: null, isLoading: false })
    const { container } = render(<SettlementRoute chainId={10} orderUid={UID} />)

    expect(container.querySelector('section')).toBeNull()
  })

  it('renders nothing for a non-traded context', () => {
    // quotedOnly/executing graphs are single-solver estimates, not settled fact.
    for (const context of ['quotedOnly', 'executing']) {
      usePathVizGraphMock.mockReturnValue({ response: traded({ context }), isLoading: false })
      const { container, unmount } = render(<SettlementRoute chainId={10} orderUid={UID} />)

      expect(container.querySelector('section')).toBeNull()
      unmount()
    }
  })

  it('renders the diagram as an <img> data URI, never inline SVG', () => {
    usePathVizGraphMock.mockReturnValue({ response: traded(), isLoading: false })
    const { container } = render(<SettlementRoute chainId={10} orderUid={UID} />)

    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    expect(img?.getAttribute('src')).toBe(`data:image/svg+xml;base64,${SVG_B64}`)
    expect(img?.getAttribute('alt')).toContain('Settlement route diagram')
    // The safety property: the SVG is a replaced element, not part of the DOM.
    expect(container.querySelector('svg')).toBeNull()
  })

  it('falls back to the venue list when the backend omits the image', () => {
    usePathVizGraphMock.mockReturnValue({ response: traded({ svgBase64: undefined }), isLoading: false })
    const { container } = render(<SettlementRoute chainId={10} orderUid={UID} />)

    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('Velodrome')
    expect(container.textContent).toContain('Uniswap V3')
    // Token and solver nodes are not venues and must not be listed as ones.
    expect(container.textContent).not.toContain('USDC')
  })

  it('renders nothing when there is neither an image nor any venue', () => {
    usePathVizGraphMock.mockReturnValue({
      response: traded({ svgBase64: undefined, graph: { nodes: [{ id: 't', label: 'USDC', kind: 'token' }] } }),
      isLoading: false,
    })
    const { container } = render(<SettlementRoute chainId={10} orderUid={UID} />)

    expect(container.querySelector('section')).toBeNull()
  })

  it('does not restate the surplus in HTML (the SVG already carries it)', () => {
    usePathVizGraphMock.mockReturnValue({ response: traded(), isLoading: false })
    const { container } = render(<SettlementRoute chainId={10} orderUid={UID} />)

    expect((container.textContent ?? '').toLowerCase()).not.toContain('surplus')
  })
})

describe('parsePathVizResponse', () => {
  it('parses the documented wire shape', () => {
    const parsed = parsePathVizResponse({
      context: 'traded',
      settlementTxHash: '0xabc',
      graph: { nodes: [{ id: 'v:1', label: 'Velodrome', kind: 'venue' }] },
      svgBase64: SVG_B64,
      generatedAt: '2026-07-31T00:00:00Z',
    })

    expect(parsed?.context).toBe('traded')
    expect(parsed?.graph.nodes).toHaveLength(1)
    expect(parsed?.svgBase64).toBe(SVG_B64)
  })

  it('is total over malformed bodies', () => {
    for (const body of [
      null,
      7,
      'x',
      [],
      {},
      { context: 'nope' },
      { context: 'traded' },
      { context: 'traded', graph: {} },
    ]) {
      expect(parsePathVizResponse(body)).toBeNull()
    }
  })

  it('drops malformed nodes and non-base64 svg payloads without dropping the response', () => {
    const parsed = parsePathVizResponse({
      context: 'traded',
      graph: {
        nodes: [
          { id: 'ok', label: 'Velodrome', kind: 'venue' },
          { id: 1 },
          'junk',
          { id: 'x', label: 'y', kind: 'martian' },
        ],
      },
      svgBase64: 'not valid base64!!<script>',
    })

    expect(parsed?.graph.nodes).toHaveLength(1)
    expect(parsed?.svgBase64).toBeUndefined()
  })
})
