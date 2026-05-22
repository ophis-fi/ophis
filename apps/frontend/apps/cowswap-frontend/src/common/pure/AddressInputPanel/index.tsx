import { ChangeEvent, ReactNode, useCallback, useEffect, useMemo, useState } from 'react'

import { getChainInfo } from '@cowprotocol/common-const'
import {
  getBlockExplorerUrl as getExplorerLink,
  isPrefixedAddress,
  parsePrefixedAddress,
} from '@cowprotocol/common-utils'
import {
  AdditionalTargetChainId,
  isBtcAddress,
  isSolanaAddress,
  SupportedChainId,
} from '@cowprotocol/cow-sdk'
import { useENS } from '@cowprotocol/ens'
import { ExternalLink, RowBetween, UI } from '@cowprotocol/ui'
import { useWalletInfo } from '@cowprotocol/wallet'

import { Trans, useLingui } from '@lingui/react/macro'
import styled from 'styled-components/macro'

import { AutoColumn } from 'legacy/components/Column'
import { useIsDarkMode } from 'legacy/state/user/hooks'

import { autofocus } from '../../utils/autofocus'
import ChainPrefixWarning from '../ChainPrefixWarning'

const InputPanel = styled.div`
  ${({ theme }) => theme.flexColumnNoWrap}
  position: relative;
  border-radius: 16px;
  background-color: var(${UI.COLOR_PAPER_DARKER});
  color: inherit;
  z-index: 1;
  width: 100%;
`

const ContainerRow = styled.div<{ error: boolean }>`
  display: flex;
  justify-content: center;
  align-items: center;
  border-radius: 16px;
  border: 0;
  color: inherit;
  background-color: var(${UI.COLOR_PAPER_DARKER});
`

export const InputContainer = styled.div`
  flex: 1;
  padding: 1rem;
`

const Input = styled.input<{ error?: boolean }>`
  font-size: 1.25rem;
  outline: none;
  border: none;
  flex: 1 1 auto;
  background: none;
  transition: color 0.2s ${({ error }) => (error ? 'step-end' : 'step-start')};
  color: ${({ error }) => (error ? `var(${UI.COLOR_DANGER})` : 'inherit')};
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 500;
  width: 100%;

  &&::placeholder {
    color: inherit;
    opacity: 0.5;
  }

  &:focus::placeholder {
    color: transparent;
  }

  padding: 0px;
  appearance: textfield;
  -webkit-appearance: textfield;

  ::-webkit-search-decoration {
    -webkit-appearance: none;
  }

  ::-webkit-outer-spin-button,
  ::-webkit-inner-spin-button {
    -webkit-appearance: none;
  }

  ::placeholder {
    color: ${({ theme }) => theme.text4};
  }
`

// TODO: Break down this large function into smaller functions
// TODO: Add proper return type annotation
// TODO: Reduce function complexity by extracting logic
// eslint-disable-next-line max-lines-per-function, @typescript-eslint/explicit-function-return-type
export function AddressInputPanel({
  id,
  className = 'recipient-address-input',
  label,
  placeholder,
  value,
  onChange,
  targetChainId,
}: {
  id?: string
  className?: string
  label?: ReactNode
  placeholder?: string
  value: string
  onChange: (value: string) => void
  targetChainId?: SupportedChainId
}) {
  const { t } = useLingui()
  const { chainId: walletChainId } = useWalletInfo()
  // Use targetChainId if provided (for cross-chain), otherwise fall back to wallet's chain
  const chainId = targetChainId ?? walletChainId
  const chainInfo = getChainInfo(chainId)
  const addressPrefix = chainInfo?.addressPrefix

  // Ophis fix (2026-05-22, PR follow-up to NEAR Intents wiring audit):
  // when the target chain is Solana or Bitcoin (NEAR Intents bridge
  // destinations), the recipient input must accept base58 (Solana) or
  // native (Bitcoin) addresses — NOT EVM checksummed addresses. Upstream
  // CoW's `useENS` chain ends in `ethers.getAddress` which rejects any
  // non-EVM input as invalid, breaking the bridge recipient UX. This is
  // an upstream-inherited bug surfaced by the 2026-05-22 audit
  // (`docs/development/specs/2026-05-22-near-intents-solana-epic.md`,
  // gap #7); fix is to branch validation on the non-EVM target.
  const isSolanaTarget = chainId === (AdditionalTargetChainId.SOLANA as unknown as SupportedChainId)
  const isBitcoinTarget = chainId === (AdditionalTargetChainId.BITCOIN as unknown as SupportedChainId)
  const isNonEvmTarget = isSolanaTarget || isBitcoinTarget

  // Skip ENS lookup when target is non-EVM — base58 / native input never
  // resolves via ENS and would always show the loading spinner forever.
  const { address: evmAddress, loading, name } = useENS(isNonEvmTarget ? null : value)

  const nonEvmAddress = useMemo<string | null>(() => {
    if (!value || !isNonEvmTarget) return null
    if (isSolanaTarget && isSolanaAddress(value)) return value
    if (isBitcoinTarget && isBtcAddress(value)) return value
    return null
  }, [value, isNonEvmTarget, isSolanaTarget, isBitcoinTarget])

  const address = isNonEvmTarget ? nonEvmAddress : evmAddress

  const [chainPrefixWarning, setChainPrefixWarning] = useState('')
  const isDarkMode = useIsDarkMode()

  const handleInput = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const input = event.target.value
      setChainPrefixWarning('')
      let value = input.replace(/\s+/g, '')

      // Skip EIP-3770 chain-prefix parsing on non-EVM targets — Solana
      // base58 + Bitcoin native addresses don't use chain prefixes, and
      // the parser would mis-fire on values containing ':'.
      if (!isNonEvmTarget && isPrefixedAddress(value)) {
        const { prefix, address } = parsePrefixedAddress(value)

        if (prefix && addressPrefix !== prefix) {
          setChainPrefixWarning(prefix)
        }

        if (address) {
          value = address
        }
      }

      onChange(value)
    },
    [onChange, addressPrefix, isNonEvmTarget],
  )

  //clear warning if target chainId changes and we are now on the right network
  useEffect(() => {
    if (chainPrefixWarning && chainPrefixWarning === addressPrefix) {
      setChainPrefixWarning('')
    }
  }, [chainPrefixWarning, addressPrefix])

  const error = Boolean(value.length > 0 && !loading && !address)

  return (
    <InputPanel id={id}>
      {chainPrefixWarning && (
        <ChainPrefixWarning chainPrefixWarning={chainPrefixWarning} chainInfo={chainInfo} isDarkMode={isDarkMode} />
      )}
      <ContainerRow error={error}>
        <InputContainer>
          <AutoColumn gap="md">
            <RowBetween>
              <span>{label ?? <Trans>Recipient</Trans>}</span>
              {address && chainId && (
                <ExternalLink href={getExplorerLink(chainId, 'address', name ?? address)} style={{ fontSize: '14px' }}>
                  <Trans>(View on Explorer)</Trans>
                </ExternalLink>
              )}
            </RowBetween>
            <Input
              className={className}
              type="text"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck="false"
              placeholder={placeholder ?? t`Wallet Address or ENS name`}
              error={error}
              pattern="^(0x[a-fA-F0-9]{40})$"
              onChange={handleInput}
              value={value}
              onFocus={autofocus}
            />
          </AutoColumn>
        </InputContainer>
      </ContainerRow>
    </InputPanel>
  )
}
