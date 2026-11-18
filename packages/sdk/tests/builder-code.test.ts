import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { appendOphisBaseBuilderCode, OPHIS_BASE_BUILDER_CODE, OPHIS_BASE_DATA_SUFFIX } from '../src/builder-code.js';

describe('Base builder code', () => {
  it('matches the supplied ERC-8021 encoding and the independent frontend workspace', () => {
    expect(OPHIS_BASE_DATA_SUFFIX).toBe('0x62635f386a3467743578360b0080218021802180218021802180218021');
    expect(Buffer.from(OPHIS_BASE_DATA_SUFFIX.slice(2, 24), 'hex').toString()).toBe(OPHIS_BASE_BUILDER_CODE);
    const frontend = readFileSync(new URL('../../../apps/frontend/libs/wallet-provider/src/baseBuilderCode.ts', import.meta.url), 'utf8');
    expect(frontend).toContain(`OPHIS_BASE_BUILDER_CODE = '${OPHIS_BASE_BUILDER_CODE}'`);
    expect(frontend).toContain(`OPHIS_BASE_DATA_SUFFIX = '${OPHIS_BASE_DATA_SUFFIX}'`);
  });
  it('attributes Base function calldata once and preserves other chains and existing suffixes', () => {
    const data = '0xd0e30db0';
    const tagged = appendOphisBaseBuilderCode(data, 8453);
    expect(tagged).toBe(data + OPHIS_BASE_DATA_SUFFIX.slice(2));
    expect(appendOphisBaseBuilderCode(tagged, 8453)).toBe(tagged);
    for (const chain of [1, 10, 130, 84532, 5042]) expect(appendOphisBaseBuilderCode(data, chain)).toBe(data);
    const foreign = '0x1234567878010080218021802180218021802180218021';
    expect(appendOphisBaseBuilderCode(foreign, 8453)).toBe(foreign);
    expect(appendOphisBaseBuilderCode('0x', 8453)).toBe('0x');
    expect(() => appendOphisBaseBuilderCode('0x12345', 8453)).toThrow('Invalid transaction calldata');
  });
});
