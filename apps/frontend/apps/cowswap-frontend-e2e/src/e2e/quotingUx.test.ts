describe('Quoting UX', () => {
  beforeEach(() => {
    cy.visit('/#/11155111/swap/WETH/COW')
    cy.unlockCrossChainSwap()
  })

  it('shows the slippage preset tiers in settings and applies one via the input path', () => {
    cy.get('#open-settings-dialog-button').click()

    cy.get('[data-testid="slippage-preset-10"]').should('exist')
    cy.get('[data-testid="slippage-preset-50"]').should('exist')
    cy.get('[data-testid="slippage-preset-100"]').should('exist')

    cy.get('[data-testid="slippage-preset-50"]').click()

    // The preset funnels through the same path as typing, so the input reflects it.
    cy.get('#slippage-input').should('have.value', '0.5')
  })

  it('shows the net-of-costs headline above the fee accordion once a quote lands', () => {
    cy.get('#input-currency-input .token-amount-input').should('be.enabled').type('1')

    // The row renders only with a quote; give the quote endpoint time to answer.
    cy.get('[data-testid="net-received-row"]', { timeout: 30000 }).should('be.visible')
  })
})
