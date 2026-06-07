import { useEffect, useState } from 'react'
import { Globe } from './components/Globe'
import { getScenarios } from './api'
import type { Scenario } from './types'
import './App.css'

function App() {
  const [scenarios, setScenarios] = useState<Scenario[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getScenarios()
      .then((list) => {
        setScenarios(list)
        if (list.length) setActive(list[0].id)
        else
          setError(
            'No scenarios found. Run scripts/generate_test_zarr.py and restart the backend.',
          )
      })
      .catch((e) => setError(String(e)))
  }, [])

  return (
    <div className="app">
      <main className="globe-pane">
        {active ? (
          <Globe scenario={active} />
        ) : (
          <div className="placeholder">{error ?? 'Loading…'}</div>
        )}
      </main>

      {/* Placeholder sidebar — sliders, timeline and energy chart arrive in
          Phase 2-3 (CLAUDE.md §7.6-7.8). */}
      <aside className="sidebar">
        <h1>Planetary Ocean</h1>
        <p className="muted">Phase 1 — globe + heatmap</p>

        <div className="card">
          <div className="card-title">Active scenario</div>
          <div className="mono">{active ?? '—'}</div>
        </div>
        <div className="card">
          <div className="card-title">Scenarios loaded</div>
          <div className="mono">{scenarios.length}</div>
        </div>

        {error && <p className="error small">{error}</p>}
        <p className="muted small">
          Controls, timeline and energy chart land in Phase 2-3.
        </p>
      </aside>
    </div>
  )
}

export default App
