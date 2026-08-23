interface ChromeAccessibilityNode {
  ignored?: boolean
  role?: { value?: unknown }
  name?: { value?: unknown }
}

const AX_ATTEMPTS = 40

function assertAccessibilityNode(
  description: string,
  matches: (node: ChromeAccessibilityNode) => boolean,
  attempt = 0,
): void {
  cy.then(() =>
    Cypress.automation('remote:debugger:protocol', {
      command: 'Accessibility.getFullAXTree',
      params: {},
    }),
  ).then((result: { nodes?: ChromeAccessibilityNode[] }) => {
    if (result.nodes?.some((node) => !node.ignored && matches(node))) return
    if (attempt >= AX_ATTEMPTS) throw new Error(`Missing accessible ${description}`)
    cy.wait(250).then(() => assertAccessibilityNode(description, matches, attempt + 1))
  })
}

export function assertAccessibleButton(name: string): void {
  assertAccessibilityNode(
    `button named "${name}"`,
    (node) => node.role?.value === 'button' && node.name?.value === name,
  )
}

export function assertAccessibleAnnouncement(role: 'alert' | 'status', text: string): void {
  cy.contains(`[role="${role}"]`, text).should('be.visible')
  assertAccessibilityNode(`${role} announcement`, (node) => node.role?.value === role)
}
