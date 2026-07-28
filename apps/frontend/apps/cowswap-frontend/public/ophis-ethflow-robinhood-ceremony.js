(() => {
  'use strict'

  const CHAIN_ID_HEX = '0x1237'
  const EXPECTED_SENDER = '0x0494f503912c101bfd76b88e4f5d8a33de284d1a'
  const EXPECTED_NONCE_HEX = '0x5'
  const EXPECTED_CONTRACT = '0xC1Ee77e8a1B85D5EED702a9bB435f434408A4d29'
  const EXPECTED_ARTIFACT_SHA256 = '795cb4fd1c88be5e7401ab9490e60a7886138bbf191157f4a666fcd1a171c712'
  const EXPECTED_INIT_HASH = '0x745253038bde16df1688f032f78eb871ae517c0e58ced1d080d7bd5ec61ff636'
  const ARTIFACT_URL =
    'https://raw.githubusercontent.com/ophis-fi/ophis/e10caf0830f81271ade6bf2465abea42ad532c52/apps/backend/contracts/artifacts/CoWSwapEthFlow.json'
  const SETTLEMENT = '886d9fd312f442c4e1f3cdeae7b4ab73493e57cd'
  const WETH = '0bd7d308f8e1639fab988df18a8011f41eacad73'

  const button = document.querySelector('#deploy')
  const status = document.querySelector('#status')
  const setStatus = (message) => { status.textContent = message }
  const padAddress = (address) => address.padStart(64, '0')
  const toHex = (value) => `0x${value.toString(16)}`

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
        params: [{
          chainId: CHAIN_ID_HEX,
          chainName: 'Robinhood Chain',
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'],
          blockExplorerUrls: ['https://robinhoodchain.blockscout.com'],
        }],
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
      if (!provider?.request) throw new Error('Rainbow provider not found. Open this page inside Rainbow browser.')

      setStatus('Verifying pinned reviewed artifact…')
      const artifactText = await (await fetch(ARTIFACT_URL, { cache: 'no-store' })).text()
      if (await sha256(artifactText) !== EXPECTED_ARTIFACT_SHA256) {
        throw new Error('Pinned artifact hash mismatch; deployment refused')
      }
      const artifact = JSON.parse(artifactText)
      if (!/^0x[0-9a-f]+$/i.test(artifact.bytecode)) throw new Error('Artifact bytecode is malformed')
      const data = `${artifact.bytecode}${padAddress(SETTLEMENT)}${padAddress(WETH)}`

      await switchToRobinhood(provider)
      const accounts = await provider.request({ method: 'eth_requestAccounts' })
      const sender = String(accounts[0] || '').toLowerCase()
      if (sender !== EXPECTED_SENDER) throw new Error(`Wrong wallet: ${sender || 'none'}`)

      setStatus('Verifying sender nonce, target vacancy, bytecode and gas…')
      const nonce = await provider.request({ method: 'eth_getTransactionCount', params: [sender, 'pending'] })
      if (nonce.toLowerCase() !== EXPECTED_NONCE_HEX) {
        throw new Error(`Sender nonce changed (${nonce}); expected contract address is no longer valid`)
      }
      const existingCode = await provider.request({ method: 'eth_getCode', params: [EXPECTED_CONTRACT, 'latest'] })
      if (existingCode !== '0x') throw new Error('Expected contract address is already occupied')
      const initHash = await provider.request({ method: 'web3_sha3', params: [data] })
      if (initHash.toLowerCase() !== EXPECTED_INIT_HASH) throw new Error('Init-code hash mismatch; deployment refused')

      const estimateHex = await provider.request({
        method: 'eth_estimateGas',
        params: [{ from: sender, data, value: '0x0' }],
      })
      const estimate = BigInt(estimateHex)
      if (estimate < 1_000_000n || estimate > 2_000_000n) {
        throw new Error(`Unexpected gas estimate ${estimate}; deployment refused`)
      }
      const gas = toHex((estimate * 120n) / 100n)

      setStatus(`Verified.\nSender: ${sender}\nChain: 4663\nValue: 0 ETH\nGas estimate: ${estimate}\nExpected contract: ${EXPECTED_CONTRACT}\n\nReview the Rainbow confirmation now.`)
      const transactionHash = await provider.request({
        method: 'eth_sendTransaction',
        params: [{ from: sender, data, value: '0x0', gas }],
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
