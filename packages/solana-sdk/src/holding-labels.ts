import {
  address,
  getAddressDecoder,
  getAddressEncoder,
  getBase64Encoder,
  getProgramDerivedAddress,
  type Address,
  type createSolanaRpc,
} from '@solana/kit';

const METADATA = address('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const prefix = new TextEncoder().encode('metadata');
type Label = { name: string; symbol: string };

// Only the canonical Metaplex account prefix through the two display strings is needed.
export function readHoldingLabel(data: Uint8Array, mint: Address): Label | undefined {
  if (data.length < 73 || data[0] !== 4 || getAddressDecoder().decode(data.slice(33, 65)) !== mint)
    return;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 65;
  const read = (limit: number): string => {
    if (offset + 4 > data.length) return '';
    const size = view.getUint32(offset, true);
    offset += 4;
    if (size > limit || offset + size > data.length) return '';
    const value = new TextDecoder()
      .decode(data.slice(offset, offset + size))
      .replace(/\p{C}/gu, '')
      .trim();
    offset += size;
    return value;
  };
  const name = read(32),
    symbol = read(10);
  if (name && symbol) return { name, symbol };
}

export async function readHoldingLabels(
  rpc: ReturnType<typeof createSolanaRpc>,
  mints: Address[],
): Promise<Map<Address, Label>> {
  const labels = new Map<Address, Label>();
  if (!mints.length) return labels;
  // Keep optional names to one account batch. Every holding still has its mint and balance.
  const batch = mints.slice(0, 100);
  const encoder = getAddressEncoder();
  const pdas = await Promise.all(
    batch.map(
      async (mint) =>
        (
          await getProgramDerivedAddress({
            programAddress: METADATA,
            seeds: [prefix, encoder.encode(METADATA), encoder.encode(mint)],
          })
        )[0],
    ),
  );
  const { value } = await rpc
    .getMultipleAccounts(pdas, {
      encoding: 'base64',
      commitment: 'confirmed',
      dataSlice: { offset: 0, length: 115 },
    })
    .send();
  for (const [i, account] of value.entries()) {
    const mint = batch[i];
    if (!account || account.owner !== METADATA || !mint) continue;
    const label = readHoldingLabel(
      Uint8Array.from(getBase64Encoder().encode(account.data[0])),
      mint,
    );
    if (label) labels.set(mint, label);
  }
  return labels;
}
