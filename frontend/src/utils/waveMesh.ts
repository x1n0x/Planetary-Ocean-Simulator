// 3D triangulated "plexus" wave mesh — geometry math + Cesium primitive
// builders. Pure functions, no React. The ocean grid is displaced radially by
// eta (hugely exaggerated) and rendered as a dark translucent fill plus a
// wave-height-tinted wireframe, replacing the flat heatmap look.
import * as Cesium from 'cesium'

// Visual constants. eta is ±0.4 m on a 6,371 km globe — invisible without
// exaggeration. The TYPICAL wave field (p98 of |eta|, which ignores localized
// extremes like a tsunami blob covering ~1% of cells) is normalized to
// TARGET_PEAK; rare spikes rise above it but clamp at CLAMP_PEAK so a single
// 2.5 m event doesn't flatten the everyday tide to nothing.
export const TARGET_PEAK = 260_000 // m — p98 |eta| maps to this altitude
export const CLAMP_PEAK = 520_000 // m — hard ceiling for extreme spikes
export const BASE_OFFSET = 25_000 // m — lifts mesh off the ellipsoid (no z-fight)
export const WIRE_LIFT = 1_500 // m — wireframe floats above the fill
export const DEADBAND = 0.04 // m — suppress the ~0.03 m data noise floor

const FILL_COLOR = Cesium.Color.fromCssColorString('#050d1a').withAlpha(0.6)
const NODE_COLOR = Cesium.Color.fromCssColorString('#bfeaff').withAlpha(0.9)

export interface MeshTemplate {
  nLat: number // 64 grid rows, row 0 = lat -90 (south)
  nLon: number // 129 columns; col 128 duplicates col 0 to close the seam
  surface: Float64Array // base ellipsoid positions (N*3)
  normal: Float64Array // geodetic surface normals (N*3)
  normal32: Float32Array // same, float32 — shader attribute for the wire
  st: Float32Array // texture coords (N*2) into the eta palette canvas
  oceanVertex: Uint8Array // 1 = ocean (chi <= 0.5)
  triIndices: Uint16Array // fill triangles, ocean-only
  lineIndices: Uint16Array // wireframe edges, each drawn exactly once
  nodeIndices: Uint32Array // subsampled ocean vertices for glow points
  boundingSphere: Cesium.BoundingSphere
}

export function buildMeshTemplate(chi: number[][]): MeshTemplate {
  const nLat = chi.length // 64
  const dataLon = chi[0].length // 128
  const nLon = dataLon + 1 // duplicated seam column
  const N = nLat * nLon

  const surface = new Float64Array(N * 3)
  const normal = new Float64Array(N * 3)
  const st = new Float32Array(N * 2)
  const oceanVertex = new Uint8Array(N)

  const pos = new Cesium.Cartesian3()
  const nrm = new Cesium.Cartesian3()
  for (let i = 0; i < nLat; i++) {
    const latDeg = -90 + (i / (nLat - 1)) * 180
    for (let j = 0; j < nLon; j++) {
      const k = i * nLon + j
      const lonDeg = -180 + (j % dataLon) * (360 / dataLon)
      Cesium.Ellipsoid.WGS84.cartographicToCartesian(
        Cesium.Cartographic.fromDegrees(lonDeg, latDeg, 0),
        pos,
      )
      Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(pos, nrm)
      surface[k * 3] = pos.x
      surface[k * 3 + 1] = pos.y
      surface[k * 3 + 2] = pos.z
      normal[k * 3] = nrm.x
      normal[k * 3 + 1] = nrm.y
      normal[k * 3 + 2] = nrm.z
      // palette canvas is drawn north-up; Cesium uploads images with
      // flipY=true, so v=0 = canvas bottom = south = grid row 0.
      st[k * 2] = j / dataLon
      st[k * 2 + 1] = i / (nLat - 1)
      oceanVertex[k] = chi[i][j % dataLon] <= 0.5 ? 1 : 0
    }
  }

  // Triangles: two per cell, skipped if any corner is land. Rows at the poles
  // produce zero-area slivers (all vertices coincide) — harmless.
  const tris: number[] = []
  const lines: number[] = []
  for (let i = 0; i < nLat; i++) {
    for (let j = 0; j < nLon; j++) {
      const v00 = i * nLon + j
      const v01 = v00 + 1 // east
      const v10 = v00 + nLon // north
      const v11 = v10 + 1
      const east = j < nLon - 1
      const north = i < nLat - 1
      if (east && north) {
        if (oceanVertex[v00] && oceanVertex[v10] && oceanVertex[v01])
          tris.push(v00, v01, v10)
        if (oceanVertex[v10] && oceanVertex[v01] && oceanVertex[v11])
          tris.push(v10, v01, v11)
        // diagonal edge shared by the two triangles — drawn once
        if (oceanVertex[v10] && oceanVertex[v01]) lines.push(v10, v01)
      }
      // grid edges, each exactly once (toWireframe would double-draw shared
      // edges → uneven brightness under translucent blending)
      if (east && oceanVertex[v00] && oceanVertex[v01]) lines.push(v00, v01)
      if (north && oceanVertex[v00] && oceanVertex[v10]) lines.push(v00, v10)
    }
  }

  // Glow nodes: every 4th vertex in both dims over ocean (~500 points).
  const nodes: number[] = []
  for (let i = 0; i < nLat; i += 4)
    for (let j = 0; j < dataLon; j += 4)
      if (oceanVertex[i * nLon + j]) nodes.push(i * nLon + j)

  return {
    nLat,
    nLon,
    surface,
    normal,
    normal32: Float32Array.from(normal),
    st,
    oceanVertex,
    triIndices: new Uint16Array(tris),
    lineIndices: new Uint16Array(lines),
    nodeIndices: new Uint32Array(nodes),
    boundingSphere: new Cesium.BoundingSphere(
      Cesium.Cartesian3.ZERO,
      6_378_137 + TARGET_PEAK * 2,
    ),
  }
}

