export function assertAccessibleButton(name: string): void {
  cy.contains('button', name)
    .should('be.visible')
    .and('not.have.attr', 'aria-hidden', 'true')
    .then(($button) => {
      expect($button.closest('[aria-hidden="true"], [inert]')).to.have.length(0)
      expect(($button.attr('aria-label') ?? $button.text()).trim()).to.equal(name)
    })
}

export function assertAccessibleAnnouncement(role: 'alert' | 'status', text: string, timeout?: number): void {
  const options = timeout === undefined ? {} : { timeout }
  cy.contains(`[role="${role}"][aria-live]`, text, options)
    .should('be.visible')
    .and('have.attr', 'aria-atomic', 'true')
    .then(($announcement) => {
      const expectedLive = role === 'alert' ? 'assertive' : 'polite'
      expect($announcement.attr('aria-live')).to.equal(expectedLive)
      expect($announcement.closest('[aria-hidden="true"], [inert]')).to.have.length(0)
    })
}
