(() => {
  'use strict'

  const CHAIN_ID = 4663
  const CHAIN_ID_HEX = '0x1237'
  const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
  const EXPECTED_SENDER = '0x0494f503912c101bfd76b88e4f5d8a33de284d1a'
  const FACTORY = '0x4e1dcf7ad4e460cfd30791ccc4f9c8a4f820ec67'
  const SINGLETON = '0x41675c099f32341bf84bfc5382af534df5c7461a'
  const MIGRATION = '0xbd89a1ce4dde368ffab0ec35506eece0b1ffdc54'
  const FINAL_SINGLETON = '0x29fcb43b46531bca003ddc8fcb67ffe91900c762'
  const FALLBACK_HANDLER = '0xfd0732dc9e303f09fcef3a7388ad10a83459ec99'
  const EXPECTED_SAFE = '0x858f0f5ee954846d47155f5203c04af1819ecef8'
  const SECOND_OWNER = '0xbec5b03ffdcac50071693e87bfdb88baa6710199'
  const THIRD_OWNER = '0x746ad9c63cca6d3a8588731d60fb87deab4da46a'
  const LEGACY_PENDING_TRANSACTION_KEY = 'ophisFeeSafePendingTransaction:v0'
  const PENDING_TRANSACTION_KEY = 'ophisFeeSafePendingTransaction:v1'
  const RECONCILED_TRANSACTION_KEY = 'ophisFeeSafeReconciledTransaction:v2'
  const CEREMONY_BROWSER_LOCK = 'ophisFeeSafeRobinhoodCeremony:v1'
  const EXPECTED_CODE_HASHES = new Map([
    [FACTORY, '0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317'],
    [SINGLETON, '0x1fe2df852ba3299d6534ef416eefa406e56ced995bca886ab7a553e6d0c5e1c4'],
    [MIGRATION, '0x2f25df28caf984366ee584e13241707e85dcd5a6ea0c14267928dafc1fd6274b'],
    [FINAL_SINGLETON, '0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff'],
    [FALLBACK_HANDLER, '0x7c6007a5d711cea8dfd5d91f5940ec29c7f200fe511eb1fc1397b367af3c42f9'],
  ])
  const DEPLOY_DATA =
    '0x1688f0b900000000000000000000000041675c099f32341bf84bfc5382af534df5c7461a0000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000001a4b63e800d00000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000bd89a1ce4dde368ffab0ec35506eece0b1ffdc540000000000000000000000000000000000000000000000000000000000000140000000000000000000000000fd0732dc9e303f09fcef3a7388ad10a83459ec99000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000005afe7a11e700000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000494f503912c101bfd76b88e4f5d8a33de284d1a0000000000000000000000000000000000000000000000000000000000000024fe51f64300000000000000000000000029fcb43b46531bca003ddc8fcb67ffe91900c7620000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000'
  const ADD_SECOND_OWNER =
    '0x0d582f13000000000000000000000000bec5b03ffdcac50071693e87bfdb88baa67101990000000000000000000000000000000000000000000000000000000000000001'
  const ADD_THIRD_OWNER =
    '0x0d582f13000000000000000000000000746ad9c63cca6d3a8588731d60fb87deab4da46a0000000000000000000000000000000000000000000000000000000000000002'

  const button = document.querySelector('#deploy')
  const status = document.querySelector('#status')
  const setStatus = (message) => { status.textContent = message }
  const stripHex = (value) => value.startsWith('0x') ? value.slice(2) : value
  const word = (value) => BigInt(value).toString(16).padStart(64, '0')
  const addressWord = (address) => stripHex(address).padStart(64, '0')
  const bytesPart = (value) => {
    const hex = stripHex(value)
    return `${word(hex.length / 2)}${hex.padEnd(Math.ceil(hex.length / 64) * 64, '0')}`
  }
  const normalizeAddresses = (addresses) => addresses.map((address) => address.toLowerCase()).sort()
  const sameAddresses = (actual, expected) =>
    JSON.stringify(normalizeAddresses(actual)) === JSON.stringify(normalizeAddresses(expected))
  let pendingTransaction = null
  let storageReadSucceeded = false
  const reconciledTransactionHashes = new Set()

  function parsePendingTransaction(value, requireVersionMarker) {
    if (!value) return null
    try {
      const transaction = JSON.parse(value)
      if (
        /^0x[0-9a-f]{64}$/i.test(transaction?.hash) &&
        /^0x[0-9a-f]{40}$/i.test(transaction?.sender) &&
        /^0x[0-9a-f]+$/i.test(transaction?.nonce) &&
        (!requireVersionMarker || typeof transaction?.nonceProvisional === 'boolean')
      ) {
        return {
          ...transaction,
          nonceProvisional: requireVersionMarker ? transaction.nonceProvisional : true,
        }
      }
    } catch {
      // Invalid JSON is not a usable transaction lock.
    }
    return null
  }

  function readPendingTransaction() {
    storageReadSucceeded = false
    try {
      const storedValue = window.localStorage.getItem(PENDING_TRANSACTION_KEY)
      const storedTransaction = parsePendingTransaction(storedValue, true)
      if (storedValue && !storedTransaction) window.localStorage.removeItem(PENDING_TRANSACTION_KEY)

      const legacyValue = window.localStorage.getItem(LEGACY_PENDING_TRANSACTION_KEY)
      storageReadSucceeded = true
      let legacyTransaction = null
      let legacyNeedsNormalization = false
      if (/^0x[0-9a-f]{64}$/i.test(legacyValue || '')) {
        legacyTransaction = {
          hash: legacyValue,
          sender: EXPECTED_SENDER,
          nonce: null,
          nonceProvisional: true,
        }
      } else if (legacyValue) {
        // Migrate the short-lived version that accidentally stored v1-shaped
        // JSON under the v0 key.
        legacyTransaction = parsePendingTransaction(legacyValue, false)
        legacyNeedsNormalization = Boolean(legacyTransaction)
      }

      // An older open tab can advance the ceremony and update only v0. Its
      // differing hash is newer than stale v1 metadata and must win.
      if (
        legacyTransaction &&
        (!storedTransaction || legacyTransaction.hash.toLowerCase() !== storedTransaction.hash.toLowerCase())
      ) {
        pendingTransaction = legacyTransaction
        if (legacyNeedsNormalization) {
          const unchangedLegacy = window.localStorage.getItem(LEGACY_PENDING_TRANSACTION_KEY) === legacyValue
          if (unchangedLegacy) {
            rememberPendingTransaction(
              pendingTransaction.hash,
              pendingTransaction.sender,
              pendingTransaction.nonce,
              pendingTransaction.nonceProvisional,
            )
          } else {
            return rereadPendingTransaction()
          }
        }
        return pendingTransaction
      }
      pendingTransaction = storedTransaction || legacyTransaction || pendingTransaction
      if (pendingTransaction && legacyNeedsNormalization) {
        const unchangedLegacy = window.localStorage.getItem(LEGACY_PENDING_TRANSACTION_KEY) === legacyValue
        if (unchangedLegacy) {
          rememberPendingTransaction(
            pendingTransaction.hash,
            pendingTransaction.sender,
            pendingTransaction.nonce,
            pendingTransaction.nonceProvisional,
          )
        } else {
          return rereadPendingTransaction()
        }
      }
      if (pendingTransaction) {
        const normalizedPendingHash = pendingTransaction.hash.toLowerCase()
        const reconciledHash = window.localStorage.getItem(RECONCILED_TRANSACTION_KEY)?.toLowerCase()
        if (reconciledTransactionHashes.has(normalizedPendingHash) || reconciledHash === normalizedPendingHash) {
          pendingTransaction = null
        }
      }
    } catch {
      // Some wallet browsers disable storage; the in-memory lock still prevents same-page retries.
    }
    return pendingTransaction
  }

  function rereadPendingTransaction() {
    const inMemoryTransaction = pendingTransaction
    pendingTransaction = null
    const storedTransaction = readPendingTransaction()
    if (!storageReadSucceeded) pendingTransaction = inMemoryTransaction
    return pendingTransaction || storedTransaction
  }

  function rememberPendingTransaction(transactionHash, sender, nonce, nonceProvisional) {
    reconciledTransactionHashes.delete(transactionHash.toLowerCase())
    pendingTransaction = {
      hash: transactionHash,
      sender: sender.toLowerCase(),
      nonce,
      nonceProvisional,
    }
    try {
      // Keep v0 as a raw hash so an already-open older tab cannot delete or bypass the lock.
      window.localStorage.setItem(LEGACY_PENDING_TRANSACTION_KEY, transactionHash)
      window.localStorage.setItem(PENDING_TRANSACTION_KEY, JSON.stringify(pendingTransaction))
    } catch {
      // Some wallet browsers disable storage; retain the in-memory lock for this page.
    }
  }

  function storedTransactionHash(value) {
    if (/^0x[0-9a-f]{64}$/i.test(value || '')) return value.toLowerCase()
    return parsePendingTransaction(value, false)?.hash.toLowerCase() || null
  }

  function forgetPendingTransaction(expectedHash) {
    const normalizedExpectedHash = expectedHash.toLowerCase()
    try {
      for (const key of [LEGACY_PENDING_TRANSACTION_KEY, PENDING_TRANSACTION_KEY]) {
        const storedValue = window.localStorage.getItem(key)
        if (!storedValue) continue
        const storedHash = storedTransactionHash(storedValue)
        if (storedHash !== normalizedExpectedHash) return false
      }
      // localStorage has no atomic compare-and-delete. Keep the reconciled hash
      // as a durable tombstone so a cached pre-Web-Locks tab cannot replace it
      // between a comparison and deletion. The next broadcast atomically
      // supersedes both records, while this page ignores the reconciled hash.
      window.localStorage.setItem(RECONCILED_TRANSACTION_KEY, normalizedExpectedHash)
      reconciledTransactionHashes.add(normalizedExpectedHash)
      pendingTransaction = null
      return true
    } catch {
      // Fail closed if storage cannot prove that the reconciled lock is still current.
      return false
    }
  }

  async function assertRobinhoodChain(provider) {
    const chainId = String(await provider.request({ method: 'eth_chainId' })).toLowerCase()
    if (chainId !== CHAIN_ID_HEX) throw new Error('Wallet left Robinhood Chain (4663); broadcast refused')
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

  async function waitForPendingResolution(provider, transaction) {
    let nonce = transaction.nonce
    let consecutiveMissingChecks = 0
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const receipt = await provider.request({
        method: 'eth_getTransactionReceipt',
        params: [transaction.hash],
      })
      if (receipt) return { receipt, replaced: false }

      const submittedTransaction = await provider.request({
        method: 'eth_getTransactionByHash',
        params: [transaction.hash],
      })
      consecutiveMissingChecks = submittedTransaction ? 0 : consecutiveMissingChecks + 1
      if (submittedTransaction?.nonce && (transaction.nonceProvisional || submittedTransaction.nonce !== nonce)) {
        nonce = submittedTransaction.nonce
        transaction.nonceProvisional = false
        rememberPendingTransaction(transaction.hash, transaction.sender, nonce, false)
      }
      if (nonce) {
        const confirmedNonce = await provider.request({
          method: 'eth_getTransactionCount',
          params: [transaction.sender, 'latest'],
        })
        if (BigInt(confirmedNonce) > BigInt(nonce)) return { receipt: null, replaced: true }
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    if (consecutiveMissingChecks === 120) {
      await assertRobinhoodChain(provider)
      const lockBeforeConfirmation = rereadPendingTransaction()
      if (!lockBeforeConfirmation || lockBeforeConfirmation.hash.toLowerCase() !== transaction.hash.toLowerCase()) {
        throw new Error('A newer ceremony transaction lock appeared; stale retirement refused')
      }
      const [confirmedNonce, nextPendingNonce] = await Promise.all([
        provider.request({
          method: 'eth_getTransactionCount',
          params: [transaction.sender, 'latest'],
        }),
        provider.request({
          method: 'eth_getTransactionCount',
          params: [transaction.sender, 'pending'],
        }),
      ])
      if (nonce) {
        if (BigInt(confirmedNonce) > BigInt(nonce)) return { receipt: null, replaced: true }
        if (BigInt(nextPendingNonce) > BigInt(nonce)) {
          throw new Error(`A same-nonce replacement is still pending; retry remains locked: ${transaction.hash}`)
        }
      } else if (BigInt(nextPendingNonce) !== BigInt(confirmedNonce)) {
        throw new Error(`The sender still has a pending transaction; legacy retry remains locked: ${transaction.hash}`)
      }
      const warning = nonce
        ? `The wallet RPC no longer knows transaction ${transaction.hash}, its nonce was not consumed, and no ` +
          'same-nonce replacement is pending. Only continue if your wallet also marks it as dropped. Retire this ' +
          'stale hash and recheck Safe state?'
        : `The wallet RPC no longer knows legacy transaction ${transaction.hash}, and the sender has no pending ` +
          'transactions. Only continue if your wallet also marks it as dropped. Retire this stale hash and ' +
          'recheck Safe state?'
      if (window.confirm(warning)) {
        await assertRobinhoodChain(provider)
        const lockAfterConfirmation = rereadPendingTransaction()
        if (!lockAfterConfirmation || lockAfterConfirmation.hash.toLowerCase() !== transaction.hash.toLowerCase()) {
          throw new Error('A newer ceremony transaction lock appeared during confirmation; retirement refused')
        }
        const [receiptAfterConfirmation, transactionAfterConfirmation] = await Promise.all([
          provider.request({
            method: 'eth_getTransactionReceipt',
            params: [transaction.hash],
          }),
          provider.request({
            method: 'eth_getTransactionByHash',
            params: [transaction.hash],
          }),
        ])
        if (receiptAfterConfirmation) return { receipt: receiptAfterConfirmation, replaced: false }
        if (transactionAfterConfirmation) {
          throw new Error(`Transaction reappeared while confirmation was open; retry remains locked: ${transaction.hash}`)
        }
        const [confirmedAfterConfirmation, pendingAfterConfirmation] = await Promise.all([
          provider.request({
            method: 'eth_getTransactionCount',
            params: [transaction.sender, 'latest'],
          }),
          provider.request({
            method: 'eth_getTransactionCount',
            params: [transaction.sender, 'pending'],
          }),
        ])
        if (nonce && BigInt(confirmedAfterConfirmation) > BigInt(nonce)) {
          return { receipt: null, replaced: true }
        }
        if (
          (nonce && BigInt(pendingAfterConfirmation) > BigInt(nonce)) ||
          (!nonce && BigInt(pendingAfterConfirmation) !== BigInt(confirmedAfterConfirmation))
        ) {
          throw new Error(`A replacement appeared during confirmation; retry remains locked: ${transaction.hash}`)
        }
        return { receipt: null, replaced: false, dropped: true }
      }
    }
    throw new Error(`Receipt timeout; verify transaction manually: ${transaction.hash}`)
  }

  async function reconcilePendingTransaction(provider) {
    const transaction = readPendingTransaction()
    if (!transaction) return
    setStatus(`Previous transaction still requires reconciliation: ${transaction.hash}\nWaiting for its receipt or nonce replacement…`)
    const { receipt, replaced, dropped } = await waitForPendingResolution(provider, transaction)
    if (!forgetPendingTransaction(transaction.hash)) {
      throw new Error('A newer ceremony transaction lock exists; reconcile it before continuing')
    }
    if (receipt && receipt.status !== '0x1') throw new Error(`Previous transaction reverted: ${transaction.hash}`)
    if (replaced || dropped) {
      const reason = replaced ? 'nonce was consumed by a replacement' : 'hash was confirmed dropped'
      setStatus(`Previous transaction ${reason}.\nRechecking canonical Safe state…`)
    }
  }

  async function broadcastAndConfirm(provider, transaction, label) {
    // The initial network switch is not sufficient: wallets may change chains
    // while the user reviews a confirmation prompt.
    await assertRobinhoodChain(provider)
    const pendingNonce = await provider.request({
      method: 'eth_getTransactionCount',
      params: [transaction.from, 'pending'],
    })
    const confirmedNonce = await provider.request({
      method: 'eth_getTransactionCount',
      params: [transaction.from, 'latest'],
    })
    if (BigInt(pendingNonce) !== BigInt(confirmedNonce)) {
      throw new Error('The sender already has a pending transaction; broadcast refused')
    }
    const transactionHash = await provider.request({
      method: 'eth_sendTransaction',
      params: [transaction],
    })
    // Persist before any fallible follow-up RPC call. The pre-send pending
    // count is provisional until the submitted transaction becomes visible.
    rememberPendingTransaction(transactionHash, transaction.from, pendingNonce, true)
    try {
      const submittedTransaction = await provider.request({
        method: 'eth_getTransactionByHash',
        params: [transactionHash],
      })
      if (submittedTransaction?.nonce) {
        rememberPendingTransaction(transactionHash, transaction.from, submittedTransaction.nonce, false)
      }
    } catch {
      // Receipt polling will enrich the provisional nonce once the transaction appears.
    }
    setStatus(`${label} broadcast: ${transactionHash}\nWaiting for confirmation…`)
    const { receipt } = await waitForPendingResolution(provider, pendingTransaction)
    if (!forgetPendingTransaction(transactionHash)) {
      throw new Error('A newer ceremony transaction lock exists; reconcile it before continuing')
    }
    if (receipt && receipt.status !== '0x1') throw new Error(`Transaction reverted: ${transactionHash}`)
    return transactionHash
  }

  async function verifyDependencies(provider) {
    for (const [address, expectedHash] of EXPECTED_CODE_HASHES) {
      const code = await provider.request({ method: 'eth_getCode', params: [address, 'latest'] })
      if (code === '0x') throw new Error(`Required Safe dependency is absent: ${address}`)
      const hash = await provider.request({ method: 'web3_sha3', params: [code] })
      if (hash.toLowerCase() !== expectedHash) throw new Error(`Safe dependency code mismatch: ${address}`)
    }
  }

  async function verifySafeSingleton(provider) {
    const storage = await provider.request({
      method: 'eth_getStorageAt',
      params: [EXPECTED_SAFE, '0x0', 'latest'],
    })
    const installedSingleton = `0x${stripHex(storage).slice(-40)}`.toLowerCase()
    if (installedSingleton !== FINAL_SINGLETON) {
      throw new Error(`Safe singleton mismatch: ${installedSingleton}`)
    }
  }

  function decodeOwners(result) {
    const hex = stripHex(result)
    if (hex.length < 128) throw new Error('Malformed getOwners response')
    const offset = Number(BigInt(`0x${hex.slice(0, 64)}`)) * 2
    const count = Number(BigInt(`0x${hex.slice(offset, offset + 64)}`))
    if (count < 1 || count > 10 || hex.length < offset + 64 + count * 64) throw new Error('Invalid owner count')
    return Array.from({ length: count }, (_, index) =>
      `0x${hex.slice(offset + 64 + index * 64 + 24, offset + 64 + (index + 1) * 64)}`,
    )
  }

  async function safeState(provider) {
    const [ownersResult, thresholdResult, nonceResult] = await Promise.all([
      provider.request({ method: 'eth_call', params: [{ to: EXPECTED_SAFE, data: '0xa0e67e2b' }, 'latest'] }),
      provider.request({ method: 'eth_call', params: [{ to: EXPECTED_SAFE, data: '0xe75235b8' }, 'latest'] }),
      provider.request({ method: 'eth_call', params: [{ to: EXPECTED_SAFE, data: '0xaffed0e0' }, 'latest'] }),
    ])
    return {
      owners: decodeOwners(ownersResult),
      threshold: Number(BigInt(thresholdResult)),
      nonce: BigInt(nonceResult),
    }
  }

  function normalizeSignature(signature) {
    const hex = stripHex(signature)
    if (!/^[0-9a-f]{130}$/i.test(hex)) throw new Error('Wallet returned a malformed signature')
    const recovery = Number.parseInt(hex.slice(128, 130), 16)
    const normalizedRecovery = recovery < 27 ? recovery + 27 : recovery
    if (normalizedRecovery !== 27 && normalizedRecovery !== 28) throw new Error('Wallet returned an invalid recovery ID')
    return `${hex.slice(0, 128)}${normalizedRecovery.toString(16).padStart(2, '0')}`
  }

  function encodeExecTransaction(data, signature) {
    const dataEncoded = bytesPart(data)
    const signatureEncoded = bytesPart(`0x${signature}`)
    const dataOffset = 10 * 32
    const signaturesOffset = dataOffset + dataEncoded.length / 2
    return `0x6a761202${[
      addressWord(EXPECTED_SAFE),
      word(0),
      word(dataOffset),
      word(0),
      word(0),
      word(0),
      word(0),
      addressWord(ZERO_ADDRESS),
      addressWord(ZERO_ADDRESS),
      word(signaturesOffset),
      dataEncoded,
      signatureEncoded,
    ].join('')}`
  }

  async function addOwner(provider, sender, owner, threshold, expectedState, label) {
    const state = await safeState(provider)
    if (!sameAddresses(state.owners, expectedState.owners) || state.threshold !== expectedState.threshold) {
      throw new Error(`Unexpected Safe state before ${label}; refused`)
    }
    const data = owner === SECOND_OWNER ? ADD_SECOND_OWNER : ADD_THIRD_OWNER
    const typedData = {
      types: {
        EIP712Domain: [
          { name: 'chainId', type: 'uint256' },
          { name: 'verifyingContract', type: 'address' },
        ],
        SafeTx: [
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'data', type: 'bytes' },
          { name: 'operation', type: 'uint8' },
          { name: 'safeTxGas', type: 'uint256' },
          { name: 'baseGas', type: 'uint256' },
          { name: 'gasPrice', type: 'uint256' },
          { name: 'gasToken', type: 'address' },
          { name: 'refundReceiver', type: 'address' },
          { name: 'nonce', type: 'uint256' },
        ],
      },
      domain: { chainId: CHAIN_ID, verifyingContract: EXPECTED_SAFE },
      primaryType: 'SafeTx',
      message: {
        to: EXPECTED_SAFE,
        value: '0',
        data,
        operation: 0,
        safeTxGas: '0',
        baseGas: '0',
        gasPrice: '0',
        gasToken: ZERO_ADDRESS,
        refundReceiver: ZERO_ADDRESS,
        nonce: state.nonce.toString(),
      },
    }
    setStatus(`${label}: request 1 wallet signature, then 1 transaction confirmation.`)
    const signature = normalizeSignature(await provider.request({
      method: 'eth_signTypedData_v4',
      params: [sender, JSON.stringify(typedData)],
    }))
    const execData = encodeExecTransaction(data, signature)
    const gasEstimate = BigInt(await provider.request({
      method: 'eth_estimateGas',
      params: [{ from: sender, to: EXPECTED_SAFE, data: execData, value: '0x0' }],
    }))
    return broadcastAndConfirm(provider, {
      from: sender,
      to: EXPECTED_SAFE,
      data: execData,
      value: '0x0',
      gas: `0x${((gasEstimate * 120n) / 100n).toString(16)}`,
    }, label)
  }

  async function deployAndConfigure() {
    button.disabled = true
    try {
      const provider = window.ethereum
      if (!provider?.request) throw new Error("Wallet provider not found. Open this page inside your wallet's browser.")
      await switchToRobinhood(provider)
      const accounts = await provider.request({ method: 'eth_requestAccounts' })
      const sender = String(accounts[0] || '').toLowerCase()
      if (sender !== EXPECTED_SENDER) throw new Error(`Wrong wallet: ${sender || 'none'}`)
      await reconcilePendingTransaction(provider)

      setStatus('Verifying Safe dependency bytecode and deterministic deployment…')
      await verifyDependencies(provider)
      let safeCode = await provider.request({ method: 'eth_getCode', params: [EXPECTED_SAFE, 'latest'] })
      let deploymentHash = null
      if (safeCode === '0x') {
        const predictedResult = await provider.request({
          method: 'eth_call',
          params: [{ from: sender, to: FACTORY, data: DEPLOY_DATA, value: '0x0' }, 'latest'],
        })
        if (`0x${stripHex(predictedResult).slice(-40)}`.toLowerCase() !== EXPECTED_SAFE) {
          throw new Error('Factory did not predict the canonical fee Safe address')
        }
        const gasEstimate = BigInt(await provider.request({
          method: 'eth_estimateGas',
          params: [{ from: sender, to: FACTORY, data: DEPLOY_DATA, value: '0x0' }],
        }))
        if (gasEstimate < 100_000n || gasEstimate > 2_000_000n) throw new Error('Unexpected deployment gas estimate')
        setStatus(`Verified canonical address ${EXPECTED_SAFE}.\nConfirm the 0 ETH Safe deployment transaction.`)
        deploymentHash = await broadcastAndConfirm(provider, {
          from: sender,
          to: FACTORY,
          data: DEPLOY_DATA,
          value: '0x0',
          gas: `0x${((gasEstimate * 120n) / 100n).toString(16)}`,
        }, 'Deployment')
        safeCode = await provider.request({ method: 'eth_getCode', params: [EXPECTED_SAFE, 'latest'] })
        if (safeCode === '0x') throw new Error('Deployment receipt succeeded but Safe code is absent')
      }
      await verifySafeSingleton(provider)

      let state = await safeState(provider)
      let secondOwnerHash = null
      let thirdOwnerHash = null
      if (sameAddresses(state.owners, [EXPECTED_SENDER]) && state.threshold === 1) {
        secondOwnerHash = await addOwner(
          provider,
          sender,
          SECOND_OWNER,
          1,
          { owners: [EXPECTED_SENDER], threshold: 1 },
          'Add owner 2 of 3',
        )
        state = await safeState(provider)
      }
      if (sameAddresses(state.owners, [EXPECTED_SENDER, SECOND_OWNER]) && state.threshold === 1) {
        thirdOwnerHash = await addOwner(
          provider,
          sender,
          THIRD_OWNER,
          2,
          { owners: [EXPECTED_SENDER, SECOND_OWNER], threshold: 1 },
          'Add owner 3 of 3 and set threshold 2',
        )
        state = await safeState(provider)
      }
      const finalOwners = [EXPECTED_SENDER, SECOND_OWNER, THIRD_OWNER]
      if (!sameAddresses(state.owners, finalOwners) || state.threshold !== 2) {
        throw new Error('Final Safe owners or threshold do not match the canonical 2-of-3 policy')
      }

      setStatus([
        'SAFE DEPLOYMENT COMPLETE',
        `Safe: ${EXPECTED_SAFE}`,
        `Owners: ${state.owners.join(', ')}`,
        `Threshold: ${state.threshold}`,
        deploymentHash ? `Deployment: ${deploymentHash}` : 'Deployment: already present',
        secondOwnerHash ? `Owner 2: ${secondOwnerHash}` : 'Owner 2: already configured',
        thirdOwnerHash ? `Owner 3: ${thirdOwnerHash}` : 'Owner 3: already configured',
      ].join('\n'))
      button.textContent = 'Safe configured'
    } catch (error) {
      const unresolvedTransaction = readPendingTransaction()
      if (unresolvedTransaction) {
        setStatus([
          'TRANSACTION STILL PENDING — RETRY LOCKED',
          unresolvedTransaction.hash,
          error?.message || String(error),
          'Keep this page open or press the button after reloading to resume receipt reconciliation.',
        ].join('\n'))
      } else {
        setStatus(`REFUSED / STOPPED\n${error?.message || String(error)}`)
        button.disabled = false
      }
    }
  }

  async function runExclusiveCeremony() {
    if (!navigator.locks?.request) {
      setStatus('REFUSED / STOPPED\nThis wallet browser does not support the cross-tab Web Locks safety API.')
      return
    }
    await navigator.locks.request(CEREMONY_BROWSER_LOCK, { ifAvailable: true }, async (lock) => {
      if (!lock) {
        setStatus('REFUSED / STOPPED\nAnother tab is already running the Robinhood Safe ceremony.')
        return
      }
      await deployAndConfigure()
    })
  }

  if (window.__OPHIS_FEE_SAFE_TEST_HOOKS__) {
    Object.assign(window.__OPHIS_FEE_SAFE_TEST_HOOKS__, {
      forgetPendingTransaction,
      readPendingTransaction,
      rememberPendingTransaction,
      rereadPendingTransaction,
      waitForPendingResolution,
    })
  }

  button.addEventListener('click', runExclusiveCeremony)
})()
