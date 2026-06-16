import { EARTH_OMEGA } from '../utils/scenarios'

// CLAUDE.md §7.7 — current rotation relative to Earth. Tone encodes regime:
// hot (fast jets) / calm (Earth-like) / cold (near-stationary).
export function OmegaBadge({ omega }: { omega: number }) {
  const rel = omega / EARTH_OMEGA
  const tone = rel > 2 ? 'hot' : rel < 0.3 ? 'cold' : 'calm'
  return (
    <span className={`ledger ledger-omega ${tone}`}>
      <span className="ledger-omega-sym display">Ω</span>
      <span className="ledger-v tnum">{rel.toFixed(1)}×</span>
      <span className="ledger-k">Earth</span>
    </span>
  )
}
