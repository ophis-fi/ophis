import { useCallback, useEffect, useMemo, useState } from 'react'

import { shortenOrderId } from '@cowprotocol/common-utils'
import { getAddressKey } from '@cowprotocol/cow-sdk'
import { Command } from '@cowprotocol/types'

import {
  GetOrderApi,
  GetOrderResult,
  SingleOrder,
  tryGetOrderOnAllNetworksAndEnvironments,
} from 'services/helpers/tryGetOrderOnAllNetworks'
import { useNetworkId } from 'state/network'
import { Errors, Network, UiError } from 'types'
import { transformOrder } from 'utils'

import { getOrder, GetOrderParams, Order } from 'api/operator'

import { useMultipleErc20 } from './useErc20'

type UseOrderResult = {
  order: Order | null
  error?: UiError
  isLoading: boolean
  errorOrderPresentInNetworkId: Network | null
  forceUpdate?: Command
}

type LoadedOrder = Pick<UseOrderResult, 'order' | 'error' | 'errorOrderPresentInNetworkId'> & {
  orderId: string
  networkId: Network
}

function _getOrder(networkId: Network, orderId: string): Promise<GetOrderResult<SingleOrder>> {
  const defaultParams: GetOrderParams = { networkId, orderId }
  const getOrderApi: GetOrderApi<GetOrderParams, SingleOrder> = {
    api: (_defaultParams) => getOrder(_defaultParams),
    defaultParams,
  }

  return tryGetOrderOnAllNetworksAndEnvironments<SingleOrder>(networkId, getOrderApi)
}

export function useOrderByNetwork(orderId: string, networkId: Network | null, updateInterval = 0): UseOrderResult {
  const [isLoading, setIsLoading] = useState(false)
  const [loadedOrder, setLoadedOrder] = useState<LoadedOrder>()
  const current = loadedOrder?.orderId === orderId && loadedOrder.networkId === networkId ? loadedOrder : undefined
  const order = current?.order ?? null
  const error = current?.error
  const errorOrderPresentInNetworkId = current?.errorOrderPresentInNetworkId ?? null
  // Hack to force component to update itself on demand
  const [forcedUpdate, setForcedUpdate] = useState({})
  const forceUpdate = useCallback((): void => setForcedUpdate({}), [])

  useEffect(() => {
    let cancelled = false

    async function fetchOrder(): Promise<void> {
      if (!networkId) {
        setIsLoading(false)
        return
      }

      setIsLoading(true)

      let nextOrder: Order | null = null
      let nextNetwork: Network | null = null
      let fetchError: UiError | undefined
      const errorMessage = `Failed to fetch order: ${shortenOrderId(orderId)}`

      try {
        const { order: rawOrder, errorOrderPresentInNetworkId: otherNetwork } = await _getOrder(networkId, orderId)
        if (cancelled) return
        nextOrder = rawOrder ? transformOrder(rawOrder) : null
        nextNetwork = otherNetwork ?? null
      } catch (e) {
        if (cancelled) return
        console.error(`Failed to fetch order: ${orderId}`, e)
        fetchError = { message: errorMessage, type: 'error' }
      }

      setLoadedOrder((previous) => {
        const next: LoadedOrder = {
          orderId,
          networkId,
          order: nextOrder,
          errorOrderPresentInNetworkId: nextNetwork,
        }
        if (nextOrder) return next
        const sameRequest = previous?.orderId === orderId && previous.networkId === networkId
        // Lookups can return null on an outage. Keep this order's last snapshot so polling can recover.
        if (sameRequest && previous.order) {
          return { ...previous, error: fetchError ?? { message: errorMessage, type: 'error' } }
        }
        return { ...next, error: fetchError }
      })
      setIsLoading(false)
    }

    void fetchOrder()
    return (): void => {
      cancelled = true
    }
  }, [networkId, orderId, forcedUpdate])

  useEffect(() => {
    let intervalId: NodeJS.Timeout | null = null

    // Only start the interval when:
    // 1. Hook is configured to do so (`updateInterval` > 0)
    // 2. Order exists
    // 3. Order is not expired
    if (updateInterval && order && order.expirationDate.getTime() > Date.now()) {
      intervalId = setInterval(forceUpdate, updateInterval)
    }

    return (): void => {
      intervalId && clearInterval(intervalId)
    }
  }, [forceUpdate, order, updateInterval])

  return useMemo(
    () => ({ order, isLoading, error, errorOrderPresentInNetworkId, forceUpdate }),
    [order, isLoading, error, errorOrderPresentInNetworkId, forceUpdate],
  )
}

export function useOrder(orderId: string, updateInterval?: number): UseOrderResult {
  const networkId = useNetworkId()
  return useOrderByNetwork(orderId, networkId, updateInterval)
}

type UseOrderAndErc20sResult = {
  order: Order | null
  isLoading: boolean
  errors: Errors
  errorOrderPresentInNetworkId: Network | null
}

/**
 * Aggregates the fetching of the order and related erc20s
 * Optionally sets an interval of how often to update Open orders
 *
 * @param orderId The order id
 * @param updateInterval [Optional] How often should try to update the order
 */
export function useOrderAndErc20s(orderId: string, updateInterval = 0): UseOrderAndErc20sResult {
  const networkId = useNetworkId() ?? undefined

  const {
    order,
    isLoading: isOrderLoading,
    error: orderError,
    errorOrderPresentInNetworkId,
  } = useOrder(orderId, updateInterval)

  const addresses = order ? [order.buyTokenAddress, order.sellTokenAddress] : []

  const { value, isLoading: areErc20Loading, error: errors = {} } = useMultipleErc20({ networkId, addresses })

  // TODO: Reduce function complexity by extracting logic

  return useMemo(() => {
    if (orderError) {
      // eslint-disable-next-line react-hooks/immutability
      errors[orderId] = orderError
    }

    if (order && value) {
      // eslint-disable-next-line react-hooks/immutability
      order.buyToken = value[getAddressKey(order?.buyTokenAddress || '')]
      // eslint-disable-next-line react-hooks/immutability
      order.sellToken = value[getAddressKey(order?.sellTokenAddress || '')]
    }

    return { order, isLoading: isOrderLoading || areErc20Loading, errors, errorOrderPresentInNetworkId }
  }, [orderError, order, isOrderLoading, areErc20Loading, errors, errorOrderPresentInNetworkId, value, orderId])
}
