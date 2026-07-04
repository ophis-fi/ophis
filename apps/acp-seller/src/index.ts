/**
 * Ophis ACP seller handler.
 *
 * Polls Virtuals ACP for jobs assigned to the Ophis agent and fulfils each by
 * building a bounded, ready-to-sign Ophis swap order and delivering it. The
 * buyer signs the delivered order with its own key, so Ophis never holds keys.
 *
 * Config (see .env.example): the whitelisted ACP signer key (a SEPARATE wallet
 * whitelisted against the agent in the Virtuals dashboard, NOT the agent's
 * embedded wallet key), the agent's numeric entity id, and its wallet address.
 * The `start` script loads .env via tsx --env-file, so `cp .env.example .env`
 * then `npm run start` is enough.
 */
import pkg, {
  AcpContractClientV2,
  AcpJobPhases,
  type AcpJob,
  type DeliverablePayload,
} from '@virtuals-protocol/acp-node'

import { buildSignableOrder, parseSwapRequirement, validateFulfillable } from './buildOrder.js'

// acp-node ships a CommonJS bundle. Under Node ESM interop a bare `import
// AcpClient from` binds to the module namespace object, not the class, so the
// AcpClient class is reached as `pkg.default` (verified against 0.3.0-beta.40).
// The named exports above import normally.
const AcpClient = pkg.default
type AcpClientInstance = InstanceType<typeof AcpClient>

const POLL_INTERVAL_MS = 20_000
/** getActiveJobs returns one page at a time; page through all of them each cycle. */
const ACTIVE_JOBS_PAGE_SIZE = 50

function env(key: string): string {
  const v = process.env[key]
  if (!v) throw new Error(`${key} is not set (see .env.example)`)
  return v
}

/**
 * Ethereum addresses are case-insensitive, so a checksummed env value and a
 * lowercase API value are the same address. Compare normalized, else the poller
 * silently skips every job while looking healthy.
 */
function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

const WHITELISTED_WALLET_PRIVATE_KEY = env('OPHIS_ACP_WHITELISTED_KEY') as `0x${string}`
const OPHIS_ACP_ENTITY_ID = parseInt(env('OPHIS_ACP_ENTITY_ID'), 10)
const OPHIS_ACP_WALLET_ADDRESS = env('OPHIS_ACP_WALLET_ADDRESS') as `0x${string}`

async function handleJob(job: AcpJob): Promise<void> {
  if (!sameAddress(job.providerAddress, OPHIS_ACP_WALLET_ADDRESS)) return
  const phase = job.phase
  console.log(`job ${job.id}: phase ${AcpJobPhases[phase]}`)

  if (phase === AcpJobPhases.REQUEST) {
    // Accept only if the requirement is a swap request we can actually fulfil.
    const req = parseSwapRequirement(job.requirement)
    if (!req) {
      await job.reject(
        'Ophis fulfils swap-order requests. Provide { chainId, sellToken, buyToken, sellAmount (atoms), owner } as the requirement.',
      )
      console.log(`job ${job.id}: rejected (unparseable requirement)`)
      return
    }
    // Reject a parseable-but-unfulfillable requirement BEFORE asking for payment
    // (unsupported chain, out-of-range slippage), so the buyer is never charged
    // for an order we cannot build at the TRANSACTION phase.
    const problem = validateFulfillable(req)
    if (problem) {
      await job.reject(`Requirement is not fulfillable: ${problem}`)
      console.log(`job ${job.id}: rejected (${problem})`)
      return
    }
    await job.accept('Swap request accepted; a bounded, signable Ophis order will be delivered after payment.')
    await job.createRequirement('Job accepted, please make payment to proceed.')
    console.log(`job ${job.id}: accepted`)
    return
  }

  if (phase === AcpJobPhases.TRANSACTION) {
    // Buyer has paid: build and deliver the signable order.
    const req = parseSwapRequirement(job.requirement)
    if (!req) {
      await job.respond(false, 'Requirement could not be parsed at delivery time.')
      return
    }
    // Re-check fulfillability so REQUEST and TRANSACTION agree (a requirement can
    // be edited between phases). buildSignableOrder guards again internally.
    const problem = validateFulfillable(req)
    if (problem) {
      await job.respond(false, `Requirement is not fulfillable: ${problem}`)
      return
    }
    try {
      const signable = await buildSignableOrder(req, Math.floor(Date.now() / 1000))
      const deliverable: DeliverablePayload = signable as unknown as Record<string, unknown>
      await job.deliver(deliverable)
      console.log(`job ${job.id}: delivered signable order for chain ${req.chainId}`)
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e)
      await job.respond(false, `Could not build an order: ${msg.slice(0, 200)}`)
      console.error(`job ${job.id}: build failed: ${msg}`)
    }
    return
  }
}

/**
 * Fetch every active job. getActiveJobs returns a single page, so paid
 * TRANSACTION jobs on later pages would sit undelivered if we read only the
 * first. Page until a short page (fewer than the page size) is returned.
 */
async function getAllActiveJobs(acpClient: AcpClientInstance): Promise<AcpJob[]> {
  const all: AcpJob[] = []
  for (let page = 1; ; page++) {
    const batch = await acpClient.getActiveJobs(page, ACTIVE_JOBS_PAGE_SIZE)
    all.push(...batch)
    if (batch.length < ACTIVE_JOBS_PAGE_SIZE) break
  }
  return all
}

async function main(): Promise<void> {
  const acpClient = new AcpClient({
    acpContractClient: await AcpContractClientV2.build(
      WHITELISTED_WALLET_PRIVATE_KEY,
      OPHIS_ACP_ENTITY_ID,
      OPHIS_ACP_WALLET_ADDRESS,
    ),
  })
  console.log(`Ophis ACP seller: polling for jobs for ${OPHIS_ACP_WALLET_ADDRESS} every ${POLL_INTERVAL_MS / 1000}s`)

  for (;;) {
    try {
      const jobs = await getAllActiveJobs(acpClient)
      for (const job of jobs) {
        try {
          await handleJob(job)
        } catch (e) {
          console.error(`job ${job.id}: handler error: ${(e as Error)?.message ?? e}`)
        }
      }
    } catch (e) {
      // A per-cycle poll failure is usually transient (RPC/API blip). Log and
      // retry next tick rather than tearing down the loop over one bad fetch.
      console.error(`poll cycle failed: ${(e as Error)?.message ?? e}`)
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }
}

main().catch((e) => {
  // The loop above swallows transient per-cycle errors, so reaching here means a
  // fatal, non-recoverable failure (e.g. client construction). The AcpClient can
  // hold open sockets/reconnect timers that keep the process alive with polling
  // stopped, which would defeat a systemd/pm2 restart. Exit non-zero so the
  // supervisor restarts a clean process.
  console.error(`fatal: ${(e as Error)?.message ?? e}`)
  process.exit(1)
})
