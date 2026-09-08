import { stubOtcHostTokenLists } from '../support/otcFork'

const mainnetDescribe =
  Cypress.env('OTC_CANARY_REHEARSAL') || Cypress.env('OTC_PUBLIC_REHEARSAL') ? describe : describe.skip

mainnetDescribe('OTC Ethereum runtime shutdown', () => {
  it('pauses the mounted create surface and a reloaded tab on shutdown or provider failure', () => {
    cy.on('fail', (error) => {
      error.message += `\nOTC page: ${Cypress.$('main').text()}`
      throw error
    })
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
    cy.contains('button', /^Create$/).click()
    cy.get('#otc-create button', { timeout: 30_000 }).first().should('not.have.text', 'OTC writes disabled')
    cy.then(() => {
      enabled = false
    })
    cy.contains('#otc-create button', 'OTC writes disabled', { timeout: 15_000 }).should('be.disabled')
    cy.reload()
    cy.contains('button', /^Create$/).click()
    cy.contains('#otc-create button', 'OTC writes disabled', { timeout: 30_000 }).should('be.disabled')
    cy.then(() => {
      enabled = true
    })
    cy.get('#otc-create button', { timeout: 15_000 }).first().should('not.have.text', 'OTC writes disabled')
    cy.then(() => {
      offline = true
    })
    cy.contains('#otc-create button', 'OTC writes disabled', { timeout: 15_000 }).should('be.disabled')
  })
})
