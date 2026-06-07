// eta / chi / anomaly arrays → RGBA ImageData, plus a helper to hand the
// pixels to Cesium as a single-tile imagery layer. CLAUDE.md §7.4.

// eta → RGBA: blue (neg) → white (0) → red (pos), grey for land.
export function etaToTexture(
  eta: number[][],
  chi: number[][],
  vmin = -2,
  vmax = 2,
): ImageData {
  const lat = eta.length,
    lon = eta[0].length
  const buf = new Uint8ClampedArray(lat * lon * 4)
  for (let i = 0; i < lat; i++) {
    for (let j = 0; j < lon; j++) {
      const idx = (i * lon + j) * 4
      if (chi[i][j] > 0.5) {
        buf[idx] = 120
        buf[idx + 1] = 100
        buf[idx + 2] = 80
        buf[idx + 3] = 220
        continue
      }
      const t = Math.max(0, Math.min(1, (eta[i][j] - vmin) / (vmax - vmin)))
      buf[idx] = Math.round(Math.min(255, t * 2 * 255))
      buf[idx + 1] = Math.round(Math.max(0, (1 - Math.abs(t - 0.5) * 2) * 200))
      buf[idx + 2] = Math.round(Math.max(0, (1 - t) * 2 * 255))
      buf[idx + 3] = 190
    }
  }
  return new ImageData(buf, lon, lat)
}

// anomaly mask → red overlay, transparent where no anomaly or land.
export function anomalyToTexture(
  mask: boolean[][],
  scores: number[][],
  chi: number[][],
): ImageData {
  const lat = mask.length,
    lon = mask[0].length
  const buf = new Uint8ClampedArray(lat * lon * 4)
  for (let i = 0; i < lat; i++) {
    for (let j = 0; j < lon; j++) {
      const idx = (i * lon + j) * 4
      if (chi[i][j] > 0.5 || !mask[i][j]) continue
      const intensity = Math.min(1, Math.abs(scores[i][j]) / 5)
      buf[idx] = 220
      buf[idx + 1] = Math.round(40 * (1 - intensity))
      buf[idx + 2] = 40
      buf[idx + 3] = Math.round(200 * intensity)
    }
  }
  return new ImageData(buf, lon, lat)
}

// land mask → opaque grey where land, fully transparent over ocean.
// Rendered as its own imagery layer (fetched once via GET /land), so it
// persists while the eta heatmap updates per timestep. Invisible while
// chi = 0 everywhere — wired and ready for real topography (CLAUDE.md §3.4).
export function chiToTexture(chi: number[][]): ImageData {
  const lat = chi.length,
    lon = chi[0].length
  const buf = new Uint8ClampedArray(lat * lon * 4)
  for (let i = 0; i < lat; i++) {
    for (let j = 0; j < lon; j++) {
      if (chi[i][j] <= 0.5) continue
      const idx = (i * lon + j) * 4
      buf[idx] = 120
      buf[idx + 1] = 100
      buf[idx + 2] = 80
      buf[idx + 3] = 235
    }
  }
  return new ImageData(buf, lon, lat)
}

// ImageData → data-URL PNG, flipped vertically.
// Zarr/eta row 0 = south (lat −90); a Cesium imagery rectangle maps the
// image's TOP edge to its northern latitude, so we flip rows north-up.
export function imageDataToDataUrl(img: ImageData): string {
  const src = document.createElement('canvas')
  src.width = img.width
  src.height = img.height
  src.getContext('2d')!.putImageData(img, 0, 0)

  const out = document.createElement('canvas')
  out.width = img.width
  out.height = img.height
  const ctx = out.getContext('2d')!
  ctx.translate(0, img.height)
  ctx.scale(1, -1)
  ctx.drawImage(src, 0, 0)
  return out.toDataURL()
}
