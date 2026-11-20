/** @jest-environment node */
import { ACROSS_V5_ADAPTER, acrossV5Program } from '@cowprotocol/common-const'
import { setGlobalAdapter, SupportedChainId } from '@cowprotocol/cow-sdk'
import { CowShedSdk } from '@cowprotocol/sdk-cow-shed'
import { EthersV5Adapter } from '@cowprotocol/sdk-ethers-v5-adapter'
import { Interface } from '@ethersproject/abi'
import { keccak256 } from '@ethersproject/keccak256'
import { JsonRpcProvider } from '@ethersproject/providers'
import { toUtf8Bytes } from '@ethersproject/strings'
import { Wallet } from '@ethersproject/wallet'

const BASE = SupportedChainId.BASE
const TOKEN = '0x4200000000000000000000000000000000000006'
const ABI = new Interface([
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
  'function storedFunding(bytes32,address) view returns (uint256)',
  'event PrefundingStored(bytes32 indexed witness,address token,uint256 amount)',
])
const forkTest = process.env.OPHIS_ACROSS_FORK_RPC ? it : it.skip

forkTest(
  'prefunds a fixed V5 order, returns the remainder, and prevents early execution and replay',
  async () => {
    const rpc = process.env.OPHIS_ACROSS_FORK_RPC ?? ''
    expect(['localhost', '127.0.0.1']).toContain(new URL(rpc).hostname)
    const provider = new JsonRpcProvider(rpc)
    expect(String(await provider.send('web3_clientVersion', []))).toMatch(/anvil/i)
    expect((await provider.getNetwork()).chainId).toBe(BASE)
    expect(await provider.getCode(ACROSS_V5_ADAPTER)).not.toBe('0x')
    const snapshot = await provider.send('evm_snapshot', [])
    try {
      await provider.send('evm_mine', [])
      const owner = new Wallet(keccak256(toUtf8Bytes('Ophis Across V5 isolated fork owner')), provider)
      await provider.send('anvil_setBalance', [owner.address, '0x56bc75e2d63100000'])
      const adapter = new EthersV5Adapter({ provider, signer: owner })
      setGlobalAdapter(adapter)
      const sdk = new CowShedSdk(adapter)
      const shed = sdk.getCowShedAccount(BASE, owner.address)
      const amount = 10n ** 16n
      const surplus = 123_456n
      const witness = keccak256(toUtf8Bytes('Ophis Across V5 isolated fork witness'))
      const call = acrossV5Program(
        {
          originChainId: BASE,
          destinationChainId: 10,
          inputToken: TOKEN,
          outputToken: TOKEN,
          depositor: shed,
          recipient: owner.address,
          amount: String(amount),
        },
        witness,
        owner.address,
      )
      const { signedMulticall } = await sdk.signCalls({
        calls: [{ target: call.to, callData: call.data, value: call.value, allowFailure: false, isDelegateCall: true }],
        chainId: BASE,
        nonce: keccak256(toUtf8Bytes('Ophis Across V5 isolated fork nonce')),
        deadline: BigInt((await provider.getBlock('latest')).timestamp + 900),
        gasLimit: 800_000n,
      })
      const tx = { to: signedMulticall.to, data: signedMulticall.data, gasLimit: 800_000 }
      await expect((await owner.sendTransaction(tx)).wait()).rejects.toThrow()
      await (
        await owner.sendTransaction({
          to: TOKEN,
          data: '0xd0e30db0',
          value: String(amount + surplus),
          gasLimit: 120_000,
        })
      ).wait()
      await (
        await owner.sendTransaction({
          to: TOKEN,
          data: ABI.encodeFunctionData('transfer', [shed, String(amount + surplus)]),
          gasLimit: 120_000,
        })
      ).wait()
      const receipt = await (await owner.sendTransaction(tx)).wait()
      expect(receipt.status).toBe(1)
      expect(receipt.gasUsed.toNumber()).toBeLessThan(800_000)
      const balanceOf = async (account: string): Promise<bigint> =>
        BigInt(await provider.call({ to: TOKEN, data: ABI.encodeFunctionData('balanceOf', [account]) }))
      expect(await balanceOf(owner.address)).toBe(surplus)
      expect(await balanceOf(shed)).toBe(0n)
      const allowance = ABI.encodeFunctionData('allowance', [shed, ACROSS_V5_ADAPTER])
      expect(BigInt(await provider.call({ to: TOKEN, data: allowance }))).toBe(0n)
      const stored = ABI.encodeFunctionData('storedFunding', [witness, TOKEN])
      expect(BigInt(await provider.call({ to: ACROSS_V5_ADAPTER, data: stored }))).toBe(amount)
      const log = receipt.logs.find((item) => item.address.toLowerCase() === ACROSS_V5_ADAPTER)
      expect(log && ABI.parseLog(log).args.witness).toBe(witness)
      await expect((await owner.sendTransaction(tx)).wait()).rejects.toThrow()
    } finally {
      await provider.send('evm_revert', [snapshot])
    }
  },
  90_000,
)
