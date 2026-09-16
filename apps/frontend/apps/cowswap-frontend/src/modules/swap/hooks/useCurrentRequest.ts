import { useEffect, useRef } from 'react'

export function useCurrentRequest(requestKey: string): { current: string } {
  const current = useRef(requestKey)
  useEffect(() => {
    current.current = requestKey
    return () => {
      current.current = ''
    }
  }, [requestKey])
  return current
}
