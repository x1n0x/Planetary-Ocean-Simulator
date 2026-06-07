// Bottom timeline overlay: play/pause + scrubber + loading indicator.
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
  return (
    <div className="timeline">
      <button className="play-btn" onClick={onTogglePlay} aria-label="play/pause">
        {playing ? '❚❚' : '▶'}
      </button>
      <input
        className="scrubber"
        type="range"
        min={0}
        max={last}
        value={Math.min(t, last)}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="t-label mono">
        {t} / {last}
      </span>
      <span className={`load-dot ${loading ? 'on' : ''}`} aria-hidden />
    </div>
  )
}
