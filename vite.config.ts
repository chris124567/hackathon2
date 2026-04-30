import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// In-memory store for live HLS manifests. The Rust publisher PUTs the latest
// manifest text here on each tick; the player GETs it (and hls.js polls it on
// target-duration cadence). Segment URIs inside the manifest remain Sia share
// URLs that the custom hls.js loader resolves via the SDK.
function manifestEndpoint(): Plugin {
  const store = new Map<string, string>()
  const path = '/api/manifest/'

  return {
    name: 'manifest-endpoint',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith(path)) return next()
        const id = req.url.slice(path.length).split('?')[0]
        if (!id) {
          res.statusCode = 400
          res.end('missing id')
          return
        }

        // Allow the Rust publisher to PUT from any origin during dev.
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS')

        if (req.method === 'OPTIONS') {
          res.statusCode = 204
          res.end()
          return
        }
        if (req.method === 'GET') {
          const manifest = store.get(id)
          if (!manifest) {
            res.statusCode = 404
            res.end('not found')
            return
          }
          res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
          res.end(manifest)
          return
        }
        if (req.method === 'PUT' || req.method === 'POST') {
          const chunks: Buffer[] = []
          req.on('data', (c: Buffer) => chunks.push(c))
          req.on('end', () => {
            store.set(id, Buffer.concat(chunks).toString('utf8'))
            res.statusCode = 204
            res.end()
          })
          return
        }
        res.statusCode = 405
        res.end('method not allowed')
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), manifestEndpoint()],
  // sia-storage loads its WASM via `new URL(..., import.meta.url)`; excluding
  // it from the deps pre-bundler keeps that URL pointing at the real file.
  optimizeDeps: { exclude: ['@siafoundation/sia-storage'] },
})
