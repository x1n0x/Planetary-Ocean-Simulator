import { useEffect, useMemo, useState, type ReactNode } from 'react'

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

// A single labelled stat: value over a small-caps label.
function Reading({ k, v }: { k: string; v: string }) {
  return (
    <div className="reading">
      <span className="reading-v display tnum">{v}</span>
      <span className="reading-k">{k}</span>
    </div>
  )
}

// A numbered section (Roman numeral + title).
function Movement({
  mark,
  title,
  aside,
  children,
}: {
  mark: string
  title: string
  aside?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="movement">
      <div className="movement-head">
        <span className="movement-mark display">{mark}</span>
        <h2 className="movement-title">{title}</h2>
        {aside != null && <span className="movement-aside tnum">{aside}</span>}
      </div>
      {children}
    </section>
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
  // 3D plexus wave surface — the default view.
  const [showMesh, setShowMesh] = useState(true)

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

  // Clicking a catalogue entry sets the sliders so nearestScenario lands on it.
  function selectScenario(s: Scenario) {
    setControls({
      moonDist: s.moon_dist_km,
      moonMass: s.moon_mass_rel,
      omegaRel: s.omega_rad_s / EARTH_OMEGA,
      temp: s.temperature_C,
    })
  }

  const issue = String(scenarios.length).padStart(2, '0')

  return (
    <div className="atlas">
      <main className="plate">
        <Globe
          scenario={active}
          total={total}
          t={t}
          chi={chi}
          showAnomaly={showAnomaly}
          showVectors={showVectors}
          showMesh={showMesh}
          meta={activeMeta}
          onProgress={setBuffered}
          onAnomalyCount={setAnomalyCount}
        />

        {/* grain texture + soft edge over the globe */}
        <div className="plate-grain" aria-hidden />
        <div className="plate-edge" aria-hidden />

        {/* top bar: title ···· status */}
        <header className="folio folio-top">
          <div className="colophon">
            <span className="colophon-mark" aria-hidden />
            <span className="colophon-name">Planetary Ocean</span>
            <span className="colophon-rule" aria-hidden />
            <span className="colophon-issue tnum">{issue} scenarios</span>
          </div>
          <div className="status-rail">
            {showAnomaly && anomalyCount != null && (
              <span className="ledger ledger-oxide">
                <span className="ledger-v tnum">{anomalyCount}</span>
                <span className="ledger-k">anomalous</span>
              </span>
            )}
            <span className={`ledger ${buffering ? 'ledger-work' : ''}`}>
              <span className="ledger-dot" aria-hidden />
              <span className="ledger-k">
                {buffering ? `loading ${buffered}/${total}` : 'live'}
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
          <div className="placeholder display">{error ?? 'Loading…'}</div>
        )}
      </main>

      <aside className="leaf">
        <div className="masthead">
          <span className="masthead-eyebrow">Shallow-water sphere · v2</span>
          <h1 className="masthead-title display">
            Planetary
            <em>Ocean</em>
          </h1>
          <p className="masthead-sub">
            Full-sphere shallow-water model. Adjustable moon and rotation.
          </p>
        </div>

        <Movement mark="I" title="Parameters">
          <ControlPanel
            values={controls}
            onChange={(patch) => setControls((c) => ({ ...c, ...patch }))}
          />
        </Movement>

        <Movement mark="II" title="Active field" aside={active ? undefined : '—'}>
          <div className="field-id tnum">{active ?? 'No scenario selected'}</div>
          {activeMeta && (
            <div className="field-grid">
              <Reading
                k="grid"
                v={`${activeMeta.grid_shape[0]}×${activeMeta.grid_shape[1]}`}
              />
              <Reading k="step Δt" v={`${activeMeta.dt_seconds}s`} />
              <Reading k="frames" v={`${activeMeta.T_total_steps}`} />
              <Reading k="temperature" v={`${activeMeta.temperature_C}°`} />
            </div>
          )}
        </Movement>

        <Movement mark="III" title="Layers">
          <div className="lantern-row">
            <button
              className={`lantern ${showMesh ? 'lit' : ''}`}
              onClick={() => setShowMesh((m) => !m)}
            >
              <span className="lantern-glyph" aria-hidden />
              <span className="lantern-label">Wave mesh</span>
            </button>
            <button
              className={`lantern ${showAnomaly ? 'lit lit-oxide' : ''}`}
              onClick={() => setShowAnomaly((a) => !a)}
            >
              <span className="lantern-glyph" aria-hidden />
              <span className="lantern-label">Anomalies</span>
              {showAnomaly && anomalyCount != null && (
                <span className="lantern-count tnum">{anomalyCount}</span>
              )}
            </button>
            <button
              className={`lantern ${showVectors ? 'lit' : ''}`}
              onClick={() => setShowVectors((s) => !s)}
            >
              <span className="lantern-glyph" aria-hidden />
              <span className="lantern-label">Currents</span>
            </button>
          </div>

          {energy ? (
            <EnergyChart
              E_k={energy.E_k}
              E_p={energy.E_p}
              spikeTimes={energy.spikes}
              t={t}
              total={total}
            />
          ) : (
            <div className="chart-skeleton">loading…</div>
          )}
        </Movement>

        <Movement mark="IV" title="Scenarios" aside={`${scenarios.length}`}>
          <ol className="catalogue">
            {scenarios.map((s, i) => {
              const rel = s.omega_rad_s / EARTH_OMEGA
              const tone = rel > 2 ? 'hot' : rel < 0.3 ? 'cold' : 'calm'
              return (
                <li key={s.id}>
                  <button
                    className={s.id === active ? 'entry active' : 'entry'}
                    onClick={() => selectScenario(s)}
                  >
                    <span className="entry-no tnum">
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <span className="entry-body">
                      <span className="entry-dims tnum">
                        {Math.round(s.moon_dist_km / 1000)}k km · {s.temperature_C}
                        °C
                      </span>
                      <span className={`entry-omega ${tone} tnum`}>
                        Ω {rel.toFixed(1)}×
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ol>
        </Movement>

        {error && <p className="dispatch-error">{error}</p>}
      </aside>
    </div>
  )
}

export default App
