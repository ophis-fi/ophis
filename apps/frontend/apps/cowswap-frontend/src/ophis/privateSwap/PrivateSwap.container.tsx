import { ReactNode, useEffect, useRef, useState } from 'react'

import { IncognitoIcon } from 'ophis/components/IncognitoIcon.pure'
import { useIsMobileSwap } from 'ophis/hooks/useIsMobileSwap'
import { MobileSwapHeading } from 'ophis/mobile/MobileSwapHeading.pure'

import * as styledEl from './PrivateSwap.styled'
import { PRIVATE_SWAP_DOCUMENT, privateSwapUrl } from './privateSwapSession.utils'

const PRIVATE_CHAINS = new Set([1, 42161, 137, 56])

export function PrivateSwap({ publicSwap }: { publicSwap: ReactNode }): ReactNode {
  const isMobileSwap = useIsMobileSwap()
  const frame = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(740)
  const [busy, setBusy] = useState(false)
  const [chainId] = useState(() => {
    const requested = Number(new URLSearchParams(window.location.search).get('privateChain') || 1)
    return PRIVATE_CHAINS.has(requested) ? requested : 1
  })
  useEffect(() => {
    const receive = (event: MessageEvent<unknown>): void => {
      if (event.origin !== window.location.origin || event.source !== frame.current?.contentWindow) return
      const data = event.data
      if (!data || typeof data !== 'object' || !('type' in data) || data.type !== 'ophis:private-layout-v1') return
      if (!('height' in data) || typeof data.height !== 'number' || !Number.isFinite(data.height)) return
      if (!('busy' in data) || typeof data.busy !== 'boolean') return
      if (!('chainId' in data) || typeof data.chainId !== 'number' || !PRIVATE_CHAINS.has(data.chainId)) return
      setHeight(Math.max(240, Math.min(6000, data.height)))
      setBusy(data.busy)
      const url = new URL(window.location.href)
      url.searchParams.set('privateChain', String(data.chainId))
      window.history.replaceState(window.history.state, '', url.href)
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [])
  if (PRIVATE_SWAP_DOCUMENT && window.top !== window.self)
    return <p role="alert">Open Ophis directly to access your private wallet.</p>
  return (
    <styledEl.Wrapper>
      {PRIVATE_SWAP_DOCUMENT && isMobileSwap && <MobileSwapHeading />}
      <styledEl.Mode aria-label="Swap privacy mode">
        <div>
          <button
            type="button"
            aria-pressed={!PRIVATE_SWAP_DOCUMENT}
            disabled={busy}
            onClick={() => window.location.assign(privateSwapUrl(false))}
          >
            Public
          </button>
          <button
            type="button"
            aria-pressed={PRIVATE_SWAP_DOCUMENT}
            disabled={busy}
            onClick={() => window.location.assign(privateSwapUrl(true))}
          >
            <IncognitoIcon size={16} /> Private
          </button>
        </div>
        {PRIVATE_SWAP_DOCUMENT && <small>RAILGUN · 0.1% Ophis fee</small>}
      </styledEl.Mode>
      {PRIVATE_SWAP_DOCUMENT ? (
        <styledEl.Runtime
          ref={frame}
          title="Ophis private swap wallet"
          src={`/private/?chainId=${chainId}`}
          height={height}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          referrerPolicy="no-referrer"
        />
      ) : (
        publicSwap
      )}
    </styledEl.Wrapper>
  )
}
