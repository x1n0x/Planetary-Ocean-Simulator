import { useEffect, useRef } from 'react'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'

import { getLand, getState } from '../api'
import {
  etaToTexture,
  chiToTexture,
  imageDataToDataUrl,
} from '../utils/textures'

// Whole-globe extent — every scenario spans the full sphere (CLAUDE.md §4.4).
const GLOBE_RECT = Cesium.Rectangle.fromDegrees(-180, -90, 180, 90)
// Idle spin: ~one revolution every ~35 s at 60 fps, paused on interaction.
const SPIN_RATE = 0.003

export function Globe({ scenario }: { scenario: string }) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!containerRef.current) return
    let cancelled = false

    // baseLayer:false → no default Ion imagery, no network token needed.
    const viewer = new Cesium.Viewer(containerRef.current, {
      baseLayer: false,
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
    // Kill the atmospheric limb wash that bleached the globe's edges.
    scene.globe.showGroundAtmosphere = false
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = false

    // Frame the equator from a slight tilt so the tidal bands read clearly.
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(0, 12, 22_000_000),
    })

    // Idle auto-rotation: brings the negative (blue) lobe into view and shows
    // the data is real. Stops the moment the user grabs the globe.
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

    async function addImagery(img: ImageData): Promise<Cesium.ImageryLayer> {
      const provider = await Cesium.SingleTileImageryProvider.fromUrl(
        imageDataToDataUrl(img),
        { rectangle: GLOBE_RECT },
      )
      return viewer.imageryLayers.addImageryProvider(provider)
    }

    ;(async () => {
      try {
        // /land is static — fetched once; /state at t=0 for the first frame.
        const [land, state] = await Promise.all([
          getLand(scenario),
          getState(scenario, 0),
        ])
        if (cancelled || viewer.isDestroyed()) return

        // eta heatmap first, land overlay on top (invisible while chi = 0).
        // vmin/vmax tightened to ±0.5 m so the ~0.3 m test tide is visible.
        const etaLayer = await addImagery(
          etaToTexture(state.eta, land.chi, -0.5, 0.5),
        )
        if (cancelled || viewer.isDestroyed()) return
        // Punch up the semi-transparent §7.4 colours at the layer level,
        // leaving the texture contract untouched.
        etaLayer.saturation = 1.7
        etaLayer.contrast = 1.35
        etaLayer.brightness = 1.15

        await addImagery(chiToTexture(land.chi))
      } catch (err) {
        if (!cancelled) console.error('[Globe] failed to load ocean state', err)
      }
    })()

    return () => {
      cancelled = true
      removeSpin()
      input.destroy()
      if (!viewer.isDestroyed()) viewer.destroy()
    }
  }, [scenario])

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
}
