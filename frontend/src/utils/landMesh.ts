// Relief land: chi (the land mask) becomes raised volcanic islands — a
// subdivided, height-displaced surface with domed interiors and ridged
// mountains, coloured by altitude and lit by a baked hillshade. Geometry and
// texture share one continuous height field, so silhouette and shading agree.
// Built once per scenario (chi is static). Pure helpers, no React.
import * as Cesium from 'cesium'

const EARTH_R = 6_378_137
export const LAND_BASE = 26_000 // m — coastline lift, just above the wave base
const LAND_RELIEF = 540_000 // m — peak height of the tallest summits
const SUB = 3 // geometry subdivisions per grid cell (sharper coastlines)
const TS = 5 // texture supersample per grid cell (no soapy blur)

// ---- deterministic value-noise fBm + ridged variant, stable each reload ----
function hash(ix: number, iy: number): number {
  const s = Math.sin(ix * 127.1 + iy * 311.7) * 43758.5453
  return s - Math.floor(s)
}
function valueNoise(x: number, y: number): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = x - ix
  const fy = y - iy
  const ux = fx * fx * (3 - 2 * fx)
  const uy = fy * fy * (3 - 2 * fy)
  const a = hash(ix, iy)
  const b = hash(ix + 1, iy)
  const c = hash(ix, iy + 1)
  const d = hash(ix + 1, iy + 1)
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy
}
function fbm(x: number, y: number): number {
  let v = 0
  let amp = 0.5
  let freq = 1
  for (let o = 0; o < 5; o++) {
    v += amp * valueNoise(x * freq, y * freq)
    freq *= 2.03
    amp *= 0.5
  }
  return v
}
// ridged multifractal — folded noise that builds sharp mountain crests
function ridged(x: number, y: number): number {
  let v = 0
  let amp = 0.5
  let freq = 1
  let weight = 1
  for (let o = 0; o < 6; o++) {
    let n = valueNoise(x * freq, y * freq)
    n = 1 - Math.abs(2 * n - 1) // fold to ridges
    n *= n
    v += amp * n * weight
    weight = Math.min(1, n * 1.4) // higher octaves only on existing ridges
    freq *= 2.07
    amp *= 0.52
  }
  return v
}

// smoothstep coastline so chi's tanh edge ramps up gently from the sea
function landMask(chi: number): number {
  const t = Math.min(1, Math.max(0, (chi - 0.42) / 0.36))
  return t * t * (3 - 2 * t)
}

// ---- continuous height field shared by geometry and texture ----
interface HeightField {
  nLat: number
  dataLon: number
  sample: (gi: number, gj: number) => number // gi=lat row, gj=lon col (frac)
}

function makeHeightField(chi: number[][]): HeightField {
  const nLat = chi.length
  const dataLon = chi[0].length
  const flat = new Float32Array(nLat * dataLon)
  for (let i = 0; i < nLat; i++)
    for (let j = 0; j < dataLon; j++) flat[i * dataLon + j] = chi[i][j]

  // box-blur chi into an "island mass" field → domed interiors, low coasts
  let mass = flat.slice()
  for (let pass = 0; pass < 4; pass++) {
    const next = new Float32Array(nLat * dataLon)
    for (let i = 0; i < nLat; i++) {
      for (let j = 0; j < dataLon; j++) {
        let s = 0
        let n = 0
        for (let di = -1; di <= 1; di++) {
          const ii = i + di
          if (ii < 0 || ii >= nLat) continue
          for (let dj = -1; dj <= 1; dj++) {
            const jj = ((j + dj) % dataLon + dataLon) % dataLon
            s += mass[ii * dataLon + jj]
            n++
          }
        }
        next[i * dataLon + j] = s / n
      }
    }
    mass = next
  }

  const bilinear = (arr: Float32Array, gi: number, gj: number): number => {
    const i0 = Math.max(0, Math.min(nLat - 1, Math.floor(gi)))
    const i1 = Math.min(nLat - 1, i0 + 1)
    const fi = Math.max(0, Math.min(1, gi - Math.floor(gi)))
    const j0 = ((Math.floor(gj) % dataLon) + dataLon) % dataLon
    const j1 = (j0 + 1) % dataLon
    const fj = gj - Math.floor(gj)
    const a = arr[i0 * dataLon + j0]
    const b = arr[i0 * dataLon + j1]
    const c = arr[i1 * dataLon + j0]
    const d = arr[i1 * dataLon + j1]
    return (a * (1 - fj) + b * fj) * (1 - fi) + (c * (1 - fj) + d * fj) * fi
  }

  const sample = (gi: number, gj: number): number => {
    const m = landMask(bilinear(flat, gi, gj))
    if (m <= 0) return 0
    const dome = Math.min(1, bilinear(mass, gi, gj) * 1.15) // inland height
    const crest = ridged(gj * 0.6 + 5, gi * 0.6 + 9) // mountain ridges
    const relief = 0.32 * dome + 0.68 * crest
    return LAND_BASE + m * relief * LAND_RELIEF
  }

  return { nLat, dataLon, sample }
}

