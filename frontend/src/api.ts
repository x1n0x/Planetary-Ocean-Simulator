// Thin fetch client. All paths go through Vite's /api proxy → FastAPI :8000.
import type { OceanState, Scenario, LandMask } from './types'

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`)
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`GET ${path} → ${res.status}: ${detail}`)
  }
  return res.json() as Promise<T>
}

export const getScenarios = () => getJson<Scenario[]>('/scenarios')

export const getState = (scenario: string, t: number) =>
  getJson<OceanState>(`/state?scenario=${encodeURIComponent(scenario)}&t=${t}`)

// Static per scenario — fetch once, cache client-side (CLAUDE.md §5.3).
export const getLand = (scenario: string) =>
  getJson<LandMask>(`/land?scenario=${encodeURIComponent(scenario)}`)
