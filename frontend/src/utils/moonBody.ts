// A real 3D moon: a cratered sphere that orbits above the sub-lunar point and
// shows a phase, lit by a fixed directional light. Replaces the old arrow +
// dot + "MOON" label indicator. Pure helpers, no React.
import * as Cesium from 'cesium'

// Visual scale (artistic — the true 60-Earth-radii distance is off-screen).
export const MOON_RADIUS = 1_350_000 // m
export const MOON_ALTITUDE = 6_800_000 // m above the surface, sub-lunar point

// Small deterministic PRNG so the moon looks the same every reload.
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Equirectangular albedo map: regolith with broad tonal variation, contrasty
// maria, and craters rendered with a directional rim light so they read as 3D.
export function makeMoonTexture(): HTMLCanvasElement {
  const W = 2048
  const H = 1024
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!
  const rand = mulberry32(0x10ca1)

  // crater light comes from the upper-left in texture space
  const lx = -0.7
  const ly = -0.7

  // base regolith
  ctx.fillStyle = '#9a958b'
  ctx.fillRect(0, 0, W, H)

  // broad highland/lowland tonal regions (large soft blobs)
  for (let i = 0; i < 90; i++) {
    const x = rand() * W
    const y = rand() * H
    const r = 80 + rand() * 320
    const lit = rand() > 0.5
    const tone = lit ? 178 + rand() * 26 : 120 + rand() * 28
    const g = ctx.createRadialGradient(x, y, 0, x, y, r)
    g.addColorStop(0, `rgba(${tone + 6},${tone},${tone - 8},0.14)`)
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
  }

  // fine regolith speckle
  for (let i = 0; i < 4000; i++) {
    const t = 130 + rand() * 70
    ctx.fillStyle = `rgba(${t},${t - 3},${t - 9},0.04)`
    const r = 2 + rand() * 10
    ctx.beginPath()
    ctx.arc(rand() * W, rand() * H, r, 0, Math.PI * 2)
    ctx.fill()
  }

  // maria — large dark basalt plains, irregular and contrasty
  const maria = [
    [0.30, 0.40, 230],
    [0.46, 0.34, 165],
    [0.40, 0.56, 200],
    [0.63, 0.30, 150],
    [0.71, 0.52, 130],
    [0.20, 0.63, 120],
    [0.55, 0.66, 110],
  ]
  for (const [fx, fy, rad] of maria) {
    const x = fx * W
    const y = fy * H
    // a few overlapping lobes for an organic outline
    for (let l = 0; l < 5; l++) {
      const ox = x + (rand() - 0.5) * rad
      const oy = y + (rand() - 0.5) * rad * 0.7
      const rr = rad * (0.5 + rand() * 0.6)
      const grad = ctx.createRadialGradient(ox, oy, 0, ox, oy, rr)
      grad.addColorStop(0, 'rgba(74,72,70,0.55)')
      grad.addColorStop(0.7, 'rgba(80,78,76,0.4)')
      grad.addColorStop(1, 'rgba(96,94,90,0)')
      ctx.fillStyle = grad
      ctx.beginPath()
      ctx.arc(ox, oy, rr, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  // craters with a directional rim (bright sunlit edge, dark shadowed edge)
  const craters = 520
  for (let i = 0; i < craters; i++) {
    const x = rand() * W
    const y = rand() * H
    const r = 3 + rand() * rand() * 46

    // shadowed floor
    const fl = ctx.createRadialGradient(x, y, 0, x, y, r)
    fl.addColorStop(0, `rgba(64,62,60,${0.28 + rand() * 0.3})`)
    fl.addColorStop(0.8, `rgba(70,68,66,${0.12 + rand() * 0.18})`)
    fl.addColorStop(1, 'rgba(70,68,66,0)')
    ctx.fillStyle = fl
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()

    // sunlit rim arc (upper-left) and shadowed rim arc (lower-right)
    ctx.lineWidth = Math.max(1, r * 0.16)
    const a0 = Math.atan2(ly, lx)
    ctx.strokeStyle = `rgba(220,216,206,${0.22 + rand() * 0.3})`
    ctx.beginPath()
    ctx.arc(x, y, r * 0.95, a0 - 1.1, a0 + 1.1)
    ctx.stroke()
    ctx.strokeStyle = `rgba(46,44,42,${0.22 + rand() * 0.26})`
    ctx.beginPath()
    ctx.arc(x, y, r * 0.95, a0 + Math.PI - 1.1, a0 + Math.PI + 1.1)
    ctx.stroke()

    // ray system for a few large young craters
    if (r > 28 && rand() > 0.55) {
      const rays = 10 + Math.floor(rand() * 12)
      ctx.strokeStyle = 'rgba(208,204,196,0.08)'
      ctx.lineWidth = 1.2
      for (let k = 0; k < rays; k++) {
        const a = rand() * Math.PI * 2
        const len = r * (2.5 + rand() * 5)
        ctx.beginPath()
        ctx.moveTo(x, y)
        ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len)
        ctx.stroke()
      }
    }
  }
  return canvas
}

// One shared sphere primitive; position/rotation set per frame via modelMatrix.
export function makeMoonPrimitive(texture: HTMLCanvasElement): Cesium.Primitive {
  return new Cesium.Primitive({
    geometryInstances: new Cesium.GeometryInstance({
      geometry: new Cesium.EllipsoidGeometry({
        radii: new Cesium.Cartesian3(MOON_RADIUS, MOON_RADIUS, MOON_RADIUS),
        stackPartitions: 48,
        slicePartitions: 48,
        vertexFormat: Cesium.VertexFormat.POSITION_NORMAL_AND_ST,
      }),
    }),
    appearance: new Cesium.MaterialAppearance({
      flat: false, // let the scene's directional light carve a phase (terminator)
      translucent: false,
      materialSupport: Cesium.MaterialAppearance.MaterialSupport.TEXTURED,
      material: Cesium.Material.fromType('Image', { image: texture }),
    }),
    asynchronous: false,
    allowPicking: false,
  })
}

// World transform: translate to the sub-lunar direction at MOON_ALTITUDE and
// add a slow spin so the surface drifts under the light.
export function moonModelMatrix(lonDeg: number, spin: number): Cesium.Matrix4 {
  const pos = Cesium.Cartesian3.fromDegrees(lonDeg, 0, MOON_ALTITUDE)
  const translation = Cesium.Matrix4.fromTranslation(pos)
  const rot = Cesium.Matrix4.fromRotationTranslation(
    Cesium.Matrix3.fromRotationZ(spin),
    Cesium.Cartesian3.ZERO,
  )
  return Cesium.Matrix4.multiply(translation, rot, new Cesium.Matrix4())
}
