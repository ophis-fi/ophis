import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { id, Transaction, Wallet, ZeroAddress, type JsonRpcProvider, type TransactionReceipt } from 'ethers'
import { Store } from '../src/storage'
import { CreditLedger, creditCharge, type CreditAttempt } from '../src/credit'
import { assertNativeRefundTrace, nativeBackingEvidence, verifyNativeBacking, verifyNativeDeposit } from '../src/credit-native-payment'
import { finalizedCreditReceipt } from '../src/credit-payment'
import { nativeCreditData } from '../../railgun/credit-protocol'
import { CHAIN, CHAIN_ID } from '../src/config'
import { recover } from '../src/recovery'
import { config } from './request.fixture'
const roots: string[] = [], stores: Store[] = []
afterEach(() => { vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ophis-native-credit-')); roots.push(root)
  const store = new Store(root); stores.push(store)
  const operator = Wallet.createRandom(), payer = Wallet.createRandom(), owner = Wallet.createRandom().address, recipient = Wallet.createRandom().address
  const scope = { chainId: CHAIN_ID, operator: operator.address, recipient: operator.address, token: ZeroAddress, funding: 'native' as const }
  const ledger = new CreditLedger(store, scope), timestamp = Math.floor(Date.now() / 1000)
  const state = { balance: 101_000_000n, nonce: 0, head: 100, finalized: 99, code: '0x' }
  const changed = new Map<number,string>(), txs = new Map<string, any>(), receipts = new Map<string, TransactionReceipt>()
  const block = (number: number) => ({ number, hash: changed.get(number) ?? id(`native block ${number}`), timestamp, baseFeePerGas: 1n })
  const provider = { getNetwork: vi.fn(async () => ({ chainId: CHAIN })),
    getBlock: vi.fn(async (tag: number|string) => block(tag === 'latest' ? state.head : tag === 'finalized' ? state.finalized : Number(tag))),
    getTransactionReceipt: vi.fn(async (hash: string) => receipts.get(hash) ?? null),
    getTransaction: vi.fn(async (hash: string) => txs.get(hash) ?? null),
    getCode: vi.fn(async () => state.code), getBalance: vi.fn(async () => state.balance), getTransactionCount: vi.fn(async () => state.nonce),
  } as unknown as JsonRpcProvider
  async function payment(paymentId = id('payment one'), suffix = '', amount = 100_000_000n, claimant = owner) {
    const hash = id(`native transaction ${paymentId}${suffix}`), b = block(90)
    const tx = { hash, chainId: CHAIN, type: 2, authorizationList: null as unknown[]|null, from: payer.address, to: operator.address,
      value: amount, data: nativeCreditData(scope, ledger.id, claimant, paymentId), blockNumber: b.number, blockHash: b.hash }
    const receipt = { hash, from: tx.from, to: tx.to, blockNumber: b.number, blockHash: b.hash, status: 1, gasUsed: 22_000n, gasPrice: 100n } as TransactionReceipt
    txs.set(hash,tx); receipts.set(hash,receipt)
    return { tx, receipt, paymentId, proof: () => verifyNativeDeposit(provider,scope,ledger.id,claimant,paymentId,hash) }
  }
  const backing = () => verifyNativeBacking(provider, scope, ledger.id, ledger.nativeDeposits(), ledger.nativeSettlements())
  async function reservation(refund = false, overrides: Partial<CreditAttempt> = {}) {
    const net = refund ? 20_000_000n : 0n, gas = refund ? 21_000n : 100_000n, rate = 115n * 10n ** 16n
    const unsigned = Transaction.from({ type: 2, chainId: CHAIN, nonce: state.nonce, to: recipient, value: net,
      data: '0x', gasLimit: gas, maxFeePerGas: 100n, maxPriorityFeePerGas: 1n }).unsignedSerialized
    return { key: id(`operation ${state.nonce}`), owner, sequence: ledger.nextSequence(owner), envelope: 'encrypted', unsigned,
      nonce: state.nonce, gasBudget: gas * 100n, maximumCharge: net + creditCharge(10_000_000n,rate,0n), rate,
      collectionAllowance: 0n, expiration: Date.now()+60_000, dailyBudget: 1_000_000_000n, backing: await backing(),
      nativeReserve: 1_000_000n, ...(refund ? { nativeRefund: { recipient,net } } : {}), ...overrides } as CreditAttempt
  }
  async function include(raw: string, status = 1, gasUsed = 21_000n, gasPrice = 100n) {
    const tx = Transaction.from(raw), b = block(100)
    const receipt = { hash: tx.hash!, from: tx.from!,to: tx.to, blockNumber:b.number,blockHash:b.hash,status,gasUsed,gasPrice } as TransactionReceipt
    state.finalized=100;state.nonce=tx.nonce+1;state.balance-=gasUsed*gasPrice+(status===1?tx.value:0n)
    receipts.set(tx.hash!,receipt)
    return finalizedCreditReceipt(provider,tx.hash!)
  }
  const reserveAndSign = async (refund = false) => {
    const attempt = await reservation(refund);ledger.reserve(attempt)
    const raw = await operator.signTransaction(Transaction.from(attempt.unsigned).toJSON());ledger.attachSignature(attempt.key,raw)
    return { attempt,raw }
  }
  return { store,ledger,scope,operator,payer,owner,recipient,state,provider,payment,backing,reservation,include,changed,reserveAndSign }
}
it('credits exact finalized direct native funding once and rejects fabricated evidence', async () => {
  const f=fixture(),p=await f.payment()
  expect(()=>f.ledger.depositNative({kind:'verified-native-credit-deposit'})).toThrow('Fresh verified')
  expect(f.ledger.depositNative(await p.proof())).toBe(true);expect(f.ledger.depositNative(await p.proof())).toBe(false)
  expect(f.ledger.balance(f.owner).available).toBe(100_000_000n);expect(f.ledger.liability()).toBe(100_000_000n);expect(f.ledger.earned()).toBe(0n)
})
it('credits zero-price funding but keeps positive operator inclusion and settlement costs mandatory', async () => {
  const f=fixture(),p=await f.payment()
  Object.assign(p.receipt,{gasPrice:0n})
  expect(f.ledger.depositNative(await p.proof())).toBe(true)
  expect(f.ledger.balance(f.owner).available).toBe(100_000_000n)
  const {attempt,raw}=await f.reserveAndSign(),before=f.ledger.balance(f.owner)
  const receipt=await f.include(raw,1,21_000n,0n)
  expect(()=>f.ledger.observeInclusion(attempt.key,receipt)).toThrow('Invalid prepaid inclusion cost')
  expect(()=>f.ledger.settle(attempt.key,receipt)).toThrow('does not match')
  expect(f.ledger.balance(f.owner)).toEqual(before)
  expect(f.ledger.earned()).toBe(0n)
})
it('quarantines duplicate payment IDs as owed funds, never spendable credit or revenue', async () => {
  const f=fixture(),p=await f.payment();f.ledger.depositNative(await p.proof())
  const duplicate=await f.payment(p.paymentId,'duplicate',5_000_000n),proof=await duplicate.proof()
  expect(()=>f.ledger.depositNative(proof)).toThrow('quarantined');expect(()=>f.ledger.depositNative(proof)).toThrow('quarantined')
  expect(f.ledger.balance(f.owner)).toMatchObject({available:100_000_000n,quarantined:5_000_000n})
  expect(f.ledger.liability()).toBe(105_000_000n);expect(f.ledger.earned()).toBe(0n);expect(f.ledger.nativeDeposits()).toHaveLength(2)
})
it.each(['self','wrong-owner','wrong-id','wrong-ledger','wrong-chain','wrong-recipient','reverted','unfinalized','wrong-block','type4','delegation','operator-code'])('rejects invalid native deposit %s', async kind => {
  const f=fixture(),p=await f.payment()
  if(kind==='self'){p.tx.from=f.operator.address;Object.assign(p.receipt,{from:f.operator.address})}
  if(kind==='wrong-owner')p.tx.data=nativeCreditData(f.scope,f.ledger.id,f.recipient,p.paymentId)
  if(kind==='wrong-id')p.tx.data=nativeCreditData(f.scope,f.ledger.id,f.owner,id('other payment'))
  if(kind==='wrong-ledger')p.tx.data=nativeCreditData(f.scope,id('other ledger'),f.owner,p.paymentId)
  if(kind==='wrong-chain')p.tx.chainId=999n
  if(kind==='wrong-recipient')p.tx.to=f.recipient
  if(kind==='reverted')Object.assign(p.receipt,{status:0})
  if(kind==='unfinalized')f.state.finalized=89
  if(kind==='wrong-block')p.tx.blockHash=id('different')
  if(kind==='type4')p.tx.type=4
  if(kind==='delegation')p.tx.authorizationList=[{}]
  if(kind==='operator-code')f.state.code='0xef0100'
  await expect(p.proof()).rejects.toThrow()
})
it('rejects a funding-mode switch before mutating the existing private journal', () => {
  const f=fixture(),root=mkdtempSync(join(tmpdir(),'ophis-private-mode-'));roots.push(root)
  const store=new Store(root);stores.push(store)
  const privateScope={chainId:CHAIN_ID,operator:f.operator.address,recipient:'0zk1qy08nqrftxezyxdegx6ca055tr65f2hf3u24j9urx04e5fnzepv6nrv7j6fe3z53luvr6qkgtjukzmkcp856gs5a6wzdd3pnesr9r6ljvym9l3a4fcepgkvek3f',token:f.recipient}
  const prior=new CreditLedger(store,privateScope),before=store.db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all()
  expect(()=>new CreditLedger(store,f.scope)).toThrow('identity changed')
  expect(store.db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all()).toEqual(before)
  expect(CreditLedger.load(store).id).toBe(prior.id)
})
it('holds the entire nonce until finality, then backs remaining liabilities without double-counting spent gas', async () => {
  const f=fixture(),p=await f.payment();f.ledger.depositNative(await p.proof())
  f.state.balance=100_999_999n;await expect(f.reservation().then(a=>f.ledger.reserve(a))).rejects.toThrow('liabilities')
  f.state.balance=101_000_000n;const {attempt:a,raw}=await f.reserveAndSign()
  const receipt=await f.include(raw,1,30_000n);f.ledger.observeInclusion(a.key,receipt)
  await expect(f.reservation().then(next=>f.ledger.reserve(next))).rejects.toThrow('Finalize the outstanding')
  expect(f.ledger.settle(a.key,receipt)).toBe(3_450_000n);expect(f.ledger.earned()).toBe(450_000n)
  expect(f.ledger.requiredBacking()).toBe(96_550_000n);f.ledger.reserve(await f.reservation())
})
it.each([1,0])('refund original status %i charges only delivered principal and actual gas margin', async status => {
  const f=fixture(),p=await f.payment();f.ledger.depositNative(await p.proof());const {attempt:a,raw}=await f.reserveAndSign(true)
  const receipt=await f.include(raw,status),fee=2_415_000n,paid=status===1?20_000_000n:0n
  expect(f.ledger.settle(a.key,receipt)).toBe(fee+paid);expect(f.ledger.settle(a.key,receipt)).toBe(fee+paid)
  expect(f.ledger.nativeRefund(a.key)).toMatchObject({paid:paid.toString(),transaction_hash:receipt.hash,status})
  expect(f.ledger.balance(f.owner)).toMatchObject({charged:fee,refunds:paid,available:100_000_000n-fee-paid,reserved:0n})
  expect(f.ledger.earned()).toBe(315_000n);f.ledger.assertNativeBacked(await f.backing(),1_000_000n)
})
it('a cancellation above the original gas estimate but inside its reserved allowance settles without paying the refund', async () => {
  const f=fixture(),p=await f.payment();f.ledger.depositNative(await p.proof());const {attempt:a}=await f.reserveAndSign(true)
  const cancellation=await f.operator.signTransaction({type:2,chainId:CHAIN,nonce:0,to:f.operator.address,value:0n,data:'0x',gasLimit:21000n,maxFeePerGas:200n,maxPriorityFeePerGas:2n})
  f.ledger.assertCancellationCovered(a.key,4_200_000n);f.store.cancel(a.key,cancellation,Transaction.from(cancellation).hash!,4_200_000n,a.dailyBudget)
  expect(f.store.get(a.key)?.max_cost).toBe('4200000')
  expect(f.ledger.settle(a.key,await f.include(cancellation,1,21000n,150n))).toBe(3_622_500n)
  expect(f.ledger.nativeRefund(a.key)?.paid).toBe('0');expect(f.ledger.balance(f.owner).available).toBe(96_377_500n)
})
it('cancellation cannot spend the reserved refund principal', async () => {
  const f=fixture(),p=await f.payment();f.ledger.depositNative(await p.proof());const {attempt:a}=await f.reserveAndSign(true)
  expect(()=>f.ledger.assertCancellationCovered(a.key,10_000_001n)).toThrow('secured prepaid')
  expect(()=>f.store.assertPrepaidCancellationCovered(a.key,10_000_001n)).toThrow('excluding the refund principal')
  expect(f.store.get(a.key)?.cancel_raw).toBeNull()
})
it('deposit ancestry reorg blocks admission despite excess operator capital and cached verification', async () => {
  const f=fixture(),p=await f.payment();f.ledger.depositNative(await p.proof());await f.backing()
  f.state.balance=1_000_000_000_000n;f.changed.set(90,id('orphan deposit'));f.changed.set(99,id('reorg checkpoint'))
  await expect(f.backing()).rejects.toThrow('canonical history')
})
it('settled refund ancestry reorg blocks admission despite excess reserve', async () => {
  const f=fixture(),p=await f.payment();f.ledger.depositNative(await p.proof());const {attempt:a,raw}=await f.reserveAndSign(true)
  f.ledger.settle(a.key,await f.include(raw));await f.backing();f.state.balance=1_000_000_000_000n;f.changed.set(100,id('orphan refund'))
  await expect(f.backing()).rejects.toThrow('canonical history')
})
it('backing is bound to exact history, current nonce and freshness', async () => {
  const f=fixture(),p=await f.payment();f.ledger.depositNative(await p.proof());const prior=await f.backing()
  f.ledger.depositNative(await (await f.payment(id('payment two'))).proof())
  expect(()=>f.ledger.assertNativeBacked(prior,1_000_000n)).toThrow('history')
  f.state.balance=201_000_000n;const proof=await f.backing()
  expect(()=>f.ledger.assertNativeBacked(proof,1_000_000n,1)).toThrow('history')
  const now=Date.now();vi.spyOn(Date,'now').mockReturnValue(now+46_000);expect(()=>nativeBackingEvidence(proof)).toThrow('Fresh verified')
})
it('private owner payment APIs cannot spend native liabilities', () => {
  const f=fixture()
  expect(()=>f.ledger.deposit({} as never)).toThrow('Private owner');expect(()=>f.ledger.accountedNotes()).toThrow('Private owner')
  expect(()=>f.ledger.reserveRefund(id('r'),f.owner,'invalid',10n,5n,1,{} as never,1n)).toThrow('Private owner')
  expect(()=>f.ledger.settleRefund(id('r'),{} as never)).toThrow('Private owner')
  expect(()=>f.ledger.prepareOwnerOperation({} as never,{} as never)).toThrow('Private owner')
  expect(()=>f.ledger.settleOwnerCollection(id('c'),{} as never)).toThrow('Private owner')
  expect(()=>f.ledger.recordOwnerPayout(id('c'),{} as never)).toThrow('Private owner')
  expect(()=>f.ledger.rejectOwnerPayout(id('c'),{} as never)).toThrow('Private owner')
  expect(()=>f.ledger.recordRefundPayout(id('c'),{} as never)).toThrow('Private owner')
})
it('refund trace binds the exact native root and rejects failed nested execution', () => {
  const f=fixture(),expected={from:f.operator.address,to:f.recipient,value:123n}
  const trace={type:'CALL',from:f.operator.address,to:f.recipient,value:'0x7b',input:'0x',gasUsed:'0x5208'}
  expect(()=>assertNativeRefundTrace(trace,expected)).not.toThrow()
  for(const change of [{value:'0x7c'},{from:f.payer.address},{to:f.payer.address},{input:'0x01'},{error:'execution reverted'},
    {calls:[{type:'CALL',error:'execution reverted'}]}])expect(()=>assertNativeRefundTrace({...trace,...change},expected)).toThrow()
})

it('reloads an unsigned native refund reservation with exact recipient/net and preserves its pending status', async () => {
  const f=fixture(),p=await f.payment();f.ledger.depositNative(await p.proof());const a=await f.reservation(true);f.ledger.reserve(a)
  const loaded=CreditLedger.load(f.store)
  expect(loaded.id).toBe(f.ledger.id);expect(loaded.nativeRefund(a.key)).toMatchObject({recipient:f.recipient,net:'20000000',paid:null,transaction_hash:null})
  expect(f.store.get(a.key)?.raw).toBeNull();expect(loaded.balance(f.owner).reserved).toBe(a.maximumCharge)
})
it.each(['recipient','value','data','operator','authorization'])('rejects malformed native refund %s before reserving any credit',async kind=>{
  const f=fixture(),p=await f.payment();f.ledger.depositNative(await p.proof());const a=await f.reservation(true)
  const tx=Transaction.from(a.unsigned)
  if(kind==='recipient')a.nativeRefund!.recipient=f.payer.address
  if(kind==='value')tx.value++
  if(kind==='data')tx.data='0x01'
  if(kind==='operator'){tx.to=f.operator.address;a.nativeRefund!.recipient=f.operator.address}
  if(kind==='authorization'){tx.type=4;tx.authorizationList=[await f.payer.authorize({chainId:CHAIN,nonce:0,address:f.recipient})]}
  a.unsigned=tx.unsignedSerialized
  expect(()=>f.ledger.reserve(a)).toThrow();expect(f.store.get(a.key)).toBeUndefined();expect(f.ledger.balance(f.owner).reserved).toBe(0n)
})
async function recoveryFixture() {
  const f=fixture(),p=await f.payment();f.ledger.depositNative(await p.proof());const a=await f.reservation(true);f.ledger.reserve(a)
  const provider=f.provider as any
  provider.getFeeData=vi.fn(async()=>({gasPrice:1n,maxPriorityFeePerGas:1n}))
  provider.estimateGas=vi.fn(async()=>21000n)
  provider.getRpcTransaction=vi.fn((tx:unknown)=>tx)
  provider.send=vi.fn(async()=>({type:'CALL',from:f.operator.address,to:f.recipient,input:'0x',value:'0x'+a.nativeRefund!.net.toString(16),gasUsed:'0x5208'}))
  const sender={pendingTransaction:vi.fn(()=>undefined),stageSigned:vi.fn(async()=>f.store.get(a.key)!.hash!),stageRecovery:vi.fn(async()=>''),
    retryPending:vi.fn(async()=>f.store.get(a.key)!.hash!),cancelPending:vi.fn(async(raw:string)=>Transaction.from(raw).hash!)}
  const sign=vi.spyOn(f.operator,'signTransaction'),settings={...config,mode:'fork' as const,chainId:CHAIN_ID,reserve:1_000_000n,maxGasPrice:1000n,maxTransactionCost:10_000_000n,dailyBudget:1_000_000_000n}
  const run=(command:'retry'|'cancel',args:string[]=[])=>recover(command,args,settings,f.store,f.provider,f.operator,sender)
  return {...f,a,provider,sender,sign,run}
}
it('native refund recovery restores only its exact held signature and binds the payout trace before disclosure',async()=>{
  const f=await recoveryFixture();expect(await f.run('retry')).toBe(f.store.get(f.a.key)?.hash)
  expect(f.sign).toHaveBeenCalledOnce();expect(f.sender.stageSigned).toHaveBeenCalledOnce();expect(f.sender.retryPending).toHaveBeenCalledOnce()
  expect(Transaction.from(f.store.get(f.a.key)!.raw!).unsignedSerialized).toBe(f.a.unsigned)
  expect(f.ledger.nativeRefund(f.a.key)?.paid).toBeNull();expect(f.ledger.balance(f.owner).reserved).toBe(f.a.maximumCharge)
})
it('native refund recovery refuses mismatched trace and insufficient native backing before disclosure',async()=>{
  const f=await recoveryFixture();f.state.balance=1n
  await expect(f.run('retry')).rejects.toThrow();expect(f.sign).not.toHaveBeenCalled();expect(f.sender.stageSigned).not.toHaveBeenCalled()
  f.state.balance=101_000_000n;f.provider.send.mockResolvedValue({type:'CALL',from:f.operator.address,to:f.payer.address,input:'0x',value:'0x1312d00'})
  await expect(f.run('retry')).rejects.toThrow('approved payout');expect(f.sender.stageSigned).not.toHaveBeenCalled();expect(f.sender.retryPending).not.toHaveBeenCalled()
})
it('native refund cancellation recovery holds principal and permits only its separate reserved gas allowance',async()=>{
  const f=await recoveryFixture();await expect(f.run('cancel',['1000','2'])).rejects.toThrow();expect(f.sign).not.toHaveBeenCalled()
  const hash=await f.run('cancel',['200','2']);expect(f.store.get(f.a.key)?.cancel_hash).toBe(hash)
  expect(f.sender.cancelPending).toHaveBeenCalledOnce();expect(f.sender.retryPending).not.toHaveBeenCalled()
  expect(Transaction.from(f.store.get(f.a.key)!.cancel_raw!).value).toBe(0n);expect(f.ledger.nativeRefund(f.a.key)?.paid).toBeNull()
})

it('native refund recovery recognizes its original held request without retiring or confusing it with execution',async()=>{
  const f=fixture(),p=await f.payment();f.ledger.depositNative(await p.proof());const a=await f.reservation(true);f.ledger.reserve(a)
  expect(f.ledger.retireUnreserved(a.key,f.owner,'refund',a.sequence)).toBe(false)
  expect(()=>f.ledger.retireUnreserved(a.key,f.owner,'execute',a.sequence)).toThrow('recovery identity')
  expect(()=>f.ledger.retireUnreserved(a.key,f.recipient,'refund',a.sequence)).toThrow('recovery identity')
  expect(f.ledger.balance(f.owner).reserved).toBe(a.maximumCharge)
})

it.each([99,100])('rejects native backing when block %i changes after the concurrent header read',async number=>{
  const f=fixture(),p=await f.payment();f.ledger.depositNative(await p.proof())
  vi.mocked(f.provider.getBalance).mockImplementation(async()=>{await Promise.resolve();f.changed.set(number,id('reorg during balance'));return f.state.balance})
  await expect(f.backing()).rejects.toThrow('changed after the balance')
})

it('credits a direct type2 payment even when its payer later acquires delegation in the same block',async()=>{
  const f=fixture(),p=await f.payment()
  vi.mocked(f.provider.getCode).mockImplementation(async address=>address===f.payer.address?'0xef0100'+'11'.repeat(20):'0x')
  expect(f.ledger.depositNative(await p.proof())).toBe(true)
  expect(vi.mocked(f.provider.getCode).mock.calls.some(call=>call[0]===f.payer.address)).toBe(false)
})
