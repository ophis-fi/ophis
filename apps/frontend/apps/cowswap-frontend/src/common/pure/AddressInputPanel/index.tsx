import { ChangeEvent, ReactNode, useCallback, useEffect, useState } from 'react'

import { getChainInfo } from '@cowprotocol/common-const'
import {
  getBlockExplorerUrl as getExplorerLink,
  isPrefixedAddress,
  parsePrefixedAddress,
} from '@cowprotocol/common-utils'
import { SupportedChainId } from '@cowprotocol/cow-sdk'
import { ExternalLink, RowBetween, UI } from '@cowprotocol/ui'
import { useWalletInfo } from '@cowprotocol/wallet'

import { useLingui } from '@lingui/react'
import { Trans } from '@lingui/react/macro'
import styled, { useTheme } from 'styled-components/macro'

import { AutoColumn } from 'legacy/components/Column'

import { useOphisNameResolution } from '../../hooks/useOphisNameResolution'
import { autofocus } from '../../utils/autofocus'
import { getRecipientPlaceholder, isNonEvmRecipientChain, isRecipientAddress } from '../../utils/recipientAddress.utils'
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

const ResolvedRecipient = styled.div`
  color: inherit;
  font-size: 12px;
  opacity: 0.72;
  overflow-wrap: anywhere;
`

// TODO: Break down this large function into smaller functions
// TODO: Add proper return type annotation
// TODO: Reduce function complexity by extracting logic
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
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
  useLingui()
  const { chainId: walletChainId } = useWalletInfo()
  // Use targetChainId if provided (for cross-chain), otherwise fall back to wallet's chain
  const chainId = targetChainId ?? walletChainId
  const chainInfo = getChainInfo(chainId)
  const addressPrefix = chainInfo?.addressPrefix

  const isNonEvmTarget = isNonEvmRecipientChain(chainId)

  // Skip ENS lookup when target is non-EVM — base58 / native input never
  // resolves via ENS and would always show the loading spinner forever.
  const {
    address: evmAddress,
    loading,
    name,
    system,
    integrityError,
  } = useOphisNameResolution(isNonEvmTarget ? null : value, chainId)

  const nonEvmAddress = isRecipientAddress(value, chainId) ? value : null

  const address = isNonEvmTarget ? nonEvmAddress : evmAddress

  const [chainPrefixWarning, setChainPrefixWarning] = useState('')
  const { darkMode: isDarkMode } = useTheme()

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

  const error = Boolean(value.length > 0 && !loading && (!address || integrityError))

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
                <ExternalLink href={getExplorerLink(chainId, 'address', address)} style={{ fontSize: '14px' }}>
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
              placeholder={placeholder ?? getRecipientPlaceholder(chainId)}
              onChange={handleInput}
              value={value}
              onFocus={autofocus}
            />
            {name && address && system ? (
              <ResolvedRecipient>
                {system === 'ens' ? 'ENS' : '.wei'} · {address}
              </ResolvedRecipient>
            ) : null}
          </AutoColumn>
        </InputContainer>
      </ContainerRow>
    </InputPanel>
  )
}
