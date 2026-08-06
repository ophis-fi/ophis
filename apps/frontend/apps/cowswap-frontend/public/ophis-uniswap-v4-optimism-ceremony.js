(() => {
  'use strict'

  const CHAIN_ID_HEX = '0xa'
  const EXPECTED_SENDER = '0x0494f503912c101bfd76b88e4f5d8a33de284d1a'
  const DEPLOYER = '0x4e59b44847b379578588920ca78fbf26c0b4956c'
  const EXPECTED_ADAPTER = '0xd882da9cb91eb458337413e5846824cdcadb2ddc'
  const SALT = 'ca248cd60aeb1711073d5cfc084d122aacc3a25ec282fc9014b569baa9f8b923'
  const EXPECTED_ARTIFACT_SHA256 = 'e3d2ae00fe00dcf558d4dfc58ff3b165c4736b1aa6eec4ab986e8ff33f0e467b'
  const EXPECTED_INIT_HASH = '0x2782f40114b090be9aa56439928743232cde826fb68fb243bf37977702827452'
  const ARTIFACT_URL = '/ophis-uniswap-v4-optimism-adapter-artifact.json'
  const CONSTRUCTOR_WORDS = [
    '310784c7fce12d578da6f53460777bac9718b859',
    '9a13f98cb987694c9f086b1f5eb990eea8264ec3',
    '4200000000000000000000000000000000000006',
    '0b2c639c533813f4aa9d7837caf62653d097ff85',
    '1f4',
    'a',
  ]

  const button = document.querySelector('#deploy')
  const status = document.querySelector('#status')
  const setStatus = (message) => { status.textContent = message }
  const padWord = (word) => word.padStart(64, '0')
  const normalizeCode = (code) => String(code || '').toLowerCase()

  async function sha256(text) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  }

  async function switchToOptimism(provider) {
    if ((await provider.request({ method: 'eth_chainId' })).toLowerCase() === CHAIN_ID_HEX) return
    try {
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_ID_HEX }] })
    } catch (error) {
      if (error?.code !== 4902) throw error
      await provider.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: CHAIN_ID_HEX,
          chainName: 'OP Mainnet',
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          rpcUrls: ['https://mainnet.optimism.io'],
          blockExplorerUrls: ['https://optimistic.etherscan.io'],
        }],
      })
    }
    if ((await provider.request({ method: 'eth_chainId' })).toLowerCase() !== CHAIN_ID_HEX) {
      throw new Error('Wallet did not switch to Optimism (10)')
    }
  }

  async function deploy() {
    button.disabled = true
    try {
      const provider = window.ethereum
      if (!provider?.request) throw new Error('Wallet provider not found')

      setStatus('Verifying pinned build artifact…')
      const response = await fetch(ARTIFACT_URL, { cache: 'no-store' })
      if (!response.ok) throw new Error(`Could not load artifact (${response.status})`)
      const artifactText = await response.text()
      if (await sha256(artifactText) !== EXPECTED_ARTIFACT_SHA256) {
        throw new Error('Artifact hash mismatch; deployment refused')
      }
      const bytecode = JSON.parse(artifactText)?.bytecode?.object
      if (!/^0x[0-9a-f]+$/i.test(bytecode)) throw new Error('Artifact bytecode is malformed')
      const initCode = `${bytecode}${CONSTRUCTOR_WORDS.map(padWord).join('')}`
      const deploymentData = `0x${SALT}${initCode.slice(2)}`

      await switchToOptimism(provider)
      const accounts = await provider.request({ method: 'eth_requestAccounts' })
      const sender = String(accounts[0] || '').toLowerCase()
      if (sender !== EXPECTED_SENDER) throw new Error(`Wrong wallet: ${sender || 'none'}`)

      const [deployerCode, targetCode, initHash] = await Promise.all([
        provider.request({ method: 'eth_getCode', params: [DEPLOYER, 'latest'] }),
        provider.request({ method: 'eth_getCode', params: [EXPECTED_ADAPTER, 'latest'] }),
        provider.request({ method: 'web3_sha3', params: [initCode] }),
      ])
      if (normalizeCode(deployerCode) === '0x') throw new Error('Canonical CREATE2 deployer is absent')
      if (normalizeCode(targetCode) !== '0x') throw new Error('Expected adapter address is occupied')
      if (initHash.toLowerCase() !== EXPECTED_INIT_HASH) throw new Error('Init-code hash mismatch')

      const create2Hash = await provider.request({
        method: 'web3_sha3',
        params: [`0xff${DEPLOYER.slice(2)}${SALT}${initHash.slice(2)}`],
      })
      if (`0x${create2Hash.slice(-40)}`.toLowerCase() !== EXPECTED_ADAPTER) {
        throw new Error('CREATE2 address mismatch')
      }

      const estimate = BigInt(await provider.request({
        method: 'eth_estimateGas',
        params: [{ from: sender, to: DEPLOYER, data: deploymentData, value: '0x0' }],
      }))
      if (estimate < 500_000n || estimate > 3_000_000n) {
        throw new Error(`Unexpected gas estimate ${estimate}`)
      }
      const gas = `0x${((estimate * 120n) / 100n).toString(16)}`

      setStatus(`Verified.\nSender: ${sender}\nChain: Optimism (10)\nValue: 0 ETH\nGas estimate: ${estimate}\nExpected adapter: ${EXPECTED_ADAPTER}\n\nReview the wallet confirmation.`)
      const hash = await provider.request({
        method: 'eth_sendTransaction',
        params: [{ from: sender, to: DEPLOYER, data: deploymentData, value: '0x0', gas }],
      })
      setStatus(`Broadcast submitted.\nTransaction: ${hash}\n\nReturn to Codex for receipt verification.`)
      button.textContent = 'Transaction submitted'
    } catch (error) {
      setStatus(`REFUSED / NOT SENT\n${error?.message || String(error)}`)
      button.disabled = false
    }
  }

  button.addEventListener('click', deploy)
})()
