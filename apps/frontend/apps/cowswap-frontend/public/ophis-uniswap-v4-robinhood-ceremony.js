;(() => {
  'use strict'

  const CHAIN_ID_HEX = '0x1237'
  const EXPECTED_SENDER = '0x0494f503912c101bfd76b88e4f5d8a33de284d1a'
  const DEPLOYER = '0x4e59b44847b379578588920ca78fbf26c0b4956c'
  const EXPECTED_ADAPTER = '0x8573c5fcf5bd890f4edd4a41e783eac552b307ae'
  const SALT = '750af977b62f2d2a17b57ffc282eaecb8b861221a852479fe38aa8d0b1e285a4'
  const EXPECTED_ARTIFACT_SHA256 = '6fe214464fe74202f4d2a39d2eb14c40c79d8f8ace36844e85a419236165a81c'
  const EXPECTED_INIT_HASH = '0x42662631a179dc07c609512e3e64353e1638f0361f5244b47a20cc46e6054226'
  const ARTIFACT_URL =
    'https://raw.githubusercontent.com/ophis-fi/ophis/ddf4bfcd40631dac4b7e54598a2e62d6eeda1417/apps/frontend/apps/cowswap-frontend/public/ophis-uniswap-v4-adapter-artifact.json'
  const CONSTRUCTOR_ADDRESSES = [
    '886d9fd312f442c4e1f3cdeae7b4ab73493e57cd',
    '8366a39cc670b4001a1121b8f6a443a643e40951',
    '0bd7d308f8e1639fab988df18a8011f41eacad73',
    '5fc5360d0400a0fd4f2af552add042d716f1d168',
  ]

  const button = document.querySelector('#deploy')
  const status = document.querySelector('#status')
  const setStatus = (message) => {
    status.textContent = message
  }
  const padAddress = (address) => address.padStart(64, '0')
  const toHex = (value) => `0x${value.toString(16)}`
  const normalizeCode = (code) => String(code || '').toLowerCase()

  async function sha256(text) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  }

  async function switchToRobinhood(provider) {
    if ((await provider.request({ method: 'eth_chainId' })).toLowerCase() === CHAIN_ID_HEX) return
    try {
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_ID_HEX }] })
    } catch (error) {
      if (error?.code !== 4902) throw error
      await provider.request({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: CHAIN_ID_HEX,
            chainName: 'Robinhood Chain',
            nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
            rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'],
            blockExplorerUrls: ['https://robinhoodchain.blockscout.com'],
          },
        ],
      })
    }
    if ((await provider.request({ method: 'eth_chainId' })).toLowerCase() !== CHAIN_ID_HEX) {
      throw new Error('Wallet did not switch to Robinhood Chain (4663)')
    }
  }

  async function deploy() {
    button.disabled = true
    try {
      const provider = window.ethereum
      if (!provider?.request) throw new Error("Wallet provider not found. Open this page inside your wallet's browser.")

      setStatus('Verifying pinned build artifact…')
      const artifactResponse = await fetch(ARTIFACT_URL, { cache: 'no-store' })
      if (!artifactResponse.ok) throw new Error(`Could not load pinned artifact (${artifactResponse.status})`)
      const artifactText = await artifactResponse.text()
      if ((await sha256(artifactText)) !== EXPECTED_ARTIFACT_SHA256) {
        throw new Error('Pinned artifact hash mismatch; deployment refused')
      }
      const artifact = JSON.parse(artifactText)
      const bytecode = artifact?.bytecode?.object
      if (!/^0x[0-9a-f]+$/i.test(bytecode)) throw new Error('Artifact bytecode is malformed')
      const initCode = `${bytecode}${CONSTRUCTOR_ADDRESSES.map(padAddress).join('')}`
      const deploymentData = `0x${SALT}${initCode.slice(2)}`

      await switchToRobinhood(provider)
      const accounts = await provider.request({ method: 'eth_requestAccounts' })
      const sender = String(accounts[0] || '').toLowerCase()
      if (sender !== EXPECTED_SENDER) throw new Error(`Wrong wallet: ${sender || 'none'}`)

      setStatus('Verifying deployer, target vacancy, init code and CREATE2 address…')
      const [deployerCode, existingCode, initHash] = await Promise.all([
        provider.request({ method: 'eth_getCode', params: [DEPLOYER, 'latest'] }),
        provider.request({ method: 'eth_getCode', params: [EXPECTED_ADAPTER, 'latest'] }),
        provider.request({ method: 'web3_sha3', params: [initCode] }),
      ])
      if (normalizeCode(deployerCode) === '0x') throw new Error('Canonical CREATE2 deployer is absent')
      if (normalizeCode(existingCode) !== '0x') throw new Error('Expected adapter address is already occupied')
      if (initHash.toLowerCase() !== EXPECTED_INIT_HASH) throw new Error('Init-code hash mismatch; deployment refused')

      const create2Hash = await provider.request({
        method: 'web3_sha3',
        params: [`0xff${DEPLOYER.slice(2)}${SALT}${initHash.slice(2)}`],
      })
      const computedAdapter = `0x${create2Hash.slice(-40)}`.toLowerCase()
      if (computedAdapter !== EXPECTED_ADAPTER) {
        throw new Error(`CREATE2 address mismatch (${computedAdapter}); deployment refused`)
      }

      const estimateHex = await provider.request({
        method: 'eth_estimateGas',
        params: [{ from: sender, to: DEPLOYER, data: deploymentData, value: '0x0' }],
      })
      const estimate = BigInt(estimateHex)
      if (estimate < 300_000n || estimate > 5_000_000n) {
        throw new Error(`Unexpected gas estimate ${estimate}; deployment refused`)
      }
      const gas = toHex((estimate * 120n) / 100n)

      setStatus(
        `Verified.\nSender: ${sender}\nChain: 4663\nValue: 0 ETH\nGas estimate: ${estimate}\nExpected adapter: ${EXPECTED_ADAPTER}\n\nReview the wallet confirmation now.`,
      )
      const transactionHash = await provider.request({
        method: 'eth_sendTransaction',
        params: [{ from: sender, to: DEPLOYER, data: deploymentData, value: '0x0', gas }],
      })
      setStatus(`Broadcast submitted.\nTransaction: ${transactionHash}\n\nReturn to Codex for receipt verification.`)
      button.textContent = 'Transaction submitted'
    } catch (error) {
      setStatus(`REFUSED / NOT SENT\n${error?.message || String(error)}`)
      button.disabled = false
    }
  }

  button.addEventListener('click', deploy)
})()
