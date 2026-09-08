import { stubOtcHostTokenLists } from '../support/otcFork'

const canaryDescribe = Cypress.env('OTC_CANARY_REHEARSAL') ? describe : describe.skip

canaryDescribe('OTC canary runtime shutdown', () => {
  it('pauses the mounted create surface and a reloaded tab on shutdown or provider failure', () => {
    stubOtcHostTokenLists()
    let enabled = true
    let offline = false
    cy.intercept('GET', '/api/otc-control?*', (request) => {
      request.reply({
        statusCode: offline ? 503 : 200,
        body: { enabled, nonce: new URL(request.url).searchParams.get('nonce') },
      })
    })
    cy.visit('/#/otc')
    cy.contains('#otc-create button', 'Connect wallet', { timeout: 30_000 }).should('be.enabled')
    cy.then(() => {
      enabled = false
    })
    cy.contains('#otc-create button', 'OTC writes are disabled', { timeout: 15_000 }).should('be.disabled')
    cy.reload()
    cy.contains('#otc-create button', 'OTC writes are disabled', { timeout: 30_000 }).should('be.disabled')
    cy.then(() => {
      enabled = true
    })
    cy.contains('#otc-create button', 'Connect wallet', { timeout: 15_000 }).should('be.enabled')
    cy.then(() => {
      offline = true
    })
    cy.contains('#otc-create button', 'OTC writes are disabled', { timeout: 15_000 }).should('be.disabled')
  })
})
