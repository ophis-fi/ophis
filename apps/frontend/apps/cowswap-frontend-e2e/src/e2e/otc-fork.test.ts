import { assertAccessibleAnnouncement, assertAccessibleButton } from '../support/accessibility'
import { TEST_ADDRESS_NEVER_USE } from '../support/ethereum'
import {
  createWethForUsdcOrder,
  depositForkWeth,
  fillOtcOrderDirectly,
  FORK_MAKER,
  FORK_RACER,
  fundForkGas,
  getNextOtcOrderId,
  isOtcOrderActive,
  prewarmOtcFork,
  prewarmOtcForkOrder,
  readOtcAllowance,
  setForkTokenBalance,
  setOtcAllowance,
  TWO_THOUSAND_USDC,
  USDC,
  type Address,
} from '../support/otcFork'

const TEST_ACCOUNT = TEST_ADDRESS_NEVER_USE as Address
const forkDescribe = Cypress.env('OTC_FORK_RPC_URL') ? describe : describe.skip
const ACTION_ATTEMPTS = 600
const FORK_RELOAD_ATTEMPTS = 2
const FORK_UI_TIMEOUT = 150_000

Cypress.on('fail', (error) => {
  error.message += `\nOTC panel: ${Cypress.$('#otc-order-action, #otc-create').text()}`
  throw error
})

function captureGateEvidence(name: string): void {
  if ([true, 'true'].includes(Cypress.env('OTC_CAPTURE_GATE_EVIDENCE'))) {
    cy.screenshot(`otc-milestone-c/${name}`, { capture: 'viewport' })
  }
}

function primaryButton(panel: string): Cypress.Chainable<JQuery<HTMLElement>> {
  return cy.get(`${panel} button`).first()
}

function connectForkWallet(panel: string, attempt = 0, reloads = 0): void {
  if (attempt >= ACTION_ATTEMPTS) throw new Error('OTC wallet did not reach a connected state')
  primaryButton(panel).then(($button) => {
    const label = $button.text().trim()
    if (label === 'Connect wallet') {
      cy.wrap($button).click()
      cy.contains('Injected').click()
      cy.wait(250).then(() => connectForkWallet(panel, attempt + 1, reloads))
      return
    }
    if (/Verifying|Checking|Wallet access/.test(label)) {
      cy.wait(250).then(() => connectForkWallet(panel, attempt + 1, reloads))
      return
    }
    if (label === 'Local Anvil fork required') {
      if (reloads >= FORK_RELOAD_ATTEMPTS) throw new Error('Injected wallet did not verify as the local Anvil fork')
      cy.reload()
      cy.wait(500).then(() => connectForkWallet(panel, 0, reloads + 1))
    }
  })
}

function reachPrimaryAction(panel: string, expected: string, attempt = 0, lastLabel = ''): void {
  if (attempt >= ACTION_ATTEMPTS) {
    throw new Error(`OTC action did not become ready: ${expected}; last label: ${lastLabel}`)
  }
  primaryButton(panel).then(($button) => {
    const label = $button.text().trim()
    if (label === expected) return
    if (label === 'Connect wallet') {
      cy.wrap($button).click()
      cy.contains('Injected').click()
    }
    cy.wait(250).then(() => reachPrimaryAction(panel, expected, attempt + 1, label))
  })
}

function waitForStableEmptyForm(attempt = 0): void {
  if (attempt >= 120) throw new Error('OTC empty form did not reach a stable action')
  primaryButton('#otc-create').then(($button) => {
    const label = $button.text().trim()
    if (label === 'Connect wallet' || label === 'Complete the order terms') return
    cy.wait(250).then(() => waitForStableEmptyForm(attempt + 1))
  })
}

function visitForkOrder(orderId: bigint): void {
  cy.visit(`/#/otc/${orderId.toString()}`)
  cy.contains(`Order #${orderId.toString()}`, { timeout: 30_000 }).should('be.visible')
  cy.get('#otc-order-action', { timeout: 30_000 }).should('be.visible')
}

