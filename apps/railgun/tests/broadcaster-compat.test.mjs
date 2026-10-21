import { expect, it } from 'vitest'
import { BroadcasterTransaction } from '@railgun-community/waku-broadcaster-client-web'
import { decryptAESGCM256 } from '@railgun-community/wallet'
import { BroadcasterTransactRequestType } from '@railgun-community/shared-models'
import { Wallet, verifyAuthorization } from 'ethers'
import { CONFIG, FEE_SIGNER, VERSION } from '../src/config'

it('encrypts compatible common and 7702 broadcaster envelopes with wallet11.2, without transmitting', async () => {
  const wallet = Wallet.createRandom()
  const authorization = await wallet.authorize({
    address: CONFIG.relayAdapt7702Contract,
    chainId: 1,
    nonce: 0,
  })
  const fees = { gasLimit: 3_600_000n, maxFeePerGas: 1_000_000n, maxPriorityFeePerGas: 100_000n }
  const poi = { testLeaf: { testList: { proof: 'compatibility-only' } } }
  for (const use7702 of [false, true]) {
    // Exercise the client's real serializer/crypto; never call send() or disclose this envelope.
    const encrypted = await BroadcasterTransaction.encryptTransaction(
      VERSION,
      wallet.address,
      '0x1234',
      FEE_SIGNER,
      'local-compatibility-fee',
      CONFIG.chain,
      42n,
      use7702,
      poi,
      use7702 ? authorization : undefined,
      use7702 ? fees : undefined,
    )
    const data = decryptAESGCM256(encrypted.encryptedData, encrypted.sharedKey)
    expect(data.to).toBe(wallet.address)
    expect(data.data).toBe('0x1234')
    expect(data.preTransactionPOIsPerTxidLeafPerList).toEqual(poi)
    expect(data.transactType).toBe(
      use7702 ? BroadcasterTransactRequestType.TX7702 : BroadcasterTransactRequestType.COMMON,
    )
    if (use7702) {
      expect(data.gasLimit).toBe('3600000')
      expect(data.maxFeePerGas).toBe('1000000')
      expect(data.maxPriorityFeePerGas).toBe('100000')
      expect(verifyAuthorization(data.authorization, data.authorization.signature)).toBe(
        wallet.address,
      )
    } else expect(data.minGasPrice).toBe('42')
  }
})
