import { useMemo } from 'react'

// Lightweight custom SVG sparkline — no Plotly. Two thin lines (E_k / E_p),
// spike ticks, a playhead at the current timestep, and a live readout.
// CLAUDE.md §7.8.

const VW = 1000 // viewBox width; height scales via CSS, strokes stay crisp.
const VH = 100
const PAD = 10

function buildPath(series: number[]): string {
  const n = series.length
  if (n < 2) return ''
  const min = Math.min(...series)
  const max = Math.max(...series)
  const span = max - min || 1
  let d = ''
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * VW
    const y = VH - PAD - ((series[i] - min) / span) * (VH - 2 * PAD)
    d += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)} `
  }
  return d.trim()
}

const fmt = (v: number) => v.toExponential(1).replace('e+', 'e')

export function EnergyChart({
  E_k,
  E_p,
  spikeTimes,
  t,
  total,
}: {
  E_k: number[]
  E_p: number[]
  spikeTimes: number[]
  t: number
  total: number
}) {
  const ekPath = useMemo(() => buildPath(E_k), [E_k])
  const epPath = useMemo(() => buildPath(E_p), [E_p])
  const n = E_k.length
  const xAt = (i: number) => (n > 1 ? (i / (n - 1)) * VW : 0)
  const phx = total > 1 ? (t / (total - 1)) * VW : 0
  const cur = Math.min(t, n - 1)

  return (
    <div className="chart-wrap">
      <div className="spark-legend">
        <span>
          <i className="dot ek" />
          <em>kinetic</em> <b className="tnum">{fmt(E_k[cur] ?? 0)}</b>
        </span>
        <span>
          <i className="dot ep" />
          <em>potential</em> <b className="tnum">{fmt(E_p[cur] ?? 0)}</b>
        </span>
      </div>

      <svg
        className="spark"
        viewBox={`0 0 ${VW} ${VH}`}
        preserveAspectRatio="none"
      >
        {spikeTimes.map((s) => (
          <line
            key={s}
            className="spark-spike"
            x1={xAt(s)}
            x2={xAt(s)}
            y1={0}
            y2={16}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        <path
          className="spark-line ep"
          d={epPath}
          fill="none"
          vectorEffect="non-scaling-stroke"
        />
        <path
          className="spark-line ek"
          d={ekPath}
          fill="none"
          vectorEffect="non-scaling-stroke"
        />
        <line
          className="spark-playhead"
          x1={phx}
          x2={phx}
          y1={0}
          y2={VH}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  )
}
