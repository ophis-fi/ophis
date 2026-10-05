import { act, renderHook } from '@testing-library/react'

import { useInlineTokenPickerBack } from './useInlineTokenPickerBack'

import { TokenSelectorView } from '../types'

let mockView = TokenSelectorView.Main
let mockListToToggle: object | undefined
const mockUpdateWidget = jest.fn()
const mockCloseManage = jest.fn()
const mockDismiss = jest.fn()

jest.mock('./useActiveBlockingView', () => ({ useActiveBlockingView: () => mockView }))
jest.mock('./useManageWidgetVisibility', () => ({
  useManageWidgetVisibility: () => ({ closeManageWidget: mockCloseManage }),
}))
jest.mock('../../../hooks/useSelectTokenWidgetState', () => ({
  useSelectTokenWidgetState: () => ({ listToToggle: mockListToToggle }),
}))
jest.mock('../../../hooks/useUpdateSelectTokenWidgetState', () => ({
  useUpdateSelectTokenWidgetState: () => mockUpdateWidget,
}))

beforeEach(() => {
  jest.clearAllMocks()
  mockView = TokenSelectorView.Main
  mockListToToggle = undefined
})

it.each([
  [TokenSelectorView.ImportToken, { tokenToImport: undefined }],
  [TokenSelectorView.ImportList, { listToImport: undefined }],
  [TokenSelectorView.LpToken, { selectedPoolAddress: undefined }],
] as const)('backs out of %s without dismissing the picker or its parent settings', (view, update) => {
  mockView = view
  const { result } = renderHook(() => useInlineTokenPickerBack(mockDismiss))
  act(() => result.current())
  expect(mockUpdateWidget).toHaveBeenCalledWith(update)
  expect(mockCloseManage).not.toHaveBeenCalled()
  expect(mockDismiss).not.toHaveBeenCalled()
})

it('cancels pending list consent before leaving settings', () => {
  mockView = TokenSelectorView.Manage
  mockListToToggle = {}
  const { result } = renderHook(() => useInlineTokenPickerBack(mockDismiss))
  act(() => result.current())
  expect(mockUpdateWidget).toHaveBeenCalledWith({ listToToggle: undefined })
  expect(mockCloseManage).not.toHaveBeenCalled()
  expect(mockDismiss).not.toHaveBeenCalled()
})

it('returns from settings to the main token list', () => {
  mockView = TokenSelectorView.Manage
  const { result } = renderHook(() => useInlineTokenPickerBack(mockDismiss))
  act(() => result.current())
  expect(mockCloseManage).toHaveBeenCalledTimes(1)
  expect(mockDismiss).not.toHaveBeenCalled()
})

it('dismisses the picker only from its main view', () => {
  const { result } = renderHook(() => useInlineTokenPickerBack(mockDismiss))
  act(() => result.current())
  expect(mockDismiss).toHaveBeenCalledTimes(1)
})
