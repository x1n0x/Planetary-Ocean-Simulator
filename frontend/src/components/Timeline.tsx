// Bottom transport: play/pause, scrubber with tick marks, current frame, and a
// loading lamp.
export function Timeline({
  t,
  total,
  playing,
  loading,
  onChange,
  onTogglePlay,
}: {
  t: number
  total: number
  playing: boolean
  loading: boolean
  onChange: (t: number) => void
  onTogglePlay: () => void
}) {
  const last = Math.max(0, total - 1)
  // a handful of engraved tick marks along the scale
  const ticks = 8
  return (
    <div className="ephemeris">
      <button
        className={`transit ${playing ? 'running' : ''}`}
        onClick={onTogglePlay}
        aria-label="play/pause"
      >
        {playing ? '‖' : '▸'}
      </button>

      <div className="scale">
        <div className="scale-ticks" aria-hidden>
          {Array.from({ length: ticks + 1 }, (_, i) => (
            <span key={i} style={{ left: `${(i / ticks) * 100}%` }} />
          ))}
        </div>
        <input
          className="scrubber"
          type="range"
          min={0}
          max={last}
          value={Math.min(t, last)}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </div>

      <span className="transit-read tnum">
        <em>t</em> {String(t).padStart(3, '0')}
        <span className="transit-of">/ {last}</span>
      </span>
      <span className={`transit-lamp ${loading ? 'on' : ''}`} aria-hidden />
    </div>
  )
}
