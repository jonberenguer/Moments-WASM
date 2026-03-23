import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const isolationHeaders = (res) => {
  // Required for SharedArrayBuffer (FFmpeg WASM threading)
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
  // Required so the worker can fetch /ffmpeg/ assets under COEP
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
}

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'isolation-headers',
      configureServer(server) {
        server.middlewares.use((_req, res, next) => {
          isolationHeaders(res)
          next()
        })
      },
      configurePreviewServer(server) {
        server.middlewares.use((_req, res, next) => {
          isolationHeaders(res)
          next()
        })
      },
    },
  ],
  // Ensure the worker chunk from @ffmpeg/ffmpeg is emitted properly
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
})