forkDescribe('OTC Milestone C injected wallet on a local mainnet fork', () => {
  let createOrderId = 0n
  let cancelOrderId = 0n
  let mismatchedAllowanceOrderId = 0n
  let fillOrderId = 0n
  let racedOrderId = 0n

  before(() => {
    cy.then({ timeout: 300_000 }, async () => {
      await fundForkGas(TEST_ACCOUNT)
      await fundForkGas(FORK_MAKER)
      await fundForkGas(FORK_RACER)
      await setForkTokenBalance(USDC, TEST_ACCOUNT, TWO_THOUSAND_USDC * 3n)
      await setForkTokenBalance(USDC, FORK_RACER, TWO_THOUSAND_USDC)
      await depositForkWeth(TEST_ACCOUNT)
      cancelOrderId = await createWethForUsdcOrder(TEST_ACCOUNT)
      mismatchedAllowanceOrderId = await createWethForUsdcOrder(FORK_MAKER)
      fillOrderId = await createWethForUsdcOrder(FORK_MAKER)
      racedOrderId = await createWethForUsdcOrder(FORK_MAKER)
      createOrderId = await getNextOtcOrderId()
      await prewarmOtcFork(TEST_ACCOUNT)
    })
  })

  it('approves the exact WETH amount and creates an ERC-20 escrow order', () => {
    cy.visit('/#/otc')
    cy.contains('Local fork writes', { timeout: 30_000 }).should('be.visible')
    connectForkWallet('#otc-create')
    cy.get('[aria-label="Maker escrow amount"]').type('1')
    cy.get('[aria-label="Requested amount"]').type('2000')
    cy.contains('label', 'I reviewed both exact token amounts').find('input').check()

    reachPrimaryAction('#otc-create', 'Approve exact amount')
    primaryButton('#otc-create').should('be.enabled').click()
    cy.contains('Local fork confirmation:', { timeout: FORK_UI_TIMEOUT }).should('be.visible')
    cy.contains('button', 'Create escrow order', { timeout: FORK_UI_TIMEOUT }).should('be.enabled').click()
    cy.contains('Local fork confirmation:', { timeout: FORK_UI_TIMEOUT }).should('be.visible')
    cy.contains('1 WETH').should('be.visible')
    cy.contains('2000 USDC').should('be.visible')
    cy.then(async () => expect(await isOtcOrderActive(createOrderId)).to.equal(true))
  })

  it('cancels a freshly verified maker order and waits for confirmation', () => {
    visitForkOrder(cancelOrderId)
    connectForkWallet('#otc-order-action')
    cy.contains('Cancel order on local fork', { timeout: 30_000 }).should('be.visible')
    cy.contains('label', 'I reviewed the exact order').find('input').check()
    reachPrimaryAction('#otc-order-action', 'Cancel order')
    assertAccessibleButton('Cancel order')
    captureGateEvidence('cancel-ready')
    primaryButton('#otc-order-action').should('be.enabled').click()
    cy.contains('#otc-order-action', 'This order is inactive.', { timeout: FORK_UI_TIMEOUT }).should('be.visible')
    cy.then(async () => expect(await isOtcOrderActive(cancelOrderId)).to.equal(false))
  })

  it('fills an entire order with exact USDC approval', () => {
    visitForkOrder(fillOrderId)
    connectForkWallet('#otc-order-action')
    cy.contains('label', 'I reviewed both exact token amounts').find('input').check()
    reachPrimaryAction('#otc-order-action', 'Approve exact amount')
    primaryButton('#otc-order-action').should('be.enabled').click()
    cy.contains('Local fork confirmation:', { timeout: FORK_UI_TIMEOUT }).should('be.visible')
    reachPrimaryAction('#otc-order-action', 'Fill entire order')
    assertAccessibleButton('Fill entire order')
    captureGateEvidence('fill-ready')
    primaryButton('#otc-order-action').should('be.enabled').click()
    assertAccessibleAnnouncement('status', 'Local fork confirmation:', FORK_UI_TIMEOUT)
    cy.then(async () => {
      expect(await isOtcOrderActive(fillOrderId)).to.equal(false)
      expect(await readOtcAllowance(TEST_ACCOUNT)).to.equal(0n)
    })
  })

  it('clears a mismatched USDC allowance before offering exact approval', () => {
    cy.then(() => setOtcAllowance(TEST_ACCOUNT, TWO_THOUSAND_USDC + 1n))
    visitForkOrder(mismatchedAllowanceOrderId)
    connectForkWallet('#otc-order-action')
    cy.contains('label', 'I reviewed both exact token amounts').find('input').check()
    reachPrimaryAction('#otc-order-action', 'Revoke mismatched allowance')
    assertAccessibleAnnouncement('alert', 'Token allowance must be cleared')
    assertAccessibleButton('Revoke mismatched allowance')
    primaryButton('#otc-order-action').should('be.enabled').click()
    assertAccessibleAnnouncement('status', 'Local fork confirmation:', FORK_UI_TIMEOUT)
    cy.then(async () => expect(await readOtcAllowance(TEST_ACCOUNT)).to.equal(0n))
    reachPrimaryAction('#otc-order-action', 'Approve exact amount')
  })

  it('revokes exact leftover allowance after losing a fill race', () => {
    visitForkOrder(racedOrderId)
    connectForkWallet('#otc-order-action')
    cy.contains('label', 'I reviewed both exact token amounts').find('input').check()
    reachPrimaryAction('#otc-order-action', 'Approve exact amount')
    primaryButton('#otc-order-action').should('be.enabled').click()
    cy.contains('Local fork confirmation:', { timeout: FORK_UI_TIMEOUT }).should('be.visible')
    reachPrimaryAction('#otc-order-action', 'Fill entire order')
    cy.then({ timeout: FORK_UI_TIMEOUT }, async () => {
      await fillOtcOrderDirectly(FORK_RACER, racedOrderId)
      await prewarmOtcForkOrder(TEST_ACCOUNT, racedOrderId)
    })
    primaryButton('#otc-order-action').should('have.text', 'Fill entire order').click()
    // Polling may replace the transient failure message with the inactive-order
    // view. Both must preserve the unused allowance and expose recovery.
    assertAccessibleAnnouncement('alert', 'Token allowance must be cleared', FORK_UI_TIMEOUT)
    cy.then(async () => {
      expect(await isOtcOrderActive(racedOrderId)).to.equal(false)
      expect(await readOtcAllowance(TEST_ACCOUNT)).to.equal(TWO_THOUSAND_USDC)
    })
    visitForkOrder(racedOrderId)
    connectForkWallet('#otc-order-action')
    cy.contains('Recover token allowance', { timeout: FORK_UI_TIMEOUT }).should('be.visible')
    cy.contains('button', 'Revoke unused allowance', { timeout: FORK_UI_TIMEOUT }).should('be.enabled')
    assertAccessibleButton('Revoke unused allowance')
    captureGateEvidence('recovery-required')
    cy.contains('button', 'Revoke unused allowance').click()
    assertAccessibleAnnouncement('status', 'Local fork confirmation:', FORK_UI_TIMEOUT)
    cy.then(async () => expect(await readOtcAllowance(TEST_ACCOUNT)).to.equal(0n))
  })

  it('keeps the fork form keyboard-usable without narrow-screen overflow', () => {
    cy.viewport(390, 844)
    cy.visit('/#/otc')
    cy.contains('Local fork writes', { timeout: 30_000 }).should('be.visible')
    cy.get('#otc-create').should('be.visible')
    cy.get('[aria-label="Maker escrow amount"]').focus().should('have.focus')
    cy.get('[aria-label="Requested amount"]').focus().should('have.focus')
    waitForStableEmptyForm()
    cy.get('#otc-create').then(($panel) => {
      const bounds = $panel[0].getBoundingClientRect()
      expect(bounds.left).to.be.at.least(0)
      expect(bounds.right).to.be.at.most(390)
    })
    cy.get('body').then(($body) => {
      expect($body[0].scrollWidth).to.be.at.most($body[0].clientWidth)
    })
  })
})
