import { createRef } from 'react'

import { AdditionalTargetChainId, TargetChainId } from '@cowprotocol/cow-sdk'

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { fireEvent, render, screen } from '@testing-library/react'
import { ThemeProvider } from 'styled-components/macro'
import { getCowswapTheme } from 'theme'

import { NetworkSelectorMenu } from './NetworkSelectorMenu.pure'

jest.mock('common/hooks/useDeprecatedChains', () => ({ useDeprecatedChains: () => new Set() }))

it('finds networks by name or chain ID, reports missing matches and preserves selection and Escape', () => {
  const onSelectChain = jest.fn()
  const onClose = jest.fn()
  render(
    <I18nProvider i18n={i18n}>
      <ThemeProvider theme={getCowswapTheme(true)}>
        <NetworkSelectorMenu
          menuRef={createRef<HTMLDivElement>()}
          currentChainId={null}
          availableChains={[1, 10, 137] as TargetChainId[]}
          isDarkMode
          onSelectChain={onSelectChain}
          onClose={onClose}
        />
      </ThemeProvider>
    </I18nProvider>,
  )
  const search = screen.getByRole('textbox', { name: 'Search network' })
  expect(document.activeElement).toBe(search)
  fireEvent.change(search, { target: { value: '  pOlY  ' } })
  expect(screen.getByRole('button', { name: 'Polygon' })).not.toBeNull()
  expect(screen.queryByRole('button', { name: 'Ethereum' })).toBeNull()
  fireEvent.change(search, { target: { value: '10' } })
  fireEvent.click(screen.getByRole('button', { name: 'Optimism' }))
  expect(onSelectChain).toHaveBeenCalledWith(10)
  fireEvent.change(search, { target: { value: 'no-such-network' } })
  expect(screen.getByRole('status').textContent).toBe('No networks found.')
  fireEvent.keyDown(search, { key: 'Escape' })
  expect(onClose).toHaveBeenCalledTimes(1)
})

it.each([
  { chains: [1], nativeEnabled: true },
  { chains: [1, AdditionalTargetChainId.SOLANA], nativeEnabled: true },
  { chains: [1, AdditionalTargetChainId.SOLANA], nativeEnabled: false },
])('shows one Solana network and selects the available route with %j', ({ chains, nativeEnabled }) => {
  const onClose = jest.fn()
  const onSelectChain = jest.fn()
  const onSelectNativeSolana = jest.fn()
  render(
    <I18nProvider i18n={i18n}>
      <ThemeProvider theme={getCowswapTheme(true)}>
        <NetworkSelectorMenu
          menuRef={createRef<HTMLDivElement>()}
          currentChainId={null}
          availableChains={chains as TargetChainId[]}
          isDarkMode
          onSelectChain={onSelectChain}
          onClose={onClose}
          onSelectNativeSolana={nativeEnabled ? onSelectNativeSolana : undefined}
        />
      </ThemeProvider>
    </I18nProvider>,
  )
  fireEvent.change(screen.getByRole('textbox', { name: 'Search network' }), { target: { value: 'solana' } })
  expect(screen.getAllByText('Solana')).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: 'Solana' }))
  if (nativeEnabled) {
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onSelectNativeSolana).toHaveBeenCalledTimes(1)
    expect(onSelectChain).not.toHaveBeenCalled()
  } else {
    expect(onSelectChain).toHaveBeenCalledWith(AdditionalTargetChainId.SOLANA)
    expect(onSelectNativeSolana).not.toHaveBeenCalled()
  }
})
