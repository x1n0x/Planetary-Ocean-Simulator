import { useEffect, useMemo, useState } from 'react'

import { Globe } from './components/Globe'
import { OmegaBadge } from './components/OmegaBadge'
import { Timeline } from './components/Timeline'
import { ControlPanel, type ControlValues } from './components/ControlPanel'
import { EnergyChart } from './components/EnergyChart'
import { useLandMask } from './hooks/useLandMask'
import { nearestScenario, EARTH_OMEGA } from './utils/scenarios'
import { getScenarios, getEnergy } from './api'
import type { Scenario, EnergySeries } from './types'
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

  // Phase 3 overlays.
  const [showAnomaly, setShowAnomaly] = useState(false)
  const [anomalyCount, setAnomalyCount] = useState<number | null>(null)
  const [showVectors, setShowVectors] = useState(false)

  // Full energy series for the chart, fetched once per scenario.
  const [energy, setEnergy] = useState<EnergySeries | null>(null)
  useEffect(() => {
    if (!active) return
    let cancelled = false
    getEnergy(active)
      .then((e) => !cancelled && setEnergy(e))
      .catch((err) => console.error('[energy]', err))
    return () => {
      cancelled = true
    }
  }, [active])

  // Reset transient state the moment the scenario switches — React's
  // "adjust state during render" pattern, no effect required.
  const [prevActive, setPrevActive] = useState(active)
  if (active !== prevActive) {
    setPrevActive(active)
    setT(0)
    setPlaying(false)
    setBuffered(0)
    setEnergy(null)
  }

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
          showAnomaly={showAnomaly}
          showVectors={showVectors}
          onProgress={setBuffered}
          onAnomalyCount={setAnomalyCount}
        />

        {/* subtle edge darkening so the globe sits in space */}
        <div className="globe-vignette" aria-hidden />

        <header className="hud hud-top">
          <div className="wordmark">
            <span className="wordmark-title">Planetary Ocean</span>
          </div>
          <div className="hud-right">
            {showAnomaly && anomalyCount != null && (
              <span className="anomaly-chip">
                <span className="anomaly-dot" />
                {anomalyCount} anomalous
              </span>
            )}
            <span className={`live ${buffering ? 'sync' : ''}`}>
              <span className="live-dot" />
              <span className="live-text">
                {buffering ? `Buffering ${buffered}/${total}` : 'Live feed'}
              </span>
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
          <div className="eyebrow">Analysis</div>
          <button
            className={`toggle ${showAnomaly ? 'on' : ''}`}
            onClick={() => setShowAnomaly((a) => !a)}
          >
            <span className="toggle-track">
              <span className="toggle-knob" />
            </span>
            <span className="toggle-label">Anomaly overlay</span>
            {showAnomaly && anomalyCount != null && (
              <span className="toggle-count">{anomalyCount}</span>
            )}
          </button>

          <button
            className={`toggle ${showVectors ? 'on' : ''}`}
            onClick={() => setShowVectors((s) => !s)}
          >
            <span className="toggle-track">
              <span className="toggle-knob" />
            </span>
            <span className="toggle-label">Current vectors</span>
          </button>

          {energy ? (
            <div className="chart-wrap">
              <EnergyChart
                E_k={energy.E_k}
                E_p={energy.E_p}
                spikeTimes={energy.spikes}
                t={t}
                total={total}
              />
            </div>
          ) : (
            <div className="chart-skeleton">loading energy…</div>
          )}
        </section>

        <section className="console-section">
          <div className="eyebrow">
            Scenario library <span className="count">{scenarios.length}</span>
          </div>
          <ul className="scenario-list">
            {scenarios.map((s) => {
              const rel = s.omega_rad_s / EARTH_OMEGA
              const tone = rel > 2 ? 'hot' : rel < 0.3 ? 'cold' : 'calm'
              return (
                <li key={s.id}>
                  <button
                    className={s.id === active ? 'active' : ''}
                    onClick={() => selectScenario(s)}
                  >
                    <span className={`scen-omega ${tone}`}>
                      Ω {rel.toFixed(1)}×
                    </span>
                    <span className="scen-dims mono">
                      {Math.round(s.moon_dist_km / 1000)}k km · {s.temperature_C}
                      °C
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </section>

        {error && <p className="console-error">{error}</p>}
      </aside>
    </div>
  )
}

export default App
