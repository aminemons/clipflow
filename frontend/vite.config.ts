import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'clipflow-offline-assets',
      generateBundle(_, bundle) {
        const assets = Object.keys(bundle)
          .filter(name => /^assets\/.+\.(css|js)$/.test(name))
          .map(name => '/' + name)
        this.emitFile({ type: 'asset', fileName: 'clipflow-assets.json', source: JSON.stringify(assets) })
      },
    },
  ],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8767' }
  },
  build: {
    rollupOptions: { input: { legacy: 'index.html', browser: 'browser.html', studio: 'studio.html' } },
  },
})
