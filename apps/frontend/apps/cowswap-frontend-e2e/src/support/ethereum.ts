/**
 * Updates cy.visit() to include an injected window.ethereum provider.
 */
import { Eip1193Bridge } from '@ethersproject/experimental/lib/eip1193-bridge'
import { JsonRpcProvider, type TransactionRequest } from '@ethersproject/providers'
import { Wallet } from '@ethersproject/wallet'

const OTC_FORK_RPC_URL = Cypress.env('OTC_FORK_RPC_URL') as string | undefined
const IS_OTC_FORK = typeof OTC_FORK_RPC_URL === 'string' && OTC_FORK_RPC_URL.length > 0
const CHAIN_ID = IS_OTC_FORK ? 1 : 11155111
const CHAIN_NAME = IS_OTC_FORK ? 'mainnet-fork' : 'sepolia'
// Foundry's public local-development key; never funded or used off the disposable fork.
const ANVIL_DEFAULT_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' // gitleaks:allow

const configuredPrivateKey =
  (Cypress.env('OTC_FORK_PRIVATE_KEY') as string | undefined) ||
  (Cypress.env('INTEGRATION_TEST_PRIVATE_KEY') as string | undefined) ||
  (IS_OTC_FORK ? ANVIL_DEFAULT_PRIVATE_KEY : undefined)

function requirePrivateKey(value: string | undefined): string {
  if (!value) throw new Error('INTEGRATION_TEST_PRIVATE_KEY env missing')
  return value
}

const INTEGRATION_TEST_PRIVATE_KEY = requirePrivateKey(configuredPrivateKey)

const INTEGRATION_TESTS_INFURA_KEY = Cypress.env('INTEGRATION_TESTS_INFURA_KEY')
const INTEGRATION_TESTS_ALCHEMY_KEY = Cypress.env('INTEGRATION_TESTS_ALCHEMY_KEY')

const NETWORK_URL = Cypress.env('REACT_APP_NETWORK_URL_' + CHAIN_ID)

const PROVIDER_URL =
  OTC_FORK_RPC_URL ||
  NETWORK_URL ||
  (INTEGRATION_TESTS_ALCHEMY_KEY
    ? `https://eth-${CHAIN_NAME}.g.alchemy.com/v2/${INTEGRATION_TESTS_ALCHEMY_KEY}`
    : INTEGRATION_TESTS_INFURA_KEY
      ? `https://${CHAIN_NAME}.infura.io/v3/${INTEGRATION_TESTS_INFURA_KEY}`
      : undefined)

assert(
  PROVIDER_URL,
  `PROVIDER_URL is empty, NETWORK_URL=${NETWORK_URL}, INTEGRATION_TESTS_ALCHEMY_KEY=${INTEGRATION_TESTS_ALCHEMY_KEY}, INTEGRATION_TESTS_INFURA_KEY=${INTEGRATION_TESTS_INFURA_KEY}`,
)

// address of the above key
export const TEST_ADDRESS_NEVER_USE = new Wallet(INTEGRATION_TEST_PRIVATE_KEY).address

/** Submit through the configured key so custom fork accounts need not be RPC-unlocked. */
export async function sendSignedForkTransaction(request: TransactionRequest): Promise<string> {
  if (!IS_OTC_FORK) throw new Error('Signed fork transactions require OTC_FORK_RPC_URL')
  const transaction = await signer.sendTransaction(request)
  return transaction.hash
}

// Redefined bridge to fix a supper annoying issue making some contract calls to fail
//  See https://github.com/ethers-io/ethers.js/issues/1683
class CustomizedBridge extends Eip1193Bridge {
  autoConnect = true

  chainId = CHAIN_ID

  // TODO: Add proper return type annotation
  // TODO: Replace any with proper type definitions
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-explicit-any
  async sendAsync(...args: any[]) {
    console.debug('sendAsync called', ...args)
    return this.send(...args)
  }
  // TODO: Break down this large function into smaller functions
  // TODO: Add proper return type annotation
  // TODO: Reduce function complexity by extracting logic
  // TODO: Replace any with proper type definitions
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type, complexity, @typescript-eslint/no-explicit-any
  async send(...args: any[]) {
    const isCallbackForm = typeof args[0] === 'object' && typeof args[1] === 'function'
    let callback
    let method
    let params
    if (isCallbackForm) {
      callback = args[1]
      method = args[0].method
      params = args[0].params
    } else {
      method = args[0]
      params = args[1]
    }
    // Mock out request accounts and chainId
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') {
      if (isCallbackForm) {
        callback({ result: [TEST_ADDRESS_NEVER_USE] })
      } else {
        return Promise.resolve([TEST_ADDRESS_NEVER_USE])
      }
    }
    if (method === 'eth_chainId') {
      if (isCallbackForm) {
        callback(null, { result: `0x${CHAIN_ID.toString(16)}` })
      } else {
        return Promise.resolve(`0x${CHAIN_ID.toString(16)}`)
      }
    }
    try {
      // Eip1193Bridge re-hexlifies calls with ethers' transaction shape. The
      // browser RPC shape uses `gas`, so normalize it back to `gasLimit` first.
      if (!IS_OTC_FORK && params && params.length && method === 'eth_call') {
        if (params[0].from) delete params[0].from
        if (params[0].gas) {
          params[0].gasLimit = params[0].gas
          delete params[0].gas
        }
      }
      let result
      if (IS_OTC_FORK && ['eth_call', 'web3_clientVersion', 'hardhat_metadata'].includes(method)) {
        // Keep calls and fork identity on the exact Anvil transport.
        result = await provider.send(method, params ?? [])
      } else if (params && params.length && params[0].from && method === 'eth_sendTransaction') {
        if (IS_OTC_FORK) {
          const req = { ...params[0] }
          delete req.from
          if (req.gas) {
            req.gasLimit = req.gas
            delete req.gas
          }
          result = await sendSignedForkTransaction(req)
          if (isCallbackForm) {
            callback(null, { result })
          } else {
            return result
          }
          return
        }
        // Hexlify will not take gas, must be gasLimit, set this property to be gasLimit
        params[0].gasLimit = params[0].gas
        delete params[0].gas
        // If from is present on eth_sendTransaction it errors, removing it makes the library set
        // from as the connected wallet which works fine
        delete params[0].from
        const req = JsonRpcProvider.hexlifyTransaction(params[0])
        // Hexlify sets the gasLimit property to be gas again and send transaction requires gasLimit
        req.gasLimit = req.gas
        delete req.gas
        // Send the transaction
        const tx = await this.signer.sendTransaction(req)
        result = tx.hash
      } else {
        // All other transactions the base class works for
        result = await super.send(method, params)
      }
      console.debug('result received', method, params, result)
      if (isCallbackForm) {
        callback(null, { result })
      } else {
        return result
      }
    } catch (error) {
      console.log(error)
      if (isCallbackForm) {
        callback(error, null)
      } else {
        throw error
      }
    }
  }
}

const provider = new JsonRpcProvider(PROVIDER_URL, CHAIN_ID)
const signer = new Wallet(INTEGRATION_TEST_PRIVATE_KEY, provider)

export const injected = new CustomizedBridge(signer, provider)
