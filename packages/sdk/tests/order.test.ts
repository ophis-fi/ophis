import { describe, it, expect } from 'vitest';
import { ophisOrderReceiver, assertReceiverIsOwner } from '@ophis/sdk';

const OWNER = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01' as const;
const OWNER_LOWER = '0xabcdef0123456789abcdef0123456789abcdef01';
const OTHER = '0x2222222222222222222222222222222222222222' as const;
const ZERO = '0x0000000000000000000000000000000000000000';

describe('ophisOrderReceiver', () => {
  it('pins the receiver to the owner by default', () => {
    expect(ophisOrderReceiver(OWNER)).toBe(OWNER);
    expect(ophisOrderReceiver(OWNER, {})).toBe(OWNER);
  });

  it('returns a non-owner receiver only via the explicit unsafe opt-in', () => {
    expect(ophisOrderReceiver(OWNER, { unsafeCustomReceiver: OTHER })).toBe(OTHER);
  });

  it('throws on a malformed owner or custom receiver', () => {
    expect(() => ophisOrderReceiver('0xnope')).toThrow(/address/);
    expect(() => ophisOrderReceiver(OWNER, { unsafeCustomReceiver: '0x123' })).toThrow(/address/);
  });
});

describe('assertReceiverIsOwner', () => {
  it('passes when receiver equals owner (case-insensitive)', () => {
    expect(() => assertReceiverIsOwner(OWNER, OWNER)).not.toThrow();
    expect(() => assertReceiverIsOwner(OWNER, OWNER_LOWER)).not.toThrow();
  });

  it('treats undefined / zero receiver as owner (CoW default) and passes', () => {
    expect(() => assertReceiverIsOwner(OWNER, undefined)).not.toThrow();
    expect(() => assertReceiverIsOwner(OWNER, ZERO)).not.toThrow();
  });

  it('throws when receiver is a different address (the drain vector)', () => {
    expect(() => assertReceiverIsOwner(OWNER, OTHER)).toThrow(/not the owner/);
  });

  it('allows a custom receiver only with the explicit opt-in', () => {
    expect(() => assertReceiverIsOwner(OWNER, OTHER, { allowCustomReceiver: true })).not.toThrow();
  });

  it('still rejects a malformed receiver even with the custom opt-in', () => {
    expect(() => assertReceiverIsOwner(OWNER, 'not-an-address', { allowCustomReceiver: true })).toThrow(/address/);
  });
});
