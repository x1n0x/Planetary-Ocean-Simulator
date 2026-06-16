import { useEffect, useRef } from 'react'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'

import { getState, getAnomaly } from '../api'
import type { Scenario } from '../types'
import {
  etaToTexture,
  anomalyToTexture,
  imageDataToDataUrl,
} from '../utils/textures'
import { makeMoonTexture, makeMoonPrimitive, moonModelMatrix } from '../utils/moonBody'
import {
  buildLandTemplate,
  landColorCanvas,
  makeLandPrimitive,
} from '../utils/landMesh'
import {
  buildMeshTemplate,
  displace,
  etaToWaveCanvas,
  frameEtaScale,
  makeWavePrimitives,
  nodePixelSize,
  MESH_NODE_COLOR,
  TARGET_PEAK,
  BASE_OFFSET,
  WIRE_LIFT,
  type MeshTemplate,
} from '../utils/waveMesh'

// Whole-globe extent — every scenario spans the full sphere (CLAUDE.md §4.4).
const GLOBE_RECT = Cesium.Rectangle.fromDegrees(-180, -90, 180, 90)
// Idle spin, paused on interaction.
const SPIN_RATE = 0.003

// Sub-lunar longitude (deg) at timestep t — the same kinematics as the physics
// solver (tidal_swe.py): the sub-lunar point regresses at Ω_planet − n_moon,
// with n_moon from Kepler for the scenario's moon distance. lon0 = 0, lat = 0
// (the primary moon is equatorial in every scenario).
const G_GRAV = 6.674e-11
const M_PLANET = 5.972e24
function subLunarLon(meta: Scenario, t: number): number {
  const d = meta.moon_dist_km * 1000
  const nMoon = Math.sqrt((G_GRAV * M_PLANET) / d ** 3)
  const omegaSub = meta.omega_rad_s - nMoon
  const lam = Cesium.Math.toDegrees(-omegaSub * t * meta.dt_seconds)
  return ((((lam + 180) % 360) + 360) % 360) - 180
}

async function makeLayer(
  viewer: Cesium.Viewer,
  img: ImageData,
): Promise<Cesium.ImageryLayer> {
  const provider = await Cesium.SingleTileImageryProvider.fromUrl(
    imageDataToDataUrl(img),
    { rectangle: GLOBE_RECT },
  )
  return viewer.imageryLayers.addImageryProvider(provider)
}

