import { useEffect, useRef } from 'react'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'

import { getState, getAnomaly } from '../api'
import {
  etaToTexture,
  chiToTexture,
  anomalyToTexture,
  imageDataToDataUrl,
} from '../utils/textures'

// Whole-globe extent — every scenario spans the full sphere (CLAUDE.md §4.4).
const GLOBE_RECT = Cesium.Rectangle.fromDegrees(-180, -90, 180, 90)
// Idle spin, paused on interaction.
const SPIN_RATE = 0.003

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
  onProgress,
  onAnomalyCount,
}: {
  scenario: string | null
  total: number
  t: number
  chi: number[][] | null
  showAnomaly?: boolean
  showVectors?: boolean
  onProgress?: (built: number) => void
  onAnomalyCount?: (count: number | null) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<Cesium.Viewer | null>(null)
  const landLayerRef = useRef<Cesium.ImageryLayer | null>(null)
  const anomalyLayerRef = useRef<Cesium.ImageryLayer | null>(null)
  const vectorsRef = useRef<Cesium.PolylineCollection | null>(null)
  const arrowMatRef = useRef<Cesium.Material | null>(null)
  // One prebuilt, hidden imagery layer per timestep — playback just toggles
  // visibility (no network, no PNG decode), so it stays buttery-smooth.
  const framesRef = useRef<Map<number, Cesium.ImageryLayer>>(new Map())
  const shownRef = useRef<Cesium.ImageryLayer | null>(null)
  const anomalySeqRef = useRef(0)
  const vectorsSeqRef = useRef(0)
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
    layer.show = true
    shownRef.current = layer
    // stacking order: eta (bottom) → land → anomaly (top)
    if (landLayerRef.current)
      viewer.imageryLayers.raiseToTop(landLayerRef.current)
    if (anomalyLayerRef.current)
      viewer.imageryLayers.raiseToTop(anomalyLayerRef.current)
  }

  // --- create the viewer once, tear down on unmount ---
  useEffect(() => {
    if (!containerRef.current) return

    const viewer = new Cesium.Viewer(containerRef.current, {
      baseLayer: false, // no default Ion imagery / token
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
    scene.backgroundColor = Cesium.Color.fromCssColorString('#050d1a')
    scene.globe.baseColor = Cesium.Color.fromCssColorString('#0a1a2f')
    scene.globe.showGroundAtmosphere = false
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = false
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
      landLayerRef.current = null
      anomalyLayerRef.current = null
      vectorsRef.current = null
      arrowMatRef.current = null
      frames.clear()
      shownRef.current = null
    }
  }, [])

  // --- land overlay: rebuild when chi (scenario) changes ---
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || !chi) return
    let cancelled = false
    makeLayer(viewer, chiToTexture(chi))
      .then((layer) => {
        if (cancelled || viewer.isDestroyed()) {
          if (!viewer.isDestroyed()) viewer.imageryLayers.remove(layer, true)
          return
        }
        if (landLayerRef.current)
          viewer.imageryLayers.remove(landLayerRef.current, true)
        landLayerRef.current = layer
      })
      .catch((e) => console.error('[Globe] land layer', e))
    return () => {
      cancelled = true
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
    onProgress?.(0)

    ;(async () => {
      for (let i = 0; i < total; i++) {
        if (cancelled || viewer.isDestroyed()) return
        try {
          const s = await getState(scenario, i)
          if (cancelled || viewer.isDestroyed()) return
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
            color: Cesium.Color.fromCssColorString('#bfe6f0').withAlpha(0.9),
          }))

        const STEP = 5 // subsample the grid
        const H = 90_000 // float arrows above the surface
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
