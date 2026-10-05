import { Suspense } from 'react'

import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { AssetSwapFields } from './AssetSwapFields'

const mockClosePicker = jest.fn()
jest.mock('@cowprotocol/common-hooks', () => ({ useReducedMotionPreference: () => true }))
jest.mock('modules/tokensList', () => ({
  useSelectTokenWidgetState: () => ({ open: false, forceOpen: false }),
  useCloseTokenSelectWidget: () => mockClosePicker,
}))
jest.mock('./useAssetSwapStyle', () => ({ useAssetSwapStyle: () => ({}) }))

it.each([false, true, undefined])('changes direction only when reversal is accepted (%s)', async (accepted) => {
  const reverse = jest.fn(() => accepted)
  const { container, unmount } = render(
    <Suspense fallback={<span>Loading</span>}>
      <AssetSwapFields
        input={<span>Pay panel</span>}
        output={<span>Receive panel</span>}
        reverse={{ onClick: reverse, disabled: false, loading: false }}
      />
    </Suspense>,
  )
  const arrow = await screen.findByRole('button', { name: 'Reverse swap direction' })
  fireEvent.click(arrow)
  expect(reverse).toHaveBeenCalledTimes(1)
  await waitFor(() => {
    const faces = Array.from(container.querySelectorAll('.swp-live-face')).map((element) => element.textContent)
    expect(faces).toEqual(accepted === false ? ['Pay panel', 'Receive panel'] : ['Receive panel', 'Pay panel'])
  })
  unmount()
  expect(mockClosePicker).toHaveBeenCalledWith({ overrideForceLock: true })
})