export function Globe({
  scenario,
  total,
  t,
  chi,
  showAnomaly = false,
  showVectors = false,
  showMesh = false,
  meta = null,
  onProgress,
  onAnomalyCount,
}: {
  scenario: string | null
  total: number
  t: number
  chi: number[][] | null
  showAnomaly?: boolean
  showVectors?: boolean
  showMesh?: boolean
  meta?: Scenario | null
  onProgress?: (built: number) => void
  onAnomalyCount?: (count: number | null) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<Cesium.Viewer | null>(null)
  const landPrimRef = useRef<Cesium.Primitive | null>(null)
  const anomalyLayerRef = useRef<Cesium.ImageryLayer | null>(null)
  const vectorsRef = useRef<Cesium.PolylineCollection | null>(null)
  const arrowMatRef = useRef<Cesium.Material | null>(null)
  // One prebuilt, hidden imagery layer per timestep — playback just toggles
  // visibility (no network, no PNG decode), so it stays buttery-smooth.
  const framesRef = useRef<Map<number, Cesium.ImageryLayer>>(new Map())
  const shownRef = useRef<Cesium.ImageryLayer | null>(null)
  const anomalySeqRef = useRef(0)
  const vectorsSeqRef = useRef(0)
  // 3D wave mesh (plexus) state — see utils/waveMesh.ts
  const meshFillRef = useRef<Cesium.Primitive | null>(null)
  const meshWireRef = useRef<Cesium.Primitive | null>(null)
  const meshNodesRef = useRef<Cesium.PointPrimitiveCollection | null>(null)
  const meshTemplateRef = useRef<MeshTemplate | null>(null)
  const maxAbsEtaRef = useRef(0) // running per-scenario |eta| max → exaggeration
  const meshSeqRef = useRef(0)
  const meshModeRef = useRef(false) // read by showFrame: mesh hides the heatmap
  // 3D moon body — a cratered sphere orbiting the sub-lunar point
  const moonPrimRef = useRef<Cesium.Primitive | null>(null)
  // latest t, for the async prebuild loop to know which frame to reveal
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  }, [t])

  function showFrame(frame: number) {
    const viewer = viewerRef.current
    if (!viewer || viewer.isDestroyed()) return
    const layer = framesRef.current.get(frame)
    if (!layer) return // not built yet — keep the previous frame on screen
    if (shownRef.current && shownRef.current !== layer)
      shownRef.current.show = false
    // mesh mode renders eta as 3D geometry — keep the flat heatmap hidden
    layer.show = !meshModeRef.current
    shownRef.current = layer
    // stacking order: eta (bottom) → anomaly (top); land is a 3D primitive
    if (anomalyLayerRef.current)
      viewer.imageryLayers.raiseToTop(anomalyLayerRef.current)
  }

  // --- create the viewer once, tear down on unmount ---
  useEffect(() => {
    if (!containerRef.current) return

    const viewer = new Cesium.Viewer(containerRef.current, {
      baseLayer: false, // no default Ion imagery / token
      // 3D only: skips the splitLongitude pass in the primitive pipeline,
      // which would otherwise reprocess the wave mesh on every rebuild.
      scene3DOnly: true,
      terrainProvider: new Cesium.EllipsoidTerrainProvider(),
      baseLayerPicker: false,
      navigationHelpButton: false,
      animation: false,
      timeline: false,
      geocoder: false,
      homeButton: false,
      fullscreenButton: false,
      sceneModePicker: false,
      selectionIndicator: false,
      infoBox: false,
    })
    const scene = viewer.scene
    viewer.imageryLayers.removeAll()
    scene.backgroundColor = Cesium.Color.fromCssColorString('#100f0c')
    scene.globe.baseColor = Cesium.Color.fromCssColorString('#1b1710')
    scene.globe.showGroundAtmosphere = false
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = false

    // Fixed directional light → the moon body shows a phase. The flat wave mesh,
    // flat land primitive (hillshade is baked into its texture) and imagery
    // layers don't use scene lighting, so they're unaffected.
    scene.light = new Cesium.DirectionalLight({
      direction: Cesium.Cartesian3.normalize(
        new Cesium.Cartesian3(-0.7, -0.55, -0.45),
        new Cesium.Cartesian3(),
      ),
      intensity: 2.4,
    })

    // Build the moon once; its world transform is updated per frame.
    const moon = makeMoonPrimitive(makeMoonTexture())
    moon.show = false
    scene.primitives.add(moon)
    moonPrimRef.current = moon

    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(0, 12, 22_000_000),
    })

    // idle auto-rotation, stops on user interaction
    let spinning = true
    const stopSpin = () => {
      spinning = false
    }
    const removeSpin = scene.preRender.addEventListener(() => {
      if (spinning) viewer.camera.rotate(Cesium.Cartesian3.UNIT_Z, -SPIN_RATE)
    })
    const input = new Cesium.ScreenSpaceEventHandler(viewer.canvas)
    input.setInputAction(stopSpin, Cesium.ScreenSpaceEventType.LEFT_DOWN)
    input.setInputAction(stopSpin, Cesium.ScreenSpaceEventType.WHEEL)
    input.setInputAction(stopSpin, Cesium.ScreenSpaceEventType.PINCH_START)

    viewerRef.current = viewer
    const frames = framesRef.current // stable Map; capture for cleanup

    return () => {
      removeSpin()
      input.destroy()
      if (!viewer.isDestroyed()) viewer.destroy()
      viewerRef.current = null
      landPrimRef.current = null
      anomalyLayerRef.current = null
      vectorsRef.current = null
      arrowMatRef.current = null
      meshFillRef.current = null // primitives destroyed with the viewer
      meshWireRef.current = null
      meshNodesRef.current = null
      meshTemplateRef.current = null
      moonPrimRef.current = null
      frames.clear()
      shownRef.current = null
    }
  }, [])

  // --- relief land: 3D island terrain, rebuilt when chi (scenario) changes ---
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || !chi) return
    const scene = viewer.scene

    if (landPrimRef.current) {
      scene.primitives.remove(landPrimRef.current)
      landPrimRef.current = null
    }
    const tpl = buildLandTemplate(chi)
    if (!tpl.hasLand) return // open ocean: nothing to draw
    const prim = makeLandPrimitive(tpl, landColorCanvas(tpl))
    scene.primitives.add(prim)
    landPrimRef.current = prim

    return () => {
      if (!viewer.isDestroyed() && landPrimRef.current) {
        scene.primitives.remove(landPrimRef.current)
        landPrimRef.current = null
      }
    }
  }, [chi])

  // --- prebuild every timestep once the scenario is known ---
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || !chi || !scenario || total <= 0) return
    let cancelled = false

    // drop the previous scenario's frames
    framesRef.current.forEach(
      (l) => !viewer.isDestroyed() && viewer.imageryLayers.remove(l, true),
    )
    framesRef.current.clear()
    shownRef.current = null
    // per-scenario mesh state: grid template depends on chi, exaggeration on
    // this scenario's eta range
    meshTemplateRef.current = null
    maxAbsEtaRef.current = 0
    onProgress?.(0)

    ;(async () => {
      for (let i = 0; i < total; i++) {
        if (cancelled || viewer.isDestroyed()) return
        try {
          const s = await getState(scenario, i)
          if (cancelled || viewer.isDestroyed()) return
          // feed the mesh exaggeration normalizer (cheap O(grid) pass)
          maxAbsEtaRef.current = Math.max(
            maxAbsEtaRef.current,
            frameEtaScale(s.eta),
          )
          const layer = await makeLayer(
            viewer,
            // ±0.5 m so the ~0.3 m test tide is visible.
            etaToTexture(s.eta, chi, -0.5, 0.5),
          )
          if (cancelled || viewer.isDestroyed()) {
            if (!viewer.isDestroyed()) viewer.imageryLayers.remove(layer, true)
            return
          }
          layer.saturation = 1.7
          layer.contrast = 1.35
          layer.brightness = 1.15
          layer.show = false
          framesRef.current.set(i, layer)
          if (i === tRef.current) showFrame(i)
          onProgress?.(framesRef.current.size)
        } catch (e) {
          console.error('[Globe] prebuild frame', i, e)
        }
      }
    })()

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenario, total, chi])

  // --- show the requested frame (instant if prebuilt) ---
  useEffect(() => {
    showFrame(t)
  }, [t])

  // --- 3D wave mesh: displaced triangulated surface, rebuilt per frame ---
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    meshModeRef.current = showMesh
    const scene = viewer.scene

    const clearMesh = () => {
      if (viewer.isDestroyed()) return
      if (meshFillRef.current) {
        scene.primitives.remove(meshFillRef.current)
        meshFillRef.current = null
      }
      if (meshWireRef.current) {
        scene.primitives.remove(meshWireRef.current)
        meshWireRef.current = null
      }
      if (meshNodesRef.current && !meshNodesRef.current.isDestroyed())
        meshNodesRef.current.removeAll()
    }

    if (!showMesh || !scenario || !chi) {
      clearMesh()
      showFrame(tRef.current) // restore the flat heatmap
      return
    }

    // mesh replaces the heatmap — hide the currently shown frame layer
    if (shownRef.current) shownRef.current.show = false

    let templateFresh = false
    if (!meshTemplateRef.current) {
      meshTemplateRef.current = buildMeshTemplate(chi)
      templateFresh = true
    }
    const tpl = meshTemplateRef.current

    const seq = ++meshSeqRef.current
    let cancelled = false
    const stale = () =>
      cancelled || viewer.isDestroyed() || seq !== meshSeqRef.current

    getState(scenario, t)
      .then((s) => {
        if (stale()) return
        // exaggeration: normalize this scenario's typical |eta| to TARGET_PEAK
        maxAbsEtaRef.current = Math.max(
          maxAbsEtaRef.current,
          frameEtaScale(s.eta),
        )
        const vAbs = Math.max(maxAbsEtaRef.current, 0.05)
        const exag = TARGET_PEAK / vAbs
        const posFill = displace(tpl, s.eta, exag, BASE_OFFSET)
        const posWire = displace(tpl, s.eta, exag, BASE_OFFSET + WIRE_LIFT)
        const { fill, wire } = makeWavePrimitives(
          tpl,
          posFill,
          posWire,
          etaToWaveCanvas(s.eta, chi, vAbs),
        )
        // add new first, then drop old — never a blank frame. Fill before
        // wire: equal-depth translucents keep insertion order (stable sort),
        // so lines composite over the dark fill.
        const oldFill = meshFillRef.current
        const oldWire = meshWireRef.current
        scene.primitives.add(fill)
        scene.primitives.add(wire)
        meshFillRef.current = fill
        meshWireRef.current = wire
        if (oldFill) scene.primitives.remove(oldFill)
        if (oldWire) scene.primitives.remove(oldWire)

        // glow nodes: persistent collection, only positions move per frame
        let nodes = meshNodesRef.current
        if (!nodes || nodes.isDestroyed()) {
          nodes = new Cesium.PointPrimitiveCollection()
          scene.primitives.add(nodes)
          meshNodesRef.current = nodes
        }
        if (templateFresh || nodes.length !== tpl.nodeIndices.length) {
          nodes.removeAll()
          for (let k = 0; k < tpl.nodeIndices.length; k++)
            nodes.add({
              color: MESH_NODE_COLOR,
              pixelSize: nodePixelSize(k),
              disableDepthTestDistance: 0,
            })
        }
        for (let k = 0; k < tpl.nodeIndices.length; k++) {
          const v = tpl.nodeIndices[k] * 3
          nodes.get(k).position = new Cesium.Cartesian3(
            posWire[v],
            posWire[v + 1],
            posWire[v + 2],
          )
        }
      })
      .catch((e) => console.error('[Globe] wave mesh', e))

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showMesh, scenario, chi, t])

  // --- moon body: orbit the sub-lunar point, slowly spinning under the light ---
  useEffect(() => {
    const moon = moonPrimRef.current
    if (!moon) return
    if (!meta) {
      moon.show = false
      return
    }
    const lon = subLunarLon(meta, t)
    moon.modelMatrix = moonModelMatrix(lon, t * 0.06)
    moon.show = true
  }, [meta, t])

  // --- anomaly overlay: red mask for the current frame when toggled on ---
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return

    const clear = () => {
      if (anomalyLayerRef.current && !viewer.isDestroyed()) {
        viewer.imageryLayers.remove(anomalyLayerRef.current, true)
        anomalyLayerRef.current = null
      }
    }

    if (!showAnomaly || !scenario || !chi) {
      clear()
      onAnomalyCount?.(null)
      return
    }

    const seq = ++anomalySeqRef.current
    let cancelled = false
    const stale = () =>
      cancelled || viewer.isDestroyed() || seq !== anomalySeqRef.current

    getAnomaly(scenario, t)
      .then(async (a) => {
        if (stale()) return
        onAnomalyCount?.(a.anomaly_count)
        const layer = await makeLayer(
          viewer,
          anomalyToTexture(a.composite_mask, a.z_scores, chi),
        )
        if (stale()) {
          if (!viewer.isDestroyed()) viewer.imageryLayers.remove(layer, true)
          return
        }
        clear()
        anomalyLayerRef.current = layer // makeLayer appends on top → already topmost
      })
      .catch((e) => console.error('[Globe] anomaly', e))

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAnomaly, scenario, chi, t])

  // --- velocity vectors: current arrows over the ocean when toggled on ---
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return

    if (!showVectors || !scenario || !chi) {
      if (vectorsRef.current && !viewer.isDestroyed())
        vectorsRef.current.removeAll()
      return
    }

    const seq = ++vectorsSeqRef.current
    let cancelled = false
    getState(scenario, t)
      .then((s) => {
        if (cancelled || viewer.isDestroyed() || seq !== vectorsSeqRef.current)
          return
        const u = s.u
        const v = s.v
        const lat = u.length
        const lon = u[0].length

        let coll = vectorsRef.current
        if (!coll || coll.isDestroyed()) {
          coll = new Cesium.PolylineCollection()
          viewer.scene.primitives.add(coll)
          vectorsRef.current = coll
        }
        coll.removeAll()
        const mat =
          arrowMatRef.current ??
          (arrowMatRef.current = Cesium.Material.fromType('PolylineArrow', {
            color: Cesium.Color.fromCssColorString('#d9c896').withAlpha(0.9),
          }))

        const STEP = 5 // subsample the grid
        const H = 260_000 // above the surface AND the mesh's ~225 km peaks
        const SCALE = 8 // degrees of arrow per m/s
        const MAX_LEN = 6 // clamp long arrows
        for (let i = 0; i < lat; i += STEP) {
          const latDeg = -90 + (i / (lat - 1)) * 180
          const cosLat = Math.max(Math.cos((latDeg * Math.PI) / 180), 0.3)
          for (let j = 0; j < lon; j += STEP) {
            if (chi[i][j] > 0.5) continue
            const uu = u[i][j]
            const vv = v[i][j]
            const speed = Math.hypot(uu, vv)
            if (speed < 1e-3) continue
            const lenDeg = Math.min(MAX_LEN, speed * SCALE)
            const lonDeg = -180 + (j / (lon - 1)) * 360
            const dLat = (vv / speed) * lenDeg
            const dLon = ((uu / speed) * lenDeg) / cosLat
            coll.add({
              positions: Cesium.Cartesian3.fromDegreesArrayHeights([
                lonDeg,
                latDeg,
                H,
                lonDeg + dLon,
                latDeg + dLat,
                H,
              ]),
              width: 9,
              material: mat,
            })
          }
        }
      })
      .catch((e) => console.error('[Globe] vectors', e))

    return () => {
      cancelled = true
    }
  }, [showVectors, scenario, chi, t])

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
}
