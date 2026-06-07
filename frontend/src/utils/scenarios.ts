import type { Scenario } from '../types'

export const EARTH_OMEGA = 7.292e-5 // rad/s
export const EARTH_MOON_KM = 384_000

// Normalise every axis to [0,1] before euclidean distance, then snap to the
// closest precomputed scenario (CLAUDE.md §7.6). Moon mass is intentionally
// not part of the metric — matches the spec's signature.
export function nearestScenario(
  scenarios: Scenario[],
  moonDist: number,
  omega: number,
  temp: number,
): string {
  const maxDist = 3 * EARTH_MOON_KM
  const maxOmega = 5 * EARTH_OMEGA
  const maxTemp = 40
  return scenarios.reduce(
    (best, s) => {
      const d = Math.hypot(
        (s.moon_dist_km - moonDist) / maxDist,
        (s.omega_rad_s - omega) / maxOmega,
        (s.temperature_C - temp) / maxTemp,
      )
      return d < best.dist ? { id: s.id, dist: d } : best
    },
    { id: scenarios[0].id, dist: Infinity },
  ).id
}