// Robust per-frame scale: 98th percentile of |eta|. A localized event (the
// tsunami blob is ~1% of cells) doesn't move it, so the everyday tide keeps
// its full visual height while the spike clamps at CLAMP_PEAK.
export function frameEtaScale(eta: number[][]): number {
  const nLat = eta.length
  const nLon = eta[0].length
  const flat = new Float32Array(nLat * nLon)
  let n = 0
  for (let i = 0; i < nLat; i++) {
    const row = eta[i]
    for (let j = 0; j < nLon; j++) flat[n++] = Math.abs(row[j])
  }
  flat.sort()
  return flat[Math.floor(0.98 * (n - 1))]
}

// Radial displacement: d = offset + sign(η)·max(0, |η|−deadband)·exag.
// Fresh array every call — Cesium may not have uploaded the previous frame's
// buffer yet, so in-flight arrays must never be mutated.
export function displace(
  tpl: MeshTemplate,
  eta: number[][],
  exag: number,
  offset: number,
): Float64Array {
  const { nLat, nLon, surface, normal, oceanVertex } = tpl
  const dataLon = nLon - 1
  const out = new Float64Array(surface.length)
  for (let i = 0; i < nLat; i++) {
    const row = eta[i]
    for (let j = 0; j < nLon; j++) {
      const k = i * nLon + j
      let d = offset
      if (oceanVertex[k]) {
        const e = row[j % dataLon]
        const mag = Math.max(0, Math.abs(e) - DEADBAND)
        d += Math.sign(e) * Math.min(mag * exag, CLAMP_PEAK)
      }
      out[k * 3] = surface[k * 3] + normal[k * 3] * d
      out[k * 3 + 1] = surface[k * 3 + 1] + normal[k * 3 + 1] * d
      out[k * 3 + 2] = surface[k * 3 + 2] + normal[k * 3 + 2] * d
    }
  }
  return out
}

