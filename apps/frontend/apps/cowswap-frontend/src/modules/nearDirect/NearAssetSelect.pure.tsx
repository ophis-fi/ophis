import { ReactNode } from 'react'

import { DIRECT_NEAR_CHAINS } from './nearDirect.constants'
import { NearToken } from './nearDirect.schemas'

interface NearAssetSelectProps {
  label: string
  tokens: NearToken[]
  value: string
  onChange(value: string): void
}

export function NearAssetSelect({ label, tokens, value, onChange }: NearAssetSelectProps): ReactNode {
  return (
    <label>
      {label}
      <select required value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Select network and asset</option>
        {Object.entries(DIRECT_NEAR_CHAINS).map(([blockchain, chain]) => (
          <optgroup key={blockchain} label={chain.label}>
            {tokens
              .filter((token) => token.blockchain === blockchain)
              .map((token) => (
                <option key={token.assetId} value={token.assetId}>
                  {token.symbol} · {chain.label}
                  {token.contractAddress ? ` · ${token.contractAddress}` : ''}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
    </label>
  )
}
