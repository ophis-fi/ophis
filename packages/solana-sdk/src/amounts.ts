/** Parse display units without floating point; token atoms always fit u64. */
export function parseOphisSolanaAmount(value: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255)
    throw Error('Invalid mint decimals');
  if (typeof value !== 'string' || value.length > 300 || !/^\d+(?:\.\d*)?$/.test(value))
    throw Error('Enter a decimal token amount');
  const [whole = '', fraction = ''] = value.split('.');
  if (fraction.length > decimals && /[1-9]/.test(fraction.slice(decimals)))
    throw Error('Amount exceeds mint precision');
  const atoms = BigInt(whole + fraction.slice(0, decimals).padEnd(decimals, '0'));
  if (atoms > 0xffff_ffff_ffff_ffffn) throw Error('Amount exceeds u64');
  return atoms;
}

export function formatOphisSolanaAmount(atoms: bigint, decimals: number): string {
  if (
    typeof atoms !== 'bigint' ||
    atoms < 0n ||
    atoms > 0xffff_ffff_ffff_ffffn ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 255
  )
    throw Error('Invalid token atoms or mint decimals');
  const text = atoms.toString().padStart(decimals + 1, '0');
  if (decimals === 0) return text;
  let end = text.length;
  const start = end - decimals;
  while (end > start && text.charCodeAt(end - 1) === 48) --end;
  const fraction = text.slice(start, end);
  return text.slice(0, -decimals) + (fraction ? `.${fraction}` : '');
}