// eta → palette canvas sampled by the wireframe via st coords.
// Deep blue (low) → cyan (mid) → near-white (high). Drawn north-up
// (canvas row 0 = lat +90) to match the flipY texture upload.
export function etaToWaveCanvas(
  eta: number[][],
  chi: number[][],
  vAbs: number,
): HTMLCanvasElement {
  const nLat = eta.length
  const nLon = eta[0].length
  const buf = new Uint8ClampedArray(nLat * nLon * 4)
  for (let r = 0; r < nLat; r++) {
    const i = nLat - 1 - r // canvas row 0 = north
    for (let j = 0; j < nLon; j++) {
      const idx = (r * nLon + j) * 4
      if (chi[i][j] > 0.5) continue // land: transparent
      const t = Math.max(0, Math.min(1, (eta[i][j] + vAbs) / (2 * vAbs)))
      let rC: number, gC: number, bC: number
      if (t < 0.5) {
        const s = t * 2 // deep blue #0a2a4a → cyan #35c8ff
        rC = 10 + (53 - 10) * s
        gC = 42 + (200 - 42) * s
        bC = 74 + (255 - 74) * s
      } else {
        const s = (t - 0.5) * 2 // cyan → near-white #eaffff
        rC = 53 + (234 - 53) * s
        gC = 200 + (255 - 200) * s
        bC = 255
      }
      buf[idx] = rC
      buf[idx + 1] = gC
      buf[idx + 2] = bC
      buf[idx + 3] = 235
    }
  }
  const canvas = document.createElement('canvas')
  canvas.width = nLon
  canvas.height = nLat
  canvas.getContext('2d')!.putImageData(new ImageData(buf, nLon, nLat), 0, 0)
  return canvas
}

export function makeWavePrimitives(
  tpl: MeshTemplate,
  posFill: Float64Array,
  posWire: Float64Array,
  paletteCanvas: HTMLCanvasElement,
): { fill: Cesium.Primitive; wire: Cesium.Primitive } {
  const common = {
    asynchronous: false, // sync build: no worker latency, no flicker
    allowPicking: false,
    vertexCacheOptimize: false,
    compressVertices: false,
  }

  const fill = new Cesium.Primitive({
    geometryInstances: new Cesium.GeometryInstance({
      geometry: new Cesium.Geometry({
        attributes: {
          position: new Cesium.GeometryAttribute({
            componentDatatype: Cesium.ComponentDatatype.DOUBLE, // auto high/low RTC split
            componentsPerAttribute: 3,
            values: posFill,
          }),
        } as unknown as Cesium.GeometryAttributes,
        indices: tpl.triIndices,
        primitiveType: Cesium.PrimitiveType.TRIANGLES,
        boundingSphere: tpl.boundingSphere,
      }),
      attributes: {
        color: Cesium.ColorGeometryInstanceAttribute.fromColor(FILL_COLOR),
      },
    }),
    appearance: new Cesium.PerInstanceColorAppearance({
      flat: true,
      translucent: true,
    }),
    ...common,
  })

  // Wireframe tinted by wave height: TEXTURED material support needs st +
  // normal attributes; flat:true skips lighting (normals only satisfy the
  // shader contract). st/normal copied per frame — see displace() note.
  const wire = new Cesium.Primitive({
    geometryInstances: new Cesium.GeometryInstance({
      geometry: new Cesium.Geometry({
        attributes: {
          position: new Cesium.GeometryAttribute({
            componentDatatype: Cesium.ComponentDatatype.DOUBLE,
            componentsPerAttribute: 3,
            values: posWire,
          }),
          normal: new Cesium.GeometryAttribute({
            componentDatatype: Cesium.ComponentDatatype.FLOAT,
            componentsPerAttribute: 3,
            values: tpl.normal32.slice(),
          }),
          st: new Cesium.GeometryAttribute({
            componentDatatype: Cesium.ComponentDatatype.FLOAT,
            componentsPerAttribute: 2,
            values: tpl.st.slice(),
          }),
        } as unknown as Cesium.GeometryAttributes,
        indices: tpl.lineIndices,
        primitiveType: Cesium.PrimitiveType.LINES,
        boundingSphere: tpl.boundingSphere,
      }),
    }),
    appearance: new Cesium.MaterialAppearance({
      flat: true,
      translucent: true,
      materialSupport: Cesium.MaterialAppearance.MaterialSupport.TEXTURED,
      material: Cesium.Material.fromType('Image', { image: paletteCanvas }),
    }),
    ...common,
  })

  return { fill, wire }
}

export function nodePixelSize(k: number): number {
  return k % 7 === 0 ? 6 : 3.5 // a few larger nodes for the plexus vibe
}

export const MESH_NODE_COLOR = NODE_COLOR
