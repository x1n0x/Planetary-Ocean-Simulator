// Thin fetch client. All paths go through Vite's /api proxy → FastAPI :8000.
import type {
  OceanState,
  Scenario,
  LandMask,
  AnomalyResult,
  EnergySeries,
} from './types'

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`)
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`GET ${path} → ${res.status}: ${detail}`)
  }
  return res.json() as Promise<T>
}

export const getScenarios = () => getJson<Scenario[]>('/scenarios')

// /state is immutable for a given (scenario, t) — cache responses so playback
// loops and re-scrubs never re-hit the network.
const stateCache = new Map<string, OceanState>()

export function getState(scenario: string, t: number): Promise<OceanState> {
  const key = `${scenario}:${t}`
  const hit = stateCache.get(key)
  if (hit) return Promise.resolve(hit)
  return getJson<OceanState>(
    `/state?scenario=${encodeURIComponent(scenario)}&t=${t}`,
  ).then((d) => {
    stateCache.set(key, d)
    return d
  })
}

// Static per scenario — fetch once, cache client-side (CLAUDE.md §5.3).
export const getLand = (scenario: string) =>
  getJson<LandMask>(`/land?scenario=${encodeURIComponent(scenario)}`)

// Full energy series + spike timesteps — static per scenario.
export const getEnergy = (scenario: string) =>
  getJson<EnergySeries>(`/energy?scenario=${encodeURIComponent(scenario)}`)

// Anomaly result is deterministic for (scenario, t, window) — cache it so
// scrubbing and replay don't recompute on the backend.
const anomalyCache = new Map<string, AnomalyResult>()

export function getAnomaly(
  scenario: string,
  t: number,
  window = 20,
): Promise<AnomalyResult> {
  const key = `${scenario}:${t}:${window}`
  const hit = anomalyCache.get(key)
  if (hit) return Promise.resolve(hit)
  return getJson<AnomalyResult>(
    `/anomaly?scenario=${encodeURIComponent(scenario)}&t=${t}&window=${window}`,
  ).then((d) => {
    anomalyCache.set(key, d)
    return d
  })
}