export interface LandTemplate {
  nLat: number
  dataLon: number
  positions: Float64Array
  normals: Float32Array
  st: Float32Array
  indices: Uint32Array
  hasLand: boolean
  heightAt: (gi: number, gj: number) => number
  boundingSphere: Cesium.BoundingSphere
}

export function buildLandTemplate(chi: number[][]): LandTemplate {
  const hf = makeHeightField(chi)
  const { nLat, dataLon } = hf

  const gLat = (nLat - 1) * SUB + 1 // subdivided rows
  const gLon = dataLon * SUB + 1 // +1 duplicated seam column
  const N = gLat * gLon

  const positions = new Float64Array(N * 3)
  const normals = new Float32Array(N * 3)
  const st = new Float32Array(N * 2)
  const land = new Uint8Array(N)
  let hasLand = false

  const pos = new Cesium.Cartesian3()
  const nrm = new Cesium.Cartesian3()
  for (let r = 0; r < gLat; r++) {
    const gi = r / SUB
    const latDeg = -90 + (gi / (nLat - 1)) * 180
    for (let c = 0; c < gLon; c++) {
      const k = r * gLon + c
      const gj = c / SUB
      const lonDeg = -180 + (gj % dataLon) * (360 / dataLon)
      const h = hf.sample(gi, gj % dataLon)
      Cesium.Ellipsoid.WGS84.cartographicToCartesian(
        Cesium.Cartographic.fromDegrees(lonDeg, latDeg, 0),
        pos,
      )
      Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(pos, nrm)
      positions[k * 3] = pos.x + nrm.x * h
      positions[k * 3 + 1] = pos.y + nrm.y * h
      positions[k * 3 + 2] = pos.z + nrm.z * h
      normals[k * 3] = nrm.x
      normals[k * 3 + 1] = nrm.y
      normals[k * 3 + 2] = nrm.z
      st[k * 2] = gj / dataLon
      st[k * 2 + 1] = gi / (nLat - 1)
      land[k] = h > 0 ? 1 : 0
      if (h > 0) hasLand = true
    }
  }

  // triangles over land cells (a cell is land if any corner is land → coasts
  // close cleanly down to the sea)
  const tris: number[] = []
  for (let r = 0; r < gLat - 1; r++) {
    for (let c = 0; c < gLon - 1; c++) {
      const v00 = r * gLon + c
      const v01 = v00 + 1
      const v10 = v00 + gLon
      const v11 = v10 + 1
      if (land[v00] || land[v01] || land[v10] || land[v11]) {
        tris.push(v00, v01, v10, v10, v01, v11)
      }
    }
  }

  return {
    nLat,
    dataLon,
    positions,
    normals,
    st,
    indices: new Uint32Array(tris),
    hasLand,
    heightAt: hf.sample,
    boundingSphere: new Cesium.BoundingSphere(
      Cesium.Cartesian3.ZERO,
      EARTH_R + LAND_BASE + LAND_RELIEF,
    ),
  }
}

// altitude ramp: wet basalt → volcanic sand → tuff → rock → scree → snow
function altColor(h01: number): [number, number, number] {
  const stops: [number, number, number, number][] = [
    [0.0, 0x39, 0x33, 0x2f], // wet volcanic rock at the waterline
    [0.05, 0x6f, 0x62, 0x52], // damp dark sand
    [0.13, 0x9c, 0x8b, 0x69], // warm volcanic sand / tuff
    [0.32, 0x84, 0x72, 0x59], // basalt brown
    [0.52, 0x6f, 0x6b, 0x5b], // olive-grey weathered rock
    [0.72, 0x90, 0x88, 0x79], // grey stone
    [0.86, 0xbe, 0xb8, 0xab], // pale scree
    [1.0, 0xf1, 0xee, 0xe6], // snow
  ]
  for (let s = 0; s < stops.length - 1; s++) {
    const [p0, r0, g0, b0] = stops[s]
    const [p1, r1, g1, b1] = stops[s + 1]
    if (h01 <= p1) {
      const f = (h01 - p0) / (p1 - p0 || 1)
      return [r0 + (r1 - r0) * f, g0 + (g1 - g0) * f, b0 + (b1 - b0) * f]
    }
  }
  const last = stops[stops.length - 1]
  return [last[1], last[2], last[3]]
}

