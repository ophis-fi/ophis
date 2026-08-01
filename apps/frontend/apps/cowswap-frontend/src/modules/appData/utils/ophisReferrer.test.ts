import { ophisReferrerForRefCode } from './ophisReferrer'

describe('ophisReferrerForRefCode', () => {
  it('emits an ophisReferrer tag for a registered on-chain partner code (Mt Pelerin)', () => {
    // The partner arm carries attribution on-chain (metadata.ophisReferrer.code), so the
    // rebate indexer credits it per-trade from chain — outage-proof, non-net-new.
    expect(ophisReferrerForRefCode('mtpelerin')).toEqual({ code: 'mtpelerin' })
  })

  it('normalizes case + surrounding whitespace to the canonical lowercase code', () => {
    // RefCodeCaptureUpdater lowercases before signing/binding; the on-chain tag MUST match
    // so the indexer's lowercase registry lookup and the DB ref_codes row both agree.
    expect(ophisReferrerForRefCode('MtPelerin')).toEqual({ code: 'mtpelerin' })
    expect(ophisReferrerForRefCode('  MTPELERIN  ')).toEqual({ code: 'mtpelerin' })
  })

  it('emits NOTHING for affiliate / unknown codes (they stay on the net-new /ref/bind arm)', () => {
    // An ordinary affiliate code is absent from the partner allowlist → no on-chain tag, so
    // the net-new anti-farming gate on /ref/bind is preserved for shared affiliate links.
    expect(ophisReferrerForRefCode('somebody')).toBeUndefined()
    expect(ophisReferrerForRefCode('affiliate123')).toBeUndefined()
  })

  it('emits nothing when no ref code is present', () => {
    expect(ophisReferrerForRefCode(undefined)).toBeUndefined()
    expect(ophisReferrerForRefCode('')).toBeUndefined()
  })
})
