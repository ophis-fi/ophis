import { type WritableAtom, useAtomValue } from 'jotai'
import { useMemo } from 'react'

import { SupportedChainId } from '@cowprotocol/cow-sdk'
import {
  NameRegistryIntegrityError,
  type OphisNameResolution,
  parseOphisName,
  resolveOphisNameOrAddress,
} from '@cowprotocol/ens'

import { atomWithQuery, type AtomWithQueryResult } from 'jotai-tanstack-query'
import { getAddress, isAddress, type PublicClient } from 'viem'
import { usePublicClient } from 'wagmi'

import { createOphisNameReader } from '../utils/createOphisNameReader'

export interface OphisNameResolutionState {
  readonly address: string | null
  readonly name: string | null
  readonly system: 'ens' | 'wei' | null
  readonly loading: boolean
  readonly integrityError: boolean
}

type NameResolutionKey = readonly ['ophis-name', string, string]
type NameResolutionQueryAtom = WritableAtom<AtomWithQueryResult<OphisNameResolution | null, Error>, [], void>

function createNameResolutionAtom(client: PublicClient | undefined, name: string | null): NameResolutionQueryAtom {
  return atomWithQuery<OphisNameResolution | null, Error, OphisNameResolution | null, NameResolutionKey>(() => ({
    queryKey: ['ophis-name', client?.uid || 'unavailable', name || ''] satisfies NameResolutionKey,
    enabled: Boolean(client && name),
    queryFn: async (): Promise<OphisNameResolution | null> => {
      if (!client || !name) return null

      return resolveOphisNameOrAddress(createOphisNameReader(client), name)
    },
  }))
}

function canResolveName(value: string, chainId: number | undefined): boolean {
  return chainId === SupportedChainId.MAINNET && parseOphisName(value) !== null
}

function getDirectAddress(value: string | null | undefined): string | null {
  return value && isAddress(value) ? getAddress(value) : null
}

function getNameResolutionKey(
  client: PublicClient | undefined,
  value: string | null | undefined,
  chainId: number | undefined,
): NameResolutionKey | null {
  return client && value && canResolveName(value, chainId) ? ['ophis-name', client.uid, value] : null
}

function getNameResolutionState(
  directAddress: string | null,
  hasKey: boolean,
  data: OphisNameResolution | null | undefined,
  error: unknown,
  isLoading: boolean,
): OphisNameResolutionState {
  return {
    address: directAddress || data?.address || null,
    name: data?.name || null,
    system: data?.system || null,
    loading: hasKey && isLoading,
    integrityError: error instanceof NameRegistryIntegrityError,
  }
}

export function useOphisNameResolution(
  value: string | null | undefined,
  chainId: number | undefined,
): OphisNameResolutionState {
  const client = usePublicClient({ chainId: SupportedChainId.MAINNET })
  const directAddress = getDirectAddress(value)
  const key = getNameResolutionKey(client, value, chainId)
  const name = key?.[2] || null
  const resolutionAtom = useMemo(() => createNameResolutionAtom(client, name), [client, name])
  const response = useAtomValue(resolutionAtom)

  return getNameResolutionState(directAddress, key !== null, response.data, response.error, response.isLoading)
}
