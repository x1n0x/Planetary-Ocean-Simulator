import { useEffect, useState } from 'react'

import { getLand } from '../api'

// chi is static per scenario (CLAUDE.md §5.3) — fetch once, cache for the
// session. Module-level so it can be read during render without a ref.
const landCache = new Map<string, number[][]>()

const cachedChi = (scenario: string | null) =>
  scenario ? landCache.get(scenario) ?? null : null

export function useLandMask(scenario: string | null) {
  const [chi, setChi] = useState<number[][] | null>(() => cachedChi(scenario))

  // Reset to the cached value the moment the scenario changes (render-time
  // adjust pattern — no effect needed for derived state).
  const [prev, setPrev] = useState(scenario)
  if (scenario !== prev) {
    setPrev(scenario)
    setChi(cachedChi(scenario))
  }

  // Fetch only when not already cached.
  useEffect(() => {
    if (!scenario || landCache.has(scenario)) return
    let cancelled = false
    getLand(scenario)
      .then((d) => {
        if (cancelled) return
        landCache.set(scenario, d.chi)
        setChi(d.chi)
      })
      .catch((e) => console.error('[useLandMask]', e))
    return () => {
      cancelled = true
    }
  }, [scenario])

  return chi
}
