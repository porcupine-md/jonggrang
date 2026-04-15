import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiTarget = env.VITE_API_TARGET || `http://localhost:${env.VITE_API_PORT || '7777'}`

  return {
    plugins: [vue()],
    build: {
      chunkSizeWarningLimit: 700,
    },
    server: {
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true
        },
        '/socket.io': {
          target: apiTarget,
          ws: true
        }
      }
    }
  }
})