// Colour + baked hillshade, sampled by st. North-up to match the flipY upload
// (canvas row 0 = lat +90 = grid row nLat-1).
export function landColorCanvas(tpl: LandTemplate): HTMLCanvasElement {
  const { nLat, dataLon, heightAt } = tpl
  const W = dataLon * TS
  const H = nLat * TS
  const peak = LAND_BASE + LAND_RELIEF

  // pass 1 — sample the shared height field per texel
  const dh = new Float32Array(W * H)
  for (let r = 0; r < H; r++) {
    const gi = (1 - r / (H - 1)) * (nLat - 1) // canvas row 0 = north
    for (let c = 0; c < W; c++) {
      const gj = (c / W) * dataLon
      dh[r * W + c] = heightAt(gi, gj)
    }
  }

  // pass 2 — altitude colour, coastal foam, hillshade + AO
  const LX = -0.62
  const LY = -0.5
  const LZ = 0.62
  const cell = 60_000 / TS // metres per texel, tuned for crisp shadows
  const dAt = (r: number, c: number) =>
    dh[Math.max(0, Math.min(H - 1, r)) * W + (((c % W) + W) % W)]
  const buf = new Uint8ClampedArray(W * H * 4)
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const h = dh[r * W + c]
      const idx = (r * W + c) * 4
      if (h <= 0) continue // sea → transparent

      const h01 = Math.max(0, Math.min(1, (h - LAND_BASE) / (peak - LAND_BASE)))
      let [cr, cg, cb] = altColor(h01)

      // coastal foam / wet sand band right at the waterline
      const foam = Math.max(0, 1 - h01 / 0.05)
      if (foam > 0) {
        cr = cr + (0xd9 - cr) * foam * 0.6
        cg = cg + (0xce - cg) * foam * 0.6
        cb = cb + (0xbb - cb) * foam * 0.6
      }

      // rocky colour speckle so plateaus don't read as plastic
      const grain = (fbm(c * 0.5, r * 0.5) - 0.5) * 22
      cr += grain
      cg += grain
      cb += grain

      // hillshade from neighbouring detailed heights
      const dx = (dAt(r, c + 1) - dAt(r, c - 1)) / cell
      const dy = (dAt(r + 1, c) - dAt(r - 1, c)) / cell
      const len = Math.hypot(dx, dy, 1)
      const shade = Math.max(0.26, (-dx * LX - dy * LY + LZ) / len)
      // gentle ambient occlusion as the land meets the sea
      const ao = 0.78 + 0.22 * Math.min(1, h01 / 0.12)
      const sh = (0.46 + 0.82 * shade) * ao

      buf[idx] = cr * sh
      buf[idx + 1] = cg * sh
      buf[idx + 2] = cb * sh
      buf[idx + 3] = 255
    }
  }

  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  canvas.getContext('2d')!.putImageData(new ImageData(buf, W, H), 0, 0)
  return canvas
}

export function makeLandPrimitive(
  tpl: LandTemplate,
  canvas: HTMLCanvasElement,
): Cesium.Primitive {
  return new Cesium.Primitive({
    geometryInstances: new Cesium.GeometryInstance({
      geometry: new Cesium.Geometry({
        attributes: {
          position: new Cesium.GeometryAttribute({
            componentDatatype: Cesium.ComponentDatatype.DOUBLE,
            componentsPerAttribute: 3,
            values: tpl.positions,
          }),
          normal: new Cesium.GeometryAttribute({
            componentDatatype: Cesium.ComponentDatatype.FLOAT,
            componentsPerAttribute: 3,
            values: tpl.normals,
          }),
          st: new Cesium.GeometryAttribute({
            componentDatatype: Cesium.ComponentDatatype.FLOAT,
            componentsPerAttribute: 2,
            values: tpl.st,
          }),
        } as unknown as Cesium.GeometryAttributes,
        indices: tpl.indices,
        primitiveType: Cesium.PrimitiveType.TRIANGLES,
        boundingSphere: tpl.boundingSphere,
      }),
    }),
    appearance: new Cesium.MaterialAppearance({
      flat: true,
      translucent: false,
      materialSupport: Cesium.MaterialAppearance.MaterialSupport.TEXTURED,
      material: Cesium.Material.fromType('Image', { image: canvas }),
    }),
    asynchronous: false,
    allowPicking: false,
  })
}
