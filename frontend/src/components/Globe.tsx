import { useEffect, useRef } from 'react'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'

import { getState } from '../api'
import {
  etaToTexture,
  chiToTexture,
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
  onProgress,
}: {
  scenario: string | null
  total: number
  t: number
  chi: number[][] | null
  onProgress?: (built: number) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<Cesium.Viewer | null>(null)
  const landLayerRef = useRef<Cesium.ImageryLayer | null>(null)
  // One prebuilt, hidden imagery layer per timestep — playback just toggles
  // visibility (no network, no PNG decode), so it stays buttery-smooth.
  const framesRef = useRef<Map<number, Cesium.ImageryLayer>>(new Map())
  const shownRef = useRef<Cesium.ImageryLayer | null>(null)
  const tRef = useRef(t)
  tRef.current = t

  function showFrame(frame: number) {
    const viewer = viewerRef.current
    if (!viewer || viewer.isDestroyed()) return
    const layer = framesRef.current.get(frame)
    if (!layer) return // not built yet — keep the previous frame on screen
    if (shownRef.current && shownRef.current !== layer)
      shownRef.current.show = false
    layer.show = true
    shownRef.current = layer
    if (landLayerRef.current)
      viewer.imageryLayers.raiseToTop(landLayerRef.current)
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

    return () => {
      removeSpin()
      input.destroy()
      if (!viewer.isDestroyed()) viewer.destroy()
      viewerRef.current = null
      landLayerRef.current = null
      framesRef.current.clear()
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t])

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
}
