import { EARTH_OMEGA } from '../utils/scenarios'

// CLAUDE.md §7.7 — current rotation relative to Earth. Tone encodes regime:
// hot (fast jets) / calm (Earth-like) / cold (near-stationary).
export function OmegaBadge({ omega }: { omega: number }) {
  const rel = omega / EARTH_OMEGA
  const tone = rel > 2 ? 'hot' : rel < 0.3 ? 'cold' : 'calm'
  return (
    <div className={`omega-badge ${tone}`}>
      <span className="omega-dot" />
      <span className="omega-body">
        <span className="omega-sym">Ω</span>
        <span className="omega-val">{rel.toFixed(1)}×</span>
        <span className="omega-unit">Earth</span>
      </span>
    </div>
  )
}
