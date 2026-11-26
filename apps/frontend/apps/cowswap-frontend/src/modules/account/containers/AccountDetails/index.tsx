import { useAtomValue } from 'jotai'
import { ReactNode } from 'react'

import { CHAIN_INFO } from '@cowprotocol/common-const'
import { styled } from '@cowprotocol/common-hooks'
import { getEtherscanLink, getExplorerLabel, isInjectedWidget, shortenAddress } from '@cowprotocol/common-utils'
import { Command } from '@cowprotocol/types'
import { StyledLink } from '@cowprotocol/ui'
import {
  ConnectionType,
  getIsHardWareWallet,
  getIsInjectedMobileBrowser,
  useConnectionType,
  useDisconnectWallet,
  useIsWalletConnect,
  useWalletDetails,
  useWalletInfo,
} from '@cowprotocol/wallet'

import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { solanaConnectionAtom } from 'entities/solana'
import { Link } from 'react-router'

import Copy from 'legacy/components/Copy'
import { useAppDispatch } from 'legacy/state/hooks'
import { updateSelectedWallet } from 'legacy/state/user/reducer'

import { useInjectedWidgetParams } from 'modules/injectedWidget'

import { useIsProviderNetworkUnsupported } from 'common/hooks/useIsProviderNetworkUnsupported'
import { UnsupportedNetworksText } from 'common/pure/UnsupportedNetworksText'

import { AccountIcon } from './AccountIcon'
import { RecentActivity } from './RecentActivity.container'
import {
  AccountControl,
  AccountGroupingRow,
  AddressLink,
  InfoCard,
  NetworkCard,
  UnsupportedWalletBox,
  WalletAction,
  WalletActions,
  WalletName,
  WalletNameAddress,
  WalletSecondaryActions,
  WalletSelector,
  WalletWrapper,
  Wrapper,
} from './styled'
import { SurplusCard } from './SurplusCard'

import { useCloseAccountModal } from '../../hooks/useToggleAccountModal'
import { CowShedInfo } from '../CowShedInfo'

const CowShedInfoStyled = styled(CowShedInfo)`
  margin-top: 10px;
`

export interface AccountDetailsProps {
  pendingTransactions: string[]
  confirmedTransactions: string[]
  ENSName?: string
  forceHardwareWallet?: boolean
  toggleAccountSelectorModal: Command
  handleCloseOrdersPanel: Command
}

export function AccountDetails({
  pendingTransactions,
  confirmedTransactions,
  ...walletProps
}: AccountDetailsProps): ReactNode {
  const { active, account } = useWalletInfo()
  const solanaOwner = useAtomValue(solanaConnectionAtom)?.account.address
  const unsupported = useIsProviderNetworkUnsupported()
  const evmAccount = active ? account : undefined
  const evmActivityAccount = unsupported ? undefined : evmAccount

  return (
    <Wrapper>
      {evmAccount && <EvmAccountDetails {...walletProps} account={evmAccount} isChainIdUnsupported={unsupported} />}
      {(evmActivityAccount || solanaOwner) && (
        <RecentActivity
          evmAccount={evmActivityAccount}
          pendingTransactions={pendingTransactions}
          confirmedTransactions={confirmedTransactions}
          solanaOwner={solanaOwner}
        />
      )}
    </Wrapper>
  )
}

function EvmAccountDetails({
  account,
  isChainIdUnsupported,
  ENSName,
  toggleAccountSelectorModal,
  handleCloseOrdersPanel,
  forceHardwareWallet,
}: Omit<AccountDetailsProps, 'pendingTransactions' | 'confirmedTransactions'> & {
  account: string
  isChainIdUnsupported: boolean
}): ReactNode {
  const { chainId } = useWalletInfo()
  const connectionType = useConnectionType()
  const walletDetails = useWalletDetails()
  const dispatch = useAppDispatch()
  const disconnectWallet = useDisconnectWallet()
  const closeAccountModal = useCloseAccountModal()
  const { standaloneMode } = useInjectedWidgetParams()

  const explorerLabel = getExplorerLabel(chainId, 'address', account)
  const walletAddress = ENSName || account

  const isWalletConnect = useIsWalletConnect()
  const isInjectedMobileBrowser = getIsInjectedMobileBrowser()

  // In case the wallet is connected via WalletConnect and has wallet name set, add the suffix to be clear
  // This to avoid confusion for instance when using Metamask mobile
  // When name is not set, it defaults to WalletConnect already
  const walletConnectSuffix = isWalletConnect && walletDetails?.walletName ? ` ` + t`(via WalletConnect)` : ''

  const handleDisconnectClick = (): void => {
    disconnectWallet()
    handleCloseOrdersPanel()
    dispatch(updateSelectedWallet({ wallet: undefined }))
  }

  const networkLabel = CHAIN_INFO[chainId].label
  const isHardWareWallet = forceHardwareWallet || getIsHardWareWallet(connectionType)

  return (
    <>
      <InfoCard>
        <AccountGroupingRow id="web3-account-identifier-row">
          <AccountControl>
            <WalletWrapper>
              <WalletSelector
                isHardWareWallet={isHardWareWallet}
                onClick={isHardWareWallet ? toggleAccountSelectorModal : undefined}
              >
                <AccountIcon size={24} account={account} />

                <WalletNameAddress>{ENSName || shortenAddress(account)}</WalletNameAddress>
              </WalletSelector>

              <Copy toCopy={walletAddress} />
            </WalletWrapper>

            <WalletActions>
              {' '}
              {!isChainIdUnsupported && <NetworkCard title={networkLabel}>{networkLabel}</NetworkCard>}{' '}
              <WalletName>
                <Trans>Connected with</Trans> {walletDetails?.walletName} {walletConnectSuffix}
              </WalletName>
            </WalletActions>

            <CowShedInfoStyled onClick={closeAccountModal} />
          </AccountControl>
        </AccountGroupingRow>
        <AccountGroupingRow>
          <AccountControl>
            <WalletSecondaryActions>
              {!isInjectedWidget() && (
                <StyledLink as={Link} to="/profile" onClick={closeAccountModal}>
                  <Trans>Profile</Trans>
                </StyledLink>
              )}
              {!isInjectedMobileBrowser && !isChainIdUnsupported && (
                <AddressLink
                  hasENS={!!ENSName}
                  isENS={!!ENSName}
                  href={getEtherscanLink(chainId, 'address', walletAddress)}
                >
                  {explorerLabel} ↗
                </AddressLink>
              )}

              {standaloneMode !== false && connectionType !== ConnectionType.GNOSIS_SAFE && (
                <WalletAction onClick={handleDisconnectClick}>
                  <Trans>Disconnect</Trans>
                </WalletAction>
              )}
            </WalletSecondaryActions>
          </AccountControl>
        </AccountGroupingRow>
      </InfoCard>

      {isChainIdUnsupported ? (
        <UnsupportedWalletBox>
          <UnsupportedNetworksText />
        </UnsupportedWalletBox>
      ) : (
        <SurplusCard />
      )}
    </>
  )
}
