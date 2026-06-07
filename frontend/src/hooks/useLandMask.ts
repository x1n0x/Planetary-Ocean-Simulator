import { useEffect, useRef, useState } from 'react'

import { getLand } from '../api'

// chi is static per scenario (CLAUDE.md §5.3) — fetch once, cache client-side.
export function useLandMask(scenario: string | null) {
  const [chi, setChi] = useState<number[][] | null>(null)
  const cacheRef = useRef<Map<string, number[][]>>(new Map())

  useEffect(() => {
    if (!scenario) {
      setChi(null)
      return
    }
    const cached = cacheRef.current.get(scenario)
    if (cached) {
      setChi(cached)
      return
    }
    let cancelled = false
    getLand(scenario)
      .then((d) => {
        if (cancelled) return
        cacheRef.current.set(scenario, d.chi)
        setChi(d.chi)
      })
      .catch((e) => console.error('[useLandMask]', e))
    return () => {
      cancelled = true
    }
  }, [scenario])

  return chi
}
