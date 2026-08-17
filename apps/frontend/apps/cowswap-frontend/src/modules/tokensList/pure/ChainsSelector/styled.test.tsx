import { render, screen } from '@testing-library/react'

import { ChainInfo, ChainLogo, ChainText } from './styled'

describe('chain selector alignment', () => {
  it('keeps every logo in the same fixed-width column', () => {
    render(
      <ChainInfo data-testid="chain-info">
        <ChainLogo data-testid="chain-logo" />
      </ChainInfo>,
    )

    expect(screen.getByTestId('chain-info')).toHaveStyleRule('min-width', '0')
    expect(screen.getByTestId('chain-logo')).toHaveStyleRule('flex', '0 0 var(--size)')
  })

  it('keeps network labels on one line', () => {
    render(<ChainText data-testid="chain-text">Robinhood Chain</ChainText>)

    expect(screen.getByTestId('chain-text')).toHaveStyleRule('white-space', 'nowrap')
  })
})
