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
 */
import AcpClient, {
  AcpContractClientV2,
  AcpError,
  AcpJobPhases,
  type AcpJob,
  type DeliverablePayload,
} from '@virtuals-protocol/acp-node'

import { buildSignableOrder, parseSwapRequirement } from './buildOrder.js'

const POLL_INTERVAL_MS = 20_000

function env(key: string): string {
  const v = process.env[key]
  if (!v) throw new Error(`${key} is not set (see .env.example)`)
  return v
}

const WHITELISTED_WALLET_PRIVATE_KEY = env('OPHIS_ACP_WHITELISTED_KEY') as `0x${string}`
const OPHIS_ACP_ENTITY_ID = parseInt(env('OPHIS_ACP_ENTITY_ID'), 10)
const OPHIS_ACP_WALLET_ADDRESS = env('OPHIS_ACP_WALLET_ADDRESS') as `0x${string}`

async function handleJob(job: AcpJob): Promise<void> {
  if (job.providerAddress !== OPHIS_ACP_WALLET_ADDRESS) return
  const phase = job.phase
  console.log(`job ${job.id}: phase ${AcpJobPhases[phase]}`)

  if (phase === AcpJobPhases.REQUEST) {
    // Accept only if the requirement is a swap request we can fulfil.
    const req = parseSwapRequirement(job.requirement)
    if (!req) {
      await job.reject(
        'Ophis fulfils swap-order requests. Provide { chainId, sellToken, buyToken, sellAmount (atoms), owner } as the requirement.',
      )
      console.log(`job ${job.id}: rejected (unparseable requirement)`)
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
    const jobs = await acpClient.getActiveJobs()
    if (jobs instanceof AcpError) {
      console.error(`getActiveJobs error: ${jobs.message ?? jobs}`)
    } else {
      for (const job of jobs) {
        try {
          await handleJob(job)
        } catch (e) {
          console.error(`job ${job.id}: handler error: ${(e as Error)?.message ?? e}`)
        }
      }
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }
}

main().catch((e) => {
  console.error(`fatal: ${(e as Error)?.message ?? e}`)
  process.exitCode = 1
})
