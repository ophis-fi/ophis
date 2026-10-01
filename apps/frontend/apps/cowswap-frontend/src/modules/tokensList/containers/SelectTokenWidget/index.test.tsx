import { ReactNode, Suspense } from 'react'

import { act, render, screen } from '@testing-library/react'

import { SelectTokenWidget } from './index'

const mockClose = jest.fn()
let mockPending: Promise<void> | undefined
const mockUpdate = jest.fn()
jest.mock('jotai', () => ({ useSetAtom: () => mockUpdate }))
jest.mock('@cowprotocol/ui', () => ({ Loader: () => <span>Loading assets</span> }))
jest.mock('./hooks', () => ({
  useChainPanelState: () => ({ isEnabled: false }),
  useWidgetOpenState: () => true,
  useWidgetEffects: () => jest.requireActual<typeof import('react')>('react').useEffect(() => () => mockClose(), []),
  useViewWithFlows: () => {
    if (mockPending) throw mockPending
    return { preFlowResult: { content: <span>Asset picker</span> } }
  },
}))
jest.mock('./internal', () => ({
  SelectTokenModal: ({ children }: { children: ReactNode }) => {
    return <div>{children}</div>
  },
}))
jest.mock('./state', () => ({ customFlowsRegistryAtom: 'flows' }))
jest.mock('../../hooks/useSelectTokenWidgetState', () => ({ useSelectTokenWidgetState: () => ({}) }))
jest.mock('../../state/selectTokenWidgetAtom', () => ({ updateSelectTokenWidgetAtom: 'widget' }))
jest.mock('../../pure/SelectTokenModal/styled', () => ({}))

it('keeps the picker open while asset queries suspend', async () => {
  let resolve: () => void = () => undefined
  const view = () => (
    <Suspense fallback={<span>Outer loading</span>}>
      <SelectTokenWidget />
    </Suspense>
  )
  const { rerender } = render(view())
  expect(screen.getByText('Asset picker')).toBeTruthy()
  mockPending = new Promise<void>((done) => {
    resolve = done
  })
  rerender(view())
  expect(screen.getByText('Loading assets')).toBeTruthy()
  expect(screen.queryByText('Outer loading')).toBeNull()
  expect(mockClose).not.toHaveBeenCalled()
  await act(async () => {
    mockPending = undefined
    resolve()
  })
  expect(screen.getByText('Asset picker')).toBeTruthy()
})
