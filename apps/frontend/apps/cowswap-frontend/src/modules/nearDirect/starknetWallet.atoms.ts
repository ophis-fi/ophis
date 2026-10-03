import { atom } from 'jotai'

import type { StarknetWindowObject } from '@starknet-io/get-starknet'

export const starknetWalletAtom = atom<{ wallet: StarknetWindowObject; address: string } | undefined>(undefined)
