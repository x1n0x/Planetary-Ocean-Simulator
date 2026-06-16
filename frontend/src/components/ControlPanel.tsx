import { EARTH_MOON_KM } from '../utils/scenarios'

// CLAUDE.md §7.6 — four sliders. Ω is the new v2 control. Values flow up to
// App, which snaps to the nearest precomputed scenario on every change.
export interface ControlValues {
  moonDist: number // km
  moonMass: number // × Moon
  omegaRel: number // × Earth
  temp: number // °C
}

function Row({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  display: string
  onChange: (v: number) => void
}) {
  return (
    <div className="ctrl-row">
      <div className="ctrl-head">
        <span className="ctrl-label">{label}</span>
        <span className="tnum ctrl-val">{display}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  )
}

export function ControlPanel({
  values,
  onChange,
}: {
  values: ControlValues
  onChange: (patch: Partial<ControlValues>) => void
}) {
  const { moonDist, moonMass, omegaRel, temp } = values
  return (
    <div className="control-panel">
      <Row
        label="Moon distance"
        value={moonDist}
        min={0.5 * EARTH_MOON_KM}
        max={3 * EARTH_MOON_KM}
        step={1000}
        display={`${(moonDist / EARTH_MOON_KM).toFixed(2)}× (${Math.round(
          moonDist / 1000,
        )}k km)`}
        onChange={(v) => onChange({ moonDist: v })}
      />
      <Row
        label="Moon mass"
        value={moonMass}
        min={0}
        max={3}
        step={0.1}
        display={`${moonMass.toFixed(1)}×`}
        onChange={(v) => onChange({ moonMass: v })}
      />
      <Row
        label="Rotation Ω"
        value={omegaRel}
        min={0.1}
        max={5}
        step={0.1}
        display={`${omegaRel.toFixed(1)}× Earth`}
        onChange={(v) => onChange({ omegaRel: v })}
      />
      <Row
        label="Temperature"
        value={temp}
        min={-10}
        max={30}
        step={1}
        display={`${temp.toFixed(0)}°C`}
        onChange={(v) => onChange({ temp: v })}
      />
    </div>
  )
}
