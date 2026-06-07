import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import cesium from 'vite-plugin-cesium'

// https://vite.dev/config/
export default defineConfig({
  // vite-plugin-cesium copies Cesium's static assets (workers, widgets,
  // Assets) and sets CESIUM_BASE_URL so the globe loads in dev and build.
  plugins: [react(), cesium()],
  server: {
    // useOceanState fetches /api/state — proxy /api to the FastAPI backend
    // so there are no CORS issues in dev (CLAUDE.md §7.5, §13).
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
