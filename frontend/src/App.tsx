import { useEffect, useMemo, useState } from 'react'

import { Globe } from './components/Globe'
import { OmegaBadge } from './components/OmegaBadge'
import { Timeline } from './components/Timeline'
import { ControlPanel, type ControlValues } from './components/ControlPanel'
import { useLandMask } from './hooks/useLandMask'
import { nearestScenario, EARTH_OMEGA } from './utils/scenarios'
import { getScenarios } from './api'
import type { Scenario } from './types'
import './App.css'

// Frames are prebuilt, so playback is just a layer-visibility toggle — we can
// run it fast and smooth.
const PLAYBACK_MS = 70

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="stat">
      <span className="stat-k">{k}</span>
      <span className="stat-v mono">{v}</span>
    </div>
  )
}

function App() {
  const [scenarios, setScenarios] = useState<Scenario[]>([])
  const [error, setError] = useState<string | null>(null)

  const [controls, setControls] = useState<ControlValues>({
    moonDist: 384_000,
    moonMass: 1,
    omegaRel: 1,
    temp: 15,
  })
  const [t, setT] = useState(0)
  const [playing, setPlaying] = useState(false)

  useEffect(() => {
    getScenarios()
      .then((list) => {
        setScenarios(list)
        if (!list.length)
          setError(
            'No scenarios found. Run scripts/generate_test_zarr.py and restart the backend.',
          )
      })
      .catch((e) => setError(String(e)))
  }, [])

  const omega = controls.omegaRel * EARTH_OMEGA

  // Snap to the nearest precomputed scenario on every slider change (§7.6).
  const active = useMemo(
    () =>
      scenarios.length
        ? nearestScenario(scenarios, controls.moonDist, omega, controls.temp)
        : null,
    [scenarios, controls.moonDist, omega, controls.temp],
  )
  const activeMeta = useMemo(
    () => scenarios.find((s) => s.id === active) ?? null,
    [scenarios, active],
  )
  const total = activeMeta?.T_total_steps ?? 1

  const chi = useLandMask(active)

  // How many timesteps Globe has prebuilt — drives the buffering indicator.
  const [buffered, setBuffered] = useState(0)
  const buffering = active != null && buffered < total

  // Reset the timeline when the scenario switches.
  useEffect(() => {
    setT(0)
    setPlaying(false)
    setBuffered(0)
  }, [active])

  // Auto-play: advance t, looping at the end.
  useEffect(() => {
    if (!playing) return
    const id = setInterval(() => setT((prev) => (prev + 1) % total), PLAYBACK_MS)
    return () => clearInterval(id)
  }, [playing, total])

  // Clicking a scenario sets the sliders so nearestScenario lands on it.
  function selectScenario(s: Scenario) {
    setControls({
      moonDist: s.moon_dist_km,
      moonMass: s.moon_mass_rel,
      omegaRel: s.omega_rad_s / EARTH_OMEGA,
      temp: s.temperature_C,
    })
  }

  return (
    <div className="app">
      <main className="globe-pane">
        <Globe
          scenario={active}
          total={total}
          t={t}
          chi={chi}
          onProgress={setBuffered}
        />

        {/* atmospheric depth + grain over the globe */}
        <div className="globe-vignette" aria-hidden />
        <div className="globe-grain" aria-hidden />

        <header className="hud hud-top">
          <div className="wordmark">
            <span className="wordmark-eyebrow">◇ Observatory</span>
            <span className="wordmark-title">Planetary Ocean</span>
          </div>
          <div className="hud-right">
            <span className={`live ${buffering ? 'sync' : ''}`}>
              <span className="live-dot" />
              {buffering ? `buffering ${buffered}/${total}` : 'live feed'}
            </span>
            <OmegaBadge omega={omega} />
          </div>
        </header>

        {active && (
          <Timeline
            t={t}
            total={total}
            playing={playing}
            loading={buffering}
            onChange={setT}
            onTogglePlay={() => setPlaying((p) => !p)}
          />
        )}

        {!active && (
          <div className="placeholder">{error ?? 'Establishing link…'}</div>
        )}
      </main>

      <aside className="console">
        <div className="console-section console-brand">
          <h1>
            Planetary<span>Ocean</span>
          </h1>
          <p className="brand-sub">Full-sphere shallow-water · spec v2</p>
        </div>

        <section className="console-section">
          <div className="eyebrow">Parameters</div>
          <ControlPanel
            values={controls}
            onChange={(patch) => setControls((c) => ({ ...c, ...patch }))}
          />
        </section>

        <section className="console-section">
          <div className="eyebrow">Active field</div>
          <div className="readout">
            <div className="readout-id mono">{active ?? '—'}</div>
            {activeMeta && (
              <div className="stat-grid">
                <Stat
                  k="Grid"
                  v={`${activeMeta.grid_shape[0]}×${activeMeta.grid_shape[1]}`}
                />
                <Stat k="Δt" v={`${activeMeta.dt_seconds}s`} />
                <Stat k="Steps" v={`${activeMeta.T_total_steps}`} />
                <Stat k="Temp" v={`${activeMeta.temperature_C}°C`} />
              </div>
            )}
          </div>
        </section>

        <section className="console-section">
          <div className="eyebrow">
            Scenario library <span className="count">{scenarios.length}</span>
          </div>
          <ul className="scenario-list">
            {scenarios.map((s) => (
              <li key={s.id}>
                <button
                  className={s.id === active ? 'active' : ''}
                  onClick={() => selectScenario(s)}
                >
                  <span className="scen-id">{s.id}</span>
                  <span className="scen-meta mono">
                    {Math.round(s.moon_dist_km / 1000)}k · Ω
                    {(s.omega_rad_s / EARTH_OMEGA).toFixed(1)} ·{' '}
                    {s.temperature_C}°
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        {error && <p className="console-error">{error}</p>}
      </aside>
    </div>
  )
}

export default App
