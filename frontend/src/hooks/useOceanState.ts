import { useEffect, useRef, useState } from 'react'
import { throttle } from 'lodash'

import { getState } from '../api'
import type { OceanState } from '../types'

// Fetch /state for (scenario, t), throttled to ≤10 req/s (CLAUDE.md §7.5).
// A monotonic sequence guards against out-of-order responses during playback:
// only the newest request is allowed to update state.
export function useOceanState(scenario: string | null, t: number) {
  const [state, setState] = useState<OceanState | null>(null)
  const [loading, setLoading] = useState(false)
  const seqRef = useRef(0)

  const fetchRef = useRef(
    throttle((sc: string, ts: number, seq: number) => {
      setLoading(true)
      getState(sc, ts)
        .then((data) => {
          if (seq === seqRef.current) setState(data)
        })
        .catch((e) => console.error('[useOceanState]', e))
        .finally(() => {
          if (seq === seqRef.current) setLoading(false)
        })
    }, 100),
  )

  useEffect(() => {
    if (!scenario) return
    const seq = ++seqRef.current
    fetchRef.current(scenario, t, seq)
  }, [scenario, t])

  return { state, loading }
}
